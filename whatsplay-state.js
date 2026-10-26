#!/usr/bin/env node
/* whatsplay-state.js — estado geral do whatsplay: grupos, contatos,
   integrantes, diretório. So leitura. */
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
  for (const c of [path.join(KERNEL_DIR, 'apps', 'dashboard', 'node_modules', 'pg')]) { try { pg = require(c); break; } catch (_) {} }
  if (!url || !pg) { console.log('[FAIL] sem conexao'); process.exit(1); }
  const pool = new pg.Pool({ connectionString: url });

  // schema real
  const cols = async (t) => { try { const r = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`, [t]); return r.rows.map(x => x.column_name); } catch (_) { return []; } };

  console.log('=== GRUPOS (chat_registry) ===');
  const reg = await pool.query(`SELECT chat_key, canonical_name, kind, role FROM chat_registry ORDER BY kind, canonical_name`).catch(() => ({ rows: [] }));
  const groups = reg.rows.filter(r => r.kind === 'group');
  const indivs = reg.rows.filter(r => r.kind === 'individual');
  for (const g of groups) console.log('  [' + (g.role === 'allowed' ? 'OK' : '  ') + '] GRUPO ' + g.canonical_name + '  (' + g.chat_key + ')');
  console.log('  total grupos: ' + groups.length);

  console.log('=== CONTATOS (individual no registry) ===');
  for (const c of indivs.slice(0, 20)) console.log('  [' + (c.role === 'allowed' ? 'OK' : '  ') + '] ' + c.canonical_name + '  (' + c.chat_key + ')');
  console.log('  total contatos: ' + indivs.length);

  // membros — achar tabela/colunas reais
  const memberTables = ['wa_group_members', 'group_members', 'chat_members'];
  let memberInfo = '(tabela de membros nao encontrada)';
  for (const t of memberTables) {
    const c = await cols(t);
    if (c.length) {
      const nameCol = c.find(x => /name|title|subject/i.test(x)) || c[1];
      const count = await pool.query(`SELECT count(*) as n FROM ${t}`).catch(() => ({ rows: [{ n: 0 }] }));
      const sample = await pool.query(`SELECT ${c.join(',')} FROM ${t} LIMIT 5`).catch(() => ({ rows: [] }));
      memberInfo = t + ' (' + c.length + ' cols, ' + count.rows[0].n + ' rows): ' + c.join(',');
      if (sample.rows.length) console.log('=== MEMBROS (amostra ' + t + ') ==='), sample.rows.forEach(r => console.log('  ' + JSON.stringify(r).slice(0, 100)));
      break;
    }
  }
  console.log('=== MEMBROS ===');
  console.log('  ' + memberInfo);

  // diretório do whatsapp (se houver)
  const waTables = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name LIKE '%contact%' OR table_name LIKE '%directory%' OR table_name LIKE '%chat%') ORDER BY 1`).catch(() => ({ rows: [] }));
  console.log('=== TABELAS de contato/chat no banco ===');
  for (const t of waTables.rows) console.log('  ' + t.table_name);

  await pool.end().catch(() => {});
  console.log('');
  console.log('=== FIM estado geral. So leitura. ===');
} catch (e) { console.log('[FAIL] ' + e.message); }
})();
