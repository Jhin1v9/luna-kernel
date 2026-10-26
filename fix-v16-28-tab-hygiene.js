#!/usr/bin/env node
/* fix-v16-28-tab-hygiene.js — v16.28 (owner 21/10)
   Higiene de abas (2)+(3): fecha abas Kimi que NAO sao a sessao ativa e que
   esfriaram ha >30min. Sessao ativa fica quente; fantasmas morrem; RAM ok. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const BRIDGE = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\kimi-bridge.cjs';
const MARK = 'v16.28-fix';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
function syntaxCheckJS(src) {
  const tmp = path.join(os.tmpdir(), 'luna-check-' + Date.now() + '.js');
  fs.writeFileSync(tmp, src);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); return true; }
  catch (e) { return false; }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

const METHOD =
  "\n" +
  "  // " + MARK + " (owner 21/10): higiene de abas — fecha as que NAO sao a sessao\n" +
  "  // ativa E esfriaram ha >30min. Sessao ativa fica quente; RAM controlada.\n" +
  "  async _tabHygiene() {\n" +
  "    try {\n" +
  "      const STALE_MS = 30 * 60 * 1000;\n" +
  "      const now = Date.now();\n" +
  "      const activePages = new Set();\n" +
  "      for (const [, s] of this.userSessions) if (s && s.page) activePages.add(s.page);\n" +
  "      const ctxs = new Set(this.userContexts.values());\n" +
  "      for (const ctx of ctxs) {\n" +
  "        if (!ctx) continue;\n" +
  "        for (const p of ctx.pages()) {\n" +
  "          if (p.isClosed() || activePages.has(p)) continue;\n" +
  "          let url = ''; try { url = p.url(); } catch (_) {}\n" +
  "          if (!url.includes('kimi.ai')) continue;\n" +
  "          let stale = false; try { stale = now - (p._lunaLastActivity || 0) > STALE_MS; } catch (_) {}\n" +
  "          if (stale) { try { await p.close(); log.info('[" + MARK + "] aba Kimi inativa fechada: ' + url.slice(0, 80)); } catch (_) {} }\n" +
  "        }\n" +
  "      }\n" +
  "    } catch (_) {}\n" +
  "  }\n" +
  "\n" +
  "  _log(...args) {";
const ANCHOR = "  _log(...args) {";
const BOOT = "    this.networkInterceptors = new Map(); // userId -> KimiNetworkInterceptor";

try {
  let src = fs.readFileSync(BRIDGE, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] ja aplicado'); process.exit(0); }

  if (src.split(ANCHOR).length - 1 !== 1) { console.log('[FAIL] anchor _log ' + (src.split(ANCHOR).length - 1) + 'x'); process.exit(1); }
  src = src.replace(ANCHOR, METHOD);

  if (src.split(BOOT).length - 1 !== 1) { console.log('[FAIL] anchor boot ' + (src.split(BOOT).length - 1) + 'x'); process.exit(1); }
  src = src.replace(BOOT, BOOT + "\n    // " + MARK + ": higiene de abas a cada 10min\n    setInterval(() => { this._tabHygiene().catch(() => {}); }, 10 * 60 * 1000).unref();");

  const ACT = "    const _v1623TurnAtMark = this.turns && typeof this.turns.get === 'function' ? this.turns.get(sessionId) : null;";
  if (src.includes(ACT)) {
    src = src.replace(ACT, ACT + "\n    try { if (this.page) this.page._lunaLastActivity = Date.now(); } catch (_) {}");
  }

  if (!syntaxCheckJS(src)) { console.log('[FAIL] sintaxe — NADA escrito'); process.exit(1); }
  fs.copyFileSync(BRIDGE, BRIDGE + '.bak-' + ts);
  fs.writeFileSync(BRIDGE, src);
  console.log('[OK] higiene de abas instalada (30min stale, 10min rotina) | backup: kimi-bridge.cjs.bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.28 ===');
