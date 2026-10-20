#!/usr/bin/env node
/**
 * fix-voice-call-end.js — v1.14 (decreto owner 21/10 01:45)
 * ENCERRAR A CHAMADA PELO CHAT:
 * A) kernel voice-call-tools.cjs: nova tool voiceCallEnd() — pg_notify
 *    'voice_call_control' (sinal de desligar a call ativa).
 * B) kernel tool-catalog.cjs: voiceCallEnd no CORE_TOOLS (com ex) + indice.
 * C) kernel luna-prompt-config.json: CHAMADAS ganha "pra ENCERRAR use voiceCallEnd {}".
 * D) agent call-executor.ts: o poll da chamada escuta LISTEN voice_call_control —
 *    sinal externo quebra o loop -> handle.stop() -> cascade existente (decreto
 *    26/09) fecha o lado ChatGPT junto (resetChatTab).
 * Seguro: backups, valida sintaxe/JSON/balanceamento, idempotente.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const KERNEL = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const AGENT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const VTOOLS = path.join(KERNEL, 'packages', 'kernel', 'voice-call-tools.cjs');
const CATALOG = path.join(KERNEL, 'packages', 'kernel', 'tool-catalog.cjs');
const CONFIG = path.join(KERNEL, 'packages', 'kernel', 'config', 'luna-prompt-config.json');
const EXECUTOR = path.join(AGENT, 'apps', 'whatsplay', 'src', 'voice', 'call-executor.ts');

function ok(m) { console.log('[OK] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); process.exit(1); }
function bak(f) {
  const b = f + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(f, b);
  return b;
}
function balanced(x) { return x.split('{').length === x.split('}').length && x.split('(').length === x.split(')').length; }
function checkJs(file, out) {
  const tmp = file + '.tmpchk.js';
  fs.writeFileSync(tmp, out, 'utf8');
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
  catch { try { fs.unlinkSync(tmp); } catch {} fail('sintaxe invalida: ' + path.basename(file)); }
  try { fs.unlinkSync(tmp); } catch {}
}

(async function main() {
  /* ---------- A) kernel tool voiceCallEnd ---------- */
  {
    const src = fs.readFileSync(VTOOLS, 'utf8');
    if (src.includes('voiceCallEnd')) ok('A ja aplicado');
    else {
      const anchor = 'module.exports = { voiceCallPlace };';
      if (src.split(anchor).length - 1 !== 1) fail('A anchor exports');
      const out = src.replace(anchor,
        '/** Encerra a chamada de voz ativa (a pedido do owner no chat). */' + '\n' +
        'async function voiceCallEnd() {' + '\n' +
        '  try {' + '\n' +
        "    await db().query(`SELECT pg_notify('voice_call_control', 'end')`);" + '\n' +
        "    return ok('📞 Encerrando a chamada ativa — o lado do operador/ChatGPT desliga junto.');" + '\n' +
        '  } catch (e) { return err(e); }' + '\n' +
        '}' + '\n' +
        '\n' +
        'module.exports = { voiceCallPlace, voiceCallEnd };');
      checkJs(VTOOLS, out);
      const b = bak(VTOOLS);
      fs.writeFileSync(VTOOLS, out, 'utf8');
      ok('A: voiceCallEnd no kernel | backup: ' + path.basename(b));
    }
  }

  /* ---------- B) catalog ---------- */
  {
    const src = fs.readFileSync(CATALOG, 'utf8');
    if (src.includes('voiceCallEnd')) ok('B ja aplicado');
    else {
      const coreAnchor = "ex: { to: 'Ana Paula', assunto: 'recado a pedido do owner', reply_chat: 'nome do chat de origem' } },";
      if (src.split(coreAnchor).length - 1 !== 1) fail('B anchor CORE_TOOLS');
      let out = src.replace(coreAnchor, coreAnchor + '\n  { name: \'voiceCallEnd\', cat: \'📞 Chamada\', desc: \'ENCERRA a chamada de voz ativa (o lado do operador/ChatGPT desliga junto). Use quando o owner pedir pra desligar.\', params: \'{}\', ex: {} },');
      const idxAnchor = "    { name: 'voiceCallPlace', desc: 'INICIA ligacao de voz p/ contato verificado; transcricao volta no chat de origem.', params: ['to', 'assunto', 'reply_chat?'] },";
      if (out.split(idxAnchor).length - 1 !== 1) fail('B anchor indice');
      out = out.replace(idxAnchor, idxAnchor + "\n    { name: 'voiceCallEnd', desc: 'ENCERRA a chamada de voz ativa; operador desliga junto.', params: [] },");
      checkJs(CATALOG, out);
      const b = bak(CATALOG);
      fs.writeFileSync(CATALOG, out, 'utf8');
      ok('B: catalog CORE_TOOLS + indice | backup: ' + path.basename(b));
    }
  }

  /* ---------- C) prompt ---------- */
  {
    const src = fs.readFileSync(CONFIG, 'utf8');
    if (src.includes('voiceCallEnd')) ok('C ja aplicado');
    else {
      const anchor = 'no chat que pediu a ligação.';
      if (src.split(anchor).length - 1 !== 1) fail('C anchor (count ' + (src.split(anchor).length - 1) + ')');
      const out = src.replace(anchor, 'no chat que pediu a ligação. Para ENCERRAR a chamada use voiceCallEnd {} — o lado do operador desliga junto (decreto owner).');
      try { JSON.parse(out); } catch { fail('C JSON invalido'); }
      const b = bak(CONFIG);
      fs.writeFileSync(CONFIG, out, 'utf8');
      ok('C: prompt CHAMADAS + voiceCallEnd | backup: ' + path.basename(b));
    }
  }

  /* ---------- D) executor: LISTEN voice_call_control ---------- */
  {
    const src = fs.readFileSync(EXECUTOR, 'utf8');
    if (src.includes('voice_call_control')) ok('D ja aplicado');
    else {
      const a1 = '      // encerra quando a chamada cair (poll do estado) — o owner também pode desligar na janela';
      if (src.split(a1).length - 1 !== 1) fail('D anchor 1');
      let out = src.replace(a1, a1 + '\n' +
        '      // v1.14 (owner 21/10): "luna desliga" pelo chat -> sinal externo encerra\n' +
        '      // a chamada; o cascade abaixo fecha o lado ChatGPT junto (decreto 26/09).\n' +
        '      let externalEnd = false;\n' +
        '      let ctrlClient: import(\'pg\').PoolClient | null = null;\n' +
        '      try {\n' +
        '        ctrlClient = await pool.connect();\n' +
        '        await ctrlClient.query(\'LISTEN voice_call_control\');\n' +
        '        ctrlClient.on(\'notification\', () => { externalEnd = true; log.info(\'voice.call: pedido externo de desligar (chat)\'); });\n' +
        '      } catch { ctrlClient = null; }');
      const a2 = '        await new Promise((r) => setTimeout(r, 5_000));\n' +
        '        const st = await (transport as never as { observePanel: () => Promise<{ state: string }> }).observePanel();\n' +
        '        if (st.state !== \'chamada\') break;';
      if (out.split(a2).length - 1 !== 1) fail('D anchor 2');
      out = out.replace(a2, '        await new Promise((r) => setTimeout(r, 5_000));\n' +
        '        if (externalEnd) break; // v1.14: owner pediu pra desligar pelo chat\n' +
        '        const st = await (transport as never as { observePanel: () => Promise<{ state: string }> }).observePanel();\n' +
        '        if (st.state !== \'chamada\') break;');
      const a3 = '      handle.stop();';
      if (out.split(a3).length - 1 !== 1) fail('D anchor 3');
      out = out.replace(a3, '      handle.stop();\n      try { if (ctrlClient) ctrlClient.release(); } catch { /* noop */ }');
      if (!balanced(out)) fail('D desbalanceamento');
      const b = bak(EXECUTOR);
      fs.writeFileSync(EXECUTOR, out, 'utf8');
      ok('D: executor escuta voice_call_control | backup: ' + path.basename(b));
    }
  }

  for (const svc of ['luna-kernel', 'luna-whatsplay']) {
    spawn('cmd.exe', ['/c', 'pm2 restart ' + svc], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    ok('restart: ' + svc);
  }
  console.log('');
  console.log('=== FIM — ciclo de chamada completo: iniciar (voiceCallPlace) / falar (callRespond) / transcrever no chat / desligar (voiceCallEnd, fecha o ChatGPT junto) ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
