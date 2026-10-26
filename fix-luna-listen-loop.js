#!/usr/bin/env node
/* fix-luna-listen-loop.js — apps/dashboard/luna-server.js
   BUG: handler de EADDRINUSE fazia process.exit(1) SEMPRE (matou=true mesmo
   quando o guard nao matou nada — porta "ocupada" so por TIME_WAIT do boot
   anterior). Cada morte gerava TIME_WAIT novo -> EADDRINUSE no proximo boot
   -> loop infinito de self-respawn (centenas de restarts, tela Kimi piscando).
   FIX: retry do server.listen com backoff (3s/5s); exit(1) so apos 12 falhas. */
const fs = require('fs');
const { spawn } = require('child_process');

const F = 'C:\\Users\\Abner\\Documents\\luna-kernel\\apps\\dashboard\\luna-server.js';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const MARK = 'v-fix-listen-loop';

try {
  let src = fs.readFileSync(F, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] ja aplicado'); process.exit(0); }

  // anchor: o bloco if(matou)...process.exit(1) dentro do handler de erro do listen
  const re = /    if \(matou\) \{\r?\n      console\.log\('\[LUNA\] porta ' \+ PORT \+ ' sera liberada[^']*'\);\r?\n    \} else \{\r?\n      console\.error\('\[LUNA-FATAL\] porta ' \+ PORT \+ ' ocupada e guarda nao conseguiu liberar — exit\(1\)'\);\r?\n    \}\r?\n    process\.exit\(1\);\r?\n  \}/;
  const m = src.match(re);
  if (!m) { console.log('[FAIL] bloco do listen-loop nao achado — cola: sed -n "425,438p" apps/dashboard/luna-server.js'); process.exit(1); }

  const replacement =
    "    if (matou) {\n" +
    "      console.log('[LUNA] porta ' + PORT + ' sera liberada — retry do listen em 3s (sem exit)');\n" +
    "    } else {\n" +
    "      console.error('[LUNA-FATAL] porta ' + PORT + ' ocupada e guarda nao conseguiu liberar — retry em 5s');\n" +
    "    }\n" +
    "    // " + MARK + " (24/10): era process.exit(1) incondicional — loop infinito:\n" +
    "    // cada morte gerava TIME_WAIT (EADDRINUSE no proximo boot) e o ciclo se\n" +
    "    // auto-alimentava. Agora: retry do listen com backoff; exit so apos 12 falhas.\n" +
    "    global.__lunaListenRetries = (global.__lunaListenRetries || 0) + 1;\n" +
    "    if (global.__lunaListenRetries > 12) {\n" +
    "      console.error('[LUNA-FATAL] porta ' + PORT + ' ocupada apos 12 retries — exit(1)');\n" +
    "      process.exit(1);\n" +
    "    }\n" +
    "    const _delay = matou ? 3000 : 5000;\n" +
    "    setTimeout(() => { try { server.listen(PORT); } catch (e) { console.error('[LUNA] retry listen: ' + e.message); } }, _delay);\n" +
    "    return;\n" +
    "  }";

  src = src.replace(re, replacement);
  fs.copyFileSync(F, F + '.bak-' + ts);
  fs.writeFileSync(F, src);
  console.log('[OK] listen-loop desarmado (retry com backoff, exit so apos 12 falhas) | backup: luna-server.js.bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'start', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] start disparado: luna-kernel');
} catch (e) { console.log('[AVISO] start: ' + e.message); }

console.log('');
console.log('=== AGUARDA 15s E CONFERE: ===');
console.log('pm2 list | grep luna-kernel   # uptime deve crescer (sem voltar pra 1s)');
console.log('curl -s -o /dev/null -w "%{http_code}\\n" --max-time 3 http://127.0.0.1:3458');
