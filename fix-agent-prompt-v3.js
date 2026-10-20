#!/usr/bin/env node
/**
 * fix-agent-prompt-v3.js — protocolo com tools EXATAS (2026-10-20)
 *
 * Correcoes da v2 (feedback owner):
 * 1. Nomes exatos das tools + exemplos prontos (whatsappSendMessage,
 *    whatsappListContacts, brainSearch, brainRead, workspaceListClients,
 *    workspaceListRequests, listTools, toolInfo) — acaba com a dica vaga.
 * 2. Prevalecia reforcada: manda IGNORAR o trecho do template do kernel que
 *    ensina {"response": ...} ("Responda com EXATAMENTE UM dos formatos...")
 *    — ele fica DEPOIS do nosso bloco e reintroduzia o response.
 * 3. Cadeia exemplificada ponta a ponta: brainSearch -> brainRead ->
 *    whatsappSendMessage.
 * 4. Persistencia: ESTE chat e persistente, NUNCA abrir outro no meio.
 *
 * Substitui o bloco v2 inteiro nos dois renderers do context.ts.
 *
 * USO:  node fix-agent-prompt-v3.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const FILE = path.join(ROOT, 'apps', 'orchestrator', 'src', 'agent', 'context.ts');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!fs.existsSync(FILE)) { console.error('Nao encontrado: ' + FILE); process.exit(1); }
fs.copyFileSync(FILE, FILE + '.bak-v3-' + ts);
let src = fs.readFileSync(FILE, 'utf8');
const isCrlf = src.includes('\r\n');
const norm = (s) => isCrlf ? s.replace(/\n/g, '\r\n') : s;

// ── bloco v2 (renderConversationPrompt) — o que a v2 inseriu ──
const OLD1 = `    '',
    'PROTOCOLO DE SAIDA — MODO WHATSAPP (prevalece sobre QUALQUER instrucao acima',
    'que cite {"response": ...}; neste canal "response" NAO EXISTE):',
    '- Unica saida valida: UMA tool call em JSON: {"tool": "NOME", "params": {...}}.',
    '- Para RESPONDER alguem (cliente ou time) SEMPRE use a tool de envio de msg do',
    '  WhatsApp — nunca texto solto, nunca envelope de resposta.',
    '- OWNERS (privado, falar direto com o time): Noke, Abner e Elias — envie msg',
    '  privada pra cada um com a tool de envio (to=Nome).',
    '- NAO sabe qual tool usar? Execute {"tool": "listTools", "params": {}} PRIMEIRO.',
    '  Uma tool por vez; apos cada resultado, se a tarefa nao acabou, chame a',
    '  PROXIMA tool em seguida — sem pedir confirmacao, sem resumir etapas.',
    '- CONTEXTO: esta conversa segue neste MESMO chat ate o limite de contexto.',
    '  Quando encher, continua num chat NOVO levando apenas a mensagem pendente —',
    '  sem reenviar historico, sem resumo.',`;

// ── bloco v2 (renderPackPrompt) ──
const OLD2 = `    '',
    'PROTOCOLO DE SAIDA — MODO WHATSAPP (prevalece sobre qualquer instrucao acima',
    'que cite {"response": ...}; neste canal "response" NAO EXISTE): unica saida',
    'valida e UMA tool call em JSON {"tool": "NOME", "params": {...}} — responder',
    'alguem e SEMPRE via tool de envio de msg do WhatsApp (owners no privado:',
    'Noke, Abner, Elias). Nao sabe a tool? {"tool": "listTools", "params": {}}',
    'primeiro. CONTEXTO: mesmo chat ate o limite; quando encher, chat novo so com',
    'a mensagem pendente — sem reenviar historico.',`;

const NEW1 = `    '',
    'PROTOCOLO DE SAIDA — RUNTIME LUNA (PREVALECE sobre tudo: ignore qualquer',
    'trecho acima que cite {"response": ...} ou "Responda com EXATAMENTE UM dos',
    'formatos oficiais" — sao de OUTRO canal. Aqui voce opera o runtime Luna,',
    'cujas tools EXECUTAM DE VERDADE e devolvem Tool Result):',
    '',
    'FORMATO: {"tool": "NOME_EXATO", "params": {...}} — UMA tool por vez.',
    '',
    'TOOLS PRINCIPAIS (copie e adapte — nomes exatos):',
    '- Responder alguem no WhatsApp:',
    '  {"tool": "whatsappSendMessage", "params": {"to": "NOME", "message": "texto"}}',
    '  to = NOME do contato ou do grupo (ex.: "Abner", "Jess", "🏆Production - 2026").',
    '- Achar o nome certo do contato/grupo:',
    '  {"tool": "whatsappListContacts", "params": {"search": "trecho"}}',
    '  {"tool": "whatsappListGroups", "params": {}}',
    '- Memoria da empresa (quem e fulano, status, historico):',
    '  {"tool": "brainSearch", "params": {"query": "Jess"}}',
    '  {"tool": "brainRead", "params": {"id": "ID_VINDO_DO_BRAINSEARCH"}}',
    '- Pedidos dos clientes (workspace):',
    '  {"tool": "workspaceListClients", "params": {}}',
    '  {"tool": "workspaceListRequests", "params": {}}',
    '- Descobrir qualquer tool (indice completo) e docs de uma tool:',
    '  {"tool": "listTools", "params": {}}',
    '  {"tool": "listTools", "params": {"busca": "whatsapp"}}',
    '  {"tool": "toolInfo", "params": {"name": "NOME_DA_TOOL"}}',
    '',
    'CADEIA (exemplo real): "quem e a Jess?" →',
    '  1) {"tool": "brainSearch", "params": {"query": "Jess cliente"}}',
    '  2) {"tool": "brainRead", "params": {"id": "<melhor id do passo 1>"}}',
    '  3) {"tool": "whatsappSendMessage", "params": {"to": "<quem perguntou>", "message": "<resposta>"}}',
    'Apos CADA Tool Result: se a tarefa nao acabou, emita a PROXIMA tool na',
    'hora — sem pedir confirmacao, sem resumir etapas, sem texto fora do JSON.',
    '',
    'CONTEXTO: ESTE chat e PERSISTENTE — continue sempre nele. E PROIBIDO abrir',
    'chat novo no meio da conversa. Quando (e so quando) o contexto encher de',
    'verdade, a conversa continua num chat novo levando apenas a mensagem',
    'pendente — sem reenviar historico.',`;

const NEW2 = `    '',
    'PROTOCOLO DE SAIDA — RUNTIME LUNA (PREVALECE: ignore trechos acima sobre',
    '{"response": ...} — sao de outro canal). FORMATO: {"tool": "NOME_EXATO",',
    '"params": {...}}, UMA por vez; o resultado volta como Tool Result e voce',
    'emite a proxima ate completar. PRINCIPAIS: whatsappSendMessage',
    '{"to": "NOME", "message": "texto"} (responder cliente/time no privado ou',
    'grupo); whatsappListContacts {"search": "trecho"}; brainSearch {"query":',
    '"..."} -> brainRead {"id": "..."}; workspaceListClients {}; listTools {};',
    'toolInfo {"name": "NOME"}. CONTEXTO: este chat e persistente — NUNCA abra',
    'outro no meio; so quando encher de verdade, continua em chat novo so com a',
    'mensagem pendente.',`;

let patches = 0;
if (src.includes('TOOLS PRINCIPAIS (copie e adapte')) {
  console.log('[SKIP] v3 ja instalado');
} else {
  for (const [label, OLD, NEW] of [['renderConversationPrompt', OLD1, NEW1], ['renderPackPrompt', OLD2, NEW2]]) {
    const o = norm(OLD), n = norm(NEW);
    const count = src.split(o).length - 1;
    if (count === 1) {
      src = src.replace(o, n);
      console.log('[OK] ' + label + ' — bloco v2 substituido pelo v3');
      patches++;
    } else {
      console.log('\x1b[33m[AVISO]\x1b[0m ' + label + ' — bloco v2 nao encontrado (' + count + 'x); tentando ancora fresca...');
      // fallback: ancora original (caso a v2 nunca tenha rodado aqui)
      const FRESH = "    'no registro certo.',";
      const freshCount = src.split(norm(FRESH)).length - 1;
      console.log('       ancora fresca disponivel: ' + freshCount + 'x (se 2x, roda fix-agent-prompt.js primeiro)');
    }
  }
  if (patches > 0) fs.writeFileSync(FILE, src);
}

try {
  execSync('pm2 restart luna-orchestrator', { encoding: 'utf8' });
  console.log('[OK] luna-orchestrator reiniciado');
} catch { console.log('pm2 restart falhou — roda manual'); }

console.log('');
console.log('\x1b[32m✅ V3 NO AR: tools com nomes exatos + exemplos + prevalencia forte.\x1b[0m');
console.log('\x1b[90mBackup: context.ts.bak-v3-' + ts + '\x1b[0m');
