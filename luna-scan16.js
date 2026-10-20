#!/usr/bin/env node
/* luna-scan16.js — dump completo do handler.ts (orchestrator local) */
const fs = require('fs');
const FILE = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\orchestrator\\src\\agent\\handler.ts';
if (!fs.existsSync(FILE)) { console.log('[FAIL] nao achei ' + FILE); process.exit(1); }
const lines = fs.readFileSync(FILE, 'utf8').split(/\r?\n/);
console.log('=== handler.ts — ' + lines.length + ' linhas — dump completo ===');
lines.forEach((l, i) => console.log(String(i + 1).padStart(4) + '| ' + l));
console.log('=== FIM ===');
