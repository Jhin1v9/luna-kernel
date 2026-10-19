#!/usr/bin/env node
/**
 * fix-coupled-return.js — ENTREGA ACOPLADA do tool result (2026-10-19)
 *
 * Decreto owner: o resultado que chega no frontend TAMBEM tem que chegar no
 * provider — sao a MESMA coisa, entao viram UMA entrega com dois destinos.
 *
 * O gatilho ja era o mesmo ponto (pos-execucao da tool). O que faltava:
 *   - quando a extensao estava desconectada no exato momento, o envio falhava
 *     em silencio (sent=0 nao logava nada) e caia no CDP travado
 *   - agora: retry sincrono ate 15s esperando a extensao reconectar
 *   - log VERBOSE sempre (sessoes vistas, motivo de 0, resultado final)
 *   - se esgotar os 15s: fallback CDP com aviso GRITANTE no log
 *
 * USO:  node fix-coupled-return.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const SOUL = path.join(ROOT, 'packages', 'kernel', 'luna-soul.cjs');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!fs.existsSync(SOUL)) { console.error('Nao encontrado: ' + SOUL); process.exit(1); }
fs.copyFileSync(SOUL, SOUL + '.bak-' + ts);
let src = fs.readFileSync(SOUL, 'utf8');

const NOVO_METODO = `  // v14.4-fix (owner 2026-10-19) — ENTREGA ACOPLADA: o resultado que vai ao
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
  }`;

// substitui o metodo antigo (inserido pelo fix-single-route.js) via regex
const re = /  \/\/ v14\.4-fix \(owner 2026-10-19\)[\s\S]*?_sendToolResultViaExtension\(text\) \{[\s\S]*?\n  \}\n/;
const m = src.match(re);

if (!m) {
  console.error('[FALHOU] metodo _sendToolResultViaExtension nao encontrado na soul. O fix-single-route.js rodou?');
  process.exit(1);
}
if (src.includes('ENTREGA ACOPLADA')) {
  console.log('[SKIP] entrega acoplada ja aplicada');
} else {
  src = src.replace(re, NOVO_METODO + '\n');
  fs.writeFileSync(SOUL, src);
  console.log('[OK] helper substituido pela versao ACOPLADA (retry 15s + verbose)');
}

try {
  execSync('pm2 restart luna-kernel', { encoding: 'utf8' });
  console.log('[OK] luna-kernel reiniciado');
} catch { console.log('⚠ pm2 restart falhou — roda manual'); }

console.log('');
console.log('✅ ENTREGA ACOPLADA NO AR.');
console.log('   Agora: tool executa -> frontend recebe -> extensao recebe (imediato ou em ate 15s');
console.log('   esperando reconectar). Se der 0 por 15s, log gritante + fallback CDP.');
console.log('');
console.log('   TESTE: Nova Sessao + multi-tool. DEPOIS roda:');
console.log('   grep -a "_sendToolResultViaExtension\\|tool result -> extensao\\|ENTREGA ACOPLADA FALHOU" ~/.pm2/logs/luna-kernel-out.log | tail -8');
console.log('');
console.log('   E no console da aba Kimi (F12) confirma:');
console.log('   [Luna Content] Direct poll ativo (2s) — retorno de tools imune ao sono do SW');
console.log('');
console.log('Backup: luna-soul.cjs.bak-' + ts);
