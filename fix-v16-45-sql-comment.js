#!/usr/bin/env node
/* fix-v16-45-sql-comment.js — o comentario // JS dentro da string SQL quebrava
 * a query do registryAllows (catch silencioso => recusa eterna do guardrail).
 * Torna o trecho SQL-valido (-- ) e fecha o fail-open do LIKE com $3 vazio. */
const fs = require('fs'), path = require('path');
const HOME = process.env.HOME || process.env.USERPROFILE;
const f = path.join(HOME, 'Documents', 'Luna cto', 'luna-agent', 'apps', 'whatsplay', 'src', 'outbound.ts');
if (!fs.existsSync(f)) { console.error('[FAIL] nao achado: ' + f); process.exit(1); }
let src = fs.readFileSync(f, 'utf8');
if (src.includes('v16.45-sqlfix')) { console.log('[OK] v16.45 ja aplicado — idempotente'); process.exit(0); }
const bak = f + '.bak-sqlfix-' + Date.now();
fs.copyFileSync(f, bak);
const lines = src.split(/\r?\n/);
const i = lines.findIndex(l => l.includes("chat_key LIKE '%' || $3"));
if (i < 0) { console.error('[FAIL] linha do LIKE nao achada'); process.exit(1); }
if (!lines[i].includes('//')) { console.error('[FAIL] linha achada mas sem // — arquivo diverge, nada alterado'); process.exit(1); }
const ind = (lines[i].match(/^\s*/) || [''])[0];
lines[i] = ind + "OR chat_key = $3 OR ($3 <> '' AND chat_key LIKE '%' || $3)) -- v16.41c-fix slug + v16.45-sqlfix: o '//' JS quebrava o SQL inteiro (catch silencioso = recusa eterna); LIKE so com $3 nao-vazio (fail-closed)";
const out = lines.join('\n');
// validacoes
if (out.includes('// v16.41c-fix')) { console.error('[FAIL] ainda resta // v16.41c-fix no arquivo'); process.exit(1); }
const li = out.indexOf('v16.45-sqlfix');
if (li < 0 || out.indexOf('LIMIT 1', li) < 0) { console.error('[FAIL] estrutura da query inesperada apos patch'); process.exit(1); }
fs.writeFileSync(f, out);
console.log('[OK] linha ' + (i + 1) + ' corrigida: // -> -- e LIKE com guarda de vazio');
console.log('[OK] backup: ' + bak);
console.log('[NEXT] rm -rf "C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\node_modules\\.cache" "$TEMP/tsx" 2>/dev/null; pm2 restart luna-whatsplay');
