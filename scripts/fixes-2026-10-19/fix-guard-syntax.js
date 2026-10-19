#!/usr/bin/env node
/**
 * fix-guard-syntax.js — conserta a sintaxe quebrada da guarda v5.7 (2026-10-19)
 *
 * O fix-final-round.js injetou o bloco da guarda com escaping errado (\\" dentro
 * de string JS quebrou o arquivo — luna-server.js nem bootava).
 *
 * O que faz:
 *   1. Restaura luna-server.js do backup do fix-final-round (estado v5.6 valido)
 *   2. Aplica a guarda v5.7 de NOVO, com escaping correto (strings de aspas simples)
 *   3. node --check em tudo que mexemos (valida sintaxe ANTES de subir)
 *   4. Sobe e verifica
 *
 * USO:  node fix-guard-syntax.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const SERVER = path.join(ROOT, 'apps', 'dashboard', 'luna-server.js');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ── 1. Restaura do backup mais recente do fix-final-round ──
console.log('\x1b[36m=== 1/4 — restaurando luna-server.js ===\x1b[0m');
const dir = path.dirname(SERVER);
const baks = fs.readdirSync(dir)
  .filter(f => f.startsWith('luna-server.js.bak-'))
  .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t);
if (baks.length === 0) { console.error('  [FALHOU] nenhum backup de luna-server.js encontrado'); process.exit(1); }
fs.copyFileSync(path.join(dir, baks[0].f), SERVER);
console.log('  [OK] restaurado de: ' + baks[0].f);

// ── 2. Aplica guarda v5.7 com escaping correto ──
console.log('\n\x1b[36m=== 2/4 — guarda v5.7 (escaping correto) ===\x1b[0m');
let src = fs.readFileSync(SERVER, 'utf8');
const isCrlf = src.includes('\r\n');
const norm = (s) => isCrlf ? s.replace(/\n/g, '\r\n') : s;

const OLD_GUARD = norm(`    if (matou) {
      console.log('[LUNA] porta ' + PORT + ' ocupada — instancia anterior (PID do arquivo) encerrada; saindo pra pm2 respawnar limpo');
    } else {
      console.error('[LUNA-FATAL] porta ' + PORT + ' ocupada e sem PID registrado nosso (ocupante estranho?) — exit(1)');
    }
    process.exit(1);`);

// Aspas SIMPLES no JS de fora -> as aspas duplas do PowerShell nao precisam de escape.
const NEW_GUARD = norm(`    if (!matou) {
      // v5.7-fix: FALLBACK — sem PID file (instancia anterior pre-guarda) ou PID
      // invalido: mata qualquer node luna-server.js (menos a propria instancia).
      try {
        const { execSync: _ex } = require('child_process');
        const _fs = require('fs');
        const _tmp = require('path').join(require('os').tmpdir(), 'luna-guard-kill-' + process.pid + '.ps1');
        _fs.writeFileSync(_tmp, [
          '$me = ' + process.pid,
          'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -like \'*luna-server.js*\' -and $_.ProcessId -ne $me } | ForEach-Object {',
          '  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Output ("matou: " + $_.ProcessId) } catch {}',
          '}'
        ].join('\\n'), 'utf8');
        const _out = _ex('powershell -NoProfile -ExecutionPolicy Bypass -File "' + _tmp + '"', { encoding: 'utf8', timeout: 15000 });
        if (_out && _out.trim()) console.log('[LUNA] guarda-fallback: ' + _out.trim());
        try { _fs.unlinkSync(_tmp); } catch {}
        matou = true;
      } catch (e2) {
        console.error('[LUNA-FATAL] guarda-fallback falhou: ' + (e2.message || e2));
      }
    }
    if (matou) {
      console.log('[LUNA] porta ' + PORT + ' sera liberada — saindo pra pm2 respawnar limpo');
    } else {
      console.error('[LUNA-FATAL] porta ' + PORT + ' ocupada e guarda nao conseguiu liberar — exit(1)');
    }
    process.exit(1);`);

if (!src.includes(OLD_GUARD)) {
  console.error('  [FALHOU] bloco v5.6 nao encontrado no restaurado. Me avisa.');
  process.exit(1);
}
fs.copyFileSync(SERVER, SERVER + '.bak-pre-v57-' + ts);
src = src.replace(OLD_GUARD, NEW_GUARD);
fs.writeFileSync(SERVER, src);
console.log('  [OK] guarda v5.7 aplicada');

// ── 3. node --check em TUDO que mexemos ──
console.log('\n\x1b[36m=== 3/4 — validacao de sintaxe (node --check) ===\x1b[0m');
const arquivos = [
  ['luna-server.js', SERVER],
  ['luna-soul.cjs', path.join(ROOT, 'packages', 'kernel', 'luna-soul.cjs')],
  ['content.js', path.join(ROOT, 'packages', 'kernel', 'luna-extension', 'content.js')],
  ['background.js', path.join(ROOT, 'packages', 'kernel', 'luna-extension', 'background.js')],
  ['kimi-bridge.cjs', path.join(ROOT, 'packages', 'kernel', 'kimi-bridge.cjs')],
  ['luna-config.js', path.join(ROOT, 'packages', 'kernel', 'config', 'luna-config.js')]
];
let sintaxeOk = true;
for (const [nome, arquivo] of arquivos) {
  try {
    execSync(`node --check "${arquivo}"`, { encoding: 'utf8', stdio: 'pipe' });
    console.log('  \x1b[32m[OK]\x1b[0m   ' + nome);
  } catch (e) {
    sintaxeOk = false;
    console.log('  \x1b[31m[ERRO]\x1b[0m ' + nome + ' — ' + (e.stderr || e.message).split('\n').filter(l => l.trim()).slice(0, 3).join(' | '));
  }
}
if (!sintaxeOk) { console.error('\n  ⚠ Corrige os erros acima antes de subir. Me manda.'); process.exit(1); }

// ── 4. Sobe e verifica ──
console.log('\n\x1b[36m=== 4/4 — sobe e verifica ===\x1b[0m');
try { execSync('pm2 restart luna-kernel', { encoding: 'utf8' }); console.log('  pm2 restart ok'); } catch { console.error('  pm2 restart FALHOU'); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  await sleep(12000);
  let port = '';
  try { port = execSync('netstat -ano | findstr :3458 | findstr LISTENING', { encoding: 'utf8' }).trim(); } catch {}
  const pidFile = path.join(require('os').tmpdir(), 'luna-server-3458.pid');
  const pidFileOk = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : null;
  const pm2 = execSync('pm2 list | findstr luna-kernel', { encoding: 'utf8' }).trim();
  console.log('  pm2: ' + pm2);
  console.log('  porta 3458: ' + (port || '(ninguem ainda)'));
  console.log('  PID file: ' + (pidFileOk || 'nao gravado'));

  if (port && pidFileOk && port.includes(pidFileOk)) {
    console.log('\n\x1b[32m✅ ESTAVEL: porta e PID file batem. Zumbi morto pra sempre.\x1b[0m');
  } else {
    console.log('\n\x1b[33m⚠ Se ainda subindo, espera 15s e confere de novo:\x1b[0m');
    console.log('   netstat -ano | findstr :3458 | findstr LISTENING');
  }
  console.log('\x1b[90mBackups: *.bak-pre-v57-' + ts + '\x1b[0m');
})();
