#!/usr/bin/env node
/* fix-v16-18b-group-registry.js — v16.18b (owner 21/10)
   Fonte correta do nome/jid do grupo: messages (contact_name +
   conversation_chat_id) — metadata das conversations não guarda chat_name.
   Seed do 🏆Production no chat_registry + lista demais grupos (decisão do owner). */
const fs = require('fs');
const path = require('path');
const KERNEL_DIR = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const AGENT_DIR = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';

(async () => {
try {
  let url = null;
  for (const ef of [path.join(AGENT_DIR, '.env'), path.join(AGENT_DIR, 'apps', 'whatsplay', '.env'), path.join(KERNEL_DIR, '.env')]) {
    try { const m = fs.readFileSync(ef, 'utf8').match(/^(?:DATABASE_URL|LUNA_DATABASE_URL)=(.+)$/m); if (m) { url = m[1].trim().replace(/^["']|["']$/g, ''); break; } } catch (_) {}
  }
  let pg = null;
  for (const c of [process.env.LUNA_KERNEL_PG_PATH, path.join(KERNEL_DIR, 'apps', 'dashboard', 'node_modules', 'pg')]) {
    if (c) { try { pg = require(c); break; } catch (_) {} }
  }
  if (!url || !pg) { console.log('[FAIL] url/pg não achados'); process.exit(1); }
  const pool = new pg.Pool({ connectionString: url });

  const g = await pool.query(
    `SELECT DISTINCT contact_name AS n, conversation_chat_id AS cid
     FROM messages
     WHERE conversation_chat_id LIKE '%@g.us' AND NULLIF(contact_name,'') IS NOT NULL
     ORDER BY 1 LIMIT 30`
  ).catch(e => ({ err: e.message }));
  if (g.err) { console.log('[FAIL] ' + g.err.slice(0, 200)); await pool.end(); process.exit(1); }
  if (!g.rows.length) { console.log('[FAIL] nenhum grupo em messages — o WA harvester nunca indexou grupos. Cola o erro e a gente vai pelo caminho do whatsappAllowContact.'); await pool.end(); process.exit(1); }

  console.log('=== grupos vistos em messages ===');
  for (const r of g.rows) console.log('  ' + r.n + '  (' + r.cid + ')');

  const prod = g.rows.find(r => /production/i.test(r.n));
  if (!prod) { console.log('[FAIL] Production não está entre os grupos vistos — me fala o nome exato'); await pool.end(); process.exit(1); }

  const ins = await pool.query(
    `INSERT INTO chat_registry (chat_key, canonical_name, kind, role)
     VALUES ($1, $2, 'group', 'allowed') ON CONFLICT DO NOTHING RETURNING canonical_name`,
    [prod.cid, prod.n]
  ).catch(e => ({ err: e.message }));
  if (ins.err) console.log('[AVISO] seed: ' + ins.err.slice(0, 250));
  else console.log('[OK] registry: "' + prod.n + '" com role=allowed' + (ins.rows && ins.rows.length ? '' : ' (já existia)'));

  const inReg = await pool.query(`SELECT canonical_name FROM chat_registry WHERE kind='group'`).catch(() => ({ rows: [] }));
  const regNames = new Set(inReg.rows.map(r => r.canonical_name));
  console.log('=== demais grupos SEM registry (decisão tua — me fala quais liberar) ===');
  for (const r of g.rows.filter(x => !regNames.has(x.n))) console.log('  - ' + r.n);

  await pool.end().catch(() => {});
  console.log('');
  console.log('=== FIM v16.18b — teste: msg no grupo -> resposta NO GRUPO ===');
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }
})();
