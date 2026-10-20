#!/usr/bin/env node
/**
 * luna-scan14.js — persistencia da msg assistant na sessao (luna-chat-routes.js)
 * USO:  node luna-scan14.js   (cola o output INTEIRO aqui)
 */
const fs = require('fs');
const FILE = 'C:\\Users\\Abner\\Documents\\luna-kernel\\apps\\dashboard\\luna-chat-routes.js';
if (!fs.existsSync(FILE)) { console.error('NAO ENCONTRADO'); process.exit(1); }
const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split('\n');
// bloco do scan9: eventos SSE -> session.messages (por volta da linha 590-650)
const start = 588, end = Math.min(lines.length, 660);
console.log('### luna-chat-routes.js linhas ' + start + '-' + end + ' (SSE -> persistencia) ###');
for (let i = start - 1; i < end; i++) console.log(String(i + 1).padStart(5) + ' | ' + lines[i]);
