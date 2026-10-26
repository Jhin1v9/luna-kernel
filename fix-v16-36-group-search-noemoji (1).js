#!/usr/bin/env node
/* fix-v16-36-group-search-noemoji.js — v16.36 (owner 21/10)
   browser.ts:825 usa _norm() na comparacao, mas _norm nao remove emoji.
   Pra grupo, hdr (titulo do painel) e want (nome com emoji) divergem.
   Fix: _norm tambem remove emoji — ai "🏆Production - 2026🙏🏻" casa com
   "Production - 2026" e o openChat reconhece o painel certo. */
const fs = require('fs');
const { spawn } = require('child_process');

const BROWSER = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\whatsplay\\src\\browser.ts';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const MARK = 'v16.36-fix';

try {
  let src = fs.readFileSync(BROWSER, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] ja aplicado'); process.exit(0); }

  // procurar a definicao de _norm e adicionar remocao de emoji
  const reNorm = /const _norm = \(s\) => \(s \|\| ''\)\.replace\(\/\[\\s\]\+\/g, ' '\)\.trim\(\);/;
  const m = src.match(reNorm);
  if (m && src.match(reNorm).length === 1) {
    src = src.replace(reNorm,
      "const _norm = (s) => String(s || '').replace(/[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE00}-\\u{FE0F}]/gu, '').replace(/\\s+/g, ' ').trim(); // " + MARK + ": remove emoji tambem");
    console.log('[OK] _norm agora remove emoji');
  } else {
    // _norm nao achado com regex — tentar a linha exata 825
    const anchor = "          earlyOk = typeof hdr === 'string' && _norm(hdr) === _norm(want);";
    if (src.split(anchor).length - 1 === 1) {
      src = src.replace(anchor,
        "          // " + MARK + " (owner 21/10): _norm nao remove emoji — adicionar.\n" +
        "          const _normEmoji = (s) => String(s || '').replace(/[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE00}-\\u{FE0F}]/gu, '').replace(/\\s+/g, ' ').trim();\n" +
        "          earlyOk = typeof hdr === 'string' && _normEmoji(hdr) === _normEmoji(want);");
      console.log('[OK] earlyOk usa _normEmoji (remove emoji)');
    } else {
      console.log('[FAIL] nem _norm nem anchor 825 achados');
      process.exit(1);
    }
  }

  fs.copyFileSync(BROWSER, BROWSER + '.bak-' + ts);
  fs.writeFileSync(BROWSER, src);
  console.log('[OK] browser.ts: busca de grupo sem emoji | backup: browser.ts.bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-whatsplay'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-whatsplay');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.36 ===');
console.log('=== TESTE: msg no grupo -> openChat reconhece o painel -> entrega -> result volta ===');
