#!/usr/bin/env node
/* fix-dashboard-listen-guard.js — o dashboard NAO da listen quando importado pelo kernel.
 * Standalone (node luna-server.js direto) continua escutando normal. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const HOME = process.env.HOME || process.env.USERPROFILE;
const f = path.join(HOME, 'Documents', 'luna-kernel', 'apps', 'dashboard', 'luna-server.js');
if (!fs.existsSync(f)) { console.error('[FAIL] nao achado: ' + f); process.exit(1); }
const src = fs.readFileSync(f, 'utf8');
if (src.includes('require.main === module')) { console.log('[OK] guarda ja presente — idempotente, saindo'); process.exit(0); }
const bak = f + '.bak-listenguard-' + Date.now();
fs.copyFileSync(f, bak);
let lines = src.split(/\r?\n/);
const anchor = "const LUNA_PID_FILE = path.join(require('os').tmpdir(), 'luna-server-3458.pid');";
const i = lines.findIndex(l => l.includes(anchor));
if (i < 0) { console.error('[FAIL] anchor LUNA_PID_FILE nao achada'); process.exit(1); }
let ins = i;
if (i > 0 && lines[i-1].trim().startsWith('//')) ins = i - 1;
const indent = (lines[i].match(/^\s*/) || [''])[0];
lines.splice(ins, 0, indent + 'if (require.main === module) {');
let j = -1;
for (let k = ins + 1; k < lines.length; k++) { if (lines[k].includes('server.listen(PORT')) { j = k; break; } }
if (j < 0) { console.error('[FAIL] server.listen(PORT nao achado'); process.exit(1); }
let close = -1;
for (let k = j + 1; k < Math.min(j + 40, lines.length); k++) { if (lines[k].trim() === '});') { close = k; break; } }
if (close < 0) { console.error('[FAIL] fechamento }); do listen nao achado'); process.exit(1); }
lines.splice(close + 1, 0, indent + '}');
const out = lines.join('\n');
try { new vm.Script(out); } catch (e) { console.error('[FAIL] sintaxe quebrada apos patch — revertendo: ' + e.message); fs.copyFileSync(bak, f); process.exit(1); }
fs.writeFileSync(f, out);
console.log('[OK] dashboard: listen protegido com require.main === module (linhas ' + (ins+1) + '..' + (close+2) + ')');
console.log('[OK] backup: ' + bak);
