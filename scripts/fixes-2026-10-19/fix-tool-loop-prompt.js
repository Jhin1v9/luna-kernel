#!/usr/bin/env node
/**
 * fix-tool-loop-prompt.js — toolLoop minimal: soh o resultado + dica listTools (2026-10-19)
 *
 * Decreto owner: o prompt de retorno da tool = APENAS o resultado + instrucao
 * curta de descoberta. SEM historial (ele vinha do template pesado do config,
 * e ainda por cima com entradas duplicadas inchando cada requisicao).
 *
 * Substitui prompts.toolLoop nos dois configs. O template nao referencia
 * {{history}} — entao a duplicacao do historico nem tem como aparecer aqui.
 *
 * USO:  node fix-tool-loop-prompt.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const NOVO_TOOL_LOOP = `{{toolResult}}

💡 NÃO SABE QUAL TOOL USAR? Chame {"tool": "listTools", "params": {}} pra ver o índice completo, ou {"tool": "listTools", "params": {"busca": "assunto"}} pra filtrar.`;

const CONFIGS = [
  path.join(ROOT, 'packages', 'kernel', 'config', 'luna-prompt-config.json'),
  path.join(os.homedir(), '.luna', 'kernel', 'config', 'luna-prompt-config.json')
];

let trocados = 0;
for (const cfgPath of CONFIGS) {
  if (!fs.existsSync(cfgPath)) { console.log('  (nao existe: ' + cfgPath + ')'); continue; }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (!cfg.prompts || typeof cfg.prompts !== 'object') cfg.prompts = {};
  const atual = cfg.prompts.toolLoop || '';
  if (atual.trim() === NOVO_TOOL_LOOP.trim()) {
    console.log('\x1b[90m  [SKIP]\x1b[0m ' + cfgPath + ' — ja minimal');
    continue;
  }
  fs.copyFileSync(cfgPath, cfgPath + '.bak-' + ts);
  cfg.prompts.toolLoop = NOVO_TOOL_LOOP;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  console.log('\x1b[32m  [OK]\x1b[0m ' + cfgPath);
  console.log('      toolLoop: ' + atual.length + ' chars (pesado) -> ' + NOVO_TOOL_LOOP.length + ' chars (minimal)');
  trocados++;
}

// verifica que a soul usa cfg.toolLoop no branch isToolResult
const SOUL = path.join(ROOT, 'packages', 'kernel', 'luna-soul.cjs');
const soul = fs.readFileSync(SOUL, 'utf8');
const usaCfg = soul.includes('cfg.toolLoop') || soul.includes("cfg['toolLoop']");
const temTernario = soul.includes("isToolResult && !isStatelessApi");
console.log('');
console.log('soul usa cfg.toolLoop no loop: ' + (usaCfg ? '✅' : '⚠ NAO ENCONTRADO — me avisa'));
console.log('K3b (sem historico no toolLoop CDP): ' + (temTernario ? '✅' : '⚠'));

try {
  execSync('pm2 restart luna-kernel', { encoding: 'utf8' });
  console.log('\x1b[32m[OK]\x1b[0m luna-kernel reiniciado');
} catch { console.log('⚠ pm2 restart falhou — roda manual'); }

console.log('');
console.log('✅ TOOL LOOP MINIMAL NO AR.');
console.log('   Proxima tool: o Kimi recebe SOH o resultado + dica de listTools.');
console.log('   Historial nao tem mais como aparecer (template nao referencia).');
console.log('\x1b[90mBackups: *.bak-' + ts + '\x1b[0m');
