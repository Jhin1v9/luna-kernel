#!/usr/bin/env node
/* scan-servers.js — mapa de arquivos-chave do kernel + agent.
   Gera tree completa em tree-scan.txt e mostra no console só o resumo:
   toda ocorrência de luna-server/luna-chat-routes/server + comparativo. */
const fs = require('fs');
const path = require('path');

const ROOTS = [
  'C:\\Users\\Abner\\Documents\\luna-kernel',
  'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent',
];
const SKIP = new Set(['node_modules', '.git', 'chrome-profile', 'dist', '.next', 'test-results', 'coverage']);
const OUT = 'C:\\Users\\Abner\\Documents\\luna-kernel\\tree-scan.txt';

const tree = [];
const hits = [];
function walk(dir, depth) {
  if (depth > 8) return;
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  items.sort((a, b) => a.name.localeCompare(b.name));
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) {
      if (SKIP.has(it.name) || it.name.endsWith('.bak')) { tree.push('  '.repeat(depth) + '[skip] ' + it.name + '/'); continue; }
      tree.push('  '.repeat(depth) + it.name + '/');
      walk(p, depth + 1);
    } else {
      tree.push('  '.repeat(depth) + it.name);
      if (/luna-server|luna-chat-routes|server\.js$|chat-routes/i.test(it.name)) {
        let size = 0, hasReq = false, head = '';
        try { const c = fs.readFileSync(p, 'utf8'); size = c.length; hasReq = c.includes("require('./luna-chat-routes')") || c.includes('require("./luna-chat-routes")'); head = c.slice(0, 60).replace(/\n/g, ' '); } catch (_) {}
        hits.push({ p, size, hasReq, head });
      }
    }
  }
}
for (const r of ROOTS) { tree.push('=== ' + r + ' ==='); walk(r, 0); }
fs.writeFileSync(OUT, tree.join('\n'));
console.log('=== ARQUIVOS-CHAVE (server/chat-routes) ===');
for (const h of hits) {
  console.log((h.hasReq ? '[REQ-chat-routes] ' : '[sem req      ] ') + h.size + ' bytes  ' + h.p);
}
console.log('');
console.log('Total linhas na arvore: ' + tree.length);
console.log('Arvore completa em: ' + OUT);
