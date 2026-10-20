#!/usr/bin/env node
/**
 * luna-diag17.js — onde a duplicação começa (owner 20/10)
 * Imprime: eventos whatsapp recebidos duplicados, inbound duplicados na
 * messages, e outbounds recentes com timestamps. Só leitura.
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
    console.log('=== A) eventos whatsapp.message.received duplicados (ultimas 3h) ===');
    try {
      const r = await pool.query(`
        SELECT left(payload->>'text', 50) AS texto, COUNT(*)::int AS n,
               string_agg(to_char(created_at, 'HH24:MI:SS'), ', ' ORDER BY created_at) AS horarios
        FROM events
        WHERE event_type = 'whatsapp.message.received'
          AND created_at > now() - interval '3 hours'
        GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 10`);
      if (!r.rows.length) console.log('  (nenhum evento duplicado)');
      for (const row of r.rows) console.log('  ' + row.n + 'x  [' + row.horarios + ']  ' + row.texto);
    } catch (e) { console.log('  (tabela events indisponivel: ' + e.message.slice(0, 80) + ')'); }

    console.log('');
    console.log('=== B) inbound duplicados na messages (ultimas 3h) ===');
    const b = await pool.query(`
      SELECT left(body, 50) AS texto, COUNT(*)::int AS n,
             string_agg(to_char(created_at, 'HH24:MI:SS'), ', ' ORDER BY created_at) AS horarios
      FROM messages
      WHERE direction = 'inbound' AND created_at > now() - interval '3 hours'
      GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 10`);
    if (!b.rows.length) console.log('  (nenhum inbound duplicado)');
    for (const row of b.rows) console.log('  ' + row.n + 'x  [' + row.horarios + ']  ' + row.texto);

    console.log('');
    console.log('=== C) ultimas 12 outbound (hora, len, inicio) ===');
    const c = await pool.query(`
      SELECT to_char(created_at, 'HH24:MI:SS') AS h, length(body) AS len,
             left(body, 45) AS ini, send_state
      FROM messages WHERE direction = 'outbound'
      ORDER BY created_at DESC LIMIT 12`);
    for (const row of c.rows) console.log('  ' + row.h + '  len=' + row.len + '  [' + row.send_state + ']  ' + row.ini.replace(/\n/g, ' '));
  } finally {
    await pool.end();
  }
  console.log('=== FIM ===');
})().catch((e) => { console.error('[FAIL] ' + (e && e.message || e)); process.exit(1); });
