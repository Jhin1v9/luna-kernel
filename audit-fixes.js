#!/usr/bin/env node
/* audit-fixes.js — auditoria de quais fixes estão realmente aplicados
   no kernel/agent local. Só leitura. Tabela OK/FALTA por marcador. */
const fs = require('fs');

const K = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel';
const A = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';

const CHECKS = [
  ['v16.13b prompts leves (soul)',        K + '\\luna-soul.cjs',         'v16.13b-fix'],
  ['v16.13c voice dispatch (soul)',       K + '\\luna-soul.cjs',         "case 'voiceCallPlace'"],
  ['v16.14  NGT-1 rede manda (bridge)',   K + '\\kimi-bridge.cjs',       'v16.14-fix'],
  ['v16.14b NGT-1b stream gate (bridge)', K + '\\kimi-bridge.cjs',       'v16.14b-fix'],
  ['v16.15  markers T2 (bridge)',         K + '\\kimi-bridge.cjs',       'v16.15: marker do modelo'],
  ['v16.16  spec goal-oriented (config)', K + '\\config\\luna-prompt-config.json', 'PROTOCOLO DE EXECUCAO (v16.16'],
  ['v16.16  override classify (soul)',    K + '\\luna-soul.cjs',         'SESSÃO DE CLASSIFICAÇÃO'],
  ['v16.17  guardrail registry (wplay)',  A + '\\apps\\whatsplay\\src\\outbound.ts', 'v16.17-fix'],
  ['v16.19  gate classifier (orch)',      A + '\\apps\\orchestrator\\src\\agent\\handler.ts', 'v16.19-fix'],
  ['v16.19  classify:main (worker)',      A + '\\apps\\worker\\src\\jobs\\classify.ts', "'classify:main'"],
  ['v16.20  schema send (registry)',      K + '\\lib\\tool-registry.cjs', '"whatsappSendMessage"'],
  ['v16.21  dedup rescue (bridge)',       K + '\\kimi-bridge.cjs',       'v16.21-fix'],
  ['v16.22  cdp-only .env',               'C:\\Users\\Abner\\Documents\\luna-kernel\\.env', 'LUNA_WEB_USE_AGENT_CONFIG=false'],
];

let faltam = 0;
for (const [name, file, marker] of CHECKS) {
  let ok = false, err = '';
  try { ok = fs.readFileSync(file, 'utf8').includes(marker); } catch (e) { err = ' ' + e.message; }
  console.log((ok ? '[OK]  ' : '[FALTA]') + ' ' + name + (err ? ' — arquivo:' + err : ''));
  if (!ok) faltam++;
}
console.log('');
console.log(faltam === 0 ? '=== TODOS OS FIXES APLICADOS ===' : '=== ' + faltam + ' FIXES PENDENTES — aplique os que faltam ANTES do próximo teste ===');

// T2 do v16.20/21 (esclarecimento do "to") — varre o config inteiro
try {
  const cfg = JSON.parse(fs.readFileSync(K + '\\config\\luna-prompt-config.json', 'utf8'));
  const hit = JSON.stringify(cfg).includes('v16.20-fix') || JSON.stringify(cfg).includes('NUNCA use a palavra');
  console.log(hit ? '[OK]   v16.20 esclarecimento do "to" (config)' : '[FALTA] v16.20 esclarecimento do "to" (config)');
} catch (e) { console.log('[FALTA] config ilegível: ' + e.message); }
