#!/usr/bin/env node
/**
 * luna-scan3.js — extrai o fluxo de retorno da tool na luna-soul.cjs LOCAL
 * Soh le e imprime. USO: node luna-scan3.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';

function read(rel) {
  const f = path.join(ROOT, ...rel.split('/'));
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}
function show(label, content, regex, before = 0, after = 0) {
  console.log('\n========================================');
  console.log('### ' + label);
  console.log('========================================');
  if (content === null) { console.log('ARQUIVO NAO ENCONTRADO'); return; }
  const m = content.match(regex);
  if (!m) { console.log('PADRAO NAO ENCONTRADO: ' + regex); return; }
  const lines = content.split('\n');
  const idx = content.slice(0, m.index).split('\n').length - 1;
  const start = Math.max(0, idx - before);
  const end = Math.min(lines.length, idx + m[0].split('\n').length + after);
  console.log('--- linhas ' + (start + 1) + ' a ' + end + ' ---');
  for (let i = start; i < end; i++) console.log(String(i + 1).padStart(5) + ' | ' + lines[i]);
}

const soul = read('packages/kernel/luna-soul.cjs');

// 1. onde a tool termina (o trace que vimos no log)
show('SOUL — TOOL_FINISHED (fim da execucao)', soul, /TRACE.*TOOL_FINISHED|TOOL_FINISHED/, 15, 10);
// 2. composicao do toolLoop / resultado que volta pro provider
show('SOUL — template toolLoop [TOOL LOOP]', soul, /\[TOOL LOOP\]|toolLoop\s*[:=]/i, 5, 15);
// 3. onde o resultado eh enviado de volta (sendMessageStream dentro do loop de tools)
show('SOUL — chamada que manda resultado de volta ao provider', soul, /(sendMessageStream|sendFollowUp|submitFollowUp)\([^)]*(toolResult|loopInput|TOOL)/i, 10, 20);
// 4. lida com domActionResults
show('SOUL — domActionResults (coleta apos execucao)', soul, /domActionResults\s*=|domActionResults\.push/, 6, 15);
// 5. onde o handler eh criado no server (pra expor global)
const server = read('apps/dashboard/luna-server.js');
show('SERVER — criacao do extensionHandler', server, /extensionHandler|LunaExtensionHandler/, 5, 15);

console.log('\n=== FIM DO SCAN ===');
