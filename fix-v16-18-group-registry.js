#!/usr/bin/env node
/* fix-v16-18-group-registry.js — v16.18 (owner 21/10)
   Grupo 🏆Production entra no chat_registry (kind=group, role=allowed) pra
   resolveTarget achar por nome e o guardrail liberar. Jid vem da própria
   tabela conversations (mesma fonte que o deliverOne usa). Demais grupos
   são LISTADOS sem liberar — quem decide allow é o owner (decreto). */
const fs = require('fs');
const path = require('path');

const KERNEL_DIR = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const AGENT_DIR = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const WT = KERNEL_DIR + '\\packages\\kernel\\whatsapp-tools.cjs';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

(async () => {
try {
  // sanity: teu resolveTarget local consulta chat_registry?
  const wt = fs.readFileSync(WT, 'utf8');
  const hits = wt.split('chat_registry').length - 1;
  if (hits < 2) {
    console.log('[FAIL] teu whatsapp-tools.cjs local NÃO consulta chat_registry (' + hits + 'x) — o resolveTarget local diverge do remoto. Cola ele que eu patcho a resolução antes do seed adiantar algo.');
    process.exit(1);
  }
  console.log('[OK] sanity: resolveTarget local consulta chat_registry (' + hits + 'x) — falta só o dado');

  // conexão (mesma lógica do v16.17)
  let url = null;
  for (const ef of [path.join(AGENT_DIR, '.env'), path.join(AGENT_DIR, 'apps', 'whatsplay', '.env'), path.join(KERNEL_DIR, '.env')]) {
    try {
      const m = fs.readFileSync(ef, 'utf8').match(/^(?:DATABASE_URL|LUNA_DATABASE_URL)=(.+)$/m);
      if (m) { url = m[1].trim().replace(/^["']|["']$/g, ''); break; }
    } catch (_) {}
  }
  if (!url) { console.log('[FAIL] DATABASE_URL não achada'); process.exit(1); }
  let pg = null;
  for (const c of [process.env.LUNA_KERNEL_PG_PATH, path.join(KERNEL_DIR, 'apps', 'dashboard', 'node_modules', 'pg')]) {
    if (c) { try { pg = require(c); break; } catch (_) {} }
  }
  if (!pg) { console.log('[FAIL] módulo pg não achado'); process.exit(1); }
  const pool = new pg.Pool({ connectionString: url });

  // 1) acha o jid do grupo Production nas conversations
  const g = await pool.query(
    `SELECT metadata->>'chat_id' AS cid, metadata->>'chat_name' AS cname
     FROM conversations
     WHERE metadata->>'chat_name' LIKE '%Production%' AND NULLIF(metadata->>'chat_id','') IS NOT NULL
     ORDER BY updated_at DESC NULLS LAST LIMIT 3`
  ).catch(e => ({ err: e.message }));
  if (g.err) { console.log('[FAIL] query conversations: ' + g.err.slice(0, 200)); await pool.end(); process.exit(1); }
  if (!g.rows.length) { console.log('[FAIL] grupo Production não achado em conversations — cola: SELECT metadata->>\'chat_name\' FROM conversations LIMIT 10'); await pool.end(); process.exit(1); }
  const row = g.rows[0];
  console.log('[OK] grupo achado: "' + row.cname + '" jid=' + row.cid);

  // 2) seed no registry (idempotente)
  const ins = await pool.query(
    `INSERT INTO chat_registry (chat_key, canonical_name, kind, role)
     VALUES ($1, $2, 'group', 'allowed') ON CONFLICT DO NOTHING RETURNING canonical_name`,
    [row.cid.includes('@') ? row.cid : row.cid + '@g.us', row.cname]
  ).catch(e => ({ err: e.message }));
  if (ins.err) { console.log('[AVISO] seed falhou: ' + ins.err.slice(0, 250) + ' — me cola o erro'); }
  else console.log('[OK] registry: grupo com role=allowed' + (ins.rows && ins.rows.length ? '' : ' (já existia)'));

  // 3) lista os demais grupos pra DECISÃO do owner (sem liberar nada)
  const others = await pool.query(
    `SELECT DISTINCT metadata->>'chat_name' AS n, metadata->>'chat_id' AS cid
     FROM conversations
     WHERE NULLIF(metadata->>'chat_name','') IS NOT NULL AND NULLIF(metadata->>'chat_id','') IS NOT NULL
     ORDER BY 1 LIMIT 30`
  ).catch(() => ({ rows: [] }));
  const inReg = await pool.query(`SELECT canonical_name FROM chat_registry WHERE kind='group'`).catch(() => ({ rows: [] }));
  const regNames = new Set(inReg.rows.map(r => r.canonical_name));
  const pendentes = others.rows.filter(r => !regNames.has(r.n));
  console.log('[INFO] grupos em conversations SEM registry (decisão tua, um a um ou em lote):');
  for (const p of pendentes.slice(0, 15)) console.log('   - ' + p.n + '  (' + p.cid + ')');

  await pool.end().catch(() => {});
  console.log('');
  console.log('=== FIM v16.18 — sem restart: a resolução consulta o registry ao vivo ===');
  console.log('=== Teste: manda msg no grupo -> ela deve responder NO GRUPO agora ===');
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }
})();
