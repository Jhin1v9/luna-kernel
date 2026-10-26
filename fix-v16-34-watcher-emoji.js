#!/usr/bin/env node
/* fix-v16-34-watcher-emoji.js — v16.34 (owner 21/10) — regex flexivel,
   sem depender de anchor exato com espacos/tabs. */
const fs = require('fs');
const { spawn } = require('child_process');

const WATCHER = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\whatsplay\\src\\watcher.ts';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const MARK = 'v16.34-fix';

try {
  let src = fs.readFileSync(WATCHER, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] ja aplicado'); process.exit(0); }

  // regex flexivel: casa a linha do getAttribute('title') com qualquer indentacao
  const re = /const name = titleEl \? titleEl\.getAttribute\('title'\) : '';/;
  const m = src.match(re);
  if (!m || src.match(re).length !== 1) { console.log('[FAIL] regex ' + (m ? src.match(re).length : 0) + 'x'); process.exit(1); }

  src = src.replace(re,
    "// " + MARK + " (owner 21/10): getAttribute('title') sem emoji. Usar textContent do span[title] (visivel, com emoji).\n" +
    "    const spanEl = item.querySelector('span[title]');\n" +
    "    const name = (spanEl && spanEl.textContent ? spanEl.textContent.trim() : '') || (titleEl ? titleEl.getAttribute('title') : '');");

  fs.copyFileSync(WATCHER, WATCHER + '.bak-' + ts);
  fs.writeFileSync(WATCHER, src);
  console.log('[OK] watcher extrai nome com emoji (regex flexivel) | backup: watcher.ts.bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-whatsplay'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-whatsplay');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.34 ===');
console.log('=== DEPOIS rode o UPDATE do registry de novo ===');
