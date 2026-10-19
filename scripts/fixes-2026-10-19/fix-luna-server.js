#!/usr/bin/env node
/**
 * fix-luna-server.js v3 (nao se mata mais) — mata o loop de zumbis da porta 3458 (2026-10-19)
 * Compativel com Git Bash / cmd / PowerShell (usa .ps1 temporario, sem aspas inline)
 *
 * USO:  node fix-luna-server.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const FILE = path.join(ROOT, 'apps', 'dashboard', 'luna-server.js');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
let errors = 0;

const OK = (m) => console.log('\x1b[32m  [OK]\x1b[0m ' + m);
const SKIP = (m) => console.log('\x1b[90m  [SKIP]\x1b[0m ' + m + ' — ja aplicado');
const FAIL = (m) => { console.log('\x1b[31m  [FALHOU]\x1b[0m ' + m); errors++; };
const H = (m) => console.log('\n\x1b[36m=== ' + m + ' ===\x1b[0m');

// Executa PowerShell via arquivo temporario (imune a problemas de quoting no Git Bash)
function runPS(body) {
  const tmp = path.join(os.tmpdir(), `luna-fix-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`, { encoding: 'utf8' });
  } catch (e) {
    return (e.stdout || '').toString();
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  // ── 1. Para o respawn do pm2 durante a cirurgia ──
  H('1/5 — pm2 stop luna-kernel (congela o respawn)');
  try {
    execSync('pm2 stop luna-kernel', { encoding: 'utf8' });
    OK('luna-kernel parado');
  } catch (e) {
    console.log('\x1b[90m  (ja estava parado — ok)\x1b[0m');
  }

  // ── 2. Mata TODOS os zumbis luna-server.js ──
  H('2/5 — matando zumbis luna-server.js');
  const killOut = runPS(`
# v3-fix: o proprio script (fix-luna-server.js) CASA com '*luna-server.js*' — exclui o pai ($PID = powershell, parent = node do script)
$me = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -like '*luna-server.js*' -and $_.ProcessId -ne $me -and $_.CommandLine -notlike '*fix-luna-server*'
} | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Output "morto: $($_.ProcessId)" }
  catch { Write-Output "falhou: $($_.ProcessId)" }
}
`);
  const mortos = killOut.trim();
  if (mortos) {
    mortos.split('\n').forEach(l => console.log('  💀 ' + l.trim()));
    OK('zumbis eliminados');
  } else {
    OK('nenhum zumbi vivo (porta ja livre)');
  }

  // ── 3. Patch no luna-server.js ──
  H('3/5 — patch luna-server.js (exit no fatal + guard do listen)');
  if (!fs.existsSync(FILE)) {
    FAIL('nao encontrado: ' + FILE);
  } else {
    fs.copyFileSync(FILE, FILE + '.bak-' + ts);
    let src = fs.readFileSync(FILE, 'utf8');
    const isCrlf = src.includes('\r\n');
    const norm = (s) => isCrlf ? s.replace(/\n/g, '\r\n') : s;

    // Patch A: handlers fatais com exit(1)
    const reA = /process\.on\('uncaughtException',[\s\S]*?\n\}\);/;
    if (src.includes('process.exit(1)') && reA.test(src) && src.match(/process\.on\('uncaughtException',/g).length === 1) {
      SKIP('Patch A');
    } else {
      const countA = (src.match(/process\.on\('uncaughtException',/g) || []).length;
      if (countA !== 1) {
        FAIL('Patch A — uncaughtException encontrado ' + countA + 'x (esperado 1)');
      } else {
        const novoHandler = norm(`// v5.4-fix (2026-10-19): loga o erro e MORRE — sem zumbis segurando a porta.
// O keep-alive antigo segurava o processo vivo com EADDRINUSE e o pm2
// acumulava instancias em loop. Agora: exit(1) e o pm2 respawna limpo.
process.on('uncaughtException', (err) => {
  console.error('[LUNA-FATAL] Uncaught Exception:', err.message);
  console.error(err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[LUNA-FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
process.on('SIGTERM', () => {
  console.log('[LUNA] SIGTERM recebido — desligando limpo');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[LUNA] SIGINT recebido — desligando limpo');
  process.exit(0);
});`);
        src = src.replace(reA, novoHandler);
        fs.writeFileSync(FILE, src);
        OK('Patch A: fatal handlers agora fazem exit (fim dos zumbis)');
      }
    }

    // Patch B: server.on('error') antes do listen
    src = fs.readFileSync(FILE, 'utf8');
    if (src.includes("server.on('error'")) {
      SKIP('Patch B');
    } else {
      const listenPattern = /server\.listen\(PORT, \(\) => \{/;
      if (!listenPattern.test(src)) {
        FAIL('Patch B — server.listen(PORT nao encontrado');
      } else {
        const guard = norm(`// v5.5-fix (2026-10-19): EADDRINUSE mata o processo IMEDIATAMENTE
// (sem depender do uncaughtException). Garante pm2 respawn limpo.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('[LUNA-FATAL] Porta ' + PORT + ' em uso — exit(1) pra pm2 respawnar limpo');
    process.exit(1);
  }
  console.error('[LUNA-FATAL] Erro no server:', err.message);
  process.exit(1);
});

server.listen(PORT, () => {`);
        src = src.replace(listenPattern, guard);
        fs.writeFileSync(FILE, src);
        OK("Patch B: server.on('error') com exit(1) antes do listen");
      }
    }
  }

  // ── 4. Sobe o kernel limpo ──
  H('4/5 — pm2 restart luna-kernel');
  try {
    execSync('pm2 restart luna-kernel', { encoding: 'utf8' });
    OK('luna-kernel reiniciado');
  } catch (e) {
    FAIL('pm2 restart falhou — roda manual: pm2 restart luna-kernel');
  }

  // ── 5. Verificacao final ──
  H('5/5 — verificacao (10s de espera pro boot)');
  await sleep(10000);

  const procsOut = runPS(`
$me = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -like '*luna-server.js*' -and $_.ProcessId -ne $me -and $_.CommandLine -notlike '*fix-luna-server*'
} | Select-Object ProcessId,ParentProcessId)
Write-Output ("COUNT=" + $procs.Count)
$procs | Format-Table -AutoSize | Out-String -Width 120
`);
  console.log('  Processos luna-server.js:');
  console.log('  ' + (procsOut.trim() || '(nenhum!)').replace(/\n/g, '\n  '));

  let portOut = '';
  try { portOut = execSync('netstat -ano | findstr :3458 | findstr LISTENING', { encoding: 'utf8' }).trim(); } catch (e) {}
  console.log('  Porta 3458:');
  console.log('    ' + (portOut || '(ninguem escutando ainda — kernel pode estar subindo)'));

  const countMatch = procsOut.match(/COUNT=(\d+)/);
  const procCount = countMatch ? parseInt(countMatch[1], 10) : 0;

  console.log('');
  if (errors > 0) {
    console.log('\x1b[33m⚠ ' + errors + ' falha(s). Backup: luna-server.js.bak-' + ts + '\x1b[0m');
    process.exit(1);
  }
  if (procCount === 1 && portOut) {
    console.log('\x1b[32m✅ FIM DOS ZUMBIS: 1 processo unico, dono da 3458. Refresh no navegador e testa! 🌙\x1b[0m');
  } else if (procCount === 0) {
    console.log('\x1b[33m⚠ Nenhum processo vivo. Roda: pm2 restart luna-kernel && sleep 10 && netstat -ano | findstr :3458\x1b[0m');
  } else {
    console.log('\x1b[33m⚠ Ainda ha ' + procCount + ' processos. Espera 30s e roda de novo o scan — se persistir, me manda o output.\x1b[0m');
  }
}

main().catch(e => {
  console.error('\x1b[31mErro inesperado:\x1b[0m', e.message);
  process.exit(1);
});
