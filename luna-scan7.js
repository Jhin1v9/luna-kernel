#!/usr/bin/env node
/**
 * luna-scan7.js — dump das linhas 190-420 do outbound.ts (deliverOne + listener)
 * USO:  node luna-scan7.js   (cola o output inteiro aqui)
 */
const fs = require('fs');
const path = require('path');
const FILE = path.join('C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent', 'apps', 'whatsplay', 'src', 'outbound.ts');
if (!fs.existsSync(FILE)) { console.error('NAO ENCONTRADO: ' + FILE); process.exit(1); }
const lines = fs.readFileSync(FILE, 'utf8').split('\n');
const start = Math.max(0, 190 - 1);
const end = Math.min(lines.length, 420);
console.log('### outbound.ts linhas ' + (start + 1) + ' a ' + end + ' ###');
for (let i = start; i < end; i++) console.log(String(i + 1).padStart(5) + ' | ' + lines[i]);
