#!/usr/bin/env node
/**
 * fix-roda-kernel.js — coração da Luna Kernel no TOPO da roda do WhatsApp (2026-10-20)
 *
 * Causa: no config/providers.json do luna-agent, o provider "luna-kernel"
 * (http://127.0.0.1:3458/v1 — o coração com master prompt v7.3 + brain +
 * workspace tools + loopback de tools) estava com priority 98 e role "coding":
 * só era tentado se as ~20 APIs grátis falhassem inteiras, e nunca pra conversa.
 *
 * Fix (só config, zero código):
 *   - luna-kernel: priority 98 -> 1, role "coding" -> "ambos"
 *   - fastBrain: "gemini" -> "luna-kernel" (o cérebro rápido do WhatsApp = coração)
 * Roda mantém failover: kernel fora -> cai pras APIs grátis automaticamente.
 *
 * USO:  node fix-roda-kernel.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ── 1. Localiza o luna-agent no PC ──
console.log('\x1b[36m=== 1/3 — localizando luna-agent ===\x1b[0m');
let AGENT_DIR = null;

// 1a. pergunta pro pm2 onde o orchestrator roda
try {
  const jlist = JSON.parse(execSync('pm2 jlist', { encoding: 'utf8' }));
  const orch = jlist.find(p => p.name === 'luna-orchestrator');
  if (orch && orch.pm2_env && orch.pm2_env.pm_cwd) {
    AGENT_DIR = orch.pm2_env.pm_cwd;
    console.log('  [OK] achado via pm2: ' + AGENT_DIR);
  }
} catch {}

// 1b. candidatos comuns
if (!AGENT_DIR) {
  const candidates = [
    path.join(os.homedir(), 'Documents', 'luna-agent'),
    path.join(os.homedir(), 'luna-agent'),
    path.join('C:\\', 'luna-agent')
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'config', 'providers.json'))) { AGENT_DIR = c; break; }
  }
  if (AGENT_DIR) console.log('  [OK] achado em: ' + AGENT_DIR);
}

if (!AGENT_DIR) {
  console.error('  [FALHOU] luna-agent nao localizado. Roda: pm2 describe luna-orchestrator | grep -i "exec cwd"');
  process.exit(1);
}

// ── 2. Atualiza providers.json ──
console.log('\n\x1b[36m=== 2/3 — subindo luna-kernel ao topo da roda ===\x1b[0m');
const CFG = path.join(AGENT_DIR, 'config', 'providers.json');
if (!fs.existsSync(CFG)) { console.error('  [FALHOU] nao existe: ' + CFG); process.exit(1); }

fs.copyFileSync(CFG, CFG + '.bak-' + ts);
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));

console.log('  fastBrain antes: ' + cfg.fastBrain);
cfg.fastBrain = 'luna-kernel';

const p = (cfg.providers || []).find(x => x.id === 'luna-kernel');
if (!p) {
  console.error('  [FALHOU] provider luna-kernel nao existe no providers.json');
  process.exit(1);
}
console.log('  luna-kernel antes: priority=' + p.priority + ' role=' + p.role + ' enabled=' + p.enabled);
p.priority = 1;
p.role = 'ambos';
p.enabled = true;
p.label = 'Luna Kernel (CORACAO — local, prompt v7.3 + brain + tools)';
console.log('  luna-kernel depois: priority=' + p.priority + ' role=' + p.role);

fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n');
console.log('  \x1b[32m[OK] providers.json atualizado (backup: providers.json.bak-' + ts + ')\x1b[0m');

// ── 3. Reinicia orchestrator + worker ──
console.log('\n\x1b[36m=== 3/3 — reiniciando agentes ===\x1b[0m');
for (const svc of ['luna-orchestrator', 'luna-worker']) {
  try {
    execSync(`pm2 restart ${svc}`, { encoding: 'utf8' });
    console.log('  \x1b[32m[OK]\x1b[0m ' + svc);
  } catch { console.log('  \x1b[33m⚠\x1b[0m ' + svc + ' nao reiniciou'); }
}

console.log('');
console.log('\x1b[32m✅ CORAÇÃO NO TOPO DA RODA.\x1b[0m');
console.log('   WhatsApp -> roda tenta Luna Kernel (localhost:3458/v1) PRIMEIRO:');
console.log('   master prompt v7.3 + brainSearch/brainRead + workspace tools + tools executam');
console.log('   (o loopback que a gente curou hoje). Kernel fora -> failover pras APIs grátis.');
console.log('');
console.log('   TESTE: manda msg pro WhatsApp da Luna e observa no log do kernel:');
console.log('   grep -a "kind=\\|TOOL\\|chat.completions" ~/.pm2/logs/luna-kernel-out.log | tail -10');
