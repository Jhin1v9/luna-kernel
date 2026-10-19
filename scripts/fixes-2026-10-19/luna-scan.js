#!/usr/bin/env node
/**
 * luna-scan.js — extrai os trechos exatos dos arquivos LOCAIS pra eu
 * gerar os patches certos. NAO modifica nada, so le e imprime.
 *
 * USO:
 *   node luna-scan.js > scan.txt
 * Cola o scan.txt aqui (ou o output direto).
 */
const fs = require('fs');
const path = require('path');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';

function read(rel) {
  const f = path.join(ROOT, ...rel.split('/'));
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8');
}

function show(label, content, regex, before = 0, after = 0) {
  console.log('\n========================================');
  console.log('### ' + label);
  console.log('========================================');
  if (content === null) { console.log('ARQUIVO NAO ENCONTRADO'); return; }
  const lines = content.split('\n');
  const m = content.match(regex);
  if (!m) { console.log('PADRAO NAO ENCONTRADO: ' + regex); return; }
  const idx = content.slice(0, m.index).split('\n').length - 1;
  const start = Math.max(0, idx - before);
  const end = Math.min(lines.length, idx + m[0].split('\n').length + after);
  console.log('--- linhas ' + (start + 1) + ' a ' + end + ' ---');
  for (let i = start; i < end; i++) {
    console.log(String(i + 1).padStart(5) + ' | ' + lines[i]);
  }
}

// ---- content.js ----
const content = read('packages/kernel/luna-extension/content.js');
show('content.js — stopForwarding', content, /function stopForwarding\(\)[\s\S]*?\n  \}/, 0, 2);
show('content.js — flushForwardQueue', content, /function flushForwardQueue\(\)[\s\S]*?\n  \}/, 0, 2);
show('content.js — scheduleForward (inicio)', content, /function scheduleForward\(event\)[\s\S]*?\n    FORWARD_QUEUE\.push\(event\);/, 0, 0);

// ---- background.js ----
const bg = read('packages/kernel/luna-extension/background.js');
show('background.js — criacao do alarme luna-poll', bg, /chrome\.alarms\.create\('luna-poll'[\s\S]*?\}\);/, 6, 2);
show('background.js — routeToTab (inicio)', bg, /async function routeToTab\(payload\)[\s\S]*?\n  [a-z]/, 0, 3);
show('background.js — pollServer (inicio)', bg, /async function pollServer\(\)/, 0, 10);

// ---- luna-soul.cjs ----
const soul = read('packages/kernel/luna-soul.cjs');
show('soul — circuit breaker (cbCount)', soul, /if \(cbCount > 3\)[\s\S]*?\n        \}/, 0, 2);
show('soul — historyLines slice (toolLoop)', soul, /const history = historyLines\.slice[\s\S]*?join\('\\n'\);/, 0, 2);
show('soul — luna_response_complete cancel', soul, /PROTOCOL COMPLETION: Cancel stream immediately[\s\S]*?STREAM_CANCEL_ERROR[\s\S]*?\}/, 4, 3);
show('soul — v2ResponseComplete done', soul, /if \(v2ResponseComplete\) \{[\s\S]*?TURN_COMPLETE[\s\S]*?\}/, 0, 3);

// ---- kimi-bridge.cjs ----
const bridge = read('packages/kernel/kimi-bridge.cjs');
show('bridge — PROCESSING_DRAIN_TIMEOUT_MS', bridge, /PROCESSING_DRAIN_TIMEOUT_MS[^\n]*/, 0, 0);

console.log('\n=== FIM DO SCAN ===');
