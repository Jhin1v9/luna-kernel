#!/usr/bin/env node
/**
 * luna-scan12.js — onde a soul usa onContextLimit/autoCompactAttempted (2026-10-20)
 * USO:  node luna-scan12.js   (cola o output INTEIRO aqui)
 */
const fs = require('fs');
const FILE = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\luna-soul.cjs';
if (!fs.existsSync(FILE)) { console.error('NAO ENCONTRADO: ' + FILE); process.exit(1); }
const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split('\n');

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

show('SOUL — onContextLimit (call site)', /onContextLimit\(/, 15, 25);
show('SOUL — autoCompactAttempted (todos os usos)', /autoCompactAttempted/, 8, 10);
show('SOUL — isContextLimit (deteccao)', /isContextLimit/, 10, 20);
