#!/usr/bin/env node
/**
 * fix-registry-amorzinho.js — desbloqueia "Meu Amorzinho" no chat_registry
 * (role blocked -> allowed) pra liberar msg/call. Mostra a row completa
 * antes/depois pra conferir se tem telefone (call precisa de numero).
 */
const fs = require('fs');
const path = require('path');
const AGENT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';

(async function main() {
  let pg = null;
  try { pg = require(path.join(AGENT, 'node_modules', 'pg')); } catch { }
  if (!pg) { console.log('[FAIL] pg nao achado'); process.exit(1); }
  let url = process.env.DATABASE_URL || '';
  for (const envf of [path.join(AGENT, '.env'), path.join(AGENT, 'apps', 'orchestrator', '.env')]) {
    if (url) break;
    try {
      for (const line of fs.readFileSync(envf, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/);
        if (m) { url = m[1]; break; }
      }
    } catch { }
  }
  if (!url) { console.log('[FAIL] DATABASE_URL nao achado'); process.exit(1); }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const before = await pool.query(
      `SELECT * FROM chat_registry WHERE canonical_name ILIKE '%amor%' OR chat_key ILIKE '%amor%'`);
    console.log('=== ANTES ===');
    for (const r of before.rows) console.log(JSON.stringify(r));
    const upd = await pool.query(
      `UPDATE chat_registry SET role = 'allowed'
       WHERE canonical_name ILIKE '%amor%' OR chat_key ILIKE '%amor%'`);
    console.log('');
    console.log('[OK] role -> allowed (' + upd.rowCount + ' row)');
    const after = await pool.query(
      `SELECT * FROM chat_registry WHERE canonical_name ILIKE '%amor%'`);
    console.log('=== DEPOIS ===');
    for (const r of after.rows) console.log(JSON.stringify(r));
    const key = after.rows[0] && String(after.rows[0].chat_key || '');
    if (key.indexOf('blocked') !== -1 || !/^\d{6,}/.test(key)) {
      console.log('');
      console.log('[AVISO] chat_key parece placeholder (' + key + '). Se a call falhar com');
      console.log('"destino sem registro", me passa o numero dela que eu corrijo a key.');
    }
  } finally { await pool.end(); }
  console.log('=== FIM — testa: manda a Luna ligar pra ela ===');
})().catch((e) => { console.error('[FAIL] ' + (e && e.message || e)); process.exit(1); });
