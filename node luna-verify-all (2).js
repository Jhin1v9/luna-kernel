#!/usr/bin/env node
/* luna-verify-all.js — auditoria: tudo que patchamos hoje ainda está no ar? (só leitura) */
const fs = require('fs');
const path = require('path');
const K = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const A = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';

const CHECKS = [
  // ── KERNEL ──
  ['K1  soul: roda/CDP persistente (v16.5)',        path.join(K,'packages/kernel/luna-soul.cjs'), 'v16.5-fix'],
  ['K2  voice-call-tools existe + place',           path.join(K,'packages/kernel/voice-call-tools.cjs'), 'voiceCallPlace'],
  ['K3  voiceCallEnd (desligar)',                   path.join(K,'packages/kernel/voice-call-tools.cjs'), 'voiceCallEnd'],
  ['K4  brief.objetivo',                            path.join(K,'packages/kernel/voice-call-tools.cjs'), 'objetivo: assunto'],
  ['K5  whatsapp-tools exporta resolveTarget',      path.join(K,'packages/kernel/whatsapp-tools.cjs'), 'resolveTarget,'],
  ['K6  luna-tools merge voice',                    path.join(K,'packages/kernel/luna-tools.cjs'), 'voice-call-tools'],
  ['K7  catalog: voiceCallPlace + End',             path.join(K,'packages/kernel/tool-catalog.cjs'), 'voiceCallEnd'],
  ['K8  prompt: regras v16.7',                      path.join(K,'packages/kernel/config/luna-prompt-config.json'), 'v16.7-fix'],
  ['K9  prompt: regra chat origem v16.8',           path.join(K,'packages/kernel/config/luna-prompt-config.json'), 'v16.8-fix'],
  ['K10 prompt: CHAMADAS',                          path.join(K,'packages/kernel/config/luna-prompt-config.json'), 'voiceCallPlace'],
  ['K11 prompt: ambiente host real (v16.5-B)',      path.join(K,'packages/kernel/config/luna-prompt-config.json'), 'HOST REAL desta máquina'],
  ['K12 chat-routes: sanitizer plain Copy',         path.join(K,'apps/dashboard/luna-chat-routes.js'), 'luna-fix-plain-copy'],
  // ── AGENT ──
  ['A1  config enum: kimi-web-local',               path.join(A,'packages/shared/src/config.ts'), "'kimi-web-local'"],
  ['A2  handler: sweeper done-only (v16.1)',        path.join(A,'apps/orchestrator/src/agent/handler.ts'), 'v16.1-fix'],
  ['A3  handler: batch+lock (v16.2)',               path.join(A,'apps/orchestrator/src/agent/handler.ts'), 'v16.2-fix'],
  ['A4  handler: origem no prompt (v16.8)',         path.join(A,'apps/orchestrator/src/agent/handler.ts'), 'v16.8-fix'],
  ['A5  handler: classify opt-in (v16.9)',          path.join(A,'apps/orchestrator/src/agent/handler.ts'), 'v16.9-fix'],
  ['A6  outbound: cadeia 1-por-vez (v16.3)',        path.join(A,'apps/whatsplay/src/outbound.ts'), 'deliverChain'],
  ['A7  ingest: dedupe conteúdo (v16.6)',           path.join(A,'apps/whatsplay/src/ingest.ts'), 'v16.6-fix'],
  ['A8  auto-repair: diagnóstico silencioso',       path.join(A,'apps/whatsplay/src/auto-repair.ts'), 'v16.4-fix'],
  ['A9  classify: leitura ao vivo (v16.11)',        path.join(A,'apps/worker/src/jobs/classify.ts'), 'v16.11-fix'],
  ['A10 conductor: mirrorTurno',                    path.join(A,'apps/whatsplay/src/voice/call-conductor.ts'), 'mirrorTurno'],
  ['A11 conductor: convId + reply_chat',            path.join(A,'apps/whatsplay/src/voice/call-conductor.ts'), 'replyChat'],
  ['A12 executor: externalEnd',                     path.join(A,'apps/whatsplay/src/voice/call-executor.ts'), 'externalEnd'],
  ['A13 executor: break do externalEnd',            path.join(A,'apps/whatsplay/src/voice/call-executor.ts'), 'if (externalEnd) break;'],
  ['A14 executor: reply_chat repass',               path.join(A,'apps/whatsplay/src/voice/call-executor.ts'), 'reply_chat: (brief as'],
  ['A15 healer: kill-switch (HEAL_ENABLED)',        path.join(A,'apps/worker/src/selfheal/heal.ts'), 'HEAL_ENABLED'],
  ['A16 healer: rollback desativado',               path.join(A,'apps/worker/src/selfheal/heal.ts'), 'rollback pro LKG NAO executado'],
  // ── ENV ──
  ['E1  .env: VOICE_CALL_ENABLED=true',             path.join(A,'.env'), 'VOICE_CALL_ENABLED=true'],
  ['E2  .env: LUNA_CLASSIFY_ENABLED=1',             path.join(A,'.env'), 'LUNA_CLASSIFY_ENABLED=1'],
  ['E3  .env: QUIET_HOURS_ALLOWED com time',        path.join(A,'.env'), 'enoque'],
];

let falhas = 0;
for (const [label, file, marker] of CHECKS) {
  let st = '[??]';
  try {
    const src = fs.readFileSync(file, 'utf8');
    st = src.includes(marker) ? '[OK]' : '[FALTOU]';
  } catch { st = '[SEM ARQUIVO]'; }
  if (st !== '[OK]') falhas++;
  console.log(st.padEnd(14) + label);
}
console.log('');
console.log(falhas === 0
  ? '=== TUDO NO AR (' + CHECKS.length + '/' + CHECKS.length + ') — healer não comeu nada commitável ==='
  : '=== ' + falhas + ' ITENS FALTANDO — os scripts são idempotentes, é só re-rodar os do item correspondente ===');