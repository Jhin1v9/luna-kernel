#!/usr/bin/env node
/* fix-prompts-lean-v2.js — v16.13b-fix (owner 21/10)
   CAUSA-RAIZ do "mesmo prompt gigante toda hora":
   - luna-prompt-config.json 'toolResultPrompt' colava o bloco INSTRUÇÃO
     OBRIGATÓRIA (~1.200 chars) em TODA tool result
   - 'prompts.followUp' reenviava PROTOCOLO INTEIRO + histórico a cada msg nova
   Em sessão CDP PERSISTENTE isso é 100% redundante (a thread já segura tudo).
   FIX: (A) no modo persistente o prompt vira SÓ o conteúdo (userInput/toolResult
   enxuto); (B) toolResultPrompt fica leve nos dois modos. Stateless inalterado. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const SOUL = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\luna-soul.cjs';
const CFG  = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\config\\luna-prompt-config.json';
const MARK = 'v16.13b-fix';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function bak(p) { try { fs.copyFileSync(p, p + '.bak-' + ts); return true; } catch (e) { return false; } }
function syntaxCheckJS(src) {
  const tmp = path.join(os.tmpdir(), 'luna-check-' + Date.now() + '.js');
  fs.writeFileSync(tmp, src);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); return true; }
  catch (e) { return false; }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}
function restartPm2(svc) {
  try {
    spawn('cmd.exe', ['/c', 'pm2', 'restart', svc], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    console.log('[OK] restart disparado: ' + svc);
  } catch (e) { console.log('[AVISO] restart falhou (' + svc + '): ' + e.message); }
}

// ─────────────────────────────────────────────
// FASE A: soul — persistente = prompt leve puro
// ─────────────────────────────────────────────
try {
  const src = fs.readFileSync(SOUL, 'utf8');
  if (src.includes(MARK)) {
    console.log('[OK] A ja aplicado (' + MARK + ')');
  } else {
    const anchor = '      if (statelessHeader) {';
    const count = src.split(anchor).length - 1;
    if (count !== 1) {
      console.log('[FAIL] A: anchor ' + count + 'x (esperado 1) — NADA alterado');
    } else {
      const insert =
        '      // ' + MARK + ' (owner 21/10): CDP PERSISTENTE = prompt leve puro. A thread CDP ja segura persona,\n' +
        '      // protocolo e historico — reenviar templates cheios a cada turno era o "mesmo prompt gigante\n' +
        '      // toda hora" + custo de provider. Stateless (API pura) segue exatamente como estava.\n' +
        '      if (!isStatelessApi) {\n' +
        '        prompt = userInput;\n' +
        '        systemPrompt = isToolResult ? \'[TOOL LOOP]\' : \'[FOLLOW UP]\';\n' +
        '        console.log(`[LUNA-PROMPT] kind=${isToolResult ? \'toolLoop\' : \'followUp\'}-light bytes=${Buffer.byteLength(prompt, \'utf8\')}`);\n' +
        '      }\n' +
        '\n';
      const novo = src.replace(anchor, insert + anchor);
      if (!syntaxCheckJS(novo)) {
        console.log('[FAIL] A: sintaxe invalida apos patch — NADA escrito');
      } else {
        bak(SOUL);
        fs.writeFileSync(SOUL, novo);
        console.log('[OK] A: persistente agora manda SO o conteudo (msg/tool result) — zero boilerplate | backup: luna-soul.cjs.bak-' + ts);
      }
    }
  }
} catch (e) { console.log('[FAIL] A: ' + e.message); }

// ─────────────────────────────────────────────
// FASE B: config — toolResultPrompt enxuto (vale pros dois modos)
// ─────────────────────────────────────────────
try {
  const raw = fs.readFileSync(CFG, 'utf8');
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { console.log('[FAIL] B: config nao e JSON: ' + e.message); throw e; }
  const atual = typeof cfg.toolResultPrompt === 'string' ? cfg.toolResultPrompt : '';
  if (atual.includes('INSTRU') && atual.includes('OBRIGAT')) {
    cfg.toolResultPrompt = [
      '[TOOL RESULT]',
      '{"status": "{{successCount}}/{{totalCount}}", "tool": "{{toolsUsed}}", "result": "{{outputText}}"}',
      '[/TOOL RESULT]',
      'TAREFA INCOMPLETA? emita a PROXIMA tool em code block json AGORA — sem texto, sem pedir confirmacao.',
      'TAREFA COMPLETA? responda o usuario via whatsappSendMessage.',
      'Sem dado? busque ou escale — nunca finja.'
    ].join('\n');
    const novo = JSON.stringify(cfg, null, 2);
    JSON.parse(novo);
    bak(CFG);
    fs.writeFileSync(CFG, novo);
    console.log('[OK] B: toolResultPrompt enxuto (' + atual.length + ' -> ' + cfg.toolResultPrompt.length + ' chars) — INSTRUÇÃO OBRIGATÓRIA de cada tool result MORTA | backup: luna-prompt-config.json.bak-' + ts);
  } else if (atual) {
    console.log('[OK] B: toolResultPrompt ja esta enxuto (' + atual.length + ' chars)');
  } else {
    console.log('[OK] B: toolResultPrompt ausente (default neutro)');
  }
} catch (e) { /* ja logado */ }

// ─────────────────────────────────────────────
// FASE C: restart
// ─────────────────────────────────────────────
restartPm2('luna-kernel');

console.log('');
console.log('=== FIM — verificacao: manda msg nova pra Luna e rode ===');
console.log('=== pm2 logs luna-kernel --lines 40 --nostream | grep LUNA-PROMPT ===');
console.log('=== esperado: kind=followUp-light bytes=<poucas centenas> e kind=toolLoop-light ===');
