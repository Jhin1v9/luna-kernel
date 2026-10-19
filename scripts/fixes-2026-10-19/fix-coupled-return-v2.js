#!/usr/bin/env node
/**
 * fix-coupled-return-v2.js — mesma coisa da v1, mas com brace-matching (2026-10-19)
 * A v1 usou regex e nao casou (formatacao local divergente). Essa acha o metodo
 * por indexOf e casa as chaves pra achar o fim — imune a formatacao.
 *
 * USO:  node fix-coupled-return-v2.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const SOUL = path.join(ROOT, 'packages', 'kernel', 'luna-soul.cjs');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!fs.existsSync(SOUL)) { console.error('Nao encontrado: ' + SOUL); process.exit(1); }

let src = fs.readFileSync(SOUL, 'utf8');

const ANCHOR = '_sendToolResultViaExtension(text) {';
const idx = src.indexOf(ANCHOR);
if (idx === -1) {
  console.error('[FALHOU] _sendToolResultViaExtension nao existe na soul. Roda node fix-single-route.js primeiro.');
  process.exit(1);
}
if (src.includes('ENTREGA ACOPLADA')) {
  console.log('[SKIP] entrega acoplada ja aplicada');
} else {
  // acha o inicio da linha (com indentacao)
  let start = idx;
  while (start > 0 && src[start - 1] !== '\n') start--;

  // brace matching a partir da chave de abertura do metodo
  let i = src.indexOf('{', idx);
  let depth = 0;
  let end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) { console.error('[FALHOU] nao achei o fim do metodo (chaves desbalanceadas?)'); process.exit(1); }
  // pula o } e o newline
  end++;
  if (src[end] === '\r') end++;
  if (src[end] === '\n') end++;

  fs.copyFileSync(SOUL, SOUL + '.bak-' + ts);

  const NOVO = `  // v14.4-fix (owner 2026-10-19) — ENTREGA ACOPLADA: o resultado que vai ao
  // frontend TAMBEM vai ao provider. Uma entrega, dois destinos. Se a extensao
  // nao estiver conectada AGORA, espera ela reconectar (ate 15s) — frontend
  // ja tem o dado; o provider vai ter tambem. Só depois de esgotado: fallback CDP.
  _sendToolResultViaExtension(text) {
    const sleepSync = (ms) => {
      try {
        const sab = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(sab, 0, 0, ms);
      } catch (e) {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { /* spin de ultima instancia */ }
      }
    };
    const t0 = Date.now();
    const attempt = () => {
      try {
        const app = global.__lunaApp;
        const h = (app && app.locals && app.locals.extensionHandler) || global.__lunaExtHandler || null;
        if (!h || typeof h._sendToSession !== 'function') {
          console.warn('[LUNA-SOUL] _sendToolResultViaExtension: HANDLER NAO ENCONTRADO (global.__lunaApp.locals.extensionHandler vazio)');
          return 0;
        }
        let sids = [];
        if (typeof h.getConnectedSessions === 'function') {
          sids = h.getConnectedSessions() || [];
        } else if (h.sessions && typeof h.sessions.keys === 'function') {
          sids = Array.from(h.sessions.keys()).filter(sid => {
            const s = h.sessions.get(sid);
            return s && (Date.now() - (s.lastPing || 0)) < 60000;
          });
        }
        if (sids.length === 0) {
          console.log('[LUNA-SOUL] _sendToolResultViaExtension: 0 sessoes conectadas no momento (extensao dormindo/reconectando?)');
          return 0;
        }
        let sent = 0;
        for (const sid of sids) {
          try {
            h._sendToSession(sid, { type: 'tool_result', result: text, text: text, source: 'luna-soul-feedback' });
            sent++;
          } catch (e) { /* sessao morreu entre a listagem e o envio — ignora */ }
        }
        console.log('[LUNA-SOUL] tool result -> extensao (' + sent + '/' + sids.length + ' sessoes, ' + String(text).length + ' chars, +' + (Date.now() - t0) + 'ms)');
        return sent;
      } catch (e) {
        console.warn('[LUNA-SOUL] _sendToolResultViaExtension erro: ' + e.message);
        return 0;
      }
    };
    let sent = attempt();
    let esperado = 0;
    while (sent === 0 && esperado < 15000) {
      sleepSync(2000);
      esperado += 2000;
      sent = attempt();
    }
    if (sent === 0) {
      console.warn('[LUNA-SOUL] ⚠⚠ ENTREGA ACOPLADA FALHOU: extensao nao reconectou em 15s. Frontend recebeu, provider NAO vai receber pela extensao — caindo no fallback CDP (pode travar no canSteer). VERIFIQUE A EXTENSAO (recarregar no chrome://extensions).');
    } else if (esperado > 0) {
      console.log('[LUNA-SOUL] entrega acoplada recuperada apos ' + esperado + 'ms de espera — extensao reconectou');
    }
    return sent;
  }

`;
  src = src.slice(0, start) + NOVO + src.slice(end);
  fs.writeFileSync(SOUL, src);
  console.log('[OK] helper substituido pela versao ACOPLADA (retry 15s + verbose)');
}

try {
  execSync('pm2 restart luna-kernel', { encoding: 'utf8' });
  console.log('[OK] luna-kernel reiniciado');
} catch { console.log('⚠ pm2 restart falhou — roda manual'); }

console.log('');
console.log('✅ ENTREGA ACOPLADA NO AR. Testa (Nova Sessao + multi-tool) e manda o grep:');
console.log('   grep -a "_sendToolResultViaExtension\\|tool result -> extensao\\|ENTREGA ACOPLADA FALHOU" ~/.pm2/logs/luna-kernel-out.log | tail -8');
console.log('');
console.log('Backup: luna-soul.cjs.bak-' + ts);
