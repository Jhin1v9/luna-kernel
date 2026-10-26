#!/usr/bin/env node
/* fix-v16-47-clear-queue.js — adiciona whatsappClearQueue ao whatsapp-tools.cjs
 * (zera a fila outbound: apaga tudo que nao foi entregue; entregues intactas).
 * Insere a funcao antes do whatsappSendMessage e a registra no module.exports
 * CLONANDO a linha do whatsappSendMessage (mesmo formato/identacao). */
const fs = require('fs'), path = require('path'), vm = require('vm');
const HOME = process.env.HOME || process.env.USERPROFILE;
const f = path.join(HOME, 'Documents', 'luna-kernel', 'packages', 'kernel', 'whatsapp-tools.cjs');
if (!fs.existsSync(f)) { console.error('[FAIL] nao achado: ' + f); process.exit(1); }
let src = fs.readFileSync(f, 'utf8');
if (src.includes('v16.47-clear-queue')) { console.log('[OK] v16.47 ja aplicado — idempotente'); process.exit(0); }
const bak = f + '.bak-clearq-' + Date.now();
fs.copyFileSync(f, bak);
const anchor = 'async function whatsappSendMessage(params = {}) {';
const i = src.indexOf(anchor);
if (i < 0) { console.error('[FAIL] anchor whatsappSendMessage nao achado'); process.exit(1); }
const fn = [
  'async function whatsappClearQueue(params = {}) {',
  '  // v16.47-clear-queue: zera a fila outbound — owner pediu reset total.',
  "  try {",
  '    const del = await q(',
  '      "DELETE FROM messages WHERE direction=\'outbound\' AND send_state <> \'delivered\' RETURNING id",',
  '      []',
  '    );',
  "    return ok('\\u{1F9F9} Fila zerada: ' + del.length + ' mensagem(ns) pendente(s)/falha(s) removida(s). Entregues intactas.');",
  '  } catch (e2) {',
  "    return err('falha ao zerar a fila: ' + (e2 && e2.message ? e2.message : e2));",
  '  }',
  '}',
  '',
].join('\n');
let out = src.slice(0, i) + fn + src.slice(i);
// registro no module.exports: clona a linha do whatsappSendMessage dentro do exports
const me = out.indexOf('module.exports');
if (me < 0) { console.error('[FAIL] module.exports nao achado'); process.exit(1); }
const lines = out.split('\n');
let meLine = -1;
for (let k = 0; k < lines.length; k++) { if (lines[k].includes('module.exports')) { meLine = k; break; } }
let insAt = -1, insIndent = '';
for (let k = meLine + 1; k < Math.min(meLine + 80, lines.length); k++) {
  if (lines[k].includes('whatsappSendMessage')) { insAt = k; insIndent = (lines[k].match(/^\s*/) || [''])[0]; break; }
  if (lines[k].trim() === '};' || lines[k].trim() === '}') break;
}
if (insAt < 0) { console.error('[FAIL] whatsappSendMessage nao achado dentro do module.exports'); process.exit(1); }
lines.splice(insAt + 1, 0, insIndent + 'whatsappClearQueue,');
out = lines.join('\n');
try { new vm.Script(out); } catch (e) { console.error('[FAIL] sintaxe quebrada — NADA escrito: ' + e.message); process.exit(1); }
fs.writeFileSync(f, out);
console.log('[OK] whatsappClearQueue adicionada e exportada (backup: ' + bak + ')');
console.log('[NEXT] falta registrar no tool-catalog.cjs pra Kimi ver a tool — me cola:');
console.log('  grep -n "whatsappSendMessage" ~/Documents/luna-kernel/packages/kernel/tool-catalog.cjs | head -3');
