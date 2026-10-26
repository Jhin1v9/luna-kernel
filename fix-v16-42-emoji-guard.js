#!/usr/bin/env node
/* fix-v16-42-emoji-guard.js — normaliza emoji na comparacao de nome do guardrail
 * + marcador [WP-CODE] pra provar qual codigo esta vivo + limpa cache tsx. */
const fs = require('fs'), path = require('path'), os = require('os');
const HOME = process.env.HOME || process.env.USERPROFILE;
const ROOT = path.join(HOME, 'Documents', 'Luna cto', 'luna-agent');
const f = path.join(ROOT, 'apps', 'whatsplay', 'src', 'outbound.ts');
if (!fs.existsSync(f)) { console.error('[FAIL] nao achado: ' + f); process.exit(1); }
const src = fs.readFileSync(f, 'utf8');
if (src.includes('v16.42-emoji')) { console.log('[OK] v16.42 ja aplicado — idempotente, saindo'); process.exit(0); }
const bak = f + '.bak-v1642-' + Date.now();
fs.copyFileSync(f, bak);
let lines = src.split(/\r?\n/);
// T1: marcador de versao dentro de registryAllows
const fi = lines.findIndex(l => l.includes('async function registryAllows'));
if (fi < 0) { console.error('[FAIL] registryAllows nao achada'); process.exit(1); }
let ti = -1;
for (let k = fi + 1; k < Math.min(fi + 6, lines.length); k++) { if (lines[k].trim() === 'try {') { ti = k; break; } }
if (ti < 0) { console.error('[FAIL] try { da registryAllows nao achado'); process.exit(1); }
const tind = (lines[ti].match(/^\s*/) || [''])[0];
lines.splice(ti + 1, 0, tind + '  console.log("[WP-CODE] v16.42-emoji registryAllows carregado");');
// T2: comparacao normalizada (remove tudo que nao e a-zA-Z0-9 dos dois lados)
const gi = lines.findIndex(l => l.includes("kind = 'group'"));
const ci = lines.findIndex((l, k) => k > gi && l.includes('lower(canonical_name) = lower($2)'));
if (gi < 0 || ci < 0) { console.error('[FAIL] clausula group da query nao achada'); process.exit(1); }
const ind = (lines[ci].match(/^\s*/) || [''])[0];
lines.splice(ci + 1, 0, ind + "OR lower(regexp_replace(canonical_name, '[^a-zA-Z0-9]', '', 'g')) = lower(regexp_replace(coalesce($2::text, ''), '[^a-zA-Z0-9]', '', 'g')) -- v16.42-emoji");
fs.writeFileSync(f, lines.join('\n'));
// T3: limpeza total de caches tsx conhecidos
const caches = [
  path.join(ROOT, 'node_modules', '.cache'),
  path.join(ROOT, 'apps', 'whatsplay', 'node_modules', '.cache'),
  path.join(os.tmpdir(), 'tsx'),
];
for (const d of caches) { try { fs.rmSync(d, { recursive: true, force: true }); console.log('[OK] cache removido: ' + d); } catch (e) { console.log('[WARN] cache nao removido (pode nao existir): ' + d); } }
console.log('[OK] outbound.ts patchado (backup: ' + bak + ')');
console.log('[NEXT] rode: pm2 delete luna-whatsplay && cd "' + ROOT + '/apps/whatsplay" && TSX_DISABLE_CACHE=1 pm2 start "../../../node_modules/tsx/dist/cli.mjs" --name luna-whatsplay --cwd "' + ROOT + '/apps/whatsplay" -- src/index.ts && pm2 save');
