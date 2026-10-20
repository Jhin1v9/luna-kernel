#!/usr/bin/env node
/**
 * fix-history-structure.js — prompt estruturado: historico separado + Luna: + msg atual (2026-10-20)
 *
 * Decreto owner: "tem que separar o historico e no final colocar MENSAGEM DE
 * AGORA DO USUARIO: e as msg da propria luna tem que vir como Luna: pra ela
 * saber quais sao as msg dela"
 *
 *   1. soul: historico marca respostas da propria Luna como "Luna:" (era "assistant:")
 *   2. configs (repo + runtime): templates firstMessage/followUp reescritos em
 *      blocos explicitos: --- HISTORICO DA CONVERSA --- / --- MENSAGEM ATUAL
 *      DO USUARIO --- + protocolo runtime Luna (o que ja funciona)
 *
 * USO:  node fix-history-structure.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ── 1. SOUL: assistant: -> Luna: ──
console.log('\x1b[36m=== 1/2 — luna-soul.cjs (prefixo Luna: no historico) ===\x1b[0m');
const SOUL = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\luna-soul.cjs';
fs.copyFileSync(SOUL, SOUL + '.bak-' + ts);
let soul = fs.readFileSync(SOUL, 'utf8');
const OLD = "        historyLines.push(`assistant: ${ev.response || ev.content || '[tool use]'}`);";
const NEW = "        historyLines.push(`Luna: ${ev.response || ev.content || '[tool use]'}`); // v16.0-fix (owner 20/10): marca as msg DELA — o modelo precisa saber o que ele mesmo ja disse";
if (soul.includes('Luna: ${ev.response')) {
  console.log('[SKIP] ja aplicado');
} else if (soul.includes(OLD)) {
  fs.writeFileSync(SOUL, soul.replace(OLD, NEW));
  console.log('[OK] historico: respostas da Luna agora sao "Luna:"');
} else {
  console.error('[FALHOU] padrao assistant: nao encontrado');
}

// ── 2. CONFIGS: templates em blocos explicitos ──
console.log('\n\x1b[36m=== 2/2 — luna-prompt-config.json (repo + runtime) ===\x1b[0m');
const TEMPLATE = `{{systemContext}}

--- HISTÓRICO DA CONVERSA ---
{{history}}

--- MENSAGEM ATUAL DO USUARIO ---
{{userInput}}

Responda como Luna, no registro adequado (cliente vs time). Identifique se quem fala é do time (Abner/Jhin/Enoque/Elias) ou cliente — e trate cada um no registro certo.

PROTOCOLO DE SAÍDA — RUNTIME LUNA (PREVALECE sobre qualquer instrução acima que cite {"response": ...} ou "Responda com EXATAMENTE UM dos formatos" — são de OUTRO canal. Única saída válida: {"tool": "NOME_EXATO", "params": {...}}):
- Responder alguém: {"tool": "whatsappSendMessage", "params": {"to": "NOME", "message": "texto"}}
- Achar contato/grupo: {"tool": "whatsappListContacts", "params": {"search": "trecho"}} / whatsappListGroups
- Memória da empresa: {"tool": "brainSearch", "params": {"query": "..."}} → brainRead {"id": "..."}
- Pedidos dos clientes: {"tool": "workspaceListClients", "params": {}} / workspaceListRequests
- Não sabe a tool? {"tool": "listTools", "params": {}} ou toolInfo {"name": "NOME"}
CADEIA: após CADA Tool Result, se a tarefa não acabou, emita a PRÓXIMA tool na hora — sem pedir confirmação.
CONTEXTO: este chat é PERSISTENTE — continue sempre nele. Só quando encher de verdade, continua em chat novo levando apenas a mensagem pendente.`;

for (const cfgPath of [
  'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\config\\luna-prompt-config.json',
  path.join(os.homedir(), '.luna', 'kernel', 'config', 'luna-prompt-config.json'),
]) {
  if (!fs.existsSync(cfgPath)) { console.log('  (nao existe: ' + cfgPath + ')'); continue; }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (cfg.prompts && cfg.prompts.followUp && cfg.prompts.followUp.includes('--- MENSAGEM ATUAL DO USUARIO ---')) {
    console.log('\x1b[90m  [SKIP]\x1b[0m ' + cfgPath + ' — ja estruturado');
    continue;
  }
  fs.copyFileSync(cfgPath, cfgPath + '.bak-' + ts);
  if (!cfg.prompts) cfg.prompts = {};
  cfg.prompts.followUp = TEMPLATE;
  cfg.prompts.firstMessage = TEMPLATE;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  console.log('\x1b[32m  [OK]\x1b[0m ' + cfgPath + ' — firstMessage/followUp em blocos explicitos');
}

try { execSync('pm2 restart luna-kernel', { encoding: 'utf8' }); console.log('\n[OK] luna-kernel reiniciado'); }
catch { console.log('pm2 restart falhou'); }

console.log('');
console.log('\x1b[32m✅ PROMPT ESTRUTURADO.\x1b[0m Historico separado, msg da Luna como "Luna:",');
console.log('   "MENSAGEM ATUAL DO USUARIO" no final. Compact funcional confirmado (ja era o caminho).');
console.log('\x1b[90mBackups: *.bak-' + ts + '\x1b[0m');
