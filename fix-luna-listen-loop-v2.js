#!/usr/bin/env node
/* fix-luna-listen-loop-v2.js — substitui o retry "exit apos 12" (v1) por
   retry ETERNO com backoff exponencial. TIME_WAIT do Windows dura 60-120s;
   desistir (exit) causava o crash loop via pm2 respawn. Agora: nunca morre
   por porta — quando liberar, sobe e segue servindo. */
const fs = require('fs');
const { spawn } = require('child_process');

const F = 'C:\\Users\\Abner\\Documents\\luna-kernel\\apps\\dashboard\\luna-server.js';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const MARK = 'v-fix-listen-loop-v2';

try {
  let src = fs.readFileSync(F, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] ja aplicado'); process.exit(0); }

  // anchor: o bloco v1 (contador + exit apos 12)
  const re = /    global\.__lunaListenRetries = \(global\.__lunaListenRetries \|\| 0\) \+ 1;\r?\n    if \(global\.__lunaListenRetries > 12\) \{\r?\n      console\.error\('\[LUNA-FATAL\] porta ' \+ PORT \+ ' ocupada apos 12 retries — exit\(1\)'\);\r?\n      process\.exit\(1\);\r?\n    \}\r?\n    const _delay = matou \? 3000 : 5000;\r?\n    setTimeout\(\(\) => \{ try \{ server\.listen\(PORT\); \} catch \(e\) \{ console\.error\('\[LUNA\] retry listen: ' \+ e\.message\); \} \}, _delay\);\r?\n    return;/;
  if (!src.match(re)) { console.log('[FAIL] bloco v1 nao achado — me cola: grep -n "lunaListenRetries" apps/dashboard/luna-server.js'); process.exit(1); }

  src = src.replace(re,
    "    // " + MARK + ": retry ETERNO com backoff exponencial (TIME_WAIT 60-120s no\n" +
    "    // Windows; exit causava crash loop via pm2 respawn). Nunca morre por porta.\n" +
    "    global.__lunaListenRetries = (global.__lunaListenRetries || 0) + 1;\n" +
    "    const _tries = global.__lunaListenRetries;\n" +
    "    const _delay = Math.min(3000 * Math.pow(1.7, _tries), 60000);\n" +
    "    console.log('[LUNA] retry ' + _tries + ' do listen em ' + Math.round(_delay/1000) + 's');\n" +
    "    setTimeout(() => { try { server.listen(PORT); } catch (e) { console.error('[LUNA] retry listen: ' + e.message); } }, _delay);\n" +
    "    return;");

  fs.copyFileSync(F, F + '.bak-' + ts);
  fs.writeFileSync(F, src);
  console.log('[OK] retry eterno com backoff | backup: luna-server.js.bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado');
} catch (e) { console.log('[AVISO] ' + e.message); }

console.log('');
console.log('=== AGUARDA 20s: uptime deve passar de 1min SEM restartar ===');
console.log('sleep 20 && pm2 list | grep luna-kernel');
console.log('curl -s -o /dev/null -w "%{http_code}\\n" --max-time 3 http://127.0.0.1:3458');
