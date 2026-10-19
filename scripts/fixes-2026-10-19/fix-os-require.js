#!/usr/bin/env node
/**
 * fix-os-require.js — adiciona require('os') que faltava no guard v5.6 (2026-10-19)
 * Erro: "os is not defined" em luna-server.js:388 (LUNA_PID_FILE usa os.tmpdir()
 * mas o modulo nunca foi importado no arquivo). Crash loop desde o fix-zombie-forever.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const SERVER = path.join(ROOT, 'apps', 'dashboard', 'luna-server.js');

let src = fs.readFileSync(SERVER, 'utf8');
if (src.includes('require(\'os\').tmpdir()')) {
  console.log('[SKIP] ja usa require inline');
} else if (src.includes('path.join(os.tmpdir(), \'luna-server-3458.pid\')')) {
  const isCrlf = src.includes('\r\n');
  const OLD = isCrlf
    ? "const LUNA_PID_FILE = path.join(os.tmpdir(), 'luna-server-3458.pid');"
    : "const LUNA_PID_FILE = path.join(os.tmpdir(), 'luna-server-3458.pid');";
  const NEW = "const LUNA_PID_FILE = path.join(require('os').tmpdir(), 'luna-server-3458.pid');";
  if (!src.includes(OLD)) { console.error('[FALHOU] padrao nao encontrado'); process.exit(1); }
  fs.writeFileSync(SERVER, src.replace(OLD, NEW));
  console.log('[OK] os via require inline (sem tocar os imports do arquivo)');
} else {
  console.error('[FALHOU] LUNA_PID_FILE nao encontrado — arquivo em estado inesperado');
  process.exit(1);
}

try {
  execSync(`node --check "${SERVER}"`, { encoding: 'utf8', stdio: 'pipe' });
  console.log('[OK] node --check passou');
} catch (e) {
  console.error('[FALHOU] sintaxe: ' + (e.stderr || e.message).split('\n').slice(0, 2).join(' | '));
  process.exit(1);
}

try { execSync('pm2 restart luna-kernel', { encoding: 'utf8' }); console.log('[OK] pm2 restart'); }
catch { console.error('pm2 restart falhou'); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  await sleep(12000);
  let port = '';
  try { port = execSync('netstat -ano | findstr :3458 | findstr LISTENING', { encoding: 'utf8' }).trim(); } catch {}
  const pidFile = path.join(require('os').tmpdir(), 'luna-server-3458.pid');
  const pidOk = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : null;
  console.log('porta 3458: ' + (port || '(ninguem ainda)'));
  console.log('PID file: ' + (pidOk || 'nao gravado'));
  if (port && pidOk && port.includes(pidOk)) {
    console.log('\x1b[32m✅ ESTAVEL — fim do crash loop. Zumbi morto pra sempre.\x1b[0m');
  } else {
    console.log('\x1b[33m⚠ Se ainda subindo: sleep 15 && netstat -ano | findstr :3458 | findstr LISTENING\x1b[0m');
  }
})();
