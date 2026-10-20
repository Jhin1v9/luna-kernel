#!/usr/bin/env node
/* luna-scan15.js — mapeia sweeper do Kimi Work, gerenciador de abas e banco de dados
 * SO LEITURA. Nao altera nada. Roda: node luna-scan15.js  (de qualquer pasta)
 */
const fs = require('fs');
const path = require('path');

const ROOTS = ['C:/Users/Abner/Documents', 'C:/Users/Abner/.luna'];
const PATTERNS = [
  { re: /askKernelWorkKernel/, label: 'SWEEPER (askKernelWorkKernel)' },
  { re: /kimiwork_inbox/, label: 'INBOX (kimiwork_inbox)' },
  { re: /luna_outbound/, label: 'OUTBOUND (luna_outbound)' },
  { re: /localhost:3458/, label: 'KERNEL WEB (localhost:3458)' },
  { re: /kimi\.ai\/(chat|en)/, label: 'ABA KIMI (url)' },
  { re: /createTarget|new-tab|new-window|Target\.createTarget/, label: 'ABRIDOR DE ABAS (CDP/tab)' },
];
const SKIP = new Set(['node_modules', '.git', '.next', 'coverage', 'dist']);
const EXTS = new Set(['.js', '.cjs', '.mjs', '.ts']);

function* walk(dir, depth) {
  if (depth > 7) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (SKIP.has(e.name) || e.name.startsWith('.bak') || e.name.endsWith('.bak')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, depth + 1);
    else if (EXTS.has(path.extname(e.name))) yield full;
  }
}

const report = [];
for (const root of ROOTS) {
  for (const file of walk(root, 0)) {
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    const lines = src.split(/\r?\n/);
    const hits = [];
    PATTERNS.forEach((p, i) => {
      const ln = [];
      lines.forEach((l, n) => { if (p.re.test(l)) ln.push(n + 1); });
      if (ln.length) hits.push({ i, label: p.label, count: ln.length, lines: ln.slice(0, 15) });
    });
    if (hits.length) report.push({ file, total: lines.length, hits });
  }
}

console.log('=== ARQUIVOS COM ACHE ===');
for (const r of report) {
  console.log('\n### ' + r.file + '  (' + r.total + ' linhas)');
  for (const h of r.hits) console.log('  [' + h.label + '] ' + h.count + 'x  linhas: ' + h.lines.join(', '));
}

console.log('\n=== CODIGO DO SWEEPER (askKernelWorkKernel + entorno) ===');
for (const r of report) {
  if (!r.hits.some(h => h.i === 0)) continue;
  const src = fs.readFileSync(r.file, 'utf8');
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex(l => /askKernelWorkKernel/.test(l));
  if (start === -1) continue;
  const from = Math.max(0, start - 15);
  const end = Math.min(lines.length, start + 160);
  console.log('\n----- ' + r.file + ' (linhas ' + (from + 1) + '-' + end + ') -----');
  for (let n = from; n < end; n++) console.log(String(n + 1).padStart(5) + '| ' + lines[n]);
}

console.log('\n=== BANCOS SQLITE ENCONTRADOS (fora de node_modules) ===');
for (const root of ROOTS) {
  for (const file of walk(root, 0)) {
    if (!/\.(db|sqlite|sqlite3)$/.test(file)) continue;
    let size = 0;
    try { size = fs.statSync(file).size; } catch (e) {}
    console.log('  ' + file + '  (' + Math.round(size / 1024) + ' KB)');
  }
}

console.log('\n=== PROCESSOS NODE RODANDO (info) ===');
try {
  const { execSync } = require('child_process');
  const out = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  const procs = out.split(/\r?\n/).filter(l => l.includes('node.exe'));
  console.log('  ' + procs.length + ' processo(s) node.exe rodando agora');
  procs.slice(0, 10).forEach(p => console.log('  ' + p));
} catch (e) { console.log('  (nao consegui listar)'); }

console.log('\n=== FIM DO SCAN — cola tudo aqui ===');
