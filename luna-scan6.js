#!/usr/bin/env node
/**
 * luna-scan6.js — estrutura real do outbound.ts do whatsplay (2026-10-20)
 * USO:  node luna-scan6.js   (cola o output inteiro aqui)
 */
const fs = require('fs');
const path = require('path');
const ROOT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';

const FILE = path.join(ROOT, 'apps', 'whatsplay', 'src', 'outbound.ts');
if (!fs.existsSync(FILE)) { console.error('NAO ENCONTRADO: ' + FILE); process.exit(1); }
const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split('\n');

console.log('=== TODAS AS FUNCOES/METODOS (assinaturas) ===');
lines.forEach((l, i) => {
  if (/^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*(async\s+)?\w+\s*\([^)]*\)\s*[:{]|^\s*(private|public|async)\s+\w+\s*\(/.test(l)) {
    console.log(String(i + 1).padStart(5) + ' | ' + l.trim().slice(0, 140));
  }
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

show('TRECHO — espera humana (pacing)', /espera humana/i, 12, 18);
show('TRECHO — luna_outbound (query da fila)', /luna_outbound/i, 10, 25);
show('TRECHO — claim/processamento (loop)', /FOR UPDATE SKIP LOCKED|SKIP LOCKED|claim/i, 10, 25);
