#!/usr/bin/env node
/* fix-voicecall-dispatch.js — v16.13c-fix (owner 21/10)
   Sintoma: listTools mostra voiceCallPlace/voiceCallEnd (165 tools), mas executar
   caía em "Ferramenta desconhecida". Causa: voice-call-tools.cjs exporta as
   funções e luna-tools.cjs espalha no module.exports, mas o switch dispatcher
   do luna-soul.cjs NUNCA teve case pra elas (commit do voice esqueceu o wiring).
   Fix: 2 cases no dispatcher. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const SOUL  = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\luna-soul.cjs';
const TOOLS = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\luna-tools.cjs';
const MARK = 'v16.13c-fix';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function bak(p) { try { fs.copyFileSync(p, p + '.bak-' + ts); return true; } catch (e) { return false; } }
function syntaxCheckJS(src) {
  const tmp = path.join(os.tmpdir(), 'luna-check-' + Date.now() + '.js');
  fs.writeFileSync(tmp, src);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); return true; }
  catch (e) { return false; }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

// Sanidade: luna-tools realmente exporta as funções?
try {
  const t = fs.readFileSync(TOOLS, 'utf8');
  if (!t.includes('...voiceCallTools')) {
    console.log('[FAIL] luna-tools.cjs NAO espalha voiceCallTools nos exports — dispatcher sozinho nao basta. NADA alterado.');
    process.exit(1);
  }
  console.log('[OK] sanity: luna-tools.cjs exporta voiceCallPlace/voiceCallEnd (...voiceCallTools presente)');
} catch (e) { console.log('[FAIL] sanity: ' + e.message); process.exit(1); }

// Patch no dispatcher
try {
  const src = fs.readFileSync(SOUL, 'utf8');
  if (src.includes(MARK)) {
    console.log('[OK] ja aplicado (' + MARK + ')');
  } else {
    const anchor = 'default: return { success: false, error: `Ferramenta desconhecida:';
    const count = src.split(anchor).length - 1;
    if (count !== 1) {
      console.log('[FAIL] anchor ' + count + 'x (esperado 1) — NADA alterado');
      process.exit(1);
    }
    const insert =
      '              // ' + MARK + ' (owner 21/10): wiring faltava — tools existiam no modulo/catalogo mas sem case no dispatcher.\n' +
      "              case 'voiceCallPlace': return lunaTools.voiceCallPlace(p);\n" +
      "              case 'voiceCallEnd': return lunaTools.voiceCallEnd(p);\n";
    const novo = src.replace(anchor, insert + '              ' + anchor);
    if (!syntaxCheckJS(novo)) {
      console.log('[FAIL] sintaxe invalida apos patch — NADA escrito');
      process.exit(1);
    }
    bak(SOUL);
    fs.writeFileSync(SOUL, novo);
    console.log('[OK] dispatcher: voiceCallPlace + voiceCallEnd com case | backup: luna-soul.cjs.bak-' + ts);
  }
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[AVISO] restart falhou: ' + e.message); }

console.log('');
console.log('=== FIM — manda "luna liga pra mim. assunto: teste da chamada" de novo ===');
