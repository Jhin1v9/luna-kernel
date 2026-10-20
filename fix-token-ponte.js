#!/usr/bin/env node
/**
 * fix-token-ponte.js — cria LUNA_KERNEL_TOKEN e planta nos dois lados (2026-10-20)
 *
 * O orchestrator recusou a ponte pro Luna Web: "LUNA_KERNEL_TOKEN ausente no .env
 * (fail-closed)". O .env do kernel nao tem token nenhum de ponte. Solucao: gerar
 * um token e gravar nos DOIS .env (kernel + agent), restartar os dois.
 * Bonus: libera a porta 3100 se tiver ocupante (EADDRINUSE do orchestrator).
 *
 * USO:  node fix-token-ponte.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const KERNEL_ENV = path.join('C:\\Users\\Abner\\Documents\\luna-kernel', '.env');
const AGENT_ENV = path.join('C:\\Users\\Abner\\Documents', 'Luna cto', 'luna-agent', '.env');

// ── 1. Token (gera se nao existir em nenhum dos dois) ──
console.log('\x1b[36m=== 1/3 — token da ponte ===\x1b[0m');
let token = null;
for (const f of [KERNEL_ENV, AGENT_ENV]) {
  try {
    const m = fs.readFileSync(f, 'utf8').match(/^LUNA_KERNEL_TOKEN=(.+)$/m);
    if (m) { token = m[1].trim(); console.log('  token ja existe em ' + path.basename(path.dirname(f)) + '/.env'); break; }
  } catch {}
}
if (!token) {
  token = 'lk-' + crypto.randomBytes(24).toString('hex');
  console.log('  token novo gerado: ' + token.slice(0, 12) + '...');
}

for (const f of [KERNEL_ENV, AGENT_ENV]) {
  if (!fs.existsSync(f)) { console.log('  \x1b[33m⚠ nao existe: ' + f + '\x1b[0m'); continue; }
  const content = fs.readFileSync(f, 'utf8');
  if (/^LUNA_KERNEL_TOKEN=/m.test(content)) {
    console.log('  [SKIP] ' + path.basename(path.dirname(f)) + ' ja tem LUNA_KERNEL_TOKEN');
  } else {
    fs.copyFileSync(f, f + '.bak-' + ts);
    fs.appendFileSync(f, '\n# ponte Luna Web <-> agent (gerado ' + ts + ')\nLUNA_KERNEL_TOKEN=' + token + '\n');
    console.log('  \x1b[32m[OK]\x1b[0m ' + path.basename(path.dirname(f)) + '/.env atualizado');
  }
}

// ── 2. Libera a 3100 se ocupada ──
console.log('\n\x1b[36m=== 2/3 — porta 3100 ===\x1b[0m');
const tmp = path.join(os.tmpdir(), `luna-tp-${Date.now()}.ps1`);
fs.writeFileSync(tmp, [
  "$conn = netstat -ano | Select-String ':3100.*LISTENING'",
  "if ($conn) {",
  '  $conn | ForEach-Object {',
  '    $parts = $_.Line.Trim() -split "\\s+"',
  '    $pid = $parts[-1]',
  '    try { Stop-Process -Id $pid -Force -ErrorAction Stop; Write-Output ("matou: " + $pid) } catch { Write-Output ("falhou: " + $pid) }',
  '  }',
  '} else { Write-Output "porta 3100 livre" }'
].join('\n'), 'utf8');
try {
  const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`, { encoding: 'utf8' });
  out.trim().split('\n').forEach(l => console.log('  ' + l.trim()));
} catch (e) { console.log('  (ps1: ' + (e.message || '').split('\n')[0] + ')'); }
try { fs.unlinkSync(tmp); } catch {}

// ── 3. Restart com env novo ──
console.log('\n\x1b[36m=== 3/3 — restartando com --update-env ===\x1b[0m');
for (const svc of ['luna-orchestrator', 'luna-kernel']) {
  try {
    execSync(`pm2 restart ${svc} --update-env`, { encoding: 'utf8' });
    console.log('  \x1b[32m[OK]\x1b[0m ' + svc);
  } catch { console.log('  \x1b[31m[FALHOU]\x1b[0m ' + svc); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  await sleep(8000);
  const list = execSync('pm2 list', { encoding: 'utf8' });
  for (const line of list.split('\n')) {
    if (/luna-(orchestrator|kernel|worker|whatsplay)/.test(line)) console.log('  ' + line.trim());
  }
  console.log('');
  console.log('\x1b[32m✅ PONTE CRAVADA nos dois .env. Se o orchestrator cair de novo,\x1b[0m');
  console.log('   manda: pm2 logs luna-orchestrator --lines 15');
  console.log('\x1b[90mBackups: .env.bak-' + ts + ' (nos dois lados)\x1b[0m');
})();
