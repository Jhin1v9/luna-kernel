#!/usr/bin/env node
/**
 * luna-scan9.js — rotas do kernel + evento SSE final (2026-10-20)
 * USO:  node luna-scan9.js   (cola o output INTEIRO aqui)
 */
const fs = require('fs');
const FILE = 'C:\\Users\\Abner\\Documents\\luna-kernel\\apps\\dashboard\\luna-chat-routes.js';
if (!fs.existsSync(FILE)) { console.error('NAO ENCONTRADO: ' + FILE); process.exit(1); }
const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split('\n');

console.log('=== TODAS AS ROTAS REGISTRADAS ===');
lines.forEach((l, i) => {
  const m = l.match(/(?:app|router)\.(get|post|put|delete)\s*\(\s*['"`]([^'"`]+)['"`]/);
  if (m) console.log(String(i + 1).padStart(5) + ' | ' + m[1].toUpperCase().padEnd(6) + m[2]);
});

function show(label, regex, before = 0, after = 0) {
  console.log('\n========================================');
  console.log('### ' + label);
  console.log('========================================');
  const mm = new RegExp(regex.source, regex.flags).exec(src);
  if (!mm) { console.log('NAO ENCONTRADO'); return; }
  const idx = src.slice(0, mm.index).split('\n').length - 1;
  const start = Math.max(0, idx - before);
  const end = Math.min(lines.length, idx + mm[0].split('\n').length + after);
  console.log('--- linhas ' + (start + 1) + ' a ' + end + ' ---');
  for (let i = start; i < end; i++) console.log(String(i + 1).padStart(5) + ' | ' + lines[i]);
}

show('TRECHO — como a msg do usuario entra (req.body)', /req\.body/, 6, 14);
show('TRECHO — resposta final da Luna (evento SSE)', /role:\s*['"]luna|type:\s*['"](message|response|done)/i, 8, 20);
show('TRECHO — headers SSE (text/event-stream)', /text\/event-stream/, 4, 12);
