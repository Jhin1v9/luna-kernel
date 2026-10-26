#!/usr/bin/env node
/* fix-v16-48-catalog-clearq.js — registra whatsappClearQueue no tool-catalog.cjs
 * (formato real: { name, desc, params }). Insere a entrada logo apos a do
 * whatsappSendMessage, com a mesma indentacao. Idempotente + valida sintaxe. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const HOME = process.env.HOME || process.env.USERPROFILE;
const f = path.join(HOME, 'Documents', 'luna-kernel', 'packages', 'kernel', 'tool-catalog.cjs');
if (!fs.existsSync(f)) { console.error('[FAIL] nao achado: ' + f); process.exit(1); }
let src = fs.readFileSync(f, 'utf8');
if (src.includes('whatsappClearQueue')) { console.log('[OK] whatsappClearQueue ja registrado no catalog — idempotente'); process.exit(0); }
const bak = f + '.bak-catalogq-' + Date.now();
fs.copyFileSync(f, bak);
const lines = src.split(/\r?\n/);
const i = lines.findIndex(l => l.includes("{ name: 'whatsappSendMessage'"));
if (i < 0) { console.error('[FAIL] entrada do whatsappSendMessage nao achada no catalog'); process.exit(1); }
const ind = (lines[i].match(/^\s*/) || [''])[0];
lines.splice(i + 1, 0, ind + "{ name: 'whatsappClearQueue', desc: 'ZERA a fila outbound: apaga mensagens pendentes/erro (nao entregues). Entregues intactas. Pra resetar a fila travada.', params: [] },");
const out = lines.join('\n');
try { new vm.Script(out); } catch (e) { console.error('[FAIL] sintaxe quebrada — NADA escrito: ' + e.message); process.exit(1); }
fs.writeFileSync(f, out);
console.log('[OK] whatsappClearQueue registrado no catalog (linha ' + (i + 2) + ')');
console.log('[OK] backup: ' + bak);
console.log('[NEXT] pm2 restart luna-kernel   (recarrega tools+catalog)');
