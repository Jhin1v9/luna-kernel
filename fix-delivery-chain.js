#!/usr/bin/env node
/**
 * fix-delivery-chain.js — v16.3 (owner 20/10)
 *
 * A) config.ts: adiciona 'kimi-web-local' (e 'kimi-cli') no enum do
 *    KIMI_ADAPTER_MODE — valor existia no .env mas nao no schema zod =>
 *    whatsplay crashava em loop no boot (ZodError, 182 restarts).
 * B) outbound.ts: CADEIA de entrega — 1 msg por vez na pagina. Dois NOTIFYs
 *    juntos disparavam dois deliverOne concurrentes digitando no mesmo
 *    campo (evidencia no log: 'busca nao bateu obtido: +34...ando normalme',
 *    msgs de 1 char, texto de resposta caindo na busca).
 * C) Zera filas (messages queued + kimiwork_inbox pending).
 * D) Restart pm2 (cmd.exe fallback).
 * Seguro: backup, falha avisando por fase, idempotente (marker v16.3-fix).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const AGENT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const CONFIG = path.join(AGENT, 'packages', 'shared', 'src', 'config.ts');
const OUTBOUND = path.join(AGENT, 'apps', 'whatsplay', 'src', 'outbound.ts');

function ok(m) { console.log('[OK] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); }
function bak(f) {
  const b = f + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(f, b);
  return b;
}

(async function main() {
  /* ---------- A) enum ---------- */
  console.log('=== A: config.ts (enum kimi-web-local) ===');
  try {
    let src = fs.readFileSync(CONFIG, 'utf8');
    if (src.includes('kimi-web-local')) {
      ok('A ja aplicado');
    } else {
      const a = "z.enum(['mock', 'kimi-web', 'kimi-api', 'gemini', 'kimiwork', 'roda', 'fcc', 'pi'])";
      if (src.split(a).length - 1 !== 1) throw new Error('anchor enum ' + (src.split(a).length - 1) + 'x');
      src = src.replace(a, "z.enum(['mock', 'kimi-web', 'kimi-web-local', 'kimi-cli', 'kimi-api', 'gemini', 'kimiwork', 'roda', 'fcc', 'pi'])");
      const b = bak(CONFIG);
      fs.writeFileSync(CONFIG, src, 'utf8');
      ok('enum atualizado — whatsplay nao crasha mais no boot');
      ok('backup: ' + path.basename(b));
    }
  } catch (e) { fail('A: ' + e.message); }

  /* ---------- B) cadeia de entrega ---------- */
  console.log('');
  console.log('=== B: outbound.ts (cadeia 1-por-vez) ===');
  try {
    let src = fs.readFileSync(OUTBOUND, 'utf8');
    if (src.includes('v16.3-fix')) {
      ok('B ja aplicado');
    } else {
      const def = '  async function deliverOne(messageId: string): Promise<void> {';
      if (src.split(def).length - 1 !== 1) throw new Error('anchor def ' + (src.split(def).length - 1) + 'x');
      const NL = src.includes('\r\n') ? '\r\n' : '\n';
      const chain = [
        '  // v16.3-fix (owner 20/10): CADEIA de entrega — 1 msg por vez na pagina.',
        '  // Dois NOTIFYs juntos disparavam deliverOne concurrentes digitando no',
        '  // mesmo campo (busca/composer corrompidos, msgs de 1 char, texto de',
        '  // resposta caindo na busca do numero). Toda entrega passa por deliverQueued.',
        '  let deliverChain: Promise<void> = Promise.resolve();',
        '  function deliverQueued(messageId: string): void {',
        '    deliverChain = deliverChain',
        '      .then(() => deliverOne(messageId))',
        "      .catch((err) => log.error({ err }, 'entrega falhou'));",
        '  }',
        '',
      ].join(NL) + def;
      src = src.replace(def, chain);
      const sites = [
        ["      if (n.payload) deliverOne(n.payload).catch((err) => log.error({ err }, 'entrega falhou'));",
         '      if (n.payload) deliverQueued(n.payload);'],
        ["      deliverOne(row.id).catch((err) => log.error({ err }, 'entrega falhou'));",
         '      deliverQueued(row.id);'],
        ["          deliverOne(messageId).catch((e2: unknown) => log.error({ err: e2 }, 'retry de entrega falhou'));",
         '          deliverQueued(messageId);'],
      ];
      for (const [o, n] of sites) {
        if (src.split(o).length - 1 !== 1) throw new Error('anchor site nao bate 1x: ' + o.slice(0, 50));
        src = src.replace(o, n);
      }
      const b = bak(OUTBOUND);
      fs.writeFileSync(OUTBOUND, src, 'utf8');
      ok('cadeia aplicada — entregas 1 por vez');
      ok('backup: ' + path.basename(b));
    }
  } catch (e) { fail('B: ' + e.message); }

  /* ---------- C) zera filas ---------- */
  console.log('');
  console.log('=== C: zera filas ===');
  try {
    let pg = null;
    for (const base of [path.join(AGENT, 'node_modules', 'pg')]) {
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
      } else ok('fila de saida vazia');
      const c2 = (await q("SELECT COUNT(*)::int AS c FROM kimiwork_inbox WHERE status IN ('pending','processing')")).rows[0].c;
      if (c2 > 0) {
        await q("UPDATE kimiwork_inbox SET status = 'done', processed_at = now(), result = COALESCE(result, '{}'::jsonb) || '{\"drained\":true}' WHERE status IN ('pending','processing')");
        ok('kimiwork_inbox: ' + c2 + ' zerado(s)');
      } else ok('kimiwork_inbox vazio');
    } finally { await pool.end(); }
  } catch (e) { fail('C: ' + e.message); }

  /* ---------- D) restart ---------- */
  console.log('');
  console.log('=== D: restart ===');
  const run = (c) => { try { execFileSync('cmd.exe', ['/c', c], { stdio: 'pipe' }); return true; } catch { return false; } };
  if (run('pm2 restart all')) ok('pm2 restart all');
  else fail('restart manual: pm2 restart all');
  console.log('=== FIM ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
