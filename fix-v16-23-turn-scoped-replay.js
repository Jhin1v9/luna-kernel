#!/usr/bin/env node
/* fix-v16-23-turn-scoped-replay.js — v16.23 (owner 21/10)
   Sintoma comprovado no log/thread: modelo emitiu brainSearch, mas o
   [TOOL RESULT] entregue foi de whatsappSendMessage ("Mensagem enfileirada
   pro contato Abner"). Mecanismo: cross-turn, a bridge re-escaneia o buffer
   acumulado e re-emite tool MUTANTE velha; o _executedActionCache (replay,
   so pra mutantes, TTL 60s) servia o result antigo SEM executar.
   Fix: replay SOMENTE dentro do mesmo turnId — retry/auto-continue legitimos
   (mesmo turno) continuam protegidos; turno novo nunca recebe result velho.
   NOTA: a raiz complementar (extracao cross-turn na bridge) eh a v16.23b —
   precisa do log da janela pra mirar a fonte exata. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const SOUL = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\luna-soul.cjs';
const MARK = 'v16.23-fix';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
function count(src, a) { return src.split(a).length - 1; }
function syntaxCheckJS(src) {
  const tmp = path.join(os.tmpdir(), 'luna-check-' + Date.now() + '.js');
  fs.writeFileSync(tmp, src);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); return true; }
  catch (e) { return false; }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

try {
  let src = fs.readFileSync(SOUL, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] ja aplicado'); process.exit(0); }

  const a1 = "    if (entry.fedBack === true) return null; // replay already delivered once for this execution";
  if (count(src, a1) !== 1) { console.log('[FAIL] a1 ' + count(src, a1) + 'x'); process.exit(1); }
  src = src.replace(a1,
    "    if (entry.fedBack === true) return null; // replay already delivered once for this execution\n" +
    "    // " + MARK + " (owner 21/10): replay SOMENTE no mesmo turno. Cross-turn, a bridge\n" +
    "    // re-escaneava o buffer acumulado e re-emitia tool mutante velha; o cache servia\n" +
    "    // o result antigo SEM executar (\"sent\" fantasma pra outra tool). Turno novo = cache nao vale.\n" +
    "    const _v1623Turn = this.turns && typeof this.turns.get === 'function' ? this.turns.get(sessionId) : null;\n" +
    "    const _v1623TurnId = _v1623Turn ? _v1623Turn.turnId : null;\n" +
    "    if (!_v1623TurnId || entry.turnId !== _v1623TurnId) return null;");

  const a2 = "    sessionCache.set(toolHash, { timestamp: Date.now(), result, fedBack: false });";
  if (count(src, a2) !== 1) { console.log('[FAIL] a2 ' + count(src, a2) + 'x'); process.exit(1); }
  src = src.replace(a2,
    "    const _v1623TurnAtMark = this.turns && typeof this.turns.get === 'function' ? this.turns.get(sessionId) : null;\n" +
    "    sessionCache.set(toolHash, { timestamp: Date.now(), result, fedBack: false, turnId: _v1623TurnAtMark ? _v1623TurnAtMark.turnId : null }); // " + MARK);

  if (!syntaxCheckJS(src)) { console.log('[FAIL] sintaxe — NADA escrito'); process.exit(1); }
  fs.copyFileSync(SOUL, SOUL + '.bak-' + ts);
  fs.writeFileSync(SOUL, src);
  console.log('[OK] T1: replay cache agora eh turn-scoped | backup: luna-soul.cjs.bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.23 ===');
console.log('=== Pra v16.23b (extracao cross-turn na bridge), dispara UMA msg simples e roda: ===');
console.log('=== pm2 logs luna-kernel --lines 120 --nostream | grep -iE "TOOL_PROTOCOL|action_detected|Duplicate|recovered tool|json_buffer|dom_mirror" | tail -25 ===');
