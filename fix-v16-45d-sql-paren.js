#!/usr/bin/env node
/* fix-v16-45d-sql-paren.js — v16.45c faltou um ')' (quebrou o SQL de novo).
 * Agora: NULLIF($3,'') da o fail-closed SEM parêntese extra (mesma estrutura
 * da versao original). Validacao ESTRUTURAL: conta ( vs ) no bloco SQL. */
const fs = require('fs'), path = require('path');
const HOME = process.env.HOME || process.env.USERPROFILE;
const f = path.join(HOME, 'Documents', 'Luna cto', 'luna-agent', 'apps', 'whatsplay', 'src', 'outbound.ts');
if (!fs.existsSync(f)) { console.error('[FAIL] nao achado: ' + f); process.exit(1); }
let src = fs.readFileSync(f, 'utf8');
if (src.includes('v16.45d-sqlfix')) { console.log('[OK] v16.45d ja aplicado — idempotente'); process.exit(0); }
const bak = f + '.bak-sqlparen-' + Date.now();
fs.copyFileSync(f, bak);
const lines = src.split(/\r?\n/);
const i = lines.findIndex(l => l.includes("chat_key LIKE '%' ||"));
if (i < 0) { console.error('[FAIL] linha do LIKE nao achada'); process.exit(1); }
const ind = (lines[i].match(/^\s*/) || [''])[0];
lines[i] = ind + "OR chat_key = $3 OR chat_key LIKE '%' || NULLIF($3, '') -- v16.41c-fix slug + v16.45d-sqlfix: barra-dupla JS quebrava o SQL; NULLIF no LIKE = fail-closed quando $3 vazio (sem parêntese extra)";
const out = lines.join('\n');
// VALIDACAO ESTRUTURAL: parênteses do bloco SQL balanceados
const s0 = out.indexOf('SELECT 1 FROM chat_registry');
const s1 = out.indexOf('LIMIT 1', s0);
if (s0 < 0 || s1 < 0) { console.error('[FAIL] bloco SQL nao localizado'); process.exit(1); }
const block = out.slice(s0, s1);
const open = (block.match(/\(/g) || []).length, close = (block.match(/\)/g) || []).length;
if (open !== close) { console.error('[FAIL] parênteses SQL desbalanceados: ' + open + ' abertos vs ' + close + ' fechados — NADA escrito'); process.exit(1); }
if (lines[i].includes('//')) { console.error('[FAIL] linha ainda tem barra-dupla'); process.exit(1); }
fs.writeFileSync(f, out);
console.log('[OK] linha ' + (i + 1) + ' corrigida com NULLIF (estrutura de parênteses intacta: ' + open + ' pares)');
console.log('[OK] backup: ' + bak);
console.log('[NEXT] rm -rf "C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\node_modules\\.cache" "$TEMP/tsx" 2>/dev/null; pm2 restart luna-whatsplay');
