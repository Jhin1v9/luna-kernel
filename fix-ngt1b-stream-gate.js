#!/usr/bin/env node
/* fix-ngt1b-stream-gate.js — v16.14b-fix (NGT-1b, owner 21/10)
   Segundo gate do mesmo principio REDE > UI, agora no sendMessageStream:
   o veto v12.4 (stillLoading DOM) rodava ANTES do consenso v13.0 e matava o
   completion candidate. E o networkDone do consenso so usava o fast-path
   (completedGeneration), que morre quando o endpoint muda.
   Fix: (1) calcula _ngtNetDone2 = fast-path OU correlacao por candidatos
   (cauda de lastResponse presente num body capturado nesta geracao);
   (2) stillLoading perde o veto quando _ngtNetDone2; (3) consenso aceita
   _ngtNetDone2 como networkDone. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const BRIDGE = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\kimi-bridge.cjs';
const MARK = 'v16.14b-fix';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function bak(p) { try { fs.copyFileSync(p, p + '.bak-' + ts); return true; } catch (e) { return false; } }
function syntaxCheckJS(src) {
  const tmp = path.join(os.tmpdir(), 'luna-check-' + Date.now() + '.js');
  fs.writeFileSync(tmp, src);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); return true; }
  catch (e) { return false; }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

try {
  let src = fs.readFileSync(BRIDGE, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] ja aplicado (' + MARK + ') — nada a fazer'); process.exit(0); }

  // A: logo apos stillLoading, calcula _ngtNetDone2
  const a1 = "              const stillLoading = await this._hasActiveLoadingIndicators(page);";
  if (src.split(a1).length - 1 !== 1) { console.log('[FAIL] A anchor != 1x — NADA alterado'); process.exit(1); }
  const blockA =
    a1 + "\n" +
    "              // " + MARK + " (NGT-1b): REDE > UI neste gate tambem. _ngtNetDone2 =\n" +
    "              // fast-path (completedGeneration) OU correlacao de conteudo\n" +
    "              // (candidato contendo a cauda de lastResponse nesta geracao).\n" +
    "              let _ngtNetDone2 = !!(interceptor && interceptor._generation > 0 && interceptor.completedGeneration === interceptor._generation);\n" +
    "              if (!_ngtNetDone2) {\n" +
    "                try {\n" +
    "                  const _norm2 = (s) => (s || '').replace(/[\\s\"\\\\]/g, '');\n" +
    "                  const _txt2 = _norm2(lastResponse);\n" +
    "                  const _cands2 = interceptor && interceptor._candidates;\n" +
    "                  if (_txt2 && _cands2 && _cands2.length) {\n" +
    "                    const _needle2 = _txt2.length > 160 ? _txt2.slice(-160) : _txt2;\n" +
    "                    _ngtNetDone2 = _cands2.some((c) => c.gen === interceptor._generation && c.text && _norm2(c.text).includes(_needle2));\n" +
    "                  }\n" +
    "                } catch (_) {}\n" +
    "              }";
  src = src.replace(a1, blockA);

  // B: stillLoading perde o veto quando rede conclusiva + log do override
  const b1 = "              if (stillLoading && delimitedProtocolActionsCount === 0) {";
  if (src.split(b1).length - 1 !== 1) { console.log('[FAIL] B anchor != 1x — NADA alterado'); process.exit(1); }
  src = src.replace(b1, "              if (stillLoading && !_ngtNetDone2 && delimitedProtocolActionsCount === 0) {");
  const b2 = "              } else if (stillLoading && delimitedProtocolActionsCount > 0) {";
  if (src.split(b2).length - 1 !== 1) { console.log('[FAIL] B2 anchor != 1x — NADA alterado'); process.exit(1); }
  src = src.replace(b2,
    "              } else if (stillLoading && delimitedProtocolActionsCount > 0) {\n" +
    "              } else if (stillLoading) {\n" +
    "                log.info('[sendMessageStream] Allowing completion despite loading indicators — rede conclusiva (NGT-1b)');");

  // C: consenso aceita _ngtNetDone2
  const c1 = "              const networkDone = !!(interceptor && interceptor.completedGeneration === interceptor._generation);";
  if (src.split(c1).length - 1 !== 1) { console.log('[FAIL] C anchor != 1x — NADA alterado'); process.exit(1); }
  src = src.replace(c1,
    "              const networkDone = _ngtNetDone2 || !!(interceptor && interceptor.completedGeneration === interceptor._generation); // " + MARK + ": inclui correlacao por candidatos");

  if (!syntaxCheckJS(src)) { console.log('[FAIL] sintaxe invalida — NADA escrito'); process.exit(1); }
  bak(BRIDGE);
  fs.writeFileSync(BRIDGE, src);
  console.log('[OK] A: _ngtNetDone2 (fast-path + correlacao) calculado no gate');
  console.log('[OK] B: stillLoading sem veto quando rede conclusiva');
  console.log('[OK] C: consenso aceita correlacao como networkDone');
  console.log('[OK] backup: kimi-bridge.cjs.bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM — repete o teste e assiste: ===');
console.log('=== pm2 logs luna-kernel --lines 80 --nostream | grep -iE "NGT-1b|completion|NET-DEGRADED|forcing isGen|LUNA-PROMPT" ===');
