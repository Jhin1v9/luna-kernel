#!/usr/bin/env node
/**
 * fix-s2a-v2.js — instala o gancho S2a em TODAS as ocorrencias 8-space (2026-10-19)
 *
 * A v1 falhou: o arquivo local tem 2 ocorrencias de
 *   loopContext = await this._buildContext(sessionId, loopInput, { ...options, isFirstMessage: false, isToolResult: true });
 * com 8 espacos (a v1 esperava 1). Essa v2 trabalha linha a linha: pra cada
 * ocorrencia SEM o gancho na linha seguinte, insere. Idempotente de verdade.
 *
 * BONUS: imprime o estado atual de K3a/K3b (cbCount + historyLines) pra gente
 * ver em que estado estranho o arquivo ta.
 *
 * USO:  node fix-s2a-v2.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const SOUL = path.join(ROOT, 'packages', 'kernel', 'luna-soul.cjs');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!fs.existsSync(SOUL)) { console.error('Nao encontrado: ' + SOUL); process.exit(1); }
fs.copyFileSync(SOUL, SOUL + '.bak-' + ts);

let lines = fs.readFileSync(SOUL, 'utf8').split('\n');
const isCrlf = lines[0] !== undefined && fs.readFileSync(SOUL, 'utf8').includes('\r\n');
const EOL = isCrlf ? '\r\n' : '\n';

const TARGET = '        loopContext = await this._buildContext(sessionId, loopInput, { ...options, isFirstMessage: false, isToolResult: true });';
const MARKER = 'v14.4-fix ROTA UNICA: a extensao injeta o resultado na pagina do Kimi;';

const HOOK = [
  '        // v14.4-fix ROTA UNICA: a extensao injeta o resultado na pagina do Kimi;',
  '        // se conectada, a ponte NAO digita (skipSubmit no proximo send).',
  '        if (this._sendToolResultViaExtension(loopContext.prompt) > 0) {',
  '          options = { ...options, __skipBridgeSubmit: true };',
  '        }'
];

let inserted = 0;
let already = 0;
const out = [];
for (let i = 0; i < lines.length; i++) {
  out.push(lines[i]);
  const line = lines[i].replace(/\r$/, '');
  if (line === TARGET) {
    // ja tem gancho na proxima linha nao-vazia?
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    if (j < lines.length && lines[j].includes(MARKER)) {
      already++;
    } else {
      HOOK.forEach(h => out.push(h));
      inserted++;
    }
  }
}

if (inserted > 0) {
  fs.writeFileSync(SOUL, out.join('\n'));
  console.log('\x1b[32m[OK]\x1b[0m gancho S2a inserido em ' + inserted + ' lugar(es)');
} else {
  console.log('\x1b[90m[SKIP]\x1b[0m gancho S2a ja presente em ' + already + ' lugar(es)');
}

// ── BONUS: diagnostico K3a/K3b ──
console.log('\n\x1b[36m=== Estado atual de K3a/K3b ===\x1b[0m');
const src = fs.readFileSync(SOUL, 'utf8');
const all = src.split('\n');
all.forEach((l, idx) => {
  if (l.includes('cbCount') && l.includes('if')) {
    console.log('cbCount @' + (idx + 1) + ': ' + l.trim().slice(0, 120));
    for (let k = idx + 1; k < Math.min(idx + 5, all.length); k++) console.log('    ' + all[k].trim().slice(0, 120));
  }
  if (l.includes('historyLines.slice')) {
    console.log('history @' + (idx + 1) + ': ' + l.trim().slice(0, 160));
  }
});

// ── restart ──
try {
  execSync('pm2 restart luna-kernel', { encoding: 'utf8' });
  console.log('\n\x1b[32m[OK]\x1b[0m luna-kernel reiniciado');
} catch { console.log('\n\x1b[33m⚠ pm2 restart falhou — roda manual\x1b[0m'); }

console.log('\x1b[90mBackup: luna-soul.cjs.bak-' + ts + '\x1b[0m');
