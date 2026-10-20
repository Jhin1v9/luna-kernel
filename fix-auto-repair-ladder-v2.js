#!/usr/bin/env node
/**
 * fix-auto-repair-ladder-v2.js — escada de evidencia + cooldown, SEM triagem noscript (2026-10-20)
 *
 * v1 tinha triagem automatica por "/noscript/i" no DOM — RETIRADA por decreto
 * owner: o meta tag _fb_noscript eh ESTATICO no HTML do WhatsApp Web (fallback
 * pra browser sem JS) e aparece ate em pagina saudavel -> falso positivo
 * permanente -> watchdog reiniciando em loop. NAO se auto-recupera por esse
 * sinal. A escada sobe a evidencia e no fim chama HUMANO (Telegram).
 *
 * USO:  node fix-auto-repair-ladder-v2.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const FILE = path.join(ROOT, 'apps', 'whatsplay', 'src', 'auto-repair.ts');
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

const hasV1 = src.includes('noscript|_fb_noscript|bootstrapWebSession');
const hasV2 = src.includes('__repairExhaustedAt');

if (hasV2 && !hasV1) {
  console.log('[SKIP] v2 ja aplicada (sem triagem)');
} else {
  if (hasV1) {
    // REMOVE a triagem da v1 (decreto owner: falso positivo permanente)
    rep('P0: removida triagem noscript (falso positivo)',
`      // v14.8-fix (owner 20/10) — TRIAGEM LOCAL: DOM em noscript/splash = problema
      // de ESTADO DE PAGINA. Seletor CSS nao conserta estado de pagina — retry
      // local sem gastar turno de provider (o watchdog recupera a pagina).
      if (/noscript|_fb_noscript|bootstrapWebSession/i.test(dom)) {
        deps.log.warn({ action: actionName, attempt }, 'auto-reparo: pagina em noscript/splash — retry local sem provider');
        try {
          const t = deps.transport as { recoverPage?: () => Promise<unknown> };
          if (typeof t.recoverPage === 'function') await t.recoverPage();
        } catch { /* recovery eh melhor-esforco */ }
        suggested = null;
        continue;
      }
      // ESCADA DE EVIDENCIA (owner 20/10): 1a falha = so texto; 2a = PRINT real.`,
`      // ESCADA DE EVIDENCIA (owner 20/10): 1a falha = so texto; 2a = PRINT real.
      // (sem triagem automatica de noscript: o meta tag _fb_noscript eh estatico
      // no HTML do WA e falso-positiva em pagina saudavel — decreto owner)`);
  }

  if (!src.includes('REPAIR_COOLDOWN_MS')) {
    rep('P1: cooldown pos-esgotamento (modulo)',
`export interface RepairableTransport extends WhatsAppTransport {`,
`// v14.8-fix (owner 20/10): cooldown pos-esgotamento — UMA sessao de reparo
// por acao por janela. Sem isso, N msgs na fila viravam N sessoes de reparo
// (N x 3 diagnosticos = enchente de abas no provider).
const REPAIR_COOLDOWN_MS = Number(process.env.REPAIR_COOLDOWN_MS || 10 * 60 * 1000);
const __repairExhaustedAt = new Map<string, number>();

export interface RepairableTransport extends WhatsAppTransport {`);

    rep('P2: prompt com escada + recovery',
`const ANALYSIS_PROMPT = (actionName: string, error: string, dom: string) =>
  [
    'Você é a Luna analisando uma falha de automação no WhatsApp Web (Playwright).',
    \`Ação que falhou: \${actionName}\`,
    \`Erro: \${error}\`,
    'A imagem anexada é o screenshot da tela no momento da falha; abaixo o DOM simplificado.',
    '',
    dom.slice(0, 2500),
    '',
    'Responda APENAS um JSON: {"diagnosis": "causa provável em uma frase",',
    '"suggested_selector": "seletor CSS alternativo plausível ou null"}.',
  ].join('\\n');`,
`const ANALYSIS_PROMPT = (actionName: string, error: string, dom: string, withImage = false) =>
  [
    'Você é a Luna analisando uma falha de automação no WhatsApp Web (Playwright).',
    \`Ação que falhou: \${actionName}\`,
    \`Erro: \${error}\`,
    withImage
      ? 'A imagem anexada é o screenshot da tela no momento da falha; abaixo o DOM simplificado.'
      : 'Diagnóstico textual (1a rodada): abaixo o DOM simplificado no momento da falha.',
    '',
    dom.slice(0, 2500),
    '',
    'Responda APENAS um JSON: {"diagnosis": "causa provável em uma frase",',
    '"suggested_selector": "seletor CSS alternativo plausível ou null",',
    '"recovery": "recarregar_pagina | relancar_browser | reparar_sessao | null"}.',
  ].join('\\n');`);

    rep('P3: cooldown check no inicio do withAutoRepair',
`  const max = deps.maxAttempts ?? 3;
  let lastErr: unknown = null;
  let suggested: string | null = null;`,
`  const max = deps.maxAttempts ?? 3;
  let lastErr: unknown = null;
  let suggested: string | null = null;
  // v14.8-fix: cooldown pos-esgotamento — fail fast, sem novas sessoes de
  // reparo nem diagnosticos (a enchente de abas morre aqui).
  const __lastExhaust = __repairExhaustedAt.get(actionName) || 0;
  if (__lastExhaust && Date.now() - __lastExhaust < REPAIR_COOLDOWN_MS) {
    deps.log.warn({ action: actionName }, 'auto-reparo: cooldown pos-esgotamento — falhando rapido sem novos diagnosticos');
    throw new Error(\`auto-reparo de '\${actionName}' em cooldown (esgotou recentemente) — fila segurada ate o time\`);
  }`);

    rep('P4: escada de evidencia (imagem so na 2a)',
`      // FAST com visão analisa (ADR-021: k2.6 aceita imagem — probe no boot).
      let analysis: Analysis = { diagnosis: String(err).slice(0, 300), suggested_selector: null };
      try {
        const image = screenshotPath ? readFileSync(screenshotPath).toString('base64') : undefined;
        const turn = await deps.adapter.sendTurn({
          session_key: \`repair:\${actionName}\`,
          prompt: ANALYSIS_PROMPT(actionName, String(err), dom),
          image_base64: image,
        });
        analysis = parseAnalysis(turn.reply_text);
      } catch (err2) {
        deps.log.error({ err: err2 }, 'auto-reparo: análise do FAST falhou — retry sem estratégia nova');
      }`,
`      // ESCADA DE EVIDENCIA (owner 20/10): 1a falha = so texto; 2a = PRINT real.
      let analysis: Analysis = { diagnosis: String(err).slice(0, 300), suggested_selector: null };
      try {
        const withImage = attempt >= 2;
        const image = withImage && screenshotPath ? readFileSync(screenshotPath).toString('base64') : undefined;
        const turn = await deps.adapter.sendTurn({
          session_key: \`repair:\${actionName}\`,
          prompt: ANALYSIS_PROMPT(actionName, String(err), dom, withImage),
          image_base64: image,
        });
        analysis = parseAnalysis(turn.reply_text);
      } catch (err2) {
        deps.log.error({ err: err2 }, 'auto-reparo: análise do FAST falhou — retry sem estratégia nova');
      }`);

    rep('P5: marca cooldown no esgotamento',
`  // Esgotou (§14): incidente + Telegram vivo.`,
`  __repairExhaustedAt.set(actionName, Date.now());

  // Esgotou (§14): incidente + Telegram vivo.`);
  }
}

if (patches > 0) fs.writeFileSync(FILE, src);

try { execSync('pm2 restart luna-whatsplay', { encoding: 'utf8' }); console.log('[OK] luna-whatsplay reiniciado'); }
catch { console.log('pm2 restart falhou'); }

console.log('');
console.log('\x1b[32m✅ SELF-HEAL V2 (sem triagem falsa-positiva).\x1b[0m');
console.log('   1a falha: texto | 2a: print real | 3a: Telegram + para | cooldown 10min');
console.log('\x1b[90mBackup: auto-repair.ts.bak-' + ts + '\x1b[0m');
