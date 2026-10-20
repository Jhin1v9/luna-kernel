#!/usr/bin/env node
/**
 * luna-scan10.js — ponto exato do brain-call no handler do orchestrator (2026-10-20)
 * USO:  node luna-scan10.js   (cola o output INTEIRO aqui)
 */
const fs = require('fs');
const FILE = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\orchestrator\\src\\agent\\handler.ts';
if (!fs.existsSync(FILE)) { console.error('NAO ENCONTRADO: ' + FILE); process.exit(1); }
const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split('\n');

function show(label, regex, before = 0, after = 0) {
  console.log('\n========================================');
  console.log('### ' + label);
  console.log('========================================');
  const mm = new RegExp(regex.source, regex.flags).exec(src);
  if (!mm) { console.log('NAO ENCONTRADO: ' + regex); return; }
  const idx = src.slice(0, mm.index).split('\n').length - 1;
  const start = Math.max(0, idx - before);
  const end = Math.min(lines.length, idx + mm[0].split('\n').length + after);
  console.log('--- linhas ' + (start + 1) + ' a ' + end + ' ---');
  for (let i = start; i < end; i++) console.log(String(i + 1).padStart(5) + ' | ' + lines[i]);
}

show('HANDLER — runFastRoute (brain call)', /runFastRoute\(/, 18, 25);
show('HANDLER — onde a resposta vira ANSWER pro cliente', /router_output|ANSWER|cliente respondido/i, 8, 20);
