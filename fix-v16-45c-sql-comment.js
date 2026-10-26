#!/usr/bin/env node
/* fix-v16-45c-sql-comment.js — corrige APENAS a linha do LIKE (comentario de
 * barra-dupla DENTRO da string SQL que quebrava a query do registryAllows).
 * A linha do throw e' comentario JS legitimo — nao se mexe. */
const fs = require('fs'), path = require('path');
const HOME = process.env.HOME || process.env.USERPROFILE;
const f = path.join(HOME, 'Documents', 'Luna cto', 'luna-agent', 'apps', 'whatsplay', 'src', 'outbound.ts');
if (!fs.existsSync(f)) { console.error('[FAIL] nao achado: ' + f); process.exit(1); }
let src = fs.readFileSync(f, 'utf8');
if (src.includes('v16.45c-sqlfix')) { console.log('[OK] v16.45c ja aplicado — idempotente'); process.exit(0); }
const bak = f + '.bak-sqlfixc-' + Date.now();
fs.copyFileSync(f, bak);
const lines = src.split(/\r?\n/);
const i = lines.findIndex(l => l.includes("chat_key LIKE '%' || $3"));
if (i < 0) { console.error('[FAIL] linha do LIKE nao achada'); process.exit(1); }
if (!lines[i].includes('//')) { console.error('[FAIL] linha ' + (i+1) + ' ja sem barra-dupla — verifique manualmente'); process.exit(1); }
const ind = (lines[i].match(/^\s*/) || [''])[0];
lines[i] = ind + "OR chat_key = $3 OR ($3 <> '' AND chat_key LIKE '%' || $3)) -- v16.41c-fix slug + v16.45c-sqlfix: comentario JS de barra-dupla DENTRO do SQL quebrava a query (catch silencioso = recusa eterna); LIKE so com $3 nao-vazio (fail-closed)";
if (lines[i].includes('//')) { console.error('[FAIL] linha ainda contem barra-dupla apos patch'); process.exit(1); }
const out = lines.join('\n');
const li = out.indexOf('v16.45c-sqlfix');
if (li < 0 || out.indexOf('LIMIT 1', li) < 0) { console.error('[FAIL] estrutura da query inesperada apos patch'); process.exit(1); }
fs.writeFileSync(f, out);
console.log('[OK] linha ' + (i + 1) + ' corrigida: barra-dupla -> travessao duplo, LIKE com guarda de vazio');
console.log('[OK] backup: ' + bak);
console.log('[NEXT] rm -rf "C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\node_modules\\.cache" "$TEMP/tsx" 2>/dev/null; pm2 restart luna-whatsplay');
