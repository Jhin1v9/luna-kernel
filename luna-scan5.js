#!/usr/bin/env node
/**
 * luna-scan5.js — extrai a logica da fila de envio do whatsplay (2026-10-20)
 *
 * Problema (owner): a fila nao serializa por conversa — a Luna nao termina de
 * escrever no chat A e ja pula pro B; e msg identica foi enviada 2x. Preciso
 * ver o loop de processamento da fila pra implementar:
 *   - serial por conversa (termina todos os envios do contato antes do proximo)
 *   - dedup (mesmo to+texto em janela curta = 1 envio)
 *
 * USO:  node luna-scan5.js   (cola o output inteiro aqui)
 */
const fs = require('fs');
const path = require('path');
const ROOT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';

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

const out = read('apps/whatsplay/src/outbound.ts');
show('OUTBOUND — processamento da fila (loop principal)', out, /sendQueue|processQueue|while.*queue|drain|dequeue/i, 10, 50);
show('OUTBOUND — pickNext/peek (como escolhe o proximo)', out, /pickNext|peekNext|nextMessage/i, 8, 30);

const sq = read('apps/whatsplay/src/send-queue.ts');
show('SEND-QUEUE — estrutura e ordenacao', sq, /ORDER BY|order by|sort\(|class|export/i, 5, 40);
