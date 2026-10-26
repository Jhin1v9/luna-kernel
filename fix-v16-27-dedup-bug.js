#!/usr/bin/env node
/* fix-v16-27-dedup-bug.js — v16.27 (owner 21/10)
   BUG do v16.21 (deixado passar no --check): _v1621Dedup (8625) chamava
   buildJsonBufferAction, definido so em 9068 -> ReferenceError derrubava o
   stream e matava o turno ANTES do tool result voltar (whatsappAllowContact
   executou com success=true, mas a entrega quebrou).
   Fix: (1) _v1621Dedup monta o objeto inline (sem depender do helper tardio);
       (2) chave de dedup por tool+JSON ESTRITO de params (code/script/etc),
           blindando contra executeScript ambiguo trocar a chave. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const BRIDGE = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\kimi-bridge.cjs';
const MARK = 'v16.27-fix';
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

  const a1 = '      return buildJsonBufferAction(tool, params);';
  if (src.split(a1).length - 1 !== 1) { console.log('[FAIL] a1 ' + (src.split(a1).length - 1) + 'x'); process.exit(1); }
  src = src.replace(a1,
    "      return { type: 'action', action: { tool, params } }; // " + MARK + ": inline, sem depender do helper tardio (def. em 9068)");

  const a2 = '        const key = String(tool) + \'|\' + JSON.stringify(params || {});';
  if (src.split(a2).length - 1 !== 1) { console.log('[FAIL] a2 ' + (src.split(a2).length - 1) + 'x'); process.exit(1); }
  src = src.replace(a2,
    "        const key = String(tool) + '|' + JSON.stringify(params || {}, Object.keys(params || {}).sort()); // " + MARK + ": chave estrita");

  if (!syntaxCheckJS(src)) { console.log('[FAIL] sintaxe — NADA escrito'); process.exit(1); }
  fs.copyFileSync(BRIDGE, BRIDGE + '.bak-' + ts);
  fs.writeFileSync(BRIDGE, src);
  console.log('[OK] _v1621Dedup: inline + chave estrita | backup: kimi-bridge.cjs.bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.27 ===');
console.log('=== TESTE: msg no grupo -> ela tenta o grupo, allowContact executa, RESULT VOLTA, envio completa ===');
