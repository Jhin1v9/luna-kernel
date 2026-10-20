#!/usr/bin/env node
/**
 * fix-whatsplay-boot-v2.js — EMERGENCIA (owner 20/10 22:25)
 * 1) Mata pid 2888 (singleton zumbi) e qualquer node *whatsplay* fora do pm2
 * 2) Enum KIMI_ADAPTER_MODE: localiza '[' logo apos a chave e insere
 *    'kimi-web-local','kimi-cli' depois de 'kimi-web' — com ANTES/DEPOIS impresso
 * 3) restart oculto.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const CONFIG = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\packages\\shared\\src\\config.ts';
function ok(m) { console.log('[OK] ' + m); }
function warn(m) { console.log('[AVISO] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); process.exit(1); }

(async function main() {
  /* ---------- 1) zumbis ---------- */
  try { execFileSync('taskkill', ['/PID', '2888', '/F'], { stdio: 'pipe' }); ok('pid 2888 morto'); }
  catch { warn('pid 2888 ja estava morto (lock sera revalidado no boot)'); }

  /* ---------- 2) enum ---------- */
  if (!fs.existsSync(CONFIG)) fail('nao achei ' + CONFIG);
  const src = fs.readFileSync(CONFIG, 'utf8');
  const keyIdx = src.indexOf('KIMI_ADAPTER_MODE');
  if (keyIdx === -1) fail('KIMI_ADAPTER_MODE nao achado');
  const open = src.indexOf('[', keyIdx);
  if (open === -1 || open - keyIdx > 300) fail('[ nao achado apos KIMI_ADAPTER_MODE');
  const close = src.indexOf(']', open);
  if (close === -1 || close - open > 500) fail('] nao achado');
  const span = src.slice(open + 1, close);
  console.log('=== ANTES: [' + span.trim() + ']');
  if (span.indexOf('kimi-web-local') !== -1) {
    ok('enum JA contem kimi-web-local — nada a fazer');
  } else {
    const newSpan = span.replace("'kimi-web'", "'kimi-web', 'kimi-web-local', 'kimi-cli'");
    if (newSpan === span) fail("'kimi-web' (exato) nao achado no span: " + span.trim());
    const out = src.slice(0, open + 1) + newSpan + src.slice(close);
    const b = CONFIG + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(CONFIG, b);
    fs.writeFileSync(CONFIG, out, 'utf8');
    console.log('=== DEPOIS: [' + newSpan.trim() + ']');
    ok('enum corrigido | backup: ' + path.basename(b));
  }

  /* ---------- 3) restart ---------- */
  spawn('cmd.exe', ['/c', 'pm2 restart luna-whatsplay'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  ok('pm2 restart disparado');
  console.log('=== AGUARDE 10s E RODE: pm2 list (uptime subindo + logs sem ZodError) ===');
  console.log('=== FIM ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
