#!/usr/bin/env node
/* fix-v16-34-group-emoji-name.js — v16.34 (owner 21/10)
   BUG: watcher extrai chat_name do atributo [title], que pra grupo vem SEM
   emoji ("Produção 2026") — o nome VISIVEL no WA tem ("🏆Production - 2026🙏🏻").
   Resultado: whatsappListGroups lista o nome errado (sem emoji), e a Luna usa
   "Produção 2026" em vez do nome real.
   Fix: extrair o nome do TEXTO VISIVEL (span de titulo) que tem o emoji real. */
const fs = require('fs');
const { spawn } = require('child_process');

const WATCHER = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\whatsplay\\src\\watcher.ts';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const MARK = 'v16.34-fix';

try {
  let src = fs.readFileSync(WATCHER, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] ja aplicado'); process.exit(0); }

  const anchor = `    const titleEl = item.querySelector('[title]');
    const name = titleEl ? titleEl.getAttribute('title') : '';
    if (!name) continue;`;
  if (src.split(anchor).length - 1 !== 1) { console.log('[FAIL] anchor ' + (src.split(anchor).length - 1) + 'x'); process.exit(1); }

  src = src.replace(anchor,
    `    // ${MARK} (owner 21/10): o atributo [title] pra grupo vem SEM emoji
    // ("Produção 2026"). O nome VISIVEL (textContent do span de titulo) tem o
    // emoji real ("🏆Production - 2026🙏🏻"). Extrair do visivel.
    const titleEl = item.querySelector('[title]');
    const spanEl = item.querySelector('span[title]') || titleEl;
    const name = (spanEl && spanEl.textContent ? spanEl.textContent.trim() : '') || (titleEl ? titleEl.getAttribute('title') : '');
    if (!name) continue;`);

  fs.copyFileSync(WATCHER, WATCHER + '.bak-' + ts);
  fs.writeFileSync(WATCHER, src);
  console.log('[OK] watcher extrai nome com emoji do texto visivel | backup: watcher.ts.bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-whatsplay'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-whatsplay');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.34 ===');
console.log('=== TESTE: whatsappListGroups agora lista "🏆Production - 2026🙏🏻" (com emoji) ===');
