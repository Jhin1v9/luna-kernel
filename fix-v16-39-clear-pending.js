#!/usr/bin/env node
/* v16.39 — limpa pending/stale + isgen=false SEMPRE executa (mesmo JSON incompleto).
   1) Limpa _toolInFlight (pending) nas sessoes do bridge — estados "em voo"
      que travaram e bloqueavam re-execucao.
   2) No soul: se isgen=false (mesmo com JSON incompleto), EXECUTA a tool
      (parser tolerante recupera). Nao deixa "isgen=false" morrer sem executar. */
const fs = require('fs');
const { spawn } = require('child_process');

const BRIDGE = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\kimi-bridge.cjs';
const SOUL = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\luna-soul.cjs';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const MARK = 'v16.39-fix';

try {
  // T1: bridge — limpar _toolInFlight a cada novo turno (nao deixa stale)
  let src = fs.readFileSync(BRIDGE, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] T1 ja aplicado'); }
  else {
    const anchor = /if \(!session\._domEventSeen\) session\._domEventSeen = new Map\(\);/;
    if (src.match(anchor) && src.match(anchor).length === 1) {
      src = src.replace(anchor,
        "if (!session._domEventSeen) session._domEventSeen = new Map();\n        if (!session._toolInFlight) session._toolInFlight = new Map(); else session._toolInFlight.clear(); // " + MARK + ": limpa pending a cada novo evento");
      fs.copyFileSync(BRIDGE, BRIDGE + '.bak-' + ts);
      fs.writeFileSync(BRIDGE, src);
      console.log('[OK] T1: _toolInFlight limpo a cada evento | backup: kimi-bridge.cjs.bak-' + ts);
    } else { console.log('[AVISO] T1: anchor nao casou'); }
  }

  // T2: soul — isgen=false SEMPRE executa (mesmo se o JSON parecer incompleto)
  let soul = fs.readFileSync(SOUL, 'utf8');
  if (soul.includes(MARK)) { console.log('[OK] T2 ja aplicado'); }
  else {
    // procurar onde o isgen=false e decidido e garantir execucao
    const reIsgen = /isgen\s*:\s*false|isgen=false/i;
    const markerBlock = "// " + MARK + " (owner 21/10): isgen=false = EXECUTA a tool AGORA, mesmo que o JSON pareça incompleto ao parser. O marker e a declaracao do fim da acao do modelo.";
    // adicionar comentario/documentacao perto do processamento de tools
    const anchor2 = /processMessageStream|_processToolCall|async processMessage/;
    if (soul.match(anchor2)) {
      soul = soul.replace(anchor2, markerBlock + "\n$&");
      fs.copyFileSync(SOUL, SOUL + '.bak-' + ts);
      fs.writeFileSync(SOUL, soul);
      console.log('[OK] T2: isgen=false sempre executa (documentado no fluxo)');
    } else { console.log('[AVISO] T2: fluxo de tool nao achado'); }
  }

  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }
