#!/usr/bin/env node
/**
 * luna-diag18.js — quem esta no Chat Registry (voice calls)
 * Lista tabelas candidatas (registry/chat/contact/voice) e dump das linhas.
 * So leitura.
 */
const fs = require('fs');
const path = require('path');
const AGENT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';

(async function main() {
  let pg = null;
  try { pg = require(path.join(AGENT, 'node_modules', 'pg')); } catch { }
  if (!pg) { console.log('[FAIL] pg nao achado'); process.exit(1); }
  let url = process.env.DATABASE_URL || '';
  for (const envf of [path.join(AGENT, '.env'), path.join(AGENT, 'apps', 'orchestrator', '.env'), path.join(AGENT, 'apps', 'whatsplay', '.env')]) {
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
    const t = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND (table_name ILIKE '%registry%' OR table_name ILIKE '%chat%' OR table_name ILIKE '%contact%' OR table_name ILIKE '%voice%' OR table_name ILIKE '%allow%')
       ORDER BY table_name`);
    console.log('=== tabelas candidatas ===');
    if (!t.rows.length) console.log('(nenhuma — registry pode ser arquivo/env, nao tabela)');
    for (const r of t.rows) {
      console.log('  - ' + r.table_name);
      try {
        const rows = await pool.query(`SELECT * FROM ${r.table_name} ORDER BY 1 DESC LIMIT 12`);
        for (const row of rows.rows) {
          const s = JSON.stringify(row);
          console.log('      ' + (s.length > 160 ? s.slice(0, 160) + '…' : s));
        }
      } catch (e) { console.log('      (erro: ' + e.message.slice(0, 60) + ')'); }
    }
    // busca direta pela namorada em qualquer coluna de texto
    console.log('');
    console.log('=== busca por "Amorinho" em todas as tabelas ===');
    for (const r of t.rows) {
      try {
        const cols = await pool.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name=$1 AND data_type IN ('text','character varying','character')`, [r.table_name]);
        for (const c of cols.rows) {
          const hit = await pool.query(
            `SELECT * FROM ${r.table_name} WHERE ${c.column_name}::text ILIKE '%amorinho%' LIMIT 3`);
          for (const row of hit.rows) console.log('  [' + r.table_name + '.' + c.column_name + '] ' + JSON.stringify(row).slice(0, 200));
        }
      } catch { }
    }
  } finally { await pool.end(); }
  console.log('=== FIM ===');
})().catch((e) => { console.error('[FAIL] ' + (e && e.message || e)); process.exit(1); });
