#!/usr/bin/env node
/**
 * luna-scan8.js — extrai os 2 pontos da FASE 1 v1: divisao code/work (2026-10-20)
 *
 * KERNEL (luna-chat-routes.js): formato exato de criar sessao + POST /api/chat
 *   (pra aceitar mode:'work' + sessionId persistente vindo do orchestrator).
 * AGENT (orchestrator): onde o brain eh chamado hoje (adapter fastBrain/roda)
 *   (pra trocar pela chamada HTTP pro kernel webchat).
 *
 * USO:  node luna-scan8.js   (cola o output INTEIRO aqui)
 */
const fs = require('fs');
const path = require('path');

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function show(label, content, regex, before = 0, after = 0) {
  console.log('\n========================================');
  console.log('### ' + label);
  console.log('========================================');
  if (content === null) { console.log('ARQUIVO NAO ENCONTRADO'); return; }
  const mm = new RegExp(regex.source, regex.flags).exec(content);
  if (!mm) { console.log('NAO ENCONTRADO: ' + regex); return; }
  const lines = content.split('\n');
  const idx = content.slice(0, mm.index).split('\n').length - 1;
  const start = Math.max(0, idx - before);
  const end = Math.min(lines.length, idx + mm[0].split('\n').length + after);
  console.log('--- linhas ' + (start + 1) + ' a ' + end + ' ---');
  for (let i = start; i < end; i++) console.log(String(i + 1).padStart(5) + ' | ' + lines[i]);
}

// ── KERNEL ──
const KR = read('C:\\Users\\Abner\\Documents\\luna-kernel\\apps\\dashboard\\luna-chat-routes.js');
show('KERNEL — criacao de sessao', KR, /app\.(post|get)\(['"]\/api\/(sessions|session)/i, 3, 30);
show('KERNEL — POST /api/chat (inicio)', KR, /app\.post\(['"]\/api\/chat/i, 3, 40);
show('KERNEL — estrutura do objeto session', KR, /(const session = \{|sessions\.set\()/i, 5, 20);

// ── AGENT: onde o brain eh chamado ──
const AG = read('C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\orchestrator\\src\\agent\\handler.ts');
show('AGENT — handler: chamada ao brain/router', AG, /runFastRoute|fastBrain|adapter\.|sendTurn/i, 12, 30);

const CTX = read('C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\orchestrator\\src\\agent\\context.ts');
show('AGENT — context: montagem do prompt pro brain', CTX, /renderConversationPrompt|buildPrompt/i, 3, 15);
