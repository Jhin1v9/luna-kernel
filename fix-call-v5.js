#!/usr/bin/env node
/**
 * fix-call-v5.js — B3 com anchor de LINHA UNICA (CRLF-safe).
 * (Arquivos locais tem CRLF; anchors multilinha com \n puro nunca casam.)
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

(async function main() {
  /* ---------- B3: break do externalEnd (anchor linha unica, CRLF-safe) ---------- */
  {
    const src = fs.readFileSync(EXECUTOR, 'utf8');
    if (src.includes('if (externalEnd) break;')) ok('B3 ja aplicado');
    else {
      const anchor = '        await new Promise((r) => setTimeout(r, 5_000));';
      const n = src.split(anchor).length - 1;
      if (n !== 1) fail('B3: sleep 5s aparece ' + n + 'x — preciso do contexto de cada um');
      const out = src.replace(anchor, anchor + '\n        if (externalEnd) break; // v1.14: owner pediu pra desligar pelo chat');
      const b = bak(EXECUTOR);
      fs.writeFileSync(EXECUTOR, out, 'utf8');
      ok('B3: break do externalEnd | backup: ' + path.basename(b));
    }
  }

  /* ---------- B4: release ctrlClient ---------- */
  {
    const src = fs.readFileSync(EXECUTOR, 'utf8');
    if (src.includes('(ctrlClient as { release')) ok('B4 ja aplicado');
    else {
      const anchor = '      handle.stop();';
      const n = src.split(anchor).length - 1;
      if (n !== 1) fail('B4: handle.stop ' + n + 'x');
      const out = src.replace(anchor, anchor + '\n      try { if (ctrlClient) (ctrlClient as { release: () => void }).release(); } catch { /* noop */ }');
      const b = bak(EXECUTOR);
      fs.writeFileSync(EXECUTOR, out, 'utf8');
      ok('B4: release ctrlClient | backup: ' + path.basename(b));
    }
  }

  /* ---------- C: kernel tool objetivo ---------- */
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
  console.log('=== FIM ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
