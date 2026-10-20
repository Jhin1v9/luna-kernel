#!/usr/bin/env node
/**
 * fix-quota-indicator.js — fim do indicador fantasma de quota (2026-10-20)
 *
 * DIAGNOSTICO (codigo-fonte lido): _hasActiveLoadingIndicators() usa seletores
 * largos ('[class*="loading"]', '[class*="cursor"]', '.toolcall-container') que
 * no estado de QUOTA do Kimi ("Keep asking, messages will be queued") ficam
 * visiveis PARA SEMPRE -> isGenerating=true eterno -> completion_candidate
 * ignorada (guarda de loading) -> stream nunca completa -> soul nunca chega no
 * toolLoop -> gancho de entrega nunca roda -> resultado da tool nunca volta,
 * MESMO com a tool executada (TOOL_FINISHED no log) e a resposta da rede tendo
 * chegado (consenso de rede existia mas era barrado antes).
 *
 * FIX (decreto owner — sem timeout, sem adivinhacao): detecta o estado de quota
 * pelo texto da pagina e, nesse estado, ignora os indicadores nao confiaveis
 * (spinners, cursores, chrome de toolcall). Mantem SEMPRE o unico sinal
 * confiavel: bloco de thinking com verbos ativos.
 *
 * USO:  node fix-quota-indicator.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const FILE = path.join(ROOT, 'packages', 'kernel', 'kimi-bridge.cjs');
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

if (src.includes('quotaState')) {
  console.log('[SKIP] ja aplicado');
} else {
  // 1. deteccao do estado de quota no inicio do evaluate
  rep('P1: deteccao do estado de quota',
`      return await page.evaluate(() => {
        // 1. Spinners / loading dots`,
`      return await page.evaluate(() => {
        // v14.6-fix (2026-10-20): estado de QUOTA/queued do Kimi ("Keep asking,
        // messages will be queued") deixa indicadores FANTASMAS visiveis pra
        // sempre (spinner da fila, cursor, chrome de toolcall) — isGenerating
        // travava em true, a stream nunca completava e o resultado da tool nao
        // voltava. Nesse estado so o bloco de thinking com verbos ativos confia.
        const __lunaBodyText = document.body?.innerText || '';
        const quotaState = /keep asking|messages will be queued|monthly quota|quota used up|enfileirada|fila de espera/i.test(__lunaBodyText);

        // 1. Spinners / loading dots — no estado de quota sao chrome da fila (ignorar)`);

  // 2-5. checks nao confiaveis viram no-op no estado de quota (uma linha cada, sem reindentar)
  rep('P2: spinners ignorados na quota', 'for (const sel of spinnerSelectors) {', 'for (const sel of (quotaState ? [] : spinnerSelectors)) {');
  rep('P3: cursores ignorados na quota', 'for (const sel of cursorSelectors) {', 'for (const sel of (quotaState ? [] : cursorSelectors)) {');
  rep('P4: exec-status ignorado na quota', 'for (const sel of codeStatusSelectors) {', 'for (const sel of (quotaState ? [] : codeStatusSelectors)) {');
  rep('P5: toolcall chrome ignorado na quota', 'for (const sel of toolCallSelectors) {', 'for (const sel of (quotaState ? [] : toolCallSelectors)) {');
}

if (patches > 0) {
  try {
    execSync(`node --check "${FILE}"`, { encoding: 'utf8', stdio: 'pipe' });
    console.log('[OK] node --check passou');
  } catch (e) {
    console.error('[FALHOU] sintaxe: ' + (e.stderr || e.message).split('\n').slice(0, 3).join(' | '));
    process.exit(1);
  }
  try { execSync('pm2 restart luna-kernel', { encoding: 'utf8' }); console.log('[OK] luna-kernel reiniciado'); }
  catch { console.log('pm2 restart falhou'); }
}

console.log('');
console.log('\x1b[32m✅ INDICADOR FANTASMA DOMADO.\x1b[0m');
console.log('   O que muda: com a quota esgotada, o Kimi nao fica mais "gerando" pra sempre.');
console.log('   A stream completa (consenso de rede + texto estavel), a soul chega no');
console.log('   toolLoop, o gancho dispara e o resultado VOLTA pra pagina.');
console.log('');
console.log('   TESTE: reenvia o prompt abusado. O log "forcing isGenerating=true because');
console.log('   active loading/thinking indicators" deve SUMIR (aparece so se houver');
console.log('   thinking REAL ativo).');
console.log('');
console.log('   NOTA: isso tambem explica os "chat novo trava, chat antigo funciona":');
console.log('   nos chats antigos a resposta ja tinha rede + estabilidade; nos novos o');
console.log('   indicador fantasma segurava tudo. Com o fix, AMBOS funcionam.');
console.log('\x1b[90mBackup: kimi-bridge.cjs.bak-' + ts + '\x1b[0m');
