#!/usr/bin/env node
/* v2 — resolve estilo Node (com extensao .js/.cjs/.json/index.js).
   v1 testava caminho sem extensao e deu falso negativo em tudo. */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const KERNEL = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel';
const DASH = 'C:\\Users\\Abner\\Documents\\luna-kernel\\apps\\dashboard';

const EXTS = ['', '.js', '.cjs', '.json'];
function resolveNodeStyle(baseDir, rel) {
  for (const ext of EXTS) {
    const p = path.resolve(baseDir, rel + ext);
    try { if (fs.statSync(p).isFile()) return p; } catch (_) {}
  }
  for (const ext of ['.js', '.cjs']) {
    const p = path.resolve(baseDir, rel, 'index' + ext);
    try { if (fs.statSync(p).isFile()) return p; } catch (_) {}
  }
  return null;
}

function relDeps(file) {
  try {
    const src = fs.readFileSync(file, 'utf8');
    const out = new Set();
    const re = /require\(['"](\.\.?\/[^'"]+)['"]\)/g;
    let m;
    while ((m = re.exec(src))) out.add(m[1]);
    return [...out];
  } catch (_) { return []; }
}

const files = [path.join(KERNEL, 'luna-server.js'), path.join(KERNEL, 'luna-chat-routes.js')];
const deps = new Set();
for (const f of files) for (const d of relDeps(f)) deps.add(d);

console.log('=== requires relativos: ' + deps.size + ' ===');
let linked = 0;
const missing = [];
for (const d of deps) {
  const local = resolveNodeStyle(KERNEL, d);
  if (local) { console.log('[ok] ' + d + '  (' + path.basename(local) + ')'); continue; }
  const dash = resolveNodeStyle(DASH, d);
  if (dash) {
    const need = path.resolve(KERNEL, path.relative(DASH, dash));
    try { fs.mkdirSync(path.dirname(need), { recursive: true }); } catch (_) {}
    try {
      fs.symlinkSync(dash, need, 'junction');
      console.log('[LINK] ' + path.relative(KERNEL, need) + '  ->  ' + path.relative(KERNEL, dash));
      linked++;
    } catch (e) {
      try {
        fs.copyFileSync(dash, need);
        console.log('[COPY] ' + path.relative(KERNEL, need));
        linked++;
      } catch (e2) { missing.push(d + ' :: ' + e2.message.slice(0, 50)); }
    }
  } else missing.push(d + ' (sem fonte no dashboard)');
}
console.log('linkados: ' + linked);
if (missing.length) { console.log('=== SEM FONTE: ==='); missing.forEach(x => console.log('  ! ' + x)); }

try { spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref(); console.log('[OK] restart disparado'); } catch (e) { console.log('[AVISO] ' + e.message); }
console.log('');
console.log('sleep 6; netstat -ano | grep -E ":3456 |:3458 " | head -4; curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:3458');
