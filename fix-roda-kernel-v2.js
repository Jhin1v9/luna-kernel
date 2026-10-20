#!/usr/bin/env node
/**
 * fix-roda-kernel-v2.js — sobe niveis ate achar config/providers.json (2026-10-20)
 * A v1 usou o cwd do pm2 (apps/orchestrator) direto — mas o config fica na raiz
 * do repo luna-agent. Essa sobe ate 4 niveis procurando config/providers.json.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ── 1. Localiza providers.json (sobe niveis a partir do pm2 cwd) ──
console.log('\x1b[36m=== 1/3 — localizando providers.json ===\x1b[0m');
let baseDir = null;
try {
  const jlist = JSON.parse(execSync('pm2 jlist', { encoding: 'utf8' }));
  const orch = jlist.find(p => p.name === 'luna-orchestrator');
  if (orch && orch.pm2_env && orch.pm2_env.pm_cwd) baseDir = orch.pm2_env.pm_cwd;
} catch {}

let CFG = null;
if (baseDir) {
  let dir = baseDir;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'config', 'providers.json');
    if (fs.existsSync(candidate)) { CFG = candidate; break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
if (!CFG) {
  for (const c of [
    path.join(os.homedir(), 'Documents', 'Luna cto', 'luna-agent', 'config', 'providers.json'),
    path.join(os.homedir(), 'Documents', 'luna-agent', 'config', 'providers.json')
  ]) {
    if (fs.existsSync(c)) { CFG = c; break; }
  }
}
if (!CFG) { console.error('  [FALHOU] providers.json nao achado em lugar nenhum'); process.exit(1); }
console.log('  [OK] achado: ' + CFG);

// ── 2. Atualiza ──
console.log('\n\x1b[36m=== 2/3 — subindo luna-kernel ao topo ===\x1b[0m');
fs.copyFileSync(CFG, CFG + '.bak-' + ts);
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));

console.log('  fastBrain antes: ' + cfg.fastBrain);
cfg.fastBrain = 'luna-kernel';

const p = (cfg.providers || []).find(x => x.id === 'luna-kernel');
if (!p) { console.error('  [FALHOU] provider luna-kernel nao existe'); process.exit(1); }
console.log('  luna-kernel antes: priority=' + p.priority + ' role=' + p.role + ' enabled=' + p.enabled);
p.priority = 1;
p.role = 'ambos';
p.enabled = true;
p.label = 'Luna Kernel (CORACAO — local, prompt v7.3 + brain + tools)';
console.log('  luna-kernel depois: priority=' + p.priority + ' role=' + p.role);

fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n');
console.log('  \x1b[32m[OK] providers.json atualizado (backup: .bak-' + ts + ')\x1b[0m');

// ── 3. Reinicia agentes ──
console.log('\n\x1b[36m=== 3/3 — reiniciando agentes ===\x1b[0m');
for (const svc of ['luna-orchestrator', 'luna-worker']) {
  try { execSync(`pm2 restart ${svc}`, { encoding: 'utf8' }); console.log('  \x1b[32m[OK]\x1b[0m ' + svc); }
  catch { console.log('  \x1b[33m⚠\x1b[0m ' + svc); }
}

console.log('');
console.log('\x1b[32m✅ CORAÇÃO NO TOPO DA RODA.\x1b[0m Testa: manda msg pro WhatsApp da Luna');
console.log('   e confere: grep -a "chat.completions\\|kind=" ~/.pm2/logs/luna-kernel-out.log | tail -10');
