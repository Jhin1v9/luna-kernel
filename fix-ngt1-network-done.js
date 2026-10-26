#!/usr/bin/env node
/* fix-ngt1-network-done.js — v16.14-fix (NGT-1, owner 21/10)
   REDE MANDA, endpoint-agnostico. Completude do turno por FATO DE REDE:
   (1) E1+E2: interceptor passa a capturar corpos de resposta NAO reconhecidos
       por _isChatUrl como CANDIDATOS durante geracao ativa (candidatos = o
       que a rede entregou enquanto o modelo gerava).
   (2) E3: path Kimi decide isGenerating assim:
       - fato direto: completedGeneration === _generation
       - correlacao de conteudo: algum candidato contem a CAUDA normalizada
         da resposta renderizada (a cauda so chega no body quando o stream
         terminou) -> isGenerating=false, vetando TODOS os sinais DOM
       - cap: resposta estavel >=45s sem confirmacao de rede -> completa +
         log [NET-DEGRADED] (rede silenciosa NUNCA mais trava o turno).
   _isChatUrl continua existindo como fast-path, mas a completude nao depende
   mais dele. Proximo elo (NGT-2): circuit breaker do reenvio de prompt. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const BRIDGE = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\kimi-bridge.cjs';
const MARK = 'v16.14-fix';
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

  // ── E1: listener captura candidatos fora da allowlist ──
  const a1 = '      if (!this._isChatUrl(url)) return;';
  if (src.split(a1).length - 1 !== 1) { console.log('[FAIL] E1 anchor != 1x — arquivo diverge, NADA alterado'); process.exit(1); }
  src = src.replace(a1, '      if (!this._isChatUrl(url)) { this._ngtCaptureCandidate(response); return; }');

  // ── E2: metodos no interceptor (antes de _isChatUrl) ──
  const a2 = '  _isChatUrl(url) {';
  if (src.split(a2).length - 1 !== 1) { console.log('[FAIL] E2 anchor != 1x — NADA alterado'); process.exit(1); }
  const methods =
    '  // ' + MARK + ' (NGT-1): captura endpoint-agnostica. Durante geracao ativa, guarda\n' +
    '  // corpos de resposta NAO reconhecidos por _isChatUrl como candidatos.\n' +
    '  _ngtCaptureCandidate(response) {\n' +
    '    try {\n' +
    '      if (!this._active) return;\n' +
    '      if (!(this._generation > 0) || this.completedGeneration === this._generation) return;\n' +
    '      const h = response.headers() || {};\n' +
    '      const ct = String(h[\'content-type\'] || \'\');\n' +
    '      if (ct && !/json|text|event-stream/i.test(ct)) return;\n' +
    '      const gen = this._generation;\n' +
    '      response.body().then((buf) => {\n' +
    '        try {\n' +
    '          const text = buf.toString(\'utf-8\');\n' +
    '          if (!text || text.length < 80) return;\n' +
    '          this._candidates = this._candidates || [];\n' +
    '          this._candidates.push({ gen, url: response.url(), text: text.slice(0, 500000) });\n' +
    '          if (this._candidates.length > 8) this._candidates.shift();\n' +
    '        } catch (_) {}\n' +
    '      }).catch(() => {});\n' +
    '    } catch (_) {}\n' +
    '  }\n' +
    '\n' +
    a2;
  src = src.replace(a2, methods);

  // ── E3: path Kimi — veto de rede + cap 45s com NET-DEGRADED ──
  const a3 = '        return { ...rest, isContextLimit, canSteer, isGenerating };';
  if (src.split(a3).length - 1 !== 1) { console.log('[FAIL] E3 anchor != 1x — NADA alterado'); process.exit(1); }
  const e3 =
    '        // ' + MARK + ' (NGT-1): REDE MANDA. (1) fato de rede (body completo/correlacao\n' +
    '        // de conteudo com a cauda da resposta) => isGenerating=false, vetando\n' +
    '        // TODOS os sinais DOM. (2) resposta estavel >=45s sem rede => completa\n' +
    '        // + [NET-DEGRADED]. Completude nao depende mais de _isChatUrl allowlist.\n' +
    '        let _ngtDone = false;\n' +
    '        try {\n' +
    '          const _it = this.interceptor;\n' +
    '          if (_it) {\n' +
    '            if (_it._generation > 0 && _it.completedGeneration === _it._generation) _ngtDone = true;\n' +
    '            else {\n' +
    '              const _norm = (s) => (s || \'\').replace(/[\\s"\\\\]/g, \'\');\n' +
    '              const _txt = _norm(rest.response);\n' +
    '              if (_txt && _it._candidates && _it._candidates.length) {\n' +
    '                const _needle = _txt.length > 160 ? _txt.slice(-160) : _txt;\n' +
    '                _ngtDone = _it._candidates.some((c) => c.gen === _it._generation && c.text && _norm(c.text).includes(_needle));\n' +
    '              }\n' +
    '            }\n' +
    '          }\n' +
    '        } catch (_) {}\n' +
    '        if (_ngtDone) {\n' +
    '          return { ...rest, isContextLimit, canSteer, isGenerating: false };\n' +
    '        }\n' +
    '        const _ngtNow = Date.now();\n' +
    '        if (rest.response && rest.response === this._ngtLastResp) {\n' +
    '          if (!this._ngtStableSince) this._ngtStableSince = _ngtNow;\n' +
    '          else if (_ngtNow - this._ngtStableSince > 45000) {\n' +
    '            log.info("[NET-DEGRADED] " + MARK + ": resposta estavel ha 45s sem confirmacao de rede -- completando por cap. Endpoint do stream pode ter mudado.");\n' +
    '            return { ...rest, isContextLimit, canSteer, isGenerating: false, _netDegraded: true };\n' +
    '          }\n' +
    '        } else {\n' +
    '          this._ngtStableSince = 0;\n' +
    '          this._ngtLastResp = rest.response;\n' +
    '        }\n' +
    a3;
  src = src.replace(a3, e3);

  if (!syntaxCheckJS(src)) { console.log('[FAIL] sintaxe invalida apos patch — NADA escrito'); process.exit(1); }
  bak(BRIDGE);
  fs.writeFileSync(BRIDGE, src);
  console.log('[OK] E1: listener captura candidatos fora da allowlist');
  console.log('[OK] E2: _ngtCaptureCandidate no interceptor');
  console.log('[OK] E3: veto de rede + cap 45s + NET-DEGRADED no path Kimi');
  console.log('[OK] backup: kimi-bridge.cjs.bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM — NGT-1 aplicado. Subir orchestrator e testar: ===');
console.log('=== pm2 start luna-orchestrator  (depois: manda msg de teste pro work) ===');
console.log('=== assistir: pm2 logs luna-kernel --lines 60 --nostream | grep -iE "NET-DEGRADED|dom-structure|forcing isGen" ===');
