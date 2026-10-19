#!/usr/bin/env node
/**
 * fix-guard-syntax-v2.js — guarda v5.7 via arquivo .ps1 separado (2026-10-19)
 *
 * A v1/v2 quebraram por escaping em 3 camadas (PowerShell->JS->Python).
 * Solucao definitiva: o script PowerShell vira um ARQUIVO no repo
 * (apps/dashboard/guard-kill.ps1) e o luna-server.js soh executa ele.
 * Zero escaping, zero sintaxe quebrada.
 *
 * USO:  node fix-guard-syntax-v2.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const SERVER = path.join(ROOT, 'apps', 'dashboard', 'luna-server.js');
const PS1 = path.join(ROOT, 'apps', 'dashboard', 'guard-kill.ps1');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ── 1. Restaura luna-server.js do backup pre-v5.7 (estado v5.6 valido) ──
console.log('\x1b[36m=== 1/4 — restaurando luna-server.js ===\x1b[0m');
const dir = path.dirname(SERVER);
const baks = fs.readdirSync(dir)
  .filter(f => f.startsWith('luna-server.js.bak-') && !f.includes('pre-v57'))
  .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t);
if (baks.length === 0) { console.error('  [FALHOU] nenhum backup valido'); process.exit(1); }
fs.copyFileSync(path.join(dir, baks[0].f), SERVER);
console.log('  [OK] restaurado de: ' + baks[0].f);

// ── 2. Arquivo PowerShell separado (SEM escaping nenhum) ──
console.log('\n\x1b[36m=== 2/4 — guard-kill.ps1 (arquivo separado) ===\x1b[0m');
const PS1_CONTENT = `param([int]$Me = 0)
# Guarda de instancia unica: mata qualquer node luna-server.js exceto $Me
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -like '*luna-server.js*' -and $_.ProcessId -ne $Me -and $_.CommandLine -notlike '*fix-*'
} | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Output ("matou: " + $_.ProcessId) }
  catch { Write-Output ("falhou: " + $_.ProcessId) }
}
`;
fs.writeFileSync(PS1, PS1_CONTENT, 'utf8');
console.log('  [OK] guard-kill.ps1 gravado (' + PS1_CONTENT.length + ' chars)');

// ── 3. Guarda v5.7 (JS limpo, sem aspas internas) ──
console.log('\n\x1b[36m=== 3/4 — guarda v5.7 no luna-server.js ===\x1b[0m');
let src = fs.readFileSync(SERVER, 'utf8');
const isCrlf = src.includes('\r\n');
const norm = (s) => isCrlf ? s.replace(/\n/g, '\r\n') : s;

const OLD_GUARD = norm(`    if (matou) {
      console.log('[LUNA] porta ' + PORT + ' ocupada — instancia anterior (PID do arquivo) encerrada; saindo pra pm2 respawnar limpo');
    } else {
      console.error('[LUNA-FATAL] porta ' + PORT + ' ocupada e sem PID registrado nosso (ocupante estranho?) — exit(1)');
    }
    process.exit(1);`);

const NEW_GUARD = norm(`    if (!matou) {
      // v5.7-fix: FALLBACK — sem PID file (instancia anterior pre-guarda): mata
      // qualquer node luna-server.js (menos esta instancia) via guard-kill.ps1.
      try {
        const { execSync: _ex } = require('child_process');
        const _ps1 = require('path').join(__dirname, 'guard-kill.ps1');
        const _out = _ex('powershell -NoProfile -ExecutionPolicy Bypass -File ' + _ps1 + ' -Me ' + process.pid, { encoding: 'utf8', timeout: 15000 });
        if (_out && _out.trim()) console.log('[LUNA] guarda-fallback: ' + _out.trim());
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

if (!src.includes(OLD_GUARD)) { console.error('  [FALHOU] bloco v5.6 nao encontrado'); process.exit(1); }
src = src.replace(OLD_GUARD, NEW_GUARD);
fs.writeFileSync(SERVER, src);
console.log('  [OK] guarda v5.7 aplicada');

// ── 4. node --check em tudo + sobe ──
console.log('\n\x1b[36m=== 4/4 — validacao de sintaxe + sobe ===\x1b[0m');
const arquivos = [
  ['luna-server.js', SERVER],
  ['guard-kill.ps1', PS1],
  ['luna-soul.cjs', path.join(ROOT, 'packages', 'kernel', 'luna-soul.cjs')],
  ['content.js', path.join(ROOT, 'packages', 'kernel', 'luna-extension', 'content.js')],
  ['kimi-bridge.cjs', path.join(ROOT, 'packages', 'kernel', 'kimi-bridge.cjs')]
];
let ok = true;
for (const [nome, arquivo] of arquivos) {
  if (nome.endsWith('.ps1')) {
    try {
      execSync(`powershell -NoProfile -Command "Get-Command Get-CimInstance | Out-Null"`, { encoding: 'utf8', stdio: 'pipe' });
      console.log('  \x1b[32m[OK]\x1b[0m   ' + nome + ' (PowerShell disponivel)');
    } catch { console.log('  [AVISO] ' + nome + ' — PowerShell?'); }
    continue;
  }
  try {
    execSync(`node --check "${arquivo}"`, { encoding: 'utf8', stdio: 'pipe' });
    console.log('  \x1b[32m[OK]\x1b[0m   ' + nome);
  } catch (e) {
    ok = false;
    console.log('  \x1b[31m[ERRO]\x1b[0m ' + nome + ' — ' + (e.stderr || e.message || '').split('\n').filter(l => l.trim()).slice(0, 2).join(' | '));
  }
}
if (!ok) { console.error('\n  ⚠ Sintaxe ainda quebrada — me manda os erros.'); process.exit(1); }

try { execSync('pm2 restart luna-kernel', { encoding: 'utf8' }); console.log('  pm2 restart ok'); } catch { console.error('  pm2 restart FALHOU'); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  await sleep(12000);
  let port = '';
  try { port = execSync('netstat -ano | findstr :3458 | findstr LISTENING', { encoding: 'utf8' }).trim(); } catch {}
  const pidFile = path.join(require('os').tmpdir(), 'luna-server-3458.pid');
  const pidOk = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : null;
  console.log('  porta 3458: ' + (port || '(ninguem ainda)'));
  console.log('  PID file: ' + (pidOk || 'nao gravado'));
  if (port && pidOk && port.includes(pidOk)) {
    console.log('\n\x1b[32m✅ ESTAVEL: porta + PID file batem. Zumbi morto pra sempre.\x1b[0m');
  } else {
    console.log('\n\x1b[33m⚠ Se subindo ainda: espera 15s e roda de novo:\x1b[0m');
    console.log('   netstat -ano | findstr :3458 | findstr LISTENING');
  }
  console.log('\x1b[90mBackup: ' + baks[0].f + ' (restaurado dele)\x1b[0m');
})();
