#!/usr/bin/env node
/**
 * fix-network-overrides-ui.js — REDE > UI: fato manda sobre inferencia (2026-10-20)
 *
 * O fix de quota (v14.6) nao bastou: o forcing "isGenerating=true because
 * active loading/thinking indicators" continuava (check de thinking com
 * seletor largo pega o toggle "Pensando" da propria resposta, ou o texto do
 * banner nao casou com a regex).
 *
 * Decreto owner (20/10): entrega/rede eh FATO, isGen da UI eh INFERENCIA.
 * O NetworkInterceptor sabe exatamente quando a resposta da geracao chegou
 * completa (completedGeneration === _generation). A partir desse momento o
 * modelo TERMINOU de escrever — nenhum spinner/cursor/toolcall/thinking tem
 * poder de veto. Sem isso, indicadores fantasmas (estado de quota) travavam
 * isGen=true pra sempre: a stream nunca completava, a soul nunca chegava no
 * toolLoop e o resultado da tool nunca voltava — mesmo com a tool executada.
 *
 * USO:  node fix-network-overrides-ui.js
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

const OLD = `      const hasLoading = await this._hasActiveLoadingIndicators(page);
      if (hasLoading && !result.isGenerating) {
        log.info(` + '`' + `[_detectUiState] forcing isGenerating=true because active loading/thinking indicators are visible` + '`' + `);
        result.isGenerating = true;
      }`;

const NEW = `      const hasLoading = await this._hasActiveLoadingIndicators(page);
      // v14.7-fix (owner 20/10) — REDE > UI: se o interceptor ja capturou a
      // resposta COMPLETA da geracao, o modelo TERMINOU de escrever. Indicador
      // de UI (spinner/cursor/toolcall/thinking) eh INFERENCIA e NAO tem poder
      // de veto sobre o fato da rede. Sem isso, indicadores fantasma (ex.: o
      // estado de quota do Kimi) travavam isGen=true pra sempre — a stream nao
      // completava, a soul nao chegava no toolLoop e o resultado da tool nao
      // voltava, mesmo com a tool executada e o corpo da resposta na rede.
      const networkFinished = !!(this.interceptor && this.interceptor._generation > 0 && this.interceptor.completedGeneration === this.interceptor._generation);
      if (hasLoading && !result.isGenerating && !networkFinished) {
        log.info(` + '`' + `[_detectUiState] forcing isGenerating=true because active loading/thinking indicators are visible` + '`' + `);
        result.isGenerating = true;
      }`;

if (src.includes('v14.7-fix')) {
  console.log('[SKIP] ja aplicado');
} else {
  const o = norm(OLD);
  const count = src.split(o).length - 1;
  if (count !== 1) { console.error('[FALHOU] ancora ' + count + 'x — me manda: grep -n "forcing isGenerating" packages/kernel/kimi-bridge.cjs'); process.exit(1); }
  src = src.replace(o, norm(NEW));
  fs.writeFileSync(FILE, src);
  console.log('[OK] rede agora tem poder de veto sobre UI (isGen so forca se a rede NAO terminou)');
}

try {
  execSync(`node --check "${FILE}"`, { encoding: 'utf8', stdio: 'pipe' });
  console.log('[OK] node --check passou');
} catch (e) {
  console.error('[FALHOU] sintaxe: ' + (e.stderr || e.message).split('\n').slice(0, 3).join(' | '));
  process.exit(1);
}

try { execSync('pm2 restart luna-kernel', { encoding: 'utf8' }); console.log('[OK] luna-kernel reiniciado'); }
catch { console.log('pm2 restart falhou'); }

console.log('');
console.log('\x1b[32m✅ REDE > UI INSTALADO.\x1b[0m Logica:');
console.log('   gerando        -> completedGeneration <  _generation -> forcing permitido (isGen=true legitimo)');
console.log('   rede completou -> completedGeneration == _generation -> forcing PROIBIDO (isGen=false, fato manda)');
console.log('');
console.log('   TESTE: reenvia o abusado. "forcing isGenerating" deve aparecer so DURANTE a geracao');
console.log('   real e sumir assim que a resposta chegar na rede.');
console.log('\x1b[90mBackup: kimi-bridge.cjs.bak-' + ts + '\x1b[0m');
