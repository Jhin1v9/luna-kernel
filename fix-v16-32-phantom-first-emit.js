#!/usr/bin/env node
/* fix-v16-46-clean-registry.js — reescrita clean-room do registryAllows.
 * As patches sucessivas (v16.41c/42/45*) deixaram a SQL comentario/parênteses
 * quebrados; o catch silencioso virava recusa eterna. Agora: funcao nova,
 * validada estruturalmente, e o catch LOGA o erro real. Idempotente. */
const fs = require('fs'), path = require('path');
const HOME = process.env.HOME || process.env.USERPROFILE;
const f = path.join(HOME, 'Documents', 'Luna cto', 'luna-agent', 'apps', 'whatsplay', 'src', 'outbound.ts');
if (!fs.existsSync(f)) { console.error('[FAIL] nao achado: ' + f); process.exit(1); }
let src = fs.readFileSync(f, 'utf8');
if (src.includes('v16.46-clean-registry')) { console.log('[OK] v16.46 ja aplicado — idempotente'); process.exit(0); }
const bak = f + '.bak-cleanreg-' + Date.now();
fs.copyFileSync(f, bak);
const lines = src.split(/\r?\n/);
const s = lines.findIndex(l => l.includes('async function registryAllows'));
if (s < 0) { console.error('[FAIL] inicio da registryAllows nao achado'); process.exit(1); }
let e = -1;
for (let k = s + 1; k < Math.min(s + 60, lines.length); k++) { if (lines[k].trim() === '}') { e = k; break; } }
if (e < 0) { console.error('[FAIL] fim da funcao (} sozinho) nao achado'); process.exit(1); }
const fn = [
  'async function registryAllows(pool: any, target: any, allowTarget: any): Promise<boolean> {',
  '  // v16.46-clean-registry: reescrita limpa (patches antigas quebraram a SQL;',
  '  // catch silencioso virava recusa eterna). Erro agora e logado, nao engolido.',
  '  try {',
  "    const digits = String(target ?? '').replace(/\\D/g, '');",
  "    const t3 = String(target ?? '');",
  '    const { rows } = await pool.query(',
  '      `SELECT 1 FROM chat_registry WHERE role = \'allowed\' AND (',
  '         (kind = \'individual\' AND (',
  '            replace(chat_key, \'@c.us\', \'\') = $1',
  '            OR replace(coalesce(phone_e164, \'\'), \'@c.us\', \'\') = $1',
  '            OR lower(canonical_name) = lower($2)))',
  '         OR (kind = \'group\' AND (',
  '            lower(canonical_name) = lower($2)',
  '            OR chat_key = $3',
  "            OR ($3 <> '' AND chat_key LIKE '%' || $3)",
  "            OR lower(regexp_replace(coalesce(canonical_name, ''), '[^a-zA-Z0-9]+', '', 'g')) = lower(regexp_replace(coalesce($2::text, ''), '[^a-zA-Z0-9]+', '', 'g'))))",
  '       ) LIMIT 1`,',
  '      [digits, String(allowTarget ?? \'\'), t3]',
  '    );',
  "    console.log('[REGISTRY] target=' + JSON.stringify(target) + ' allowTarget=' + JSON.stringify(allowTarget) + ' rows=' + rows.length);",
  '    return rows.length > 0;',
  '  } catch (err: any) {',
  "    console.log('[REGISTRY-ERR] ' + (err && err.message ? err.message : String(err)));",
  '    return false;',
  '  }',
  '}',
];
// validacao estrutural da funcao nova
const fnText = fn.join('\n');
const o = (fnText.match(/\(/g) || []).length, c = (fnText.match(/\)/g) || []).length;
if (o !== c) { console.error('[FAIL] funcao nova desbalanceada em (): ' + o + ' vs ' + c); process.exit(1); }
const ob = (fnText.match(/{/g) || []).length, cb = (fnText.match(/}/g) || []).length;
if (ob !== cb) { console.error('[FAIL] funcao nova desbalanceada em {}: ' + ob + ' vs ' + cb); process.exit(1); }
lines.splice(s, e - s + 1, ...fn);
const out = lines.join('\n');
// validacao estrutural do SQL DENTRO do arquivo final
const s0 = out.indexOf('SELECT 1 FROM chat_registry');
const s1 = out.indexOf('LIMIT 1', s0);
if (s0 < 0 || s1 < 0) { console.error('[FAIL] bloco SQL nao localizado no arquivo final'); process.exit(1); }
const block = out.slice(s0, s1);
const bo = (block.match(/\(/g) || []).length, bc = (block.match(/\)/g) || []).length;
if (bo !== bc) { console.error('[FAIL] SQL final desbalanceado: ' + bo + ' vs ' + bc + ' — NADA escrito'); process.exit(1); }
fs.writeFileSync(f, out);
console.log('[OK] registryAllows reescrita (linhas ' + (s + 1) + '..' + (e + 1) + ' substituidas, ' + fn.length + ' linhas novas)');
console.log('[OK] validacao estrutural: funcao e SQL com parênteses balanceados (' + bo + ' pares no bloco SQL)');
console.log('[OK] backup: ' + bak);
console.log('[NEXT] rm -rf "C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\node_modules\\.cache" "$TEMP/tsx" 2>/dev/null; pm2 restart luna-whatsplay');
