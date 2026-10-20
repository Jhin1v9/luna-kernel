#!/usr/bin/env node
/**
 * fix-call-v4.js — fecha os 3 ultimos (owner 21/10 00:56)
 * B3: if (externalEnd) break; no poll da chamada (anchor = loop local exato)
 * B4: release do ctrlClient apos handle.stop()
 * C: kernel tool brief.objetivo (executor le brief.objetivo)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const AGENT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const KERNEL_TOOL = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\voice-call-tools.cjs';
const EXECUTOR = path.join(AGENT, 'apps', 'whatsplay', 'src', 'voice', 'call-executor.ts');

function ok(m) { console.log('[OK] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); process.exit(1); }
function bak(f) {
  const b = f + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(f, b);
  return b;
}
function put(file, marker, anchor, addition, label) {
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(marker)) { ok('ja aplicado: ' + label); return; }
  const n = src.split(anchor).length - 1;
  if (n !== 1) fail(label + ': anchor ' + n + 'x');
  const out = src.replace(anchor, anchor + addition);
  const b = bak(file);
  fs.writeFileSync(file, out, 'utf8');
  ok(label + ' | backup: ' + path.basename(b));
}

(async function main() {
  put(EXECUTOR, 'if (externalEnd) break;',
    '      for (;;) {\n        await new Promise((r) => setTimeout(r, 5_000));',
    '\n        if (externalEnd) break; // v1.14: owner pediu pra desligar pelo chat',
    'B3: break do externalEnd no poll');

  put(EXECUTOR, '(ctrlClient as { release',
    '      handle.stop();',
    '\n      try { if (ctrlClient) (ctrlClient as { release: () => void }).release(); } catch { /* noop */ }',
    'B4: release ctrlClient');

  {
    const src = fs.readFileSync(KERNEL_TOOL, 'utf8');
    if (src.includes('objetivo: assunto')) ok('C ja aplicado');
    else {
      if (src.split('      assunto,').length - 1 !== 1) fail('C anchor');
      const out = src.replace('      assunto,', '      assunto,\n      objetivo: assunto,');
      const tmp = KERNEL_TOOL + '.tmpchk.js';
      fs.writeFileSync(tmp, out, 'utf8');
      try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
      catch { try { fs.unlinkSync(tmp); } catch {} fail('C sintaxe'); }
      try { fs.unlinkSync(tmp); } catch {}
      const b = bak(KERNEL_TOOL);
      fs.writeFileSync(KERNEL_TOOL, out, 'utf8');
      ok('C: brief.objetivo | backup: ' + path.basename(b));
    }
  }

  for (const svc of ['luna-whatsplay', 'luna-kernel']) {
    spawn('cmd.exe', ['/c', 'pm2 restart ' + svc], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    ok('restart: ' + svc);
  }
  console.log('=== FIM — conferencia: pm2 list (whatsplay online) ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
