#!/usr/bin/env node
/* fix-v16-45b-sql-comment.js — corrige APENAS a linha 28 (comentario // DENTRO
 * da string SQL que quebrava a query do registryAllows). A linha 334 e' um
 * comentario JS legitimo — nao se mexe. */
const fs = require('fs'), path = require('path');
const HOME = process.env.HOME || process.env.USERPROFILE;
const f = path.join(HOME, 'Documents', 'Luna cto', 'luna-agent', 'apps', 'whatsplay', 'src', 'outbound.ts');
if (!fs.existsSync(f)) { console.error('[FAIL] nao achado: ' + f); process.exit(1); }
let src = fs.readFileSync(f, 'utf8');
if (src.includes('v16.45b-sqlfix')) { console.log('[OK] v16.45b ja aplicado — idempotente'); process.exit(0); }
const bak = f + '.bak-sqlfixb-' + Date.now();
fs.copyFileSync(f, bak);
const lines = src.split(/\r?\n/);
const i = lines.findIndex(l => l.includes("chat_key LIKE '%' || $3"));
if (i < 0) { console.error('[FAIL] linha do LIKE nao achada'); process.exit(1); }
if (!lines[i].includes('//')) { console.error('[FAIL] linha ' + (i+1) + ' ja sem // — verifique manualmente'); process.exit(1); }
const ind = (lines[i].match(/^\s*/) || [''])[0];
lines[i] = ind + "OR chat_key = $3 OR ($3 <> '' AND chat_key LIKE '%' || $3)) -- v16.41c-fix slug + v16.45b-sqlfix: o '//' JS quebrava o SQL (catch silencioso = recusa eterna); LIKE so com $3 nao-vazio (fail-closed)";
// valida SO a linha alterada (a outra ocorrencia de // v16.41c-fix na linha 334 e' comentario JS legitimo)
if (lines[i].includes('//')) { console.error('[FAIL] linha ainda contem // apos patch'); process.exit(1); }
const out = lines.join('\n');
const li = out.indexOf('v16.45b-sqlfix');
if (li < 0 || out.indexOf('LIMIT 1', li) < 0) { console.error('[FAIL] estrutura da query inesperada apos patch'); process.exit(1); }
fs.writeFileSync(f, out);
console.log('[OK] linha ' + (i + 1) + ' corrigida: // -> -- e LIKE com guarda de vazio (linha 334 intacta — comentario JS valido)');
console.log('[OK] backup: ' + bak);
console.log('[NEXT] rm -rf "C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\node_modules\\.cache" "$TEMP/tsx" 2>/dev/null; pm2 restart luna-whatsplay');
