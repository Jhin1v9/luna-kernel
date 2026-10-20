#!/usr/bin/env node
/**
 * luna-scan4.js — extrai os 3 pontos onde a REGRA DO OWNER entra (2026-10-20)
 *
 * Regra (decreto owner): "tool entregue no frontend da Luna Web -> turno acabou
 * (isGen=false, sem veto de UI)". Pra implementar de verdade preciso ver:
 *   1. o loop de eventos da stream na soul (onde o resultado eh entregue)
 *   2. o momento exato do TOOL_FINISHED (execucao + entrega)
 *   3. o loop SSE do chat-routes (quem manda o card pro frontend)
 *
 * USO:  node luna-scan4.js   (cola o output inteiro aqui)
 */
const fs = require('fs');
const path = require('path');
const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';

function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8'); }
  catch { return null; }
}
function show(label, content, regex, before = 0, after = 0) {
  console.log('\n========================================');
  console.log('### ' + label);
  console.log('========================================');
  if (content === null) { console.log('ARQUIVO NAO ENCONTRADO'); return; }
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  const m = re.exec(content);
  if (!m) { console.log('PADRAO NAO ENCONTRADO: ' + regex); return; }
  const lines = content.split('\n');
  const idx = content.slice(0, m.index).split('\n').length - 1;
  const start = Math.max(0, idx - before);
  const end = Math.min(lines.length, idx + m[0].split('\n').length + after);
  console.log('--- linhas ' + (start + 1) + ' a ' + end + ' ---');
  for (let i = start; i < end; i++) console.log(String(i + 1).padStart(5) + ' | ' + lines[i]);
}

const soul = read('packages/kernel/luna-soul.cjs');
show('SOUL — loop de eventos da stream (for await)', soul, /for await \(const event of stream\)/, 3, 45);
show('SOUL — TOOL_FINISHED (execucao da tool)', soul, /TOOL_FINISHED/, 25, 12);
show('SOUL — case action_detected (como a soul recebe a action)', soul, /action_detected/, 5, 25);

const routes = read('apps/dashboard/luna-chat-routes.cjs');
show('ROUTES — loop SSE (entrega pro frontend)', routes, /for await/, 5, 40);
