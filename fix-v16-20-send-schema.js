#!/usr/bin/env node
/* fix-v16-20-send-schema.js — v16.20 (owner 21/10)
   T1: whatsappSendMessage entra no tool-registry COM SCHEMA ESTRITO
       (required: to + message). O guard era fail-open: chamadas com "text"
       no lugar de "message" ou destino lixo no-opavam em silencio e o
       modelo dizia "enviei" sem ter enviado. Agora o guard REJEITA e o
       erro volta pra ela corrigir.
   T2: systemPrompt esclarece o campo "to": nome do chat X do cabeçalho
       [chat: X | autor: Y] — NUNCA a palavra "chat" nem o autor Y. */
const fs = require('fs');
const { spawn } = require('child_process');

const REG = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\lib\\tool-registry.cjs';
const CFG = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\config\\luna-prompt-config.json';
const MARK = 'v16.20-fix';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
function count(src, a) { return src.split(a).length - 1; }

// ── T1: schema estrito no registry ──
try {
  let src = fs.readFileSync(REG, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] T1 ja aplicado'); }
  else {
    if (count(src, '"whatsappSendMessage"') !== 0) { console.log('[FAIL] T1: whatsappSendMessage ja existe no registry (formato inesperado)'); process.exit(1); }
    const anchor = '  "computer": {';
    if (count(src, anchor) !== 1) { console.log('[FAIL] T1 anchor ' + count(src, anchor) + 'x'); process.exit(1); }
    const iComp = src.indexOf(anchor);
    const iEnd = src.indexOf('\n};', iComp);
    if (iEnd < 0) { console.log('[FAIL] T1: fim do registry nao achado'); process.exit(1); }
    const entry =
      '\n  // ' + MARK + ' (owner 21/10): schema estrito pro envio — guard era fail-open\n' +
      '  // (calls com "text"/destino lixo no-opavam; modelo dizia "enviei" sem enviar).\n' +
      '  "whatsappSendMessage": {\n' +
      '    schema: {\n' +
      '      required: ["to", "message"],\n' +
      '      types: { to: "string", message: "string" },\n' +
      '    },\n' +
      '    meta: { icon: "💬", color: "#22c55e", label: null },\n' +
      '  },';
    src = src.slice(0, iEnd) + entry + src.slice(iEnd);
    const tmp = require('os').tmpdir() + '\\luna-reg-check.js';
    fs.writeFileSync(tmp, src);
    try { require('child_process').execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
    catch (e) { console.log('[FAIL] T1 sintaxe — NADA escrito'); process.exit(1); }
    finally { try { fs.unlinkSync(tmp); } catch (_) {} }
    fs.copyFileSync(REG, REG + '.bak-' + ts);
    fs.writeFileSync(REG, src);
    console.log('[OK] T1: whatsappSendMessage com schema estrito (to+message obrigatórios) | backup: tool-registry.cjs.bak-' + ts);
  }
} catch (e) { console.log('[FAIL] T1: ' + e.message); process.exit(1); }

// ── T2: esclarecimento do campo "to" no systemPrompt ──
try {
  const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  if (cfg.systemPrompt.includes(MARK)) { console.log('[OK] T2 ja aplicado'); }
  else {
    const marker = '(v16.8-fix)';
    if (count(cfg.systemPrompt, marker) !== 1) { console.log('[FAIL] T2 marker ' + count(cfg.systemPrompt, marker) + 'x'); process.exit(1); }
    const idx = cfg.systemPrompt.indexOf(marker) + marker.length;
    const add = ' No whatsappSendMessage, o campo "to" = o NOME do chat X do cabeçalho [chat: X | autor: Y] (ex.: to: "🏆Production - 2026🙏🏻"). NUNCA use a palavra "chat" nem o nome do autor Y como "to". (' + MARK + ')';
    cfg.systemPrompt = cfg.systemPrompt.slice(0, idx) + add + cfg.systemPrompt.slice(idx);
    const novo = JSON.stringify(cfg, null, 2); JSON.parse(novo);
    fs.copyFileSync(CFG, CFG + '.bak-' + ts);
    fs.writeFileSync(CFG, novo);
    console.log('[OK] T2: campo "to" esclarecido no systemPrompt | backup: luna-prompt-config.json.bak-' + ts);
  }
} catch (e) { console.log('[FAIL] T2: ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.20 ===');
console.log('=== Resta a raiz mae: REENTREGA do tool result. Pra cravar, dispara UMA classificacao e roda: ===');
console.log('=== pm2 logs luna-kernel --lines 300 --nostream | grep -viE "ext/poll|NetworkInterceptor" | grep -iE "LUNA-RESCUE|tool result|truncated|stream error|_sendToolResult|deliver" | tail -40 ===');
