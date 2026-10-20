#!/usr/bin/env node
/**
 * fix-work-batch-serial.js — v16.2 (decreto owner 20/10)
 *
 * 1. LOCK GLOBAL: chats serializam (A termina -> B comeca). Fim do paralelo.
 * 2. BATCH POR AUTOR: pendentes do MESMO autor em 1 prompt -> 1 resposta.
 *    NUNCA mistura autores (grupo: cada um recebe a sua de cada vez).
 * 3. Zera filas (messages queued + kimiwork_inbox pending).
 * 4. Restart pm2 (fallback cmd.exe).
 * Seguro: backup, falha avisando, idempotente (marker v16.2-fix).
 * Roda com o orchestrator PARADO.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const AGENT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const HANDLER = path.join(AGENT, 'apps', 'orchestrator', 'src', 'agent', 'handler.ts');

function ok(m) { console.log('[OK] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); }
function bak(file) {
  const b = file + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(file, b);
  return b;
}

(async function main() {
  console.log('=== handler.ts ===');
  if (!fs.existsSync(HANDLER)) { fail('nao achei ' + HANDLER); process.exit(1); }
  let src = fs.readFileSync(HANDLER, 'utf8');
  if (src.includes('v16.2-fix')) {
    ok('ja aplicado (marker v16.2-fix)');
  } else {
    const NL = src.includes('\r\n') ? '\r\n' : '\n';
    const lockOld = '`luna:conv:${conversationId}`';
    if (src.split(lockOld).length - 1 !== 2) throw new Error('anchor lock ' + (src.split(lockOld).length - 1) + 'x (esperado 2)');
    src = src.split(lockOld).join('`luna:work:global`');
    const callOld = '      const answerText = await askKernelWorkKernel(text, conversationId, log);';
    if (src.split(callOld).length - 1 !== 1) throw new Error('anchor askKernel ' + (src.split(callOld).length - 1) + 'x (esperado 1)');
    const block = [
      '      // v16.2-fix (decreto owner 20/10): BATCH POR AUTOR + LOCK GLOBAL.',
      '      // Num grupo: junta TODAS as pendentes do MESMO autor num prompt so,',
      '      // 1 resposta, 1 msg no zap. Nunca mistura autores. Chats em serie.',
      '      let batchText = text;',
      '      try {',
      "        if (process.env.LUNA_WORK_BATCH !== '0') {",
      '          await new Promise((r) => setTimeout(r, Number(process.env.LUNA_WORK_DEBOUNCE_MS || 6000)));',
      '          const author = payload.author_name ?? null;',
      '          const pend = await db.query(',
      '            `SELECT m.body FROM messages m',
      "             WHERE m.conversation_id = $1 AND m.direction = 'inbound'",
      "               AND m.created_at > now() - interval '15 minutes'",
      '               AND (m.author_name = $2 OR ($2::text IS NULL AND m.author_name IS NULL))',
      '               AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.conversation_id = $1',
      "                               AND r.direction = 'outbound' AND r.created_at > m.created_at)",
      '             ORDER BY m.created_at ASC LIMIT 20`,',
      '            [conversationId, author],',
      '          );',
      '          const msgs = (pend.rows as Array<{ body?: string | null }>)',
      "            .map((r) => (r.body ?? '').trim()).filter(Boolean);",
      '          if (msgs.length > 1) {',
      "            batchText = '(varias mensagens seguidas do mesmo autor — responda a todas de uma vez, em 1 so msg)' + '\\n' + msgs.join('\\n');",
      "            log.info({ conversation_id: conversationId, author, folded: msgs.length }, 'work: batch por autor');",
      '          } else if (msgs.length === 1) {',
      '            batchText = msgs[0] || text;',
      '          }',
      '        }',
      '      } catch (err) {',
      "        log.warn({ err: String(err).slice(0, 140) }, 'work: batch falhou — segue com msg unica');",
      '      }',
      '      // anti-duplicada: resposta Luna posterior ao inbound = ja respondida.',
      '      try {',
      '        const mine = await db.query(',
      '          `SELECT m.created_at FROM messages m',
      "           WHERE m.conversation_id = $1 AND m.direction = 'inbound' AND m.body = $2",
      '           ORDER BY m.created_at DESC LIMIT 1`,',
      '          [conversationId, text],',
      '        );',
      '        const mineRow = mine.rows[0] as { created_at?: string } | undefined;',
      '        if (mineRow?.created_at) {',
      '          const answered = await db.query(',
      "            `SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'outbound'",
      "             AND author_name = 'Luna' AND created_at > $2 LIMIT 1`,",
      '            [conversationId, mineRow.created_at],',
      '          );',
      '          if (answered.rowCount) {',
      "            log.info({ conversation_id: conversationId }, 'work: ja respondida em batch anterior — skip');",
      '            await recordAudit(db, {',
      "              actor: 'orchestrator',",
      "              action: 'agent.reply.batch_already_answered',",
      "              tool: 'message_handler',",
      '              client_id: event.client_id,',
      '              correlation_id: event.correlation_id,',
      "              result: 'success',",
      '              metadata: { conversation_id: conversationId },',
      '            });',
      '            return;',
      '          }',
      '        }',
      '      } catch { /* segue */ }',
      '      const answerText = await askKernelWorkKernel(batchText, conversationId, log);',
    ].join(NL);
    src = src.replace(callOld, block);
    const b = bak(HANDLER);
    fs.writeFileSync(HANDLER, src, 'utf8');
    ok('lock global aplicado (chats em serie)');
    ok('batch por autor aplicado (1 prompt por autor, nunca mistura)');
    ok('backup: ' + path.basename(b));
  }

  console.log('');
  console.log('=== zera filas ===');
  try {
    let pg = null;
    for (const base of [path.join(AGENT, 'node_modules', 'pg'), 'C:\\Users\\Abner\\Documents\\luna-kernel\\node_modules\\pg']) {
      try { pg = require(base); break; } catch (_) {}
    }
    if (!pg) throw new Error('modulo pg nao achado');
    let url = process.env.DATABASE_URL || '';
    for (const envf of [path.join(AGENT, '.env'), path.join(AGENT, 'apps', 'orchestrator', '.env'), path.join(AGENT, 'apps', 'whatsplay', '.env')]) {
      if (url) break;
      try {
        for (const line of fs.readFileSync(envf, 'utf8').split(/\r?\n/)) {
          const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/);
          if (m) { url = m[1]; break; }
        }
      } catch (_) {}
    }
    if (!url) throw new Error('DATABASE_URL nao achado');
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const q = async (sql, p) => pool.query(sql, p);
      const c1 = (await q("SELECT COUNT(*)::int AS c FROM messages WHERE send_state = 'queued'")).rows[0].c;
      if (c1 > 0) {
        try { await q("UPDATE messages SET send_state = 'failed' WHERE send_state = 'queued'"); ok(c1 + " msg(s) queued -> failed"); }
        catch { await q("DELETE FROM messages WHERE send_state = 'queued'"); ok(c1 + ' msg(s) queued DELETADAS'); }
      } else ok('fila de saida ja vazia');
      const c2 = (await q("SELECT COUNT(*)::int AS c FROM kimiwork_inbox WHERE status IN ('pending','processing')")).rows[0].c;
      if (c2 > 0) {
        await q("UPDATE kimiwork_inbox SET status = 'done', processed_at = now(), result = COALESCE(result, '{}'::jsonb) || '{\"drained\":true}' WHERE status IN ('pending','processing')");
        ok('kimiwork_inbox: ' + c2 + ' pendente(s) zerado(s)');
      } else ok('kimiwork_inbox ja vazio');
    } finally { await pool.end(); }
  } catch (e) { fail('zerar filas: ' + e.message); }

  console.log('');
  console.log('=== restart ===');
  const run = (fullCmd) => {
    try { execFileSync('cmd.exe', ['/c', fullCmd], { stdio: 'pipe' }); return true; } catch { return false; }
  };
  if (run('pm2 restart all')) ok('pm2 restart all');
  else if (run('pm2 restart luna-orchestrator')) ok('pm2 restart luna-orchestrator');
  else fail('nao consegui reiniciar — roda manual: pm2 restart all');
  console.log('');
  console.log('=== FIM ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
