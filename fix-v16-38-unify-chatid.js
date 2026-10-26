#!/usr/bin/env node
/* v16.38 — unifica RESPOSTA no mesmo chat_id que LEITURA usa.
   LEITURA: messages.metadata->>'chat_id' (solido, NAO TOCA).
   RESPOSTA: resolveTarget resolvia so pelo registry (nome canônico, falhava
   com emoji). Fix: consulta messages PRIMEIRO (fonte da leitura) — achou o
   nome la, usa o chat_id de la. Nao achou, cai no registry (atual). */
const fs = require('fs');
const { spawn } = require('child_process');

const WT = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\whatsapp-tools.cjs';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const MARK = 'v16.38-fix';

try {
  let src = fs.readFileSync(WT, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] ja aplicado'); process.exit(0); }

  // anchor: logo apos a funcao resolveTarget abrir, antes do primeiro q (registry)
  const anchor = /const n = normName\(raw\)\.toLowerCase\(\);\s*\n\s*const groups = await q\(/;
  const m = src.match(anchor);
  if (!m || src.match(anchor).length !== 1) { console.log('[FAIL] anchor ' + (m ? src.match(anchor).length : 0) + 'x'); process.exit(1); }

  src = src.replace(anchor,
    "const n = normName(raw).toLowerCase();\n" +
    "  // " + MARK + " (owner 21/10): unifica RESPOSTA no chat_id que LEITURA usa.\n" +
    "  // Consulta messages PRIMEIRO (fonte da leitura, solida) — achou o nome\n" +
    "  // la, usa o chat_id de la (estavel, nao muda com emoji). Nao achou,\n" +
    "  // cai no registry abaixo (comportamento atual, nao quebra).\n" +
    "  try {\n" +
    "    const msgMatch = await q(\n" +
    "      \"SELECT DISTINCT metadata->>'chat_id' as cid FROM messages WHERE lower(metadata->>'chat_name') = $1 OR lower(metadata->>'chat_name') LIKE $2 LIMIT 1\",\n" +
    "      [n, '%' + n + '%']\n" +
    "    );\n" +
    "    if (msgMatch.length && msgMatch[0].cid) {\n" +
    "      const cid = msgMatch[0].cid;\n" +
    "      if (cid.includes('@g.us') || cid.startsWith('group:')) {\n" +
    "        return { chatId: cid, kind: 'group', display: raw };\n" +
    "      }\n" +
    "      const digits = cid.replace(/\\D/g, '');\n" +
    "      if (digits.length >= 8) {\n" +
    "        return { chatId: digits + '@c.us', kind: 'individual', display: raw };\n" +
    "      }\n" +
    "    }\n" +
    "  } catch (_) {}\n" +
    "  const groups = await q(");

  fs.copyFileSync(WT, WT + '.bak-' + ts);
  fs.writeFileSync(WT, src);
  console.log('[OK] resolveTarget: messages primeiro (chat_id da leitura) | backup: whatsapp-tools.cjs.bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.38 ===');
console.log('=== TESTE: msg no grupo -> resolveTarget acha chat_id nas messages (como a leitura) -> whatsplay abre pelo chat_id -> entrega -> result volta ===');
