#!/usr/bin/env node
/* audit-whatsplay-groups.js — auditoria completa de dados de GRUPOS no
   whatsplay vs brain (owner 21/10). So leitura. Nao altera nada. */
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

  // 1) chat_registry — grupos conhecidos
  const reg = await pool.query(`SELECT chat_key, canonical_name, kind, role FROM chat_registry WHERE kind = 'group' ORDER BY canonical_name`).catch(e => ({ err: e.message, rows: [] }));
  console.log('=== 1. chat_registry (grupos) ===');
  if (reg.err) console.log('  ERRO: ' + reg.err.slice(0, 150));
  else if (!reg.rows.length) console.log('  (vazio — nenhum grupo no registry)');
  else for (const r of reg.rows) console.log('  ' + (r.role === 'allowed' ? '[ALLOWED]' : '[       ]') + ' ' + r.canonical_name + '  (' + r.chat_key + ')');

  // 2) wa_group_members — membros por grupo
  const mem = await pool.query(`SELECT chat_id, count(*) as n FROM wa_group_members GROUP BY chat_id ORDER BY n DESC`).catch(e => ({ err: e.message, rows: [] }));
  console.log('=== 2. wa_group_members (contagem) ===');
  if (mem.err) console.log('  ERRO: ' + mem.err.slice(0, 150));
  else if (!mem.rows.length) console.log('  (vazio — nenhum membro harvestado)');
  else for (const r of mem.rows) console.log('  ' + r.chat_id + ': ' + r.n + ' membros');

  // 3) conversations — grupos vistos em mensagens
  const conv = await pool.query(`SELECT DISTINCT contact_name, conversation_chat_id FROM messages WHERE conversation_chat_id LIKE '%@g.us' AND NULLIF(contact_name,'') IS NOT NULL ORDER BY 1`).catch(e => ({ err: e.message, rows: [] }));
  console.log('=== 3. messages (grupos que trocaram msg) ===');
  if (conv.err) console.log('  ERRO: ' + conv.err.slice(0, 150));
  else if (!conv.rows.length) console.log('  (nenhum grupo em messages)');
  else for (const r of conv.rows) console.log('  ' + r.contact_name + '  (' + r.conversation_chat_id + ')');

  // 4) divergencia: registry vs messages
  const regNames = new Set((reg.rows || []).map(r => r.canonical_name));
  const msgNames = (conv.rows || []).map(r => r.contact_name);
  const onlyInMsg = msgNames.filter(n => !regNames.has(n) && ![...regNames].some(rn => rn.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim() === n.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim()));
  console.log('=== 4. DIVERGENCIAS (em messages, NAO no registry) ===');
  if (onlyInMsg.length) for (const n of onlyInMsg) console.log('  ! ' + n + ' — precisa whatsappAllowContact ou harvest');
  else console.log('  (ok — todos os grupos de messages estao no registry)');

  await pool.end().catch(() => {});
  console.log('');
  console.log('=== FIM auditoria. So leitura, nada alterado. ===');
} catch (e) { console.log('[FAIL] ' + e.message); }
})();
