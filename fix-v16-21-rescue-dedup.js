#!/usr/bin/env node
/* fix-v16-21-rescue-dedup.js — v16.21 (owner 21/10)
   RAIZ MAE da reentrega: o tolerant parser do LUNA-RESCUE re-varre o mesmo
   texto a cada re-render do DOM ("DOM shrank") e erro de stream, e os 4
   pontos de disparo re-emitiam a MESMA tool 3-5x (log comprovou: "tolerant
   parser recovered tool (whatsappSendMessage)" repetido + stream errors).
   Fix: dedup de acoes por stream — mesmo (tool, params) = 1 emissao so.
   T2: retry do esclarecimento do campo "to" varrendo TODAS as chaves do config
       (o v16.20 falhou porque o protocolo v16.8 nao estava em systemPrompt). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const BRIDGE = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\kimi-bridge.cjs';
const CFG = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\config\\luna-prompt-config.json';
const MARK = 'v16.21-fix';
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
  let src = fs.readFileSync(BRIDGE, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] T1 ja aplicado'); }
  else {
    const a0 = "  async *sendMessageStream(userId, text, options = {}, provider = 'kimi') {";
    if (count(src, a0) !== 1) { console.log('[FAIL] T1.a ' + count(src, a0) + 'x'); process.exit(1); }
    src = src.replace(a0, a0 + "\n" +
      "    // " + MARK + " (owner 21/10): dedup de acoes por stream. O tolerant parser do\n" +
      "    // LUNA-RESCUE re-varre o mesmo texto a cada re-render do DOM/erro de stream e\n" +
      "    // re-emitia a MESMA tool 3-5x. Mesmo (tool, params) = 1 emissao so por stream.\n" +
      "    const _v1621Yielded = new Set();\n" +
      "    const _v1621Dedup = (tool, params) => {\n" +
      "      try {\n" +
      "        const key = String(tool) + '|' + JSON.stringify(params || {});\n" +
      "        if (_v1621Yielded.has(key)) { log.warn('[v16.21] acao duplicada suprimida: ' + tool); return null; }\n" +
      "        _v1621Yielded.add(key);\n" +
      "      } catch (_) {}\n" +
      "      return buildJsonBufferAction(tool, params);\n" +
      "    };");

    const b1 = 'const actionEvent = buildJsonBufferAction(extracted.tool, extracted.params);';
    if (count(src, b1) !== 2) { console.log('[FAIL] T1.b ' + count(src, b1) + 'x'); process.exit(1); }
    src = src.split(b1).join('const actionEvent = _v1621Dedup(extracted.tool, extracted.params);');

    const b2 = 'const actionEvent = buildJsonBufferAction(cleanR.tool, cleanR.params);';
    if (count(src, b2) !== 1) { console.log('[FAIL] T1.c ' + count(src, b2) + 'x'); process.exit(1); }
    src = src.replace(b2, 'const actionEvent = _v1621Dedup(cleanR.tool, cleanR.params);');

    const b3 = 'const orphanAction = buildJsonBufferAction(orphanExtracted.tool, orphanExtracted.params);';
    if (count(src, b3) !== 1) { console.log('[FAIL] T1.d ' + count(src, b3) + 'x'); process.exit(1); }
    src = src.replace(b3, 'const orphanAction = _v1621Dedup(orphanExtracted.tool, orphanExtracted.params);');

    if (!syntaxCheckJS(src)) { console.log('[FAIL] T1 sintaxe — NADA escrito'); process.exit(1); }
    fs.copyFileSync(BRIDGE, BRIDGE + '.bak-' + ts);
    fs.writeFileSync(BRIDGE, src);
    console.log('[OK] T1: dedup de acoes nos 4 pontos de disparo do rescue | backup: kimi-bridge.cjs.bak-' + ts);
  }
} catch (e) { console.log('[FAIL] T1: ' + e.message); process.exit(1); }

try {
  const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  if (JSON.stringify(cfg).includes('v16.20-fix')) { console.log('[OK] T2 ja aplicado'); }
  else {
    const add = ' No whatsappSendMessage, o campo "to" = o NOME do chat X do cabeçalho [chat: X | autor: Y] (ex.: to: "🏆Production - 2026🙏🏻"). NUNCA use a palavra "chat" nem o nome do autor Y como "to". (v16.20-fix)';
    let mexeu = false;
    for (const k of Object.keys(cfg)) {
      const v = cfg[k];
      if (typeof v === 'string' && v.includes('mesmo chat de origem')) {
        const marker = '(v16.8-fix)';
        const idx = v.includes(marker) ? v.indexOf(marker) + marker.length : v.length;
        cfg[k] = v.slice(0, idx) + add + v.slice(idx);
        mexeu = true;
        console.log('[OK] T2: esclarecimento do "to" adicionado na key: ' + k);
        break;
      }
      if (v && typeof v === 'object') {
        for (const k2 of Object.keys(v)) {
          const v2 = v[k2];
          if (typeof v2 === 'string' && v2.includes('mesmo chat de origem')) {
            const marker = '(v16.8-fix)';
            const idx = v2.includes(marker) ? v2.indexOf(marker) + marker.length : v2.length;
            cfg[k][k2] = v2.slice(0, idx) + add + v2.slice(idx);
            mexeu = true;
            console.log('[OK] T2: esclarecimento do "to" adicionado em: ' + k + '.' + k2);
            break;
          }
        }
        if (mexeu) break;
      }
    }
    if (!mexeu) console.log('[AVISO] T2: protocolo "mesmo chat" nao achado em nenhuma key do config — ele vem de codigo. Roda: grep -n "mesmo chat" luna-soul.cjs | head -3');
    else {
      const novo = JSON.stringify(cfg, null, 2); JSON.parse(novo);
      fs.copyFileSync(CFG, CFG + '.bak-' + ts);
      fs.writeFileSync(CFG, novo);
      console.log('[OK] T2: config salvo | backup: luna-prompt-config.json.bak-' + ts);
    }
  }
} catch (e) { console.log('[FAIL] T2: ' + e.message); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.21 — dedup por stream: fim da reentrega 3-5x ===');
