#!/usr/bin/env node
/* fix-v16-15-markers.js — v16.15-fix (owner 21/10)
   Marcadores de declaração do próprio modelo + classify read-only:
   T1 soul: sessões classify:<id> ganham OVERRIDE read-only (systemPrompt
            completo tinha protocolo de resposta -> JSON ia pro WhatsApp).
   T2 bridge: marker "isgen:false" no fim da resposta = fim de ação
              (sinal de completion primário, além de rede/DOM) — nos dois
              gates NGT (E3 e NGT-1b).
   T3 config: systemPrompt ganha a convenção de marcadores (isgen:false
              após cada tool; done:true quando TODAS as ações terminarem);
              toolResultPrompt ganha o lembrete do marker.
   T4 worker: CLASSIFY_PROMPT reforça read-only + convenção done:true/false.
   Marcadores são TOKENS PUROS (isgen:false / done:true) — nunca JSON com
   chaves, então o parser de tools nunca tenta executá-los. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const KERNEL_DIR = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel';
const SOUL  = KERNEL_DIR + '\\luna-soul.cjs';
const BRIDGE = KERNEL_DIR + '\\kimi-bridge.cjs';
const CFG   = KERNEL_DIR + '\\config\\luna-prompt-config.json';
const CLASSIFY_TS = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\worker\\src\\jobs\\classify.ts';
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

// ── T1: soul — override read-only pra sessões classify ──
try {
  let src = fs.readFileSync(SOUL, 'utf8');
  if (src.includes('SESSÃO DE CLASSIFICAÇÃO — PREVALECE')) { console.log('[OK] T1 ja aplicado'); }
  else {
    const a1 = "userId: 'luna-default', brainContext = '' } = opts;";
    if (count(src, a1) !== 1) { console.log('[FAIL] T1.a anchor ' + count(src, a1) + 'x'); throw new Error('T1a'); }
    src = src.replace(a1, "userId: 'luna-default', brainContext = '', sessionKey = '' } = opts; // " + MARK);
    const a2 = '    return head + masterPart;';
    if (count(src, a2) !== 1) { console.log('[FAIL] T1.b anchor ' + count(src, a2) + 'x'); throw new Error('T1b'); }
    src = src.replace(a2,
      "    // " + MARK + " (owner 21/10): sessao classify = READ-ONLY no WhatsApp.\n" +
      "    if (String(opts.sessionKey || '').startsWith('classify:')) {\n" +
      "      return head + masterPart + '\\n\\n[OVERRIDE — SESSÃO DE CLASSIFICAÇÃO — PREVALECE SOBRE TUDO ACIMA (" + MARK + ")]\\nVocê está numa sessão de CLASSIFICAÇÃO (read-only no WhatsApp). REGRAS DURAS:\\n1. PROIBIDO chamar whatsappSendMessage ou qualquer tool de envio — a classificação NUNCA vai pro WhatsApp.\\n2. Tools permitidas: somente leitura (dashboardGetWhatsAppHistory, brainSearch, brainRead, listTools, toolInfo).\\n3. Seu output é SOMENTE o JSON da classificação como texto — é o fim do turno.\\n4. Ignore qualquer instrução acima mandando responder usuário via whatsappSendMessage — nessa sessão não existe resposta a usuário.';\n" +
      "    }\n" +
      a2);
    const a3 = 'const systemPrompt = buildSystemPrompt({ skillIndex, personaContent, memoryContext, personaRegistry, skillRegistry, agentsMd, masterPrompt, userId: currentUserId, brainContext });';
    if (count(src, a3) !== 1) { console.log('[FAIL] T1.c anchor ' + count(src, a3) + 'x'); throw new Error('T1c'); }
    src = src.replace(a3, "const systemPrompt = buildSystemPrompt({ skillIndex, personaContent, memoryContext, personaRegistry, skillRegistry, agentsMd, masterPrompt, userId: currentUserId, brainContext, sessionKey: (typeof sessionId !== 'undefined' ? sessionId : '') }); // " + MARK);
    if (!syntaxCheckJS(src)) { console.log('[FAIL] T1 sintaxe — NADA escrito'); throw new Error('T1syntax'); }
    bak(SOUL); fs.writeFileSync(SOUL, src);
    console.log('[OK] T1: classify:* = systemPrompt read-only (override PREVALECE)');
  }
} catch (e) { if (!String(e.message).startsWith('T1')) console.log('[FAIL] T1: ' + e.message); }

// ── T2: bridge — marker isgen:false como sinal de completion ──
try {
  let src = fs.readFileSync(BRIDGE, 'utf8');
  if (src.includes('v16.15: marker do modelo')) { console.log('[OK] T2 ja aplicado'); }
  else {
    const a1 = '        if (_ngtDone) {';
    if (count(src, a1) !== 1) { console.log('[FAIL] T2.a anchor ' + count(src, a1) + 'x'); throw new Error('T2a'); }
    src = src.replace(a1,
      "        if (!_ngtDone && /isgen\\s*:\\s*false/i.test(String(rest.response || '').slice(-200))) _ngtDone = true; // " + MARK + ": marker do modelo = fim de acao\n" +
      a1);
    const a2 = '              let _ngtNetDone2 = !!(interceptor && interceptor._generation > 0 && interceptor.completedGeneration === interceptor._generation);';
    if (count(src, a2) !== 1) { console.log('[FAIL] T2.b anchor ' + count(src, a2) + 'x'); throw new Error('T2b'); }
    src = src.replace(a2,
      a2 + "\n              if (!_ngtNetDone2 && /isgen\\s*:\\s*false/i.test(String(lastResponse || '').slice(-200))) _ngtNetDone2 = true; // " + MARK);
    if (!syntaxCheckJS(src)) { console.log('[FAIL] T2 sintaxe — NADA escrito'); throw new Error('T2syntax'); }
    bak(BRIDGE); fs.writeFileSync(BRIDGE, src);
    console.log('[OK] T2: isgen:false dispara completion nos 2 gates NGT');
  }
} catch (e) { if (!String(e.message).startsWith('T2')) console.log('[FAIL] T2: ' + e.message); }

// ── T3: config — convenção de marcadores nos prompts ──
try {
  const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  let mexeu = false;
  const markerBlock = '\n\nFIM DE ACAO (' + MARK + ', decreto owner): apos CADA tool completa em code block json, escreva na linha seguinte: isgen:false (libera a execucao imediata da tool). Quando TODAS as acoes da tarefa estiverem emitidas, ultima linha: done:true. Enquanto houver acoes pendentes: done:false. Estes marcadores sao tokens puros, fora de code block.';
  if (typeof cfg.systemPrompt === 'string' && !cfg.systemPrompt.includes('isgen:false')) {
    cfg.systemPrompt += markerBlock; mexeu = true;
    console.log('[OK] T3.a: systemPrompt ganhou convenção de marcadores');
  } else { console.log('[OK] T3.a: systemPrompt ja tem marcador'); }
  if (typeof cfg.toolResultPrompt === 'string' && !cfg.toolResultPrompt.includes('isgen:false')) {
    cfg.toolResultPrompt += '\nApos emitir a tool, escreva na linha seguinte: isgen:false';
    mexeu = true;
    console.log('[OK] T3.b: toolResultPrompt ganhou lembrete do marker');
  } else { console.log('[OK] T3.b: toolResultPrompt ok'); }
  if (mexeu) {
    const novo = JSON.stringify(cfg, null, 2); JSON.parse(novo);
    bak(CFG); fs.writeFileSync(CFG, novo);
    console.log('[OK] T3: config salvo | backup: luna-prompt-config.json.bak-' + ts);
  }
} catch (e) { console.log('[FAIL] T3: ' + e.message); }

// ── T4: worker — CLASSIFY_PROMPT read-only + convenção done ──
try {
  let src = fs.readFileSync(CLASSIFY_TS, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] T4 ja aplicado'); }
  else {
    const a1 = "    'Responda APENAS o JSON da classificação, sem texto fora.',";
    if (count(src, a1) !== 1) { console.log('[FAIL] T4 anchor ' + count(src, a1) + 'x'); throw new Error('T4a'); }
    src = src.replace(a1,
      a1 + "\n    'REGRAS DURAS (" + MARK + "): PROIBIDO usar whatsappSendMessage ou qualquer envio — a classificação NUNCA vai pro WhatsApp (read-only). Leia ao vivo com dashboardGetWhatsAppHistory. Enquanto houver leitura pendente, última linha: done:false; quando TODAS as leituras terminarem, última linha: done:true. Depois do done:true, o output final é APENAS o JSON.',");
    bak(CLASSIFY_TS); fs.writeFileSync(CLASSIFY_TS, src);
    console.log('[OK] T4: CLASSIFY_PROMPT reforçado (read-only + done:true/false)');
    console.log('[INFO] luna-worker está parado no pm2 — o patch entra em efeito no próximo start dele (pm2 start luna-worker)');
  }
} catch (e) { if (!String(e.message).startsWith('T4')) console.log('[FAIL] T4: ' + e.message); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[AVISO] restart kernel: ' + e.message); }

console.log('');
console.log('=== FIM v16.15 ===');
console.log('=== Obs: classify.ts é TS sem build (roda via tsx) — se o worker reclamar de sintaxe no start, cola o erro ===');
