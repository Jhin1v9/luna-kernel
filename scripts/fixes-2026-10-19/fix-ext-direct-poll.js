#!/usr/bin/env node
/**
 * fix-ext-direct-poll.js — content.js polla DIRETO, sem depender do SW (2026-10-19)
 *
 * Problema: o caminho de volta (tool_result -> Kimi) dependia do Service Worker
 * fazer poll. SW MV3 DORME apos ~30s idle -> resultado ficava preso na fila ->
 * "funciona 1 hora, depois morre".
 *
 * Solucao (sem lutar contra o sono do SW): o content script vive enquanto a aba
 * existe — NUNCA dorme. Ele passa a fazer poll DIRETO no /ext/poll a cada 2s e
 * injeta o tool_result na hora. O SW pode dormir a vontade que o retorno nao
 * depende mais dele.
 *
 * Patches:
 *   1. handler: CORS em /ext/* (content script faz fetch cross-origin)
 *   2. content.js: loop de poll direto + dedup por hash (a soul broadcasta pra
 *      todas as sessoes conectadas — SW e content — msg pode chegar 2x)
 *
 * USO:  node fix-ext-direct-poll.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const HANDLER = path.join(ROOT, 'apps', 'dashboard', 'luna-extension-handler.cjs');
const CONTENT = path.join(ROOT, 'packages', 'kernel', 'luna-extension', 'content.js');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
let errors = 0;

const OK = (m) => console.log('\x1b[32m  [OK]\x1b[0m ' + m);
const SKIP = (m) => console.log('\x1b[90m  [SKIP]\x1b[0m ' + m + ' — ja aplicado');
const FAIL = (m) => { console.log('\x1b[31m  [FALHOU]\x1b[0m ' + m); errors++; };

function replaceOnce(file, oldS, newS, label) {
  const raw = fs.readFileSync(file, 'utf8');
  const isCrlf = raw.includes('\r\n');
  const norm = (s) => isCrlf ? s.replace(/\n/g, '\r\n') : s;
  const o = norm(oldS), n = norm(newS);
  if (raw.includes(n)) { SKIP(label); return true; }
  const count = raw.split(o).length - 1;
  if (count !== 1) { FAIL(label + ' — padrao ' + count + 'x (esperado 1)'); return false; }
  fs.writeFileSync(file, raw.replace(o, n));
  OK(label);
  return true;
}

// ── Patch 1: CORS no handler ──
console.log('\n\x1b[36m=== 1/2 — luna-extension-handler.cjs (CORS p/ poll direto) ===\x1b[0m');
if (!fs.existsSync(HANDLER)) { FAIL('nao encontrado: ' + HANDLER); }
else {
  fs.copyFileSync(HANDLER, HANDLER + '.bak-' + ts);
  replaceOnce(HANDLER,
`    // Parse JSON body
    app.use('/ext', express.json());`,
`    // v14.4-fix (2026-10-19): CORS pro CONTENT SCRIPT fazer poll DIRETO no
    // /ext/poll (o SW pode estar dormindo — o content vive enquanto a aba existe).
    app.use('/ext', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });

    // Parse JSON body
    app.use('/ext', express.json());`,
  'P1: CORS em /ext/*');
}

// ── Patch 2: poll direto no content.js ──
console.log('\n\x1b[36m=== 2/2 — content.js (poll direto, imune ao sono do SW) ===\x1b[0m');
if (!fs.existsSync(CONTENT)) { FAIL('nao encontrado: ' + CONTENT); }
else {
  fs.copyFileSync(CONTENT, CONTENT + '.bak-' + ts);
  replaceOnce(CONTENT,
`  console.log('[Luna Content] v11.7 loaded — forwarding DOM events + injection ready');
})();`,
`  console.log('[Luna Content] v11.7 loaded — forwarding DOM events + injection ready');

  // v14.4-fix (2026-10-19) — RETORNO DIRETO: poll direto no servidor a cada 2s.
  // O content script NUNCA dorme (vive enquanto a aba existe) — o SW dorme.
  // Dedup por hash: a soul broadcasta pra TODAS as sessoes conectadas (SW e
  // content), entao a mesma msg pode chegar 2x.
  if (/kimi\\.(ai|moonshot\\.cn)$/.test(window.location.hostname)) {
    const DIRECT_SID = 'content-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const seenHashes = new Map();
    const payloadHash = (p) => {
      try {
        const body = String(p.result || p.text || '');
        return (p.type || '') + '::' + (p.tool || '') + '::' + body.length + '::' + body.slice(0, 120);
      } catch (e) { return 'x' + Math.random(); }
    };
    const directPoll = async () => {
      try {
        const r = await fetch('http://localhost:3458/ext/poll?sessionId=' + encodeURIComponent(DIRECT_SID));
        if (!r.ok) return;
        const data = await r.json();
        const msgs = (data && data.messages) || [];
        const now = Date.now();
        for (const p of msgs) {
          const h = payloadHash(p);
          if (seenHashes.has(h)) continue; // ja injetado (via SW ou poll anterior)
          seenHashes.set(h, now);
          if (p.type === 'tool_result' && (p.result || p.text)) {
            const text = typeof (p.result || p.text) === 'string'
              ? (p.result || p.text)
              : JSON.stringify(p.result || p.text, null, 2);
            console.log('[Luna Content] DIRECT POLL: tool_result (' + text.length + ' chars) — injetando');
            injectToolResult(text);
          } else if (p.type === 'inject_text' && p.text) {
            injectToolResult(p.text);
          }
        }
        for (const [k, t] of seenHashes) { if (now - t > 90000) seenHashes.delete(k); }
      } catch (e) { /* server offline — tenta no proximo ciclo */ }
    };
    setInterval(directPoll, 2000);
    directPoll();
    console.log('[Luna Content] Direct poll ativo (2s) — retorno de tools imune ao sono do SW');
  }
})();`,
  'P2: loop de poll direto no content.js');
}

// ── restart ──
console.log('');
try {
  execSync('pm2 restart luna-kernel', { encoding: 'utf8' });
  OK('luna-kernel reiniciado');
} catch { console.log('\x1b[33m  ⚠ pm2 restart falhou — roda manual\x1b[0m'); }

console.log('');
if (errors > 0) {
  console.log('\x1b[33m⚠ ' + errors + ' falha(s). Backups: *.bak-' + ts + '\x1b[0m');
  process.exit(1);
}
console.log('\x1b[32m✅ RETORNO DIRETO INSTALADO.\x1b[0m');
console.log('   O content.js (que NUNCA dorme) agora pega o tool_result direto da fila');
console.log('   a cada 2s e injeta no Kimi — o SW dormir nao afeta mais o retorno.');
console.log('');
console.log('\x1b[33m⚠ RECARREGA A EXTENSAO (chrome://extensions → 🔄) e faz NOVA SESSAO.\x1b[0m');
console.log('\x1b[90mBackups: *.bak-' + ts + '\x1b[0m');
