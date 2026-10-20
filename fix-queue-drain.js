#!/usr/bin/env node
/**
 * fix-queue-drain.js — dreno por conversa + dedup na fila do whatsplay (2026-10-20)
 *
 * Decreto owner: "a Luna tem que respeitar a fila e terminar 1 conversa primeiro
 * pra dps processar a outra. ela nem termina de escrever ja vai pra outro chat
 * e enviou 2x a msm coisa."
 *
 * Implementado no evento certo (deliverOne, apos o primeiro envio da conversa):
 *   - drainSameConversation: entrega TODAS as msgs 'queued' da MESMA conversa
 *     (chat ja aberto, delay curto anti-ban), ate esvaziar — so entao o proximo
 *     destino abre chat novo.
 *   - dedup: conteudo identico ao recm-enviado nessa sequencia = pulado,
 *     marcado 'sent' com audit 'whatsapp.message.dedup_skipped' (rastro honesto).
 *   - guard: __drainingConversations evita dois drenos paralelos na mesma conversa.
 *
 * USO:  node fix-queue-drain.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const FILE = path.join(ROOT, 'apps', 'whatsplay', 'src', 'outbound.ts');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!fs.existsSync(FILE)) { console.error('Nao encontrado: ' + FILE); process.exit(1); }
fs.copyFileSync(FILE, FILE + '.bak-' + ts);
let src = fs.readFileSync(FILE, 'utf8');
const isCrlf = src.includes('\r\n');
const norm = (s) => isCrlf ? s.replace(/\n/g, '\r\n') : s;

let patches = 0;
function rep(label, OLD, NEW) {
  const o = norm(OLD), n = norm(NEW);
  const count = src.split(o).length - 1;
  if (count !== 1) { console.error('[FALHOU] ' + label + ' — ' + count + 'x'); return false; }
  src = src.split(o).join(n);
  console.log('[OK] ' + label);
  patches++;
  return true;
}

if (src.includes('drainSameConversation')) {
  console.log('[SKIP] ja aplicado');
} else {
  rep('P1: chamada do dreno apos o primeiro envio',
`      log.info({ message_id: messageId, target }, 'resposta entregue no WhatsApp');
    } catch (err) {`,
`      log.info({ message_id: messageId, target }, 'resposta entregue no WhatsApp');
      // v14.9-fix (owner 20/10) — DRENO POR CONVERSA: termina TODAS as pendentes
      // desta conversa (chat ja aberto) antes de qualquer outra. Dedup incluso.
      const __justSentText = sanitizeOutboundText(extractAnswerEnvelopeText(row.body) ?? row.body);
      await drainSameConversation(row.conversation_id, sendTarget, __justSentText);
    } catch (err) {`);

  rep('P2: funcao drainSameConversation + guard',
`
  async function mark(messageId: string, state: 'sent' | 'failed', error?: string): Promise<void> {`,
`
  // v14.9-fix (owner 20/10) — DRENO POR CONVERSA + DEDUP
  const __drainingConversations = new Set<string>();
  async function drainSameConversation(conversationId: string, sendTarget: string, lastText: string): Promise<void> {
    if (__drainingConversations.has(conversationId)) return;
    __drainingConversations.add(conversationId);
    let textoAnterior = lastText;
    try {
      for (let i = 0; i < 10; i++) {
        const next = await pool.query<OutboundMessageRow>(
          \`SELECT m.id, m.body, m.conversation_id, m.metadata,
                  m.metadata->>'reply_to_query' AS reply_to_query
           FROM messages m
           WHERE m.conversation_id = $1 AND m.send_state = 'queued'
             AND (m.metadata->>'next_retry_at' IS NULL OR (m.metadata->>'next_retry_at')::timestamptz <= now())
           ORDER BY m.created_at ASC
           LIMIT 1\`,
          [conversationId],
        );
        if (!next.rowCount) return;
        const nmsg = next.rows[0]!;
        const rawN = extractAnswerEnvelopeText(nmsg.body) ?? nmsg.body;
        const textoN = sanitizeOutboundText(rawN);
        // DEDUP: conteudo identico ao envio imediatamente anterior -> pula (auditado)
        if (textoN && textoN === textoAnterior) {
          await mark(nmsg.id, 'sent');
          await recordAudit(pool, {
            actor: 'whatsplay',
            action: 'whatsapp.message.dedup_skipped',
            tool: 'whatsplay_transport',
            result: 'success',
            metadata: { message_id: nmsg.id, target: sendTarget, reason: 'conteudo identico ao envio imediatamente anterior (dreno)' },
          });
          log.info({ message_id: nmsg.id }, 'dreno: DEDUP — conteudo identico ao anterior, envio pulado');
          continue;
        }
        try {
          // delay curto: mesmo chat ja aberto, so digita e manda (anti-ban mantido)
          await new Promise((r) => setTimeout(r, 700 + Math.floor(Math.random() * 500)));
          if (nmsg.reply_to_query && transport.replyToMessage) {
            await withSendLock(() => transport.replyToMessage!(sendTarget, nmsg.reply_to_query!, textoN));
          } else {
            await withSendLock(() => transport.sendMessage(sendTarget, textoN));
          }
          await mark(nmsg.id, 'sent');
          textoAnterior = textoN;
          await recordAudit(pool, {
            actor: 'whatsplay',
            action: 'whatsapp.message.sent',
            tool: 'whatsplay_transport',
            result: 'success',
            metadata: { message_id: nmsg.id, target: sendTarget, via: 'drain_same_conversation' },
          });
          log.info({ message_id: nmsg.id, target: sendTarget }, 'dreno: msg da MESMA conversa entregue (chat ja aberto)');
        } catch (err) {
          log.warn({ err, message_id: nmsg.id }, 'dreno: falha — deixa pro fluxo normal (backoff)');
          return;
        }
      }
    } finally {
      __drainingConversations.delete(conversationId);
    }
  }

  async function mark(messageId: string, state: 'sent' | 'failed', error?: string): Promise<void> {`);
}

if (patches === 2) fs.writeFileSync(FILE, src);

try { execSync('pm2 restart luna-whatsplay', { encoding: 'utf8' }); console.log('[OK] luna-whatsplay reiniciado'); }
catch { console.log('pm2 restart falhou'); }

console.log('');
console.log('\x1b[32m✅ FILA COMPORTADA.\x1b[0m');
console.log('   - termina a conversa A toda (chat aberto, delay curto) antes do B');
console.log('   - conteudo identico seguido = 1 envio (dedup auditado)');
console.log('');
console.log('   Falta so o dedup UPSTREAM (mesmo comando teu processado 2x — isso e no');
console.log('   orchestrator/router, nao na fila). Anota pra Fase 1.');
console.log('\x1b[90mBackup: outbound.ts.bak-' + ts + '\x1b[0m');
