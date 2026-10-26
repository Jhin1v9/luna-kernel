#!/usr/bin/env node
/* fix-ext-v13-heartbeat.js — keep-alive raiz da extensao MV3.
 * Remove o alarme (corrida 30s vs 30s) e adiciona heartbeat Port:
 * o content script (vida = vida da pagina) manda HB a cada 15s => o SW
 * nunca passa 15s sem evento => vivo enquanto a pagina vive; pagina fecha
 * => Port cai => SW dorme natural. Backup, idempotente, valida sintaxe. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const HOME = process.env.HOME || process.env.USERPROFILE;
const DIR = path.join(HOME, 'Documents', 'luna-kernel', 'packages', 'kernel', 'luna-extension');
const bg = path.join(DIR, 'background.js');
const ct = path.join(DIR, 'content.js');
for (const fp of [bg, ct]) { if (!fs.existsSync(fp)) { console.error('[FAIL] nao achado: ' + fp); process.exit(1); } }
const ts = Date.now();

// ── background.js ──
let bsrc = fs.readFileSync(bg, 'utf8');
if (bsrc.includes('luna-heartbeat')) { console.log('[OK] background.js ja tem heartbeat — idempotente'); }
else {
  const bak = bg + '.bak-hb-' + ts;
  fs.copyFileSync(bg, bak);
  // 1) remove o alarme keepalive (corrida 30s) — mantem o branch luna-poll
  const alarmAnchor = "chrome.alarms.create('luna-keepalive', { periodInMinutes: 0.17 }); // every ~10s";
  const ai = bsrc.indexOf(alarmAnchor);
  if (ai < 0) { console.error('[FAIL] alarme keepalive nao achado no background.js'); process.exit(1); }
  const alarmOld = [
    alarmAnchor,
    'chrome.alarms.onAlarm.addListener((alarm) => {',
    "  if (alarm.name === 'luna-keepalive') {",
    '    // Minimal work to reset idle timer',
    "    chrome.storage.session.get('luna-active').catch(() => {});",
    '  }',
    "  if (alarm.name === 'luna-poll') {",
    '    pollServer();',
    '  }',
    '});',
  ].join('\n');
  if (!bsrc.includes(alarmOld)) { console.error('[FAIL] bloco do alarme diverge do esperado'); process.exit(1); }
  const alarmNew = [
    '// v13.0-fix: alarme keepalive REMOVIDO de proposito — Chrome clampa alarme',
    '// em 30s e o MV3 mata o SW aos ~30s sem eventos (corrida que perde as vezes).',
    '// Keep-alive raiz = heartbeat Port vindo do content script (veja onConnect abaixo):',
    "// enquanto uma pagina provider vive, HB chega a cada 15s e o SW nunca dorme.",
    "chrome.alarms.onAlarm.addListener((alarm) => {",
    "  if (alarm.name === 'luna-poll') {",
    '    pollServer();',
    '  }',
    '});',
  ].join('\n');
  bsrc = bsrc.replace(alarmOld, alarmNew);
  // 2) insere o onConnect do heartbeat antes de "── Message Routing ──"
  const rtAnchor = '// ── Message Routing ──';
  const ri = bsrc.indexOf(rtAnchor);
  if (ri < 0) { console.error('[FAIL] anchor Message Routing nao achado'); process.exit(1); }
  const hb = [
    '// ── Heartbeat keep-alive (v13.0-fix) ──',
    '// O content script abre uma Port e manda {type:"luna:hb"} a cada 15s. Cada',
    '// mensagem na Port e um EVENTO pro SW => idle timer zera => SW vivo enquanto',
    '// a pagina vive. Sem pagina: nenhuma Port => SW dorme natural (~30s).',
    "const lunaHeartbeatPorts = new Set();",
    "chrome.runtime.onConnect.addListener((port) => {",
    "  if (port.name !== 'luna-heartbeat') return;",
    '  lunaHeartbeatPorts.add(port);',
    '  port.onMessage.addListener((msg) => {',
    '    if (msg && msg.type === "luna:hb") port.__lastHb = Date.now();',
    '  });',
    '  port.onDisconnect.addListener(() => { lunaHeartbeatPorts.delete(port); });',
    '});',
    '',
    '',
  ].join('\n');
  bsrc = bsrc.slice(0, ri) + hb + bsrc.slice(ri);
  try { new vm.Script(bsrc); } catch (e) { console.error('[FAIL] background.js sintaxe quebrada — NADA escrito: ' + e.message); process.exit(1); }
  fs.writeFileSync(bg, bsrc);
  console.log('[OK] background.js: alarme removido + onConnect heartbeat inserido (backup ' + bak + ')');
}

// ── content.js ──
let csrc = fs.readFileSync(ct, 'utf8');
if (csrc.includes('luna-heartbeat')) { console.log('[OK] content.js ja tem heartbeat — idempotente'); }
else {
  const bak = ct + '.bak-hb-' + ts;
  fs.copyFileSync(ct, bak);
  const block = [
    '',
    '// ── Luna heartbeat keep-alive (v13.0-fix) ──',
    '// Mantem o service worker vivo ENQUANTO ESTA PAGINA existir (contrato owner:',
    '// chromeIsOpen=true => extension=alive). HB de 15s pela Port; se a Port cair',
    '// (SW renasceu/reload), reconecta — o connect() acorda o SW, que restabelece',
    '// sessao + poll sozinho. Pagina fechou: este script morre e o SW dorme natural.',
    '(function lunaHeartbeatKeepalive() {',
    '  let port = null;',
    '  let stopped = false;',
    '  function connect() {',
    '    if (stopped) return;',
    '    try {',
    "      port = chrome.runtime.connect({ name: 'luna-heartbeat' });",
    '      port.onDisconnect.addListener(() => {',
    '        port = null;',
    '        if (!stopped) setTimeout(connect, 1000);',
    '      });',
    "      try { port.postMessage({ type: 'luna:hb', t: Date.now(), phase: 'open' }); } catch (e) {}",
    '    } catch (e) {',
    '      setTimeout(connect, 2000);',
    '    }',
    '  }',
    '  connect();',
    '  setInterval(() => {',
    '    if (stopped) return;',
    '    if (!port) { connect(); return; }',
    "    try { port.postMessage({ type: 'luna:hb', t: Date.now() }); }",
    '    catch (e) { port = null; setTimeout(connect, 1000); }',
    '  }, 15000);',
    "  window.addEventListener('beforeunload', () => { stopped = true; });",
    "  document.addEventListener('visibilitychange', () => {",
    '    if (!document.hidden && port) {',
    "      try { port.postMessage({ type: 'luna:hb', t: Date.now(), phase: 'focus' }); } catch (e) {}",
    '    }',
    '  });',
    '})();',
    '',
  ].join('\n');
  const out = csrc.replace(/\s*$/, '') + '\n' + block;
  try { new vm.Script(out); } catch (e) { console.error('[FAIL] content.js sintaxe quebrada — NADA escrito: ' + e.message); process.exit(1); }
  fs.writeFileSync(ct, out);
  console.log('[OK] content.js: heartbeat appendado no fim do arquivo (backup ' + bak + ')');
}
console.log('[NEXT] recarregue a extensao: chrome://extensions -> Luna -> Recarregar');
