#!/usr/bin/env node
/**
 * fix-single-route.js — AUTO-CURA + ROTA UNICA de retorno da tool (2026-10-19)
 *
 * PARTE 1 — AUTO-CURA: o scan das 21:45 mostrou texto VELHO de volta na soul
 * (buffer antigo salvo no VS Code / git checkout). Re-aplica K3a-d + R1-R4
 * (soul) e K3e (bridge) SE estiverem faltando. Tudo idempotente: ja aplicado = SKIP.
 *
 * PARTE 2 — ROTA UNICA (decreto owner): quem executa manda pros dois.
 *   soul termina tool -> _sendToolResultViaExtension() joga o resultado na
 *   fila da extensao -> content.js injectToolResult() preenche o Kimi e da send
 *   -> ponte so OBSERVA a resposta (skipSubmit), nao digita mais via CDP.
 *   CDP continua SO quando a extensao esta offline (fallback automatico).
 *
 * USO:  node fix-single-route.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const SOUL = path.join(ROOT, 'packages', 'kernel', 'luna-soul.cjs');
const BRIDGE = path.join(ROOT, 'packages', 'kernel', 'kimi-bridge.cjs');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
let errors = 0;

const OK = (m) => console.log('\x1b[32m  [OK]\x1b[0m ' + m);
const SKIP = (m) => console.log('\x1b[90m  [SKIP]\x1b[0m ' + m + ' — ja aplicado');
const FAIL = (m) => { console.log('\x1b[31m  [FALHOU]\x1b[0m ' + m); errors++; };
const H = (m) => console.log('\n\x1b[36m=== ' + m + ' ===\x1b[0m');

// executa PowerShell via .ps1 temporario (imune a quoting no Git Bash)
function runPS(body) {
  const tmp = path.join(os.tmpdir(), `luna-sr-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`, { encoding: 'utf8' });
  } catch (e) {
    return (e.stdout || '').toString();
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// ─────────────────────────── PATCH DEFINITIONS ───────────────────────────
// strings com \n = newline real, \\` = backslash+crase, \\n = backslash+n literal

const SOUL_PATCHES = [
  // ── SELF-HEAL K3 ──
  {
    id: 'K3a: circuit breaker removido',
    old: "        if (cbCount > 3) {\n          const cbName = parsed.mode === 'SCRIPT' ? 'executeScript' : parsed.tool;\n          yield { type: 'warning', message: '🔁 Circuit breaker: mesma chamada (' + cbName + ') emitida 3x sem progressão — encerrando o loop.', sessionId };\n          const cbResponse = 'Tentei executar ' + cbName + ' várias vezes, mas não consegui progredir. O resultado da última tentativa foi: ' + String(result && result.output ? result.output : '(sem saída)').slice(0, 300) + ' — me diga se quer que eu tente de outro jeito.';\n          yield { type: 'done', result: { success: true, mode: 'CHAT', response: cbResponse, sessionId }, sessionId };\n          return;\n        }",
    neu: "        if (cbCount > 3) {\n          // v14.3-fix (owner 2026-10-19): circuit breaker NUNCA encerra o turno.\n          console.warn('[LUNA-SOUL] mesma chamada (' + (parsed.mode === 'SCRIPT' ? 'executeScript' : parsed.tool) + ') emitida ' + cbCount + 'x — continuando (decreto owner: sem breaker)');\n        }",
    exp: 1,
  },
  {
    id: 'K3b: toolLoop CDP sem historico',
    old: "      const history = historyLines.slice(isToolResult ? -12 : (isStatelessApi ? -30 : -10)).join('\\n');",
    neu: "      // v14.3-fix (owner 2026-10-19): toolLoop NUNCA reenvia historico acumulado\n      // (output inteiro das tools decolava o prompt: 592B -> 13.7KB). A thread CDP\n      // do Kimi Web ja segura a conversa. API stateless PRECISA do historico.\n      const history = (isToolResult && !isStatelessApi)\n        ? ''\n        : historyLines.slice(isStatelessApi ? -30 : -10).join('\\n');",
    exp: 1,
  },
  {
    id: 'K3c: luna_response_complete nao cancela com tools pendentes',
    old: "                // PROTOCOL COMPLETION: Cancel stream immediately\n                // The V2 protocol is the authority - don't wait for stream_end\n                console.log(`[PROTO][STREAM_CANCEL_REQUESTED] time=${Date.now()} reason=v2_response_complete`);\n                try {\n                  await this.kimiBridge.cancelStream(userId, true); // soft-cancel: stop Kimi, drain queue\n                  console.log(`[PROTO][STREAM_CANCELLED] time=${Date.now()}`);\n                } catch (cancelErr) {\n                  console.log(`[PROTO][STREAM_CANCEL_ERROR] time=${Date.now()} error=${cancelErr.message}`);\n                }",
    neu: "                // v14.3-fix (owner 2026-10-19): NUNCA cancelar a stream com tools\n                // pendentes — o cancel engolia o loopback dos resultados.\n                if (domActionPromises.length === 0) {\n                  // PROTOCOL COMPLETION: Cancel stream immediately\n                  // The V2 protocol is the authority - don't wait for stream_end\n                  console.log(`[PROTO][STREAM_CANCEL_REQUESTED] time=${Date.now()} reason=v2_response_complete`);\n                  try {\n                    await this.kimiBridge.cancelStream(userId, true); // soft-cancel: stop Kimi, drain queue\n                    console.log(`[PROTO][STREAM_CANCELLED] time=${Date.now()}`);\n                  } catch (cancelErr) {\n                    console.log(`[PROTO][STREAM_CANCEL_ERROR] time=${Date.now()} error=${cancelErr.message}`);\n                  }\n                } else {\n                  console.log(`[PROTO][STREAM_CANCEL_SKIPPED] time=${Date.now()} reason=tools_pending count=${domActionPromises.length}`);\n                }",
    exp: 1,
  },
  {
    id: 'K3d: v2ResponseComplete nao engole resultados',
    old: "      if (v2ResponseComplete) {\n        // Clear watchdog timer",
    neu: "      // v14.3-fix: com tools executadas neste turno, cai no fluxo normal de\n      // feedback — dar done aqui engolia o resultado (owner virava transporte\n      // manual colando outputs no chat).\n      if (v2ResponseComplete && domActionResults.length === 0) {\n        // Clear watchdog timer",
    exp: 1,
  },
  // ── SELF-HEAL PROMPT (R1-R4) ──
  {
    id: 'R1: DEFAULT_MINI_REMINDER JSON puro',
    old: 'const DEFAULT_MINI_REMINDER = `PROTOCOLO (lembrete):\n- Tool: [[action]]\n{"tool":"nome","params":{}}\n[[/action]]\n- Resposta: [[response]]\ntexto\n[[/response]]\n- code block \\`\\`\\`json com {"tool":...} / {"response":...} equivale aos blocos.\n- NUNCA use tags XML (<luna_tool_call>, <luna_response>).\n\nApós receber um resultado, continue a tarefa.`;',
    neu: 'const DEFAULT_MINI_REMINDER = `PROTOCOLO (lembrete):\n- Tool: code block \\`\\`\\`json com {"tool":"nome","params":{}} — EXCLUSIVAMENTE este formato.\n- Resposta: code block \\`\\`\\`json com {"response":"texto"}\n- NUNCA use [[action]]/[[response]] nem tags XML — soh JSON puro no code block.\n- NAO sabe quais tools existem? Chame {"tool":"listTools","params":{}} primeiro pra ver o indice oficial.\n\nApós receber um resultado, continue a tarefa.`;',
    exp: 1,
  },
  {
    id: 'R2: secao [FORMAT] JSON puro',
    old: '[FORMAT — DOIS FORMATOS ACEITOS (equivalentes, use UM deles)]\n- Response: \\`\\`\\`json\\n{"response": "Sua resposta aqui"}\\n\\`\\`\\`  — ou —  [[response]]\\nSua resposta\\n[[/response]]\n- Tool:    \\`\\`\\`json\\n{"tool": "...", "params": {...}}\\n\\`\\`\\`  — ou —  [[action]]\\n{"tool": "...", "params": {...}}\\n[[/action]]\n- Script:  \\`\\`\\`json\\n{"script": "..."}\\n\\`\\`\\`\nNUNCA use tags XML (<luna_tool_call>, <luna_response>) — nao sao o protocolo oficial.',
    neu: '[FORMAT — JSON PURO (UNICO FORMATO ACEITO)]\n- Response: \\`\\`\\`json\\n{"response": "Sua resposta aqui"}\\n\\`\\`\\`\n- Tool:    \\`\\`\\`json\\n{"tool": "...", "params": {...}}\\n\\`\\`\\`\n- Script:  \\`\\`\\`json\\n{"script": "..."}\\n\\`\\`\\`\nNUNCA use [[action]]/[[response]] nem tags XML (<luna_tool_call>, <luna_response>) — soh JSON puro no code block.\nNAO sabe quais tools existem ou quais params usar? Chame primeiro \\`\\`\\`json\\n{"tool": "listTools", "params": {}}\\n\\`\\`\\` (indice oficial) ou {"tool": "toolInfo", "params": {"name": "NOME"}} (docs da tool).',
    exp: 1,
  },
  {
    id: 'R3: templates firstMessage/followUp JSON puro',
    old: 'Responda com EXATAMENTE UM dos formatos oficiais: um code block \\`\\`\\`json com {"response": "..."} ou {"tool": ..., "params": ...} — OU o bloco equivalente [[response]]...[[/response]] / [[action]]...[[/action]]. NUNCA use tags XML (<luna_tool_call>):',
    neu: 'Responda com EXATAMENTE UM formato oficial: um code block \\`\\`\\`json contendo SEMPRE um objeto JSON completo — {"response": "..."} pra responder ou {"tool": ..., "params": ...} pra agir. NUNCA use [[action]]/[[response]] nem tags XML. NAO sabe quais tools existem ou quais params usar? Chame primeiro {"tool": "listTools", "params": {}} (indice) ou {"tool": "toolInfo", "params": {"name": "NOME"}} (docs):',
    exp: 2,
  },
  {
    id: 'R4: prompt de reparo luna_unknown_output (ensinava XML)',
    old: "loopInput = 'Formato de saída não reconhecido. Use exatamente um destes formatos:\\n\\n<luna_tool_call>\\n{\"name\":\"tool\",\"arguments\":{}}\\n</luna_tool_call>\\n\\nou\\n\\n<luna_response>\\ntexto\\n</luna_response>';",
    neu: "loopInput = 'Formato de saída não reconhecido. Responda SEMPRE com UM code block \\`\\`\\`json contendo um objeto JSON completo: {\"response\": \"texto\"} para responder ou {\"tool\": \"nome\", \"params\": {...}} para agir. NUNCA use [[action]]/[[response]] nem tags XML. NAO sabe quais tools existem? Chame {\"tool\": \"listTools\", \"params\": {}} primeiro.';",
    exp: 1,
  },
  // ── ROTA UNICA: helper + 2 ganchos + call-site ──
  {
    id: 'S1: helper _sendToolResultViaExtension',
    old: '  /** ACTION mode — execute a tool */',
    neu: "  // v14.4-fix (owner 2026-10-19) — ROTA UNICA de retorno da tool: quem executa\n  // manda pros dois (frontend SSE + fila da extensao). content.js injeta o\n  // texto no textarea do Kimi e da send — sem depender de canSteer/isGen/CDP.\n  _sendToolResultViaExtension(text) {\n    try {\n      const app = global.__lunaApp;\n      const h = app && app.locals ? app.locals.extensionHandler : null;\n      if (!h || typeof h._sendToSession !== 'function') return 0;\n      let sids = [];\n      if (typeof h.getConnectedSessions === 'function') {\n        sids = h.getConnectedSessions() || [];\n      } else if (h.sessions && typeof h.sessions.keys === 'function') {\n        sids = Array.from(h.sessions.keys());\n      }\n      let sent = 0;\n      for (const sid of sids) {\n        try {\n          h._sendToSession(sid, { type: 'tool_result', result: text, text: text, source: 'luna-soul-feedback' });\n          sent++;\n        } catch (e) { /* sessao pode ter morrido — ignora */ }\n      }\n      if (sent > 0) {\n        console.log(`[LUNA-SOUL] tool result -> extensao (${sent} sessao/oes, ${String(text).length} chars) — content.js injeta na pagina`);\n      }\n      return sent;\n    } catch (e) {\n      console.warn('[LUNA-SOUL] _sendToolResultViaExtension: ' + e.message);\n      return 0;\n    }\n  }\n\n  /** ACTION mode — execute a tool */",
    exp: 1,
  },
  {
    id: 'S2a: gancho no fluxo principal (apos tool executar)',
    old: '        loopContext = await this._buildContext(sessionId, loopInput, { ...options, isFirstMessage: false, isToolResult: true });',
    neu: '        loopContext = await this._buildContext(sessionId, loopInput, { ...options, isFirstMessage: false, isToolResult: true });\n        // v14.4-fix ROTA UNICA: a extensao injeta o resultado na pagina do Kimi;\n        // se conectada, a ponte NAO digita (skipSubmit no proximo send).\n        if (this._sendToolResultViaExtension(loopContext.prompt) > 0) {\n          options = { ...options, __skipBridgeSubmit: true };\n        }',
    exp: 1,
  },
  {
    id: 'S2b: gancho no fluxo pos-STREAM_CANCELLED',
    old: '              loopContext = await this._buildContext(sessionId, loopInput, { ...options, isFirstMessage: false, isToolResult: true });',
    neu: '              loopContext = await this._buildContext(sessionId, loopInput, { ...options, isFirstMessage: false, isToolResult: true });\n              // v14.4-fix ROTA UNICA (pos-cancel): a extensao injeta o resultado.\n              if (this._sendToolResultViaExtension(loopContext.prompt) > 0) {\n                options = { ...options, __skipBridgeSubmit: true };\n              }',
    exp: 1,
  },
  {
    id: 'S3: sendMessageStream com skipSubmit consumivel',
    old: '          const stream = this.kimiBridge.sendMessageStream(userId, loopContext.prompt, { mode, files: options.files, newChat: forceNewChat, isAutoContinue: safety > 1 }, provider);',
    neu: '          // v14.4-fix: se a extensao vai injetar o tool-result na pagina, a ponte so observa\n          const _skipSubmitOnce = options.__skipBridgeSubmit === true;\n          if (_skipSubmitOnce) options = { ...options, __skipBridgeSubmit: false };\n          const stream = this.kimiBridge.sendMessageStream(userId, loopContext.prompt, { mode, files: options.files, newChat: forceNewChat, isAutoContinue: safety > 1, skipSubmit: _skipSubmitOnce }, provider);',
    exp: 1,
  },
];

const BRIDGE_PATCHES = [
  {
    id: 'K3e: PROCESSING_DRAIN_TIMEOUT_MS 60s -> 10s',
    old: 'const PROCESSING_DRAIN_TIMEOUT_MS = 60_000;',
    neu: 'const PROCESSING_DRAIN_TIMEOUT_MS = 10_000; // v14.3-fix (2026-10-19): era 60s — a proxima msg esperava 1min pro force-clear ("mando msg e ele revive")',
    exp: 1,
  },
  {
    id: 'B1: skipSubmit — ponte so observa quando a extensao injeta',
    old: "      // W7-T4: Lexical-safe fill. Playwright's fill() does not register in the\n      // React/Lexical contenteditable (text visible in the DOM but EditorState\n      // empty → Enter becomes a no-op and the message sits unsent in the box).\n      await this._fillContentEditable(inputLocator, text);\n      await page.waitForTimeout(500);\n      // TRACE: log bridge send started (about to call _submitWithVerification)\n      console.log(`[TRACE][BRIDGE_SEND_STARTED] time=${Date.now()} userId=${hashUserId(userId)} textLen=${text.length} provider=${resolvedProvider}`);\n      // W7-T4: verify-and-retry submit — typed text must never sit unsent.\n      await this._submitWithVerification(page, inputLocator, text, { provider: resolvedProvider });\n      // TRACE: log bridge send completed\n      console.log(`[TRACE][BRIDGE_SEND_COMPLETED] time=${Date.now()} userId=${hashUserId(userId)}`);",
    neu: "      // W7-T4: Lexical-safe fill. Playwright's fill() does not register in the\n      // React/Lexical contenteditable (text visible in the DOM but EditorState\n      // empty → Enter becomes a no-op and the message sits unsent in the box).\n      // v14.4-fix (owner 2026-10-19): skipSubmit — quando a extensao injeta o\n      // tool-result na pagina (rota unica), a ponte NAO digita de novo.\n      if (!options.skipSubmit) {\n        await this._fillContentEditable(inputLocator, text);\n        await page.waitForTimeout(500);\n        // TRACE: log bridge send started (about to call _submitWithVerification)\n        console.log(`[TRACE][BRIDGE_SEND_STARTED] time=${Date.now()} userId=${hashUserId(userId)} textLen=${text.length} provider=${resolvedProvider}`);\n        // W7-T4: verify-and-retry submit — typed text must never sit unsent.\n        await this._submitWithVerification(page, inputLocator, text, { provider: resolvedProvider });\n        // TRACE: log bridge send completed\n        console.log(`[TRACE][BRIDGE_SEND_COMPLETED] time=${Date.now()} userId=${hashUserId(userId)}`);\n      } else {\n        log.info('[sendMessageStream] skipSubmit=true — extensao injeta o texto; ponte apenas observa a resposta');\n      }",
    exp: 1,
  },
];

// ─────────────────────────── APPLY ENGINE ───────────────────────────
function applyPatches(file, patches, label) {
  H(label);
  if (!fs.existsSync(file)) { FAIL('arquivo nao encontrado: ' + file); return; }
  fs.copyFileSync(file, file + '.bak-' + ts);
  let src = fs.readFileSync(file, 'utf8');
  const isCrlf = src.includes('\r\n');
  const norm = (s) => isCrlf ? s.replace(/\n/g, '\r\n') : s;

  for (const p of patches) {
    const o = norm(p.old);
    const n = norm(p.neu);
    if (src.includes(n) || (p.id.startsWith('S2') && src.includes('__skipBridgeSubmit')) ) {
      SKIP(p.id);
      continue;
    }
    const count = src.split(o).length - 1;
    if (count === 0) { FAIL(p.id + ' — padrao original nao encontrado (arquivo em estado inesperado?)'); continue; }
    if (count !== p.exp) { FAIL(p.id + ' — padrao encontrado ' + count + 'x (esperado ' + p.exp + ')'); continue; }
    src = src.split(o).join(n);
    OK(p.id + ' (' + count + 'x)');
  }
  fs.writeFileSync(file, src);
}

// 0. Congela respawn e mata zumbis (senao o restart morre em EADDRINUSE de novo)
H('0/4 — pm2 stop + limpa zumbis luna-server.js');
try { execSync('pm2 stop luna-kernel', { encoding: 'utf8' }); OK('luna-kernel parado'); }
catch { console.log('\x1b[90m  (ja estava parado)\x1b[0m'); }
const killOut = runPS(`
$me = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -like '*luna-server.js*' -and $_.ProcessId -ne $me -and $_.CommandLine -notlike '*fix-*'
} | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; "morto: $($_.ProcessId)" } catch {} }
`);
if (killOut.trim()) killOut.trim().split('\n').forEach(l => console.log('  💀 ' + l.trim()));

// 1+2. Patches
applyPatches(SOUL, SOUL_PATCHES, '1/4 — luna-soul.cjs (self-heal K3+R1-R4 + ROTA UNICA S1-S3)');
applyPatches(BRIDGE, BRIDGE_PATCHES, '2/4 — kimi-bridge.cjs (K3e + skipSubmit B1)');

// 3. Sobe limpo
H('3/4 — pm2 restart luna-kernel');
try { execSync('pm2 restart luna-kernel', { encoding: 'utf8' }); OK('reiniciado'); }
catch { FAIL('pm2 restart falhou — roda manual: pm2 restart luna-kernel'); }

// 4. Verificacao
H('4/4 — verificacao (8s)');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  await sleep(8000);
  const procs = runPS(`
$me = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -like '*luna-server.js*' -and $_.ProcessId -ne $me -and $_.CommandLine -notlike '*fix-*'
} | Select-Object ProcessId,ParentProcessId)
Write-Output ("COUNT=" + $procs.Count)
$procs | Format-Table -AutoSize | Out-String -Width 120
`);
  console.log('  Processos luna-server.js:');
  console.log('  ' + (procs.trim() || '(nenhum)').replace(/\n/g, '\n  '));
  let portOut = '';
  try { portOut = execSync('netstat -ano | findstr :3458 | findstr LISTENING', { encoding: 'utf8' }).trim(); } catch {}
  console.log('  Porta 3458: ' + (portOut || '(ninguem)').replace(/\n/g, ' | '));

  console.log('');
  if (errors > 0) {
    console.log('\x1b[33m⚠ ' + errors + ' falha(s). Backups: *.bak-' + ts + ' — me manda quais falharam\x1b[0m');
    process.exit(1);
  }
  console.log('\x1b[32m✅ ROTA UNICA INSTALADA.\x1b[0m');
  console.log('   FLUXO: tool executa → soul manda p/ frontend + fila da extensao →');
  console.log('   content.js injeta no Kimi e da send → ponte so observa (skipSubmit).');
  console.log('');
  console.log('\x1b[33m⚠⚠ AGORA FAZ ISSO (ordem importa):');
  console.log('   1. Recarrega a extensao: chrome://extensions → 🔄 na Luna (K1/K2 + injectToolResult rapido)');
  console.log('   2. NOVA SESSAO na Luna Web (pega o prompt JSON-puro de volta se tinha revertido)');
  console.log('   3. Manda o teste multi-tool — agora o resultado VOLTA sozinho pro Kimi\x1b[0m');
  console.log('\x1b[90mBackups: *.bak-' + ts + '\x1b[0m');
})();
