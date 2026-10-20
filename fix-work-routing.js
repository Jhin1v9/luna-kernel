#!/usr/bin/env node
/**
 * fix-work-routing.js — FASE 1 v1: WhatsApp roteia pro kernel (sessao work) (2026-10-20)
 *
 * Decreto owner: divisao code/work no CODIGO primeiro. Regra:
 *   - msg digitada no textarea do localhost:3458  -> area 'code' (ja eh o padrao)
 *   - msg vinda do orchestrator (whatsapp)        -> POST /api/chat do KERNEL
 *     com sessionId 'work-<conversationId>' + area 'work' — mesmo pipeline
 *     curado (entrega=turno, tools, loopback), contexto PERSISTENTE (a sessao
 *     work vive ate o contexto encher; o kernel segue a regra da msg pendente).
 *
 * O handler do orchestrator so troca a FONTE do answerText: em vez de
 * runFastRoute (brain local, protocolo duplo), askKernelWorkKernel (HTTP pro
 * kernel webchat). Delivery/fila/auditoria intactos. Env LUNA_WORK_VIA_KERNEL=0
 * volta pro caminho antigo (A/B test).
 *
 * USO:  node fix-work-routing.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const FILE = path.join(ROOT, 'apps', 'orchestrator', 'src', 'agent', 'handler.ts');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!fs.existsSync(FILE)) { console.error('Nao encontrado: ' + FILE); process.exit(1); }
fs.copyFileSync(FILE, FILE + '.bak-' + ts);
let src = fs.readFileSync(FILE, 'utf8');
const isCrlf = src.includes('\r\n');
const norm = (s) => isCrlf ? s.replace(/\n/g, '\r\n') : s;

let patches = 0;
function rep(label, OLD, NEW) {
  const o = norm(OLD), n = norm(NEW);
  const count = src.split(o).length - 1;
  if (count !== 1) { console.error('[FALHOU] ' + label + ' — ' + count + 'x'); return false; }
  src = src.split(o).join(n);
  console.log('[OK] ' + label);
  patches++;
  return true;
}

if (src.includes('askKernelWorkKernel')) {
  console.log('[SKIP] ja aplicado');
} else {
  rep('P1: helper askKernelWorkKernel (HTTP pro kernel webchat)',
`export function createMessageHandler(deps: MessageHandlerDeps) {`,
`// v16.0 — FASE 1 (decreto owner 20/10): conversa WhatsApp -> kernel na sessao
// work-<conversation> (area 'work'). Mesmo pipeline curado do webchat, sem
// tradutor de protocolo, contexto persistente ate encher (regra: so a msg
// pendente vai pro chat novo). Polling simples do endpoint de mensagens.
async function askKernelWorkKernel(
  text: string,
  conversationId: string,
  log: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void },
): Promise<string> {
  const base = (process.env.LUNA_KERNEL_URL || 'http://localhost:3458').replace(/\\/+$/, '');
  const sessionId = 'work-' + conversationId;
  const fetchJson = async (url: string) => {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      return await r.json().catch(() => null);
    } catch { return null; }
  };
  const listMessages = async () => {
    const data = (await fetchJson(\`\${base}/api/chat/session/\${sessionId}/messages\`)) as
      | Array<{ role?: string; content?: string }>
      | { messages?: Array<{ role?: string; content?: string }> }
      | null;
    if (Array.isArray(data)) return data;
    return data?.messages ?? [];
  };

  const before = await listMessages();
  const beforeCount = before.length;

  const post = await fetch(\`\${base}/api/chat\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: text,
      sessionId,
      area: 'work',
      mode: process.env.LUNA_WORK_MODE || 'instant',
    }),
  });
  if (!post.ok) throw new Error(\`kernel /api/chat HTTP \${post.status}\`);
  log.info({ sessionId }, 'work: msg enviada pro kernel (sessao work persistente)');

  const startedAt = Date.now();
  const timeoutMs = Number(process.env.LUNA_WORK_TIMEOUT_MS || 180_000);
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    const arr = await listMessages();
    if (arr.length > beforeCount) {
      const last = arr[arr.length - 1];
      if (last && last.role === 'assistant' && last.content) return last.content;
    }
  }
  throw new Error('kernel work: timeout aguardando resposta (' + Math.round(timeoutMs / 1000) + 's)');
}

export function createMessageHandler(deps: MessageHandlerDeps) {`);

  rep('P2: handler usa kernel pra work (answerText da sessao work)',
`    const decision = await runFastRoute(
      { pool: eventPool, adapter, log },
      {
        event,
        prompt,
        sessionKey: conversationId,
        allowLiveHandoff: route.allowLiveHandoff,
        imageBase64,
        // Config da route (§4, routes.json) — investigation_budget /
        // investigation_timeout_ms, zero hardcode.
        investigationBudget: route.investigationBudget,
        investigationTimeoutMs: route.investigationTimeoutMs,
      },
    );`,
`    // v16.0 — FASE 1 (decreto owner 20/10): WhatsApp -> kernel (area work,
    // sessao work-<conversation> persistente). LUNA CODE continua no brain
    // local. LUNA_WORK_VIA_KERNEL=0 volta pro runFastRoute (A/B).
    type FastDecision = Awaited<ReturnType<typeof runFastRoute>>;
    let decision: FastDecision;
    if (process.env.LUNA_WORK_VIA_KERNEL !== '0') {
      const answerText = await askKernelWorkKernel(text, conversationId, log);
      decision = {
        output: { type: 'ANSWER' as const },
        answerText,
        toolRounds: 0,
        turn: {},
      } as unknown as FastDecision;
    } else {
      decision = await runFastRoute(
        { pool: eventPool, adapter, log },
        {
          event,
          prompt,
          sessionKey: conversationId,
          allowLiveHandoff: route.allowLiveHandoff,
          imageBase64,
          // Config da route (§4, routes.json) — investigation_budget /
          // investigation_timeout_ms, zero hardcode.
          investigationBudget: route.investigationBudget,
          investigationTimeoutMs: route.investigationTimeoutMs,
        },
      );
    }`);
}

if (patches === 2) fs.writeFileSync(FILE, src);

for (const svc of ['luna-orchestrator', 'luna-worker']) {
  try { execSync(`pm2 restart ${svc}`, { encoding: 'utf8' }); console.log('[OK] ' + svc + ' reiniciado'); }
  catch { console.log('[AVISO] ' + svc + ' nao reiniciou'); }
}

console.log('');
console.log('\x1b[32m✅ FASE 1 V1 NO AR.\x1b[0m');
console.log('   WhatsApp -> kernel sessao work-<conversa> (area work, MESMO pipeline).');
console.log('   Webchat  -> code (inalterado). A/B: LUNA_WORK_VIA_KERNEL=0.');
console.log('');
console.log('   TESTE: manda msg pro WhatsApp da Luna. Deve aparecer:');
console.log('   - log "work: msg enviada pro kernel"');
console.log('   - UMA aba so (a sessao work reutiliza o chat ate encher)');
console.log('   - resposta volta pro zap via fila');
console.log('\x1b[90mBackup: handler.ts.bak-' + ts + '\x1b[0m');
