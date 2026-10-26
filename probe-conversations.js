#!/usr/bin/env node
/* probe-conversations.js — inspeciona estrutura real da tabela conversations
   pra achar onde o nome/jid do grupo mora. Somente leitura. */
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
  const pool = new pg.Pool({ connectionString: url });

  const cols = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='conversations' ORDER BY ordinal_position`);
  console.log('=== colunas de conversations ===');
  for (const c of cols.rows) console.log('  ' + c.column_name + ' : ' + c.data_type);

  const keys = await pool.query(`SELECT DISTINCT jsonb_object_keys(metadata) AS k FROM conversations WHERE metadata IS NOT NULL LIMIT 40`);
  console.log('=== chaves de metadata ===');
  console.log('  ' + keys.rows.map(r => r.k).join(', '));

  const sample = await pool.query(`SELECT * FROM conversations ORDER BY updated_at DESC NULLS LAST LIMIT 3`);
  console.log('=== 3 rows recentes (truncado) ===');
  for (const r of sample.rows) {
    const s = JSON.stringify(r);
    console.log('  ' + s.slice(0, 600));
  }

  const prod = await pool.query(`SELECT * FROM conversations WHERE metadata::text LIKE '%Production%' LIMIT 2`);
  console.log('=== rows com "Production" no metadata (' + prod.rows.length + ') ===');
  for (const r of prod.rows) {
    const s = JSON.stringify(r);
    console.log('  ' + s.slice(0, 900));
  }

  await pool.end().catch(() => {});
} catch (e) { console.log('[FAIL] ' + e.message); }
})();
