#!/usr/bin/env node
/**
 * fix-poller-null-selectors.js — fim do "Cannot read properties of null (reading 'assistant')" (2026-10-20)
 *
 * Causa raiz (codigo lido no kimi-bridge.cjs): _pollThinkingAndResponse Layer 2.5 fazia
 *   const chains = provider === 'kimi' ? this._resolveDomSelectorChains(provider) : null;
 * Quando o provider LOGICO era 'roda' (fallback de config) mas a PAGINA FISICA era
 * kimi.ai, chains vinha null -> o evaluate no-page lia selectors.assistant -> TypeError
 * em loop a cada 400ms -> poller cego -> [WATCHDOG][STREAM_STALLED] em chat novo.
 * Chat antigo "funcionava" pq o network-interceptor ja tinha dados; pagina nova nao.
 *
 * Fix (2 pontos):
 *   1. chains resolvidas por URL DA PAGINA (kimi.ai/moonshot.cn -> chains kimi),
 *      nao so pelo nome logico do provider
 *   2. guard null-safe dentro do evaluate (defesa em profundidade)
 *
 * USO:  node fix-poller-null-selectors.js
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

// ── Patch 1: chains por URL da pagina, nao so pelo provider logico ──
const OLD1 = `      const turnAssistantMarker = (session && typeof session._turnAssistantMarker === 'number') ? session._turnAssistantMarker : null;
      const chains = provider === 'kimi' ? this._resolveDomSelectorChains(provider) : null;`;

const NEW1 = `      const turnAssistantMarker = (session && typeof session._turnAssistantMarker === 'number') ? session._turnAssistantMarker : null;
      // v14.5-fix (2026-10-20): provider LOGICO ('roda'/fallback) != pagina FISICA.
      // Se a pagina eh kimi.ai, usa as chains do kimi de qualquer jeito — chains null
      // fazia selectors.assistant explodir no evaluate (TypeError em loop, poller cego,
      // STREAM_STALLED em chat novo).
      const isKimiPage = /kimi\\.(ai|moonshot\\.cn)/i.test(page.url() || '');
      const chains = (provider === 'kimi' || isKimiPage) ? this._resolveDomSelectorChains('kimi') : null;`;

// ── Patch 2: guard null-safe dentro do evaluate (defesa em profundidade) ──
const OLD2 = `        const assistants = allMatches(document, selectors.assistant);
        const scoped = typeof assistantMarker === 'number' ? assistants.slice(assistantMarker) : assistants;`;

const NEW2 = `        if (!selectors) return { _empty: true, _debug: { error: 'no-selectors', url: location.href } };
        const assistants = allMatches(document, selectors.assistant || []);
        const scoped = typeof assistantMarker === 'number' ? assistants.slice(assistantMarker) : assistants;`;

let patches = 0;
if (src.includes('v14.5-fix')) {
  console.log('[SKIP] ja aplicado');
} else {
  for (const [label, OLD, NEW] of [['P1: chains por URL da pagina', OLD1, NEW1], ['P2: guard null-safe no evaluate', OLD2, NEW2]]) {
    const o = norm(OLD), n = norm(NEW);
    const count = src.split(o).length - 1;
    if (count !== 1) { console.error('[FALHOU] ' + label + ' — ' + count + 'x'); continue; }
    src = src.replace(o, n);
    console.log('[OK] ' + label);
    patches++;
  }
  if (patches === 2) fs.writeFileSync(FILE, src);
}

if (patches > 0) {
  try {
    execSync(`node --check "${FILE}"`, { encoding: 'utf8', stdio: 'pipe' });
    console.log('[OK] node --check passou');
  } catch (e) {
    console.error('[FALHOU] sintaxe: ' + (e.stderr || e.message).split('\n').slice(0, 3).join(' | '));
    process.exit(1);
  }
}

try { execSync('pm2 restart luna-kernel', { encoding: 'utf8' }); console.log('[OK] luna-kernel reiniciado'); }
catch { console.log('pm2 restart falhou'); }

console.log('');
console.log('\x1b[32m✅ POLLER CURADO.\x1b[0m Teste: Nova Sessao na Luna Web + o prompt abusado.');
console.log('   O erro "Cannot read properties of null" deve SUMIR do log:');
console.log('   pm2 logs luna-kernel --lines 15');
console.log('\x1b[90mBackup: kimi-bridge.cjs.bak-' + ts + '\x1b[0m');
