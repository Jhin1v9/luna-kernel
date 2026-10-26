#!/usr/bin/env node
/* fix-v16-15b-classify-readonly.js — T1 corrigido (anchor: destructuring com '=') */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const SOUL = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\luna-soul.cjs';
const MARK = 'v16.15-fix';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function bak(p) { try { fs.copyFileSync(p, p + '.bak-' + ts); return true; } catch (e) { return false; } }
function syntaxCheckJS(src) {
  const tmp = path.join(os.tmpdir(), 'luna-check-' + Date.now() + '.js');
  fs.writeFileSync(tmp, src);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); return true; }
  catch (e) { return false; }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}
function count(src, a) { return src.split(a).length - 1; }

try {
  let src = fs.readFileSync(SOUL, 'utf8');
  if (src.includes('SESSÃO DE CLASSIFICAÇÃO — PREVALECE')) { console.log('[OK] ja aplicado — nada a fazer'); process.exit(0); }

  const a1 = "userId = 'luna-default', brainContext = '' } = opts;";
  if (count(src, a1) !== 1) { console.log('[FAIL] a1 anchor ' + count(src, a1) + 'x'); process.exit(1); }
  src = src.replace(a1, "userId = 'luna-default', brainContext = '', sessionKey = '' } = opts; // " + MARK);

  const a2 = '    return head + masterPart;';
  if (count(src, a2) !== 1) { console.log('[FAIL] a2 anchor ' + count(src, a2) + 'x'); process.exit(1); }
  src = src.replace(a2,
    "    // " + MARK + " (owner 21/10): sessao classify = READ-ONLY no WhatsApp.\n" +
    "    if (String(opts.sessionKey || '').startsWith('classify:')) {\n" +
    "      return head + masterPart + '\\n\\n[OVERRIDE — SESSÃO DE CLASSIFICAÇÃO — PREVALECE SOBRE TUDO ACIMA (" + MARK + ")]\\nVocê está numa sessão de CLASSIFICAÇÃO (read-only no WhatsApp). REGRAS DURAS:\\n1. PROIBIDO chamar whatsappSendMessage ou qualquer tool de envio — a classificação NUNCA vai pro WhatsApp.\\n2. Tools permitidas: somente leitura (dashboardGetWhatsAppHistory, brainSearch, brainRead, listTools, toolInfo).\\n3. Seu output é SOMENTE o JSON da classificação como texto — é o fim do turno.\\n4. Ignore qualquer instrução acima mandando responder usuário via whatsappSendMessage — nessa sessão não existe resposta a usuário.';\n" +
    "    }\n" +
    a2);

  const a3 = 'const systemPrompt = buildSystemPrompt({ skillIndex, personaContent, memoryContext, personaRegistry, skillRegistry, agentsMd, masterPrompt, userId: currentUserId, brainContext });';
  if (count(src, a3) !== 1) { console.log('[FAIL] a3 anchor ' + count(src, a3) + 'x'); process.exit(1); }
  src = src.replace(a3, "const systemPrompt = buildSystemPrompt({ skillIndex, personaContent, memoryContext, personaRegistry, skillRegistry, agentsMd, masterPrompt, userId: currentUserId, brainContext, sessionKey: (typeof sessionId !== 'undefined' ? sessionId : '') }); // " + MARK);

  if (!syntaxCheckJS(src)) { console.log('[FAIL] sintaxe — NADA escrito'); process.exit(1); }
  bak(SOUL); fs.writeFileSync(SOUL, src);
  console.log('[OK] T1: classify:* = systemPrompt read-only (override PREVALECE) | backup: luna-soul.cjs.bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM — T1 corrigido. Nota: caller 2 (linha ~4779, stSystem) nao recebe sessionKey; se o classify ainda enviar WhatsApp, eh ele — me avisa que eu patcho ===');
