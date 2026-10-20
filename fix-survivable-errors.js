#!/usr/bin/env node
/**
 * fix-survivable-errors.js — kernel sobrevive a quedas de conexao (2026-10-20)
 *
 * Sintoma: cada Ctrl+F5 na Luna Web matava o kernel (uptime resetando,
 * localhost demorando). Causa: o Patch A (fix-luna-server.js) fazia
 * exit(1) em QUALQUER uncaughtException — inclusive EPIPE/ECONNRESET/write
 * after end, que sao ERROS BENIGNOS de cliente desconectando (normal em
 * servidor com SSE).
 *
 * Fix: erros de conexao viram WARN e o servidor continua vivo; so erros
 * REALES (bug de codigo) matam o processo pro pm2 respawnar limpo.
 *
 * USO:  node fix-survivable-errors.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const FILE = path.join(ROOT, 'apps', 'dashboard', 'luna-server.js');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!fs.existsSync(FILE)) { console.error('Nao encontrado: ' + FILE); process.exit(1); }
fs.copyFileSync(FILE, FILE + '.bak-' + ts);
let src = fs.readFileSync(FILE, 'utf8');
const isCrlf = src.includes('\r\n');
const norm = (s) => isCrlf ? s.replace(/\n/g, '\r\n') : s;

const OLD = norm(`process.on('uncaughtException', (err) => {
  console.error('[LUNA-FATAL] Uncaught Exception:', err.message);
  console.error(err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[LUNA-FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});`);

const NEW = norm(`// v5.8-fix (2026-10-20): erros de CONEXAO (cliente desconectou, refresh da
// pagina, socket morto) sao BENIGNOS — loga e continua vivo. So erro real de
// codigo mata o processo. Sem isso, cada Ctrl+F5 derrubava o kernel.
const SURVIVABLE_ERRORS = /EPIPE|ECONNRESET|ECONNABORTED|EHOSTUNREACH|ETIMEDOUT|write after end|premature close|aborted|socket hang up/i;
process.on('uncaughtException', (err) => {
  if (SURVIVABLE_ERRORS.test(err && err.message ? err.message : String(err))) {
    console.warn('[LUNA] conexao caiu (benigno, kernel continua vivo): ' + (err && err.message));
    return;
  }
  console.error('[LUNA-FATAL] Uncaught Exception:', err.message);
  console.error(err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  if (SURVIVABLE_ERRORS.test(msg)) {
    console.warn('[LUNA] rejeicao de conexao (benigna, kernel continua vivo): ' + msg);
    return;
  }
  console.error('[LUNA-FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});`);

if (src.includes('SURVIVABLE_ERRORS')) {
  console.log('[SKIP] ja aplicaado');
} else {
  const count = src.split(OLD).length - 1;
  if (count !== 1) { console.error('[FALHOU] handlers nao encontrados ' + count + 'x'); process.exit(1); }
  src = src.replace(OLD, NEW);
  fs.writeFileSync(FILE, src);
  console.log('[OK] erros de conexao agora sao benignos (kernel sobrevive a F5)');
}

try {
  execSync(`node --check "${FILE}"`, { encoding: 'utf8', stdio: 'pipe' });
  console.log('[OK] node --check passou');
} catch (e) { console.error('[FALHOU] sintaxe: ' + (e.stderr || e.message).split('\n').slice(0,2).join(' | ')); process.exit(1); }

try { execSync('pm2 restart luna-kernel', { encoding: 'utf8' }); console.log('[OK] luna-kernel reiniciado'); }
catch { console.log('pm2 restart falhou'); }

console.log('');
console.log('\x1b[32m✅ KERNEL SOBREVIVE A REFRESH.\x1b[0m Ctrl+F5 a vontade — no maximo um WARN no log.');
console.log('\x1b[90mBackup: luna-server.js.bak-' + ts + '\x1b[0m');
