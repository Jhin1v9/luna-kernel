#!/usr/bin/env node
/**
 * luna-scan2.js — extrai os trechos do fluxo de RETORNO da tool (2026-10-19)
 *
 * Arquitetura decidida: rota unica (MAIN) = extensao devolve resultado pra
 * pagina. Esse scan extrai do teu codigo LOCAL as pecas que o patch vai
 * conectar. Soh le e imprime, nao modifica nada.
 *
 * USO:  node luna-scan2.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';

function read(rel) {
  const f = path.join(ROOT, ...rel.split('/'));
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8');
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

// ===================== 1. SOUL: onde a tool termina e o resultado e composto
const soul = read('packages/kernel/luna-soul.cjs');
show('SOUL — trace TOOL_FINISHED (quem executa e loga)', soul, /TOOL_FINISHED/, 8, 4);
show('SOUL — processamento de domActionResults apos stream', soul, /domActionResults[\s\S]{0,80}?(map|forEach|for\s*\()/, 4, 25);
show('SOUL — composicao do toolResult/loopInput', soul, /toolResultPrompt[\s\S]{0,200}?(slice|substring|\+ result)/i, 6, 12);
show('SOUL — onde manda o resultado de volta (sendMessageStream no loop)', soul, /\/\*\s*=\s*=\s*=\s*TOOL[\s\S]{0,400}/i, 0, 30);

// ===================== 2. HANDLER: fila de retorno da extensao
const handler = read('packages/kernel/luna-extension-handler.cjs');
show('HANDLER — endpoint /ext/poll', handler, /['"]\/ext\/poll['"]|ext\/poll/, 5, 25);
show('HANDLER — queue de mensagens (session.messages / tool_result)', handler, /tool_result/, 10, 10);
show('HANDLER — toolExecutor wiring', handler, /toolExecutor/, 6, 8);

// ===================== 3. CONTENT.JS: o que faz com msgs do poll
const content = read('packages/kernel/luna-extension/content.js');
show('CONTENT — handler de mensagens vindas do poll', content, /poll|session\.messages|onMessage/i, 3, 30);
show('CONTENT — injecao no textarea / send', content, /textarea|editor|send|dispatch/i, 5, 20);

// ===================== 4. BRIDGE: _detectUiState (contexto do isGen)
const bridge = read('packages/kernel/kimi-bridge.cjs');
show('BRIDGE — _detectUiState (forcing isGenerating)', bridge, /_detectUiState/, 2, 40);
show('BRIDGE — canSteer', bridge, /canSteer/, 4, 8);

console.log('\n=== FIM DO SCAN ===');
