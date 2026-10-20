#!/usr/bin/env node
/**
 * luna-scan11.js — os DOIS mecanismos de compact no kernel (2026-10-20)
 * Owner alertou: um eh MOCK, outro FUNCIONAL. Achar os dois e qual eh qual.
 * USO:  node luna-scan11.js   (cola o output INTEIRO aqui)
 */
const fs = require('fs');
const path = require('path');

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function hits(label, content, regex, ctx = 6, maxHits = 8) {
  console.log('\n========================================');
  console.log('### ' + label);
  console.log('========================================');
  if (content === null) { console.log('ARQUIVO NAO ENCONTRADO'); return; }
  const lines = content.split('\n');
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  let m, count = 0;
  while ((m = re.exec(content)) && count < maxHits) {
    count++;
    const idx = content.slice(0, m.index).split('\n').length - 1;
    const start = Math.max(0, idx - ctx);
    const end = Math.min(lines.length, idx + m[0].split('\n').length + ctx);
    console.log('--- hit ' + count + ' (linha ' + (idx + 1) + ') ---');
    for (let i = start; i < end; i++) console.log(String(i + 1).padStart(5) + ' | ' + lines[i]);
    console.log('');
  }
  if (count === 0) console.log('nenhum hit');
}

const soul = read('C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\luna-soul.cjs');
hits('SOUL — compact (todos os mecanismos)', soul, /compact/i, 5, 10);

const routes = read('C:\\Users\\Abner\\Documents\\luna-kernel\\apps\\dashboard\\luna-chat-routes.js');
hits('ROUTES — comando /compact e auto-compact', routes, /compact/i, 5, 6);
