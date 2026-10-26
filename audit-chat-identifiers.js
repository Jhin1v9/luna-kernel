#!/usr/bin/env node
/* audit-chat-identifiers.js — mapeia TODOS os identificadores de chat em uso
   (pra unificacao arquitetural). So leitura.
   Mostra: o que cada sistema usa (kernel, whatsplay, WA), e onde divergem. */
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

  // 1) chat_registry — o que o kernel usa pra responder
  console.log('=== 1. chat_registry (kernel RESPONDE por aqui) ===');
  const reg = await pool.query(`SELECT chat_key, canonical_name, kind, role FROM chat_registry ORDER BY kind, canonical_name`).catch(() => ({ rows: [] }));
  for (const r of reg.rows) console.log('  [' + (r.role === 'allowed' ? 'OK' : '  ') + '] ' + r.kind.padEnd(10) + ' ' + r.chat_key.padEnd(40) + ' | ' + r.canonical_name);
  console.log('  total: ' + reg.rows.length);

  // 2) messages — o que o kernel usa pra LER (chat_id real nas mensagens)
  console.log('=== 2. messages (kernel LÊ por aqui — chat_id real) ===');
  const msgs = await pool.query(`SELECT DISTINCT metadata->>'chat_id' as chat_id, metadata->>'chat_name' as chat_name FROM messages WHERE metadata->>'chat_id' IS NOT NULL ORDER BY 2 LIMIT 20`).catch(() => ({ rows: [] }));
  if (msgs.rows.length) {
    for (const m of msgs.rows) console.log('  ' + String(m.chat_id).padEnd(40) + ' | ' + m.chat_name);
  } else {
    console.log('  (metadata->>chat_id vazio — tentando external_id)');
    const ext = await pool.query(`SELECT DISTINCT external_id FROM messages WHERE external_id IS NOT NULL AND external_id != '' LIMIT 20`).catch(() => ({ rows: [] }));
    for (const e of ext.rows) console.log('  ' + e.external_id);
  }

  // 3) divergencia: registry chat_key vs messages chat_id
  console.log('=== 3. DIVERGENCIA (registry chat_key vs messages chat_id) ===');
  const regKeys = new Set(reg.rows.map(r => r.chat_key));
  const msgIds = new Set(msgs.rows.map(m => String(m.chat_id)));
  const inRegNotMsg = [...regKeys].filter(k => !msgIds.has(k));
  const inMsgNotReg = [...msgIds].filter(i => !regKeys.has(i));
  if (inRegNotMsg.length) { console.log('  no registry, NAO em messages:'); inRegNotMsg.forEach(k => console.log('    ' + k)); }
  if (inMsgNotReg.length) { console.log('  em messages, NAO no registry:'); inMsgNotReg.forEach(i => console.log('    ' + i)); }
  if (!inRegNotMsg.length && !inMsgNotReg.length) console.log('  (ok — convergem)');

  // 4) conversations — se existir
  console.log('=== 4. conversations (se existir) ===');
  const conv = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='conversations'`).catch(() => ({ rows: [] }));
  if (conv.rows.length) {
    console.log('  colunas: ' + conv.rows.map(c => c.column_name).join(', '));
    const convData = await pool.query(`SELECT * FROM conversations LIMIT 3`).catch(() => ({ rows: [] }));
    convData.rows.forEach(r => console.log('  ' + JSON.stringify(r).slice(0, 150)));
  } else {
    console.log('  (tabela nao existe)');
  }

  await pool.end().catch(() => {});
  console.log('');
  console.log('=== FIM auditoria de identificadores. So leitura. ===');
} catch (e) { console.log('[FAIL] ' + e.message); }
})();
