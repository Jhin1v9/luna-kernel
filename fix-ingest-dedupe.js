#!/usr/bin/env node
/**
 * fix-ingest-dedupe.js — v16.6 (decreto owner 20/10)
 *
 * Diagnóstico (luna-diag17): mesma msg do zap virou 2 inbound na messages
 * (19:44:36 e 19:49:29 — reconcile re-ingeriu não-lida 5min depois). Causa:
 * external_id é base64(author|text) e os caminhos (preview diff vs reconcile)
 * montam formatos diferentes (watcher.ts:351 sem chat_id vs :471/:521 com),
 * então o dedupe §7.6 por external_id falha entre caminhos. Cada duplicata
 * virava evento novo -> turno novo -> re-sweep pegava a resposta do turno
 * anterior -> outbounds em cascata + streams concorrentes na aba (garble).
 *
 * Fix: safety net no ingest.ts — corpo igual na MESMA conversa em janela de
 * 15min = a mesma mensagem, skip independente de external_id.
 * Aplica em TODAS as copias de apps/whatsplay/src/ingest.ts em Documents.
 * Seguro: backup, idempotente (marker v16.6-fix), restart luna-whatsplay.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DOCS = 'C:\\Users\\Abner\\Documents';
function ok(m) { console.log('[OK] ' + m); }
function warn(m) { console.log('[AVISO] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); }
function bak(f) {
  const b = f + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(f, b);
  return b;
}
function* walk(dir, depth) {
  if (depth > 7) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (['node_modules', '.git', '.next', 'coverage'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, depth + 1);
    else if (e.name === 'ingest.ts' && full.includes('whatsplay')) yield full;
  }
}

(async function main() {
  let patched = 0;
  for (const file of walk(DOCS, 0)) {
    try {
      const src = fs.readFileSync(file, 'utf8');
      if (src.includes('v16.6-fix')) { ok('ja aplicado: ' + file); patched++; continue; }
      const anchor = '    const messageId = await insertInboundMessage(pool, {';
      if (src.split(anchor).length - 1 !== 1) { warn('anchor nao bate 1x: ' + file); continue; }
      const NL = src.includes('\r\n') ? '\r\n' : '\n';
      const block = [
        '    // v16.6-fix (owner 20/10): safety net anti-duplicata — external_id é',
        '    // base64(author|text) e os caminhos (preview diff vs reconcile) montam',
        '    // formatos diferentes; corpo igual na mesma conversa em 15min = mesma',
        '    // mensagem. Skip independente de external_id.',
        '    const dupBodyNet = await pool.query<{ id: string }>(',
        '      `SELECT id FROM messages',
        "       WHERE conversation_id = $1 AND direction = 'inbound'",
        "         AND body = $2 AND created_at > now() - interval '15 minutes'",
        '       LIMIT 1`,',
        '      [identity.conversation_id, effectiveText],',
        '    );',
        '    if (dupBodyNet.rowCount) {',
        "      log.info({ external_id: msg.external_id }, 'mensagem duplicada por conteúdo — ignorada (v16.6)');",
        "      return 'skipped';",
        '    }',
        '',
      ].join(NL);
      const out = src.replace(anchor, block + anchor);
      // validação leve: balanceamento de chaves/parênteses no trecho inserido
      const seg = block;
      if (seg.split('{').length !== seg.split('}').length || seg.split('(').length !== seg.split(')').length) {
        warn('bloco desbalanceado — pulado: ' + file);
        continue;
      }
      const b = bak(file);
      fs.writeFileSync(file, out, 'utf8');
      ok('aplicado: ' + file);
      ok('   backup: ' + path.basename(b));
      patched++;
    } catch (e) { warn('erro em ' + file + ': ' + e.message); }
  }
  if (!patched) { fail('nenhum ingest.ts patchiado'); }
  console.log('');
  console.log('=== restart ===');
  const run = (c) => { try { execFileSync('cmd.exe', ['/c', c], { stdio: 'pipe' }); return true; } catch { return false; } };
  if (run('pm2 restart luna-whatsplay')) ok('luna-whatsplay reiniciado');
  else warn('restart manual: pm2 restart luna-whatsplay');
  console.log('=== FIM — se o whatsplay crashar em loop, pm2 logs luna-whatsplay ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
