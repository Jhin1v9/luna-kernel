#!/usr/bin/env node
/**
 * fix-whatsplay-boot.js — EMERGENCIA (owner 20/10 22:15)
 * luna-whatsplay crash-loopando: ZodError — enum KIMI_ADAPTER_MODE sem
 * 'kimi-web-local' (fix anterior deu falso positivo na checagem).
 * A) enum real ganha 'kimi-web-local' + 'kimi-cli'  B) restart oculto.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CONFIG = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\packages\\shared\\src\\config.ts';
function ok(m) { console.log('[OK] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); process.exit(1); }

(async function main() {
  if (!fs.existsSync(CONFIG)) fail('nao achei ' + CONFIG);
  const src = fs.readFileSync(CONFIG, 'utf8');
  const idx = src.indexOf('KIMI_ADAPTER_MODE:');
  if (idx === -1) fail('KIMI_ADAPTER_MODE nao achado');
  const start = src.indexOf('z.enum([', idx);
  if (start === -1) fail('z.enum nao achado apos KIMI_ADAPTER_MODE');
  const end = src.indexOf('])', start);
  if (end === -1 || end - start > 400) fail('fim do enum nao localizado');
  const list = src.slice(start + 8, end);
  if (list.indexOf('kimi-web-local') !== -1) {
    ok('enum ja contem kimi-web-local');
  } else {
    const newList = list.replace("'kimi-web',", "'kimi-web', 'kimi-web-local', 'kimi-cli',");
    if (newList === list) fail('nao achei o item kimi-web na lista: ' + list.trim());
    const out = src.slice(0, start + 8) + newList + src.slice(end);
    const b = CONFIG + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(CONFIG, b);
    fs.writeFileSync(CONFIG, out, 'utf8');
    ok('enum corrigido: ' + newList.trim());
    ok('backup: ' + path.basename(b));
  }
  spawn('cmd.exe', ['/c', 'pm2 restart luna-whatsplay'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  ok('pm2 restart disparado');
  console.log('=== AGUARDE 8s E RODE: pm2 list (uptime do whatsplay subindo = curado) ===');
  console.log('=== FIM ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
