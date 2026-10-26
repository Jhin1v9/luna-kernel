#!/usr/bin/env node
/* fix-v16-19-classify-gate.js — v16.19 (owner 21/10)
   Acaba com a explosao de abas e o regress do classifier:
   T1 handler (orchestrator): classify SO quando (a) done:true na resposta
      do work (objetivo concluido), (b) cliente real (nao admin), (c) conversa
      nao-meta (nome nao comeca com "WhatsApp" — status/send/allowlist).
      Antes: a CADA evento de msg, de qualquer conversa.
   T2 classify (worker): session_key fixa 'classify:main' — 1 aba so,
      reutilizada (era 1 aba por conversa).
   Spec do owner: 1 aba do chat em questao + 1 aba do classifier quando done:true. */
const fs = require('fs');
const { spawn } = require('child_process');

const HANDLER = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\orchestrator\\src\\agent\\handler.ts';
const CLASSIFY = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\worker\\src\\jobs\\classify.ts';
const MARK = 'v16.19-fix';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
function count(src, a) { return src.split(a).length - 1; }

try {
  let src = fs.readFileSync(HANDLER, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] T1 ja aplicado'); }
  else {
    const a1 = "      if (process.env.LUNA_CLASSIFY_ENABLED === '1') {";
    if (count(src, a1) !== 1) { console.log('[FAIL] T1 anchor ' + count(src, a1) + 'x'); process.exit(1); }
    src = src.replace(a1,
      "      // " + MARK + " (owner 21/10): classifier SO no done:true + cliente real + conversa nao-meta.\n" +
      "      // Antes disparava a cada evento de msg -> spam de abas + regress do classifier.\n" +
      "      const v1619Done = /done\\s*:\\s*true/i.test(decision.answerText ?? '');\n" +
      "      const v1619Client = ((pack as { client_name?: string }).client_name ?? 'admin') !== 'admin';\n" +
      "      const v1619Meta = /^whatsapp/i.test(String(packName ?? ''));\n" +
      "      if (process.env.LUNA_CLASSIFY_ENABLED === '1' && v1619Done && v1619Client && !v1619Meta) {");
    fs.copyFileSync(HANDLER, HANDLER + '.bak-' + ts);
    fs.writeFileSync(HANDLER, src);
    console.log('[OK] T1: gate done:true + cliente real + nao-meta | backup: handler.ts.bak-' + ts);
  }
} catch (e) { console.log('[FAIL] T1: ' + e.message); process.exit(1); }

try {
  let src = fs.readFileSync(CLASSIFY, 'utf8');
  if (src.includes("'classify:main'")) { console.log('[OK] T2 ja aplicado'); }
  else {
    const a1 = '      session_key: `classify:${conversationId}`,';
    if (count(src, a1) !== 1) { console.log('[FAIL] T2 anchor ' + count(src, a1) + 'x'); process.exit(1); }
    src = src.replace(a1, "      session_key: 'classify:main', // " + MARK + ": 1 aba so pro classifier (reutilizada)");
    fs.copyFileSync(CLASSIFY, CLASSIFY + '.bak-' + ts);
    fs.writeFileSync(CLASSIFY, src);
    console.log('[OK] T2: classify:main — 1 aba pro classifier | backup: classify.ts.bak-' + ts);
  }
} catch (e) { console.log('[FAIL] T2: ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-orchestrator'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-worker'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restarts disparados: luna-orchestrator, luna-worker');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.19 — spec: 1 aba work + 1 aba classifier (so no done:true) ===');
console.log('=== TS sem compile aqui: se tsx reclamar no start, cola o erro ===');
