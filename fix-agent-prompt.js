#!/usr/bin/env node
/**
 * fix-agent-prompt.js — PROTOCOLO MODO WHATSAPP no prompt do agent (2026-10-20)
 * v2: sem crases no conteudo (a v1 quebrou o template literal com ```json)
 *
 * USO:  node fix-agent-prompt.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const FILE = path.join(ROOT, 'apps', 'orchestrator', 'src', 'agent', 'context.ts');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!fs.existsSync(FILE)) { console.error('Nao encontrado: ' + FILE); process.exit(1); }
fs.copyFileSync(FILE, FILE + '.bak-' + ts);
let src = fs.readFileSync(FILE, 'utf8');
const isCrlf = src.includes('\r\n');
const norm = (s) => isCrlf ? s.replace(/\n/g, '\r\n') : s;

const OLD1 = `    'Responda como Luna, no registro adequado (cliente vs time). Identifique se',
    'quem fala é do time (Abner/Jhin/Enoque/Elias) ou cliente — e trate cada um',
    'no registro certo.',
  ].join('\\n');
}

// ─────────────────────────── Context packs (§7.9) — F3 ───────────────────────────`;

const NEW1 = `    'Responda como Luna, no registro adequado (cliente vs time). Identifique se',
    'quem fala é do time (Abner/Jhin/Enoque/Elias) ou cliente — e trate cada um',
    'no registro certo.',
    '',
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
    '  sem reenviar historico, sem resumo.',
  ].join('\\n');
}

// ─────────────────────────── Context packs (§7.9) — F3 ───────────────────────────`;

const OLD2 = `    '',
    'Responda como Luna, no registro adequado (cliente vs time).',
  ].join('\\n');
}`;

const NEW2 = `    '',
    'Responda como Luna, no registro adequado (cliente vs time).',
    '',
    'PROTOCOLO DE SAIDA — MODO WHATSAPP (prevalece sobre qualquer instrucao acima',
    'que cite {"response": ...}; neste canal "response" NAO EXISTE): unica saida',
    'valida e UMA tool call em JSON {"tool": "NOME", "params": {...}} — responder',
    'alguem e SEMPRE via tool de envio de msg do WhatsApp (owners no privado:',
    'Noke, Abner, Elias). Nao sabe a tool? {"tool": "listTools", "params": {}}',
    'primeiro. CONTEXTO: mesmo chat ate o limite; quando encher, chat novo so com',
    'a mensagem pendente — sem reenviar historico.',
  ].join('\\n');
}`;

let patches = 0;
if (src.includes('PROTOCOLO DE SAIDA — MODO WHATSAPP')) {
  console.log('[SKIP] protocolo ja instalado');
} else {
  for (const [label, OLD, NEW] of [['renderConversationPrompt', OLD1, NEW1], ['renderPackPrompt', OLD2, NEW2]]) {
    const o = norm(OLD), n = norm(NEW);
    const count = src.split(o).length - 1;
    if (count !== 1) { console.error('[FALHOU] ' + label + ' — ancora ' + count + 'x'); continue; }
    src = src.replace(o, n);
    console.log('[OK] ' + label + ' — protocolo WHATSAPP no final do prompt');
    patches++;
  }
  if (patches > 0) fs.writeFileSync(FILE, src);
}

try {
  execSync('pm2 restart luna-orchestrator', { encoding: 'utf8' });
  console.log('[OK] luna-orchestrator reiniciado');
} catch { console.log('pm2 restart falhou — roda manual'); }

console.log('');
console.log('\x1b[32m✅ PROMPT DO AGENT ATUALIZADO.\x1b[0m');
console.log('   - "response" deixou de ser saida valida');
console.log('   - envio privado pros owners (Noke, Abner, Elias)');
console.log('   - listTools como porta de descoberta');
console.log('   - persistencia de contexto instruida');
console.log('\x1b[90mBackup: context.ts.bak-' + ts + '\x1b[0m');
