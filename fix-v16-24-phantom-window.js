#!/usr/bin/env node
/* fix-v16-24-phantom-window.js — v16.24 (owner 21/10)
   Fecha a janela do phantom cross-turn DEPOIS do v16.23 (replay turn-scoped).
   Cadeia: send real limpava _domEventSeen (8840) + TTL de 2s (v12.5) ->
   phantom da tool velha (segmento anterior ainda no DOM) chegava no poll do
   turno novo com mapa vazio -> EXECUTAVA DE VERDADE (send duplicado real).
   Fix: (1) nao limpar o seen map em send real (re-issue legitimo identico
   so passa apos o TTL — trade assumido pelo proprio W6-T6); (2) TTL 2s ->
   120s (phantoms de um turno continuam suprimidos nos turnos seguintes).
   Steer (8542) intocado. Marker _turnAssistantMarker intacto. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const BRIDGE = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\kimi-bridge.cjs';
const MARK = 'v16.24-fix';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
function syntaxCheckJS(src) {
  const tmp = path.join(os.tmpdir(), 'luna-check-' + Date.now() + '.js');
  fs.writeFileSync(tmp, src);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); return true; }
  catch (e) { return false; }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

try {
  let src = fs.readFileSync(BRIDGE, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] ja aplicado'); process.exit(0); }

  // (1) remover o clear no send real (regex com tolerancia CRLF)
  const reClear = /        if \(!options\.isAutoContinue\) \{\r?\n          session\._domEventSeen = new Map\(\);\r?\n        \}/;
  const hits = src.match(reClear) || [];
  if (hits.length !== 1) { console.log('[FAIL] clear-site ' + hits.length + 'x'); process.exit(1); }
  src = src.replace(reClear,
    "        if (!options.isAutoContinue) {\n" +
    "          // " + MARK + " (owner 21/10): NAO limpar o seen map em send real.\n" +
    "          // Limpar reabria a janela do phantom cross-turn (DOM ainda mostra o\n" +
    "          // segmento anterior -> tool JSON velha re-emitida e EXECUTADA de verdade,\n" +
    "          // pois o replay do soul agora eh turn-scoped). Phantoms ficam suprimidos\n" +
    "          // pelo seen map + TTL; re-issue legitimo identico so passa apos o TTL.\n" +
    "        }");

  // (2) TTL 2s -> 120s
  const aTtl = 'const SEEN_TTL_MS = 2 * 1000;';
  if (src.includes('SEEN_TTL_MS')) {
    if (src.split(aTtl).length - 1 === 1) {
      src = src.replace(aTtl, 'const SEEN_TTL_MS = 120 * 1000; // ' + MARK + ': janela que cobre o phantom cross-turn');
      console.log('[OK] TTL 2s -> 120s');
    } else {
      const m = src.match(/const SEEN_TTL_MS = (\d+) \* 1000;/);
      console.log('[AVISO] TTL com valor inesperado: ' + (m ? m[0] : '?') + ' — ajuste manual pra 120 * 1000');
    }
  } else { console.log('[AVISO] SEEN_TTL_MS nao achado (nome diverge?) — me cola: grep -n SEEN_TTL_MS kimi-bridge.cjs'); }

  if (!syntaxCheckJS(src)) { console.log('[FAIL] sintaxe — NADA escrito'); process.exit(1); }
  fs.copyFileSync(BRIDGE, BRIDGE + '.bak-' + ts);
  fs.writeFileSync(BRIDGE, src);
  console.log('[OK] clear no send real removido | backup: kimi-bridge.cjs.bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.24 ===');
console.log('=== ABA NOVA (estabilizacao): sessao work-<conversationId> por chat. Se o kernel abrir tab por sessao, ===');
console.log('=== fecha as tabs velhas e manda msg de cada chat — cada uma deve abrir/puxar a SUA aba ===');
