#!/usr/bin/env node
/**
 * fix-final-round.js — consolida: kill real + guarda com fallback + result-id v2 (2026-10-19)
 *
 * 1. Mata zumbi com o .ps1 QUE FUNCIONOU no fix-luna-server.js v3 (o do
 *    fix-zombie-forever teve erro de sintaxe no PowerShell)
 * 2. Guarda de instancia GANHA FALLBACK: sem PID file (primeiro boot) → mata
 *    qualquer node luna-server.js (exceto a propria instancia) via .ps1 temporario
 * 3. fix-result-id v2: com tratamento CRLF (a v1 esqueceu e falhou no content.js)
 * 4. Sobe, verifica 1 processo + porta + PID file
 *
 * USO:  node fix-final-round.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const SERVER = path.join(ROOT, 'apps', 'dashboard', 'luna-server.js');
const SOUL = path.join(ROOT, 'packages', 'kernel', 'luna-soul.cjs');
const CONTENT = path.join(ROOT, 'packages', 'kernel', 'luna-extension', 'content.js');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function runPS(body) {
  const tmp = path.join(os.tmpdir(), `luna-fr-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(tmp, body, 'utf8');
  try { return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`, { encoding: 'utf8' }); }
  catch (e) { return (e.stdout || '').toString() + '\n[stderr] ' + (e.stderr || '').toString(); }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

// ── 1. Mata zumbis (ps1 comprovado da v3) ──
console.log('\x1b[36m=== 1/4 — matando zumbis ===\x1b[0m');
try { execSync('pm2 stop luna-kernel', { encoding: 'utf8' }); console.log('  pm2 stop ok'); } catch { console.log('  (ja parado)'); }
const killOut = runPS([
  '$me = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId',
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*luna-server.js*' -and $_.ProcessId -ne $me -and $_.CommandLine -notlike '*fix-*' } | ForEach-Object {",
  '  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Output ("morto: $($_.ProcessId)") }',
  '  catch { Write-Output ("falhou: $($_.ProcessId)") }',
  '}'
].join('\n'));
if (killOut.trim()) killOut.trim().split('\n').forEach(l => console.log('  💀 ' + l.trim()));
else console.log('  (nenhum zumbi)');

// ── 2. Guarda com fallback ──
console.log('\n\x1b[36m=== 2/4 — guarda: fallback sem PID file ===\x1b[0m');
fs.copyFileSync(SERVER, SERVER + '.bak-' + ts);
let ssrc = fs.readFileSync(SERVER, 'utf8');
const sCrlf = ssrc.includes('\r\n');
const snorm = (s) => sCrlf ? s.replace(/\n/g, '\r\n') : s;

const OLD_GUARD = snorm(`    if (matou) {
      console.log('[LUNA] porta ' + PORT + ' ocupada — instancia anterior (PID do arquivo) encerrada; saindo pra pm2 respawnar limpo');
    } else {
      console.error('[LUNA-FATAL] porta ' + PORT + ' ocupada e sem PID registrado nosso (ocupante estranho?) — exit(1)');
    }
    process.exit(1);`);

const NEW_GUARD = snorm(`    if (!matou) {
      // v5.7-fix: FALLBACK — sem PID file (instancia anterior pre-guarda) ou PID
      // invalido: mata qualquer node luna-server.js (menos a propria instancia).
      try {
        const { execSync: _ex } = require('child_process');
        const _tmp = require('path').join(require('os').tmpdir(), 'luna-guard-kill-' + process.pid + '.ps1');
        require('fs').writeFileSync(_tmp, [
          '$me = ' + process.pid,
          "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { \\$_.CommandLine -like '*luna-server.js*' -and \\$_.ProcessId -ne \\$me } | ForEach-Object {",
          '  try { Stop-Process -Id \\$_.ProcessId -Force -ErrorAction Stop; Write-Output (\\"matou: \\" + \\$_.ProcessId) } catch {}',
          '}'
        ].join('\\n'), 'utf8');
        const _out = _ex('powershell -NoProfile -ExecutionPolicy Bypass -File \\"' + _tmp + '\\"', { encoding: 'utf8', timeout: 15000 });
        if (_out && _out.trim()) console.log('[LUNA] guarda-fallback: ' + _out.trim());
        try { require('fs').unlinkSync(_tmp); } catch {}
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

if (ssrc.includes('v5.7-fix')) {
  console.log('  [SKIP] fallback ja instalado');
} else if (!ssrc.includes(OLD_GUARD)) {
  console.error('  [FALHOU] bloco da guarda v5.6 nao encontrado. Me avisa.');
  process.exit(1);
} else {
  ssrc = ssrc.replace(OLD_GUARD, NEW_GUARD);
  fs.writeFileSync(SERVER, ssrc);
  console.log('  [OK] guarda v5.7: mata qualquer luna-server.js quando sem PID file');
}

// ── 3. result-id v2 (com CRLF norm) ──
console.log('\n\x1b[36m=== 3/4 — result-id v2 no content.js ===\x1b[0m');
let csrc = fs.readFileSync(CONTENT, 'utf8');
const cCrlf = csrc.includes('\r\n');
const cnorm = (s) => cCrlf ? s.replace(/\n/g, '\r\n') : s;

if (csrc.includes("'id:' + p.id")) {
  console.log('  [SKIP] dedup por id ja presente');
} else {
  fs.copyFileSync(CONTENT, CONTENT + '.bak-' + ts);
  const OLD_DEDUP = cnorm("          const h = payloadHash(p);\n          if (seenHashes.has(h)) continue; // ja injetado (via SW ou poll anterior)\n          seenHashes.set(h, now);");
  const NEW_DEDUP = cnorm("          const h = payloadHash(p);\n          // v14.4-fix: dedup PRIMARIO por id unico (quando a soul envia);\n          // hash continua como fallback pra msgs antigas sem id.\n          if (p.id && seenHashes.has('id:' + p.id)) continue;\n          if (seenHashes.has(h)) continue; // ja injetado (via SW ou poll anterior)\n          seenHashes.set(h, now);\n          if (p.id) seenHashes.set('id:' + p.id, now);");
  const count = csrc.split(OLD_DEDUP).length - 1;
  if (count !== 1) { console.error('  [FALHOU] dedup ' + count + 'x — local divergiu, me manda: grep -n "payloadHash(p)" packages/kernel/luna-extension/content.js'); }
  else {
    fs.writeFileSync(CONTENT, csrc.replace(OLD_DEDUP, NEW_DEDUP));
    console.log('  [OK] dedup por id instalado no content.js');
  }
}
// soul: verifica que ja foi (fix-result-id v1 aplicou na soul)
if (fs.readFileSync(SOUL, 'utf8').includes("'tr-' + Date.now()")) console.log('  [OK] soul ja tem id unico (v1)');
else console.log('  ⚠ soul sem id unico — roda: node scripts/fixes-2026-10-19/fix-result-id.js');

// ── 4. Sobe + verifica ──
console.log('\n\x1b[36m=== 4/4 — sobe e verifica ===\x1b[0m');
try { execSync('pm2 restart luna-kernel', { encoding: 'utf8' }); console.log('  pm2 restart ok'); } catch { console.error('  pm2 restart FALHOU'); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  await sleep(10000);
  const procs = runPS([
    '$me = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId',
    "$procs = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*luna-server.js*' -and $_.ProcessId -ne $me -and $_.CommandLine -notlike '*fix-*' })",
    'Write-Output ("COUNT=" + $procs.Count)',
    'foreach ($p in $procs) { Write-Output ("PID=" + $p.ProcessId) }'
  ].join('\n'));
  console.log('  ' + (procs.trim() || '(nenhum)').replace(/\n/g, '\n  '));
  let port = '';
  try { port = execSync('netstat -ano | findstr :3458 | findstr LISTENING', { encoding: 'utf8' }).trim(); } catch {}
  console.log('  porta 3458: ' + (port || '(ninguem)').replace(/\n/g, ' | '));
  const pidFile = path.join(os.tmpdir(), 'luna-server-3458.pid');
  console.log('  PID file: ' + (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() + ' ✅' : 'ainda nao (pode estar subindo — se COUNT=0, o guarda-fallback esta matando e respawnando; espera +10s e roda o bloco de verificacao de novo)'));

  const countMatch = procs.match(/COUNT=(\d+)/);
  const pidMatch = procs.match(/PID=(\d+)/);
  const portPid = port.match(/LISTENING\s+(\d+)\s*$/) || port.match(/(\d+)\s*$/);
  console.log('');
  if (countMatch && parseInt(countMatch[1]) === 1 && portPid && pidMatch && portPid[1] === pidMatch[1] && fs.existsSync(pidFile)) {
    console.log('\x1b[32m✅ TUDO CERTO: 1 processo, dono da porta, PID file gravado.\x1b[0m');
    console.log('   Zumbi agora morre sozinho em 1 ciclo de respawn — pra sempre.');
  } else {
    console.log('\x1b[33m⚠ Ainda estabilizando. Espera 15s e roda a verificacao:\x1b[0m');
    console.log('   node scripts/fixes-2026-10-19/pre-commit-audit.js');
  }
  console.log('\x1b[90mBackups: *.bak-' + ts + '\x1b[0m');
})();
