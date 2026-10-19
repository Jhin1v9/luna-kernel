#!/usr/bin/env node
/**
 * fix-zombie-forever.js — GUARDA DE INSTANCIA UNICA: fim dos zumbis (2026-10-19)
 *
 * Causa raiz do zumbi que renasce: no Windows, `pm2 stop/restart` frequentemente
 * NAO consegue matar o processo filho — ele vira orfao segurando a porta 3458,
 * e todo restart seguinte morre em EADDRINUSE (contador de restarts sobe pra
 * sempre, e alguem tem que matar o orfao na mao).
 *
 * Cura: o proprio luna-server.js defende a porta.
 *   - Ao subir com sucesso, grava o proprio PID num arquivo
 *   - Se uma nova instancia achar a porta ocupada (EADDRINUSE), ela LE o PID
 *     registrado, MATA a instancia anterior (process.kill = force no Windows)
 *     e sai com exit(1) — o pm2 respawna e encontra a porta livre
 *   - Funciona independente de QUEM criou o orfao
 *
 * USO:  node fix-zombie-forever.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const SERVER = path.join(ROOT, 'apps', 'dashboard', 'luna-server.js');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function runPS(body) {
  const tmp = path.join(os.tmpdir(), `luna-zf-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(tmp, body, 'utf8');
  try { return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`, { encoding: 'utf8' }); }
  catch (e) { return (e.stdout || '').toString(); }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

// ── 1. Para o respawn e mata o zumbi atual ──
console.log('\x1b[36m=== 1/4 — limpa o atual ===\x1b[0m');
try { execSync('pm2 stop luna-kernel', { encoding: 'utf8' }); console.log('  pm2 stop ok'); }
catch { console.log('  (ja estava parado)'); }
const killOut = runPS(`
$me = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -like '*luna-server.js*' -and $_.ProcessId -ne $me -and $_.CommandLine -notlike '*fix-*'
} | ForEach-Object {
  $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ProcessId)").ParentProcessId
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Output ("morto: " + $_.ProcessId + " (pai: " + $parent + ")") } catch {}
`);
if (killOut.trim()) killOut.trim().split('\n').forEach(l => console.log('  💀 ' + l.trim()));
else console.log('  (nenhum zumbi vivo)');

// ── 2. Patch: guarda de instancia unica ──
console.log('\n\x1b[36m=== 2/4 — guarda de instancia unica no luna-server.js ===\x1b[0m');
if (!fs.existsSync(SERVER)) { console.error('  [FALHOU] nao encontrado: ' + SERVER); process.exit(1); }
fs.copyFileSync(SERVER, SERVER + '.bak-' + ts);
let src = fs.readFileSync(SERVER, 'utf8');
const isCrlf = src.includes('\r\n');
const norm = (s) => isCrlf ? s.replace(/\n/g, '\r\n') : s;

if (src.includes('LUNA_PID_FILE')) {
  console.log('  [SKIP] guarda ja instalada');
} else {
  // o bloco que o fix-luna-server.js instalou (Patch B) — verificado no audit
  const OLD = norm(`server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('[LUNA-FATAL] Porta ' + PORT + ' em uso — exit(1) pra pm2 respawnar limpo');
    process.exit(1);
  }
  console.error('[LUNA-FATAL] Erro no server:', err.message);
  process.exit(1);
});

server.listen(PORT, () => {`);

  const NEW = norm(`// v5.6-fix (2026-10-19): GUARDA DE INSTANCIA UNICA — fim dos zumbis.
// Grava o proprio PID ao subir. Se a porta estiver ocupada, a nova instancia
// MATA a anterior (pelo PID registrado) e sai — pm2 respawna e acha porta livre.
const LUNA_PID_FILE = path.join(os.tmpdir(), 'luna-server-3458.pid');
server.on('listening', () => {
  try { fs.writeFileSync(LUNA_PID_FILE, String(process.pid)); } catch {}
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    let matou = false;
    try {
      const oldPid = parseInt(fs.readFileSync(LUNA_PID_FILE, 'utf8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try { process.kill(oldPid); matou = true; } catch {}
      }
    } catch {}
    if (matou) {
      console.log('[LUNA] porta ' + PORT + ' ocupada — instancia anterior (PID do arquivo) encerrada; saindo pra pm2 respawnar limpo');
    } else {
      console.error('[LUNA-FATAL] porta ' + PORT + ' ocupada e sem PID registrado nosso (ocupante estranho?) — exit(1)');
    }
    process.exit(1);
  }
  console.error('[LUNA-FATAL] Erro no server:', err.message);
  process.exit(1);
});

server.listen(PORT, () => {`);

  if (!src.includes(OLD)) {
    console.error('  [FALHOU] bloco EADDRINUSE do fix-luna-server.js nao encontrado.');
    console.error('  O arquivo local divergiu? Roda: node fix-luna-server.js primeiro, depois essa de novo.');
    process.exit(1);
  }
  src = src.replace(OLD, NEW);
  fs.writeFileSync(SERVER, src);
  console.log('  [OK] guarda instalada: PID file + kill da instancia anterior');
}

// ── 3. Sobe limpo ──
console.log('\n\x1b[36m=== 3/4 — sobe ===\x1b[0m');
try { execSync('pm2 restart luna-kernel', { encoding: 'utf8' }); console.log('  pm2 restart ok'); }
catch { console.error('  [FALHOU] pm2 restart'); }

// ── 4. Verificacao + diagnostico do spawnador ──
console.log('\n\x1b[36m=== 4/4 — verificacao + quem spawna zumbi ===\x1b[0m');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  await sleep(8000);
  const procs = runPS(`
$me = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -like '*luna-server.js*' -and $_.ProcessId -ne $me -and $_.CommandLine -notlike '*fix-*'
})
Write-Output ("COUNT=" + $procs.Count)
foreach ($p in $procs) {
  $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ProcessId)").ParentProcessId
  $pName = (Get-CimInstance Win32_Process -Filter "ProcessId=$parent").Name
  Write-Output ("PID=" + $p.ProcessId + " PAI=" + $parent + "(" + $pName + ") CRIADO=" + $p.CreationDate)
}
`);
  console.log(procs.trim() || '  (nenhum processo!)');

  const pidFile = path.join(os.tmpdir(), 'luna-server-3458.pid');
  if (fs.existsSync(pidFile)) {
    console.log('  PID file gravado: ' + fs.readFileSync(pidFile, 'utf8').trim() + ' ✅');
  } else {
    console.log('  ⚠ PID file ainda nao gravado (kernel pode estar subindo)');
  }

  // diagnostico: serviço Windows / tarefa agendada que possa spawnar luna-server
  const svc = runPS(`Get-CimInstance Win32_Service | Where-Object { $_.PathName -like '*luna*' } | Select-Object Name, State, PathName | Format-List | Out-String -Width 200`);
  if (svc.trim()) console.log('\n  ⚠ SERVICOS Windows apontando pra luna:\n' + svc.trim().split('\n').map(l => '    ' + l).join('\n'));
  const sch = runPS(`Get-ScheduledTask | Where-Object { $_.Actions.Execute -like '*node*' -or $_.Actions.Arguments -like '*luna*' } | Select-Object TaskName, State | Format-Table -AutoSize | Out-String -Width 120`);
  if (sch.trim()) console.log('\n  ⚠ TAREFAS AGENDADAS com node/luna:\n' + sch.trim().split('\n').map(l => '    ' + l).join('\n'));

  console.log('\n\x1b[32m✅ GUARDA INSTALADA.\x1b[0m De agora em diante:');
  console.log('   • Zumbi aparecer → a PROXIMA instancia do pm2 mata ele sozinha e assume');
  console.log('   • Nenhuma intervencao manual, nunca mais');
  console.log('   • Se o diagnostico acima mostrar servico/tarefa estranha, me manda que removemos');
  console.log('\x1b[90mBackup: luna-server.js.bak-' + ts + '\x1b[0m');
})();
