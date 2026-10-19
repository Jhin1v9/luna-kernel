#!/usr/bin/env node
/**
 * fix-config-bootstrap.js — prompt-config auto-criado/syncado do template (2026-10-19)
 *
 * Decreto owner: o REPO eh a fonte da verdade. Instalacao em PC novo (ou
 * reinstalacao) tem que nascer com o config correto, sem intervencao manual.
 *
 * Como: bootstrap no luna-config.js (modulo carregado por tudo, antes da soul
 * ler o config). No boot:
 *   - config de runtime nao existe → copia do template do repo (install novo)
 *   - existe mas _templateVersion menor que o template → backup + sync
 * O template ganha _templateVersion: "15.7".
 *
 * USO:  node fix-config-bootstrap.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const CFG = path.join(ROOT, 'packages', 'kernel', 'config', 'luna-config.js');
const TEMPLATE = path.join(ROOT, 'packages', 'kernel', 'config', 'luna-prompt-config.json');
const RUNTIME = path.join(os.homedir(), '.luna', 'kernel', 'config', 'luna-prompt-config.json');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const VERSION = '15.7';

// ── 1. luna-config.js: bootstrap ──
let src = fs.readFileSync(CFG, 'utf8');
if (src.includes('ensurePromptConfig')) {
  console.log('[SKIP] bootstrap ja presente no luna-config.js');
} else {
  fs.copyFileSync(CFG, CFG + '.bak-' + ts);
  const ANCHOR = "};\n\n// ── Kimi Bridge ──";
  const BOOTSTRAP = `};

// ── Prompt Config Bootstrap (v14.4-fix 2026-10-19) ──
// O REPO eh a fonte da verdade: packages/kernel/config/luna-prompt-config.json
// No boot: runtime (~/.luna/kernel/config/) inexistente → copia do template.
// Runtime com _templateVersion menor que o template → backup + sync.
// Assim PC novo / reinstalacao nasce com o config correto, zero manual.
const PROMPT_CONFIG_TEMPLATE = path.join(__dirname, 'luna-prompt-config.json');
function ensurePromptConfig() {
  try {
    if (!fs.existsSync(PROMPT_CONFIG_TEMPLATE)) return false;
    let tpl = null;
    try { tpl = JSON.parse(fs.readFileSync(PROMPT_CONFIG_TEMPLATE, 'utf8')); } catch { return false; }
    const dest = PATHS.promptConfig;
    if (!fs.existsSync(dest)) {
      ensureDir(path.dirname(dest));
      fs.copyFileSync(PROMPT_CONFIG_TEMPLATE, dest);
      console.log('[LunaConfig] prompt-config criado do template do repo (install novo)');
      return true;
    }
    const tplV = parseFloat(tpl._templateVersion || 0);
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(dest, 'utf8')); } catch { return false; }
    const curV = parseFloat(cur._templateVersion || 0);
    if (tplV > curV) {
      const bak = dest + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      try { fs.copyFileSync(dest, bak); } catch {}
      fs.copyFileSync(PROMPT_CONFIG_TEMPLATE, dest);
      console.log('[LunaConfig] prompt-config sincronizado: v' + curV + ' -> v' + tplV + ' (backup: ' + path.basename(bak) + ')');
    }
    return true;
  } catch (err) {
    console.warn('[LunaConfig] ensurePromptConfig: ' + err.message);
    return false;
  }
}
ensurePromptConfig();

// ── Kimi Bridge ──`;
  const count = src.split(ANCHOR).length - 1;
  if (count !== 1) { console.error('[FALHOU] ancora do luna-config.js: ' + count + 'x (esperado 1)'); process.exit(1); }
  fs.writeFileSync(CFG, src.replace(ANCHOR, BOOTSTRAP));
  console.log('[OK] luna-config.js: bootstrap ensurePromptConfig() instalado');
}

// ── 2. template do repo: _templateVersion ──
const tpl = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
if (String(tpl._templateVersion) === VERSION) {
  console.log('[SKIP] template ja em v' + VERSION);
} else {
  fs.copyFileSync(TEMPLATE, TEMPLATE + '.bak-' + ts);
  tpl._templateVersion = VERSION;
  fs.writeFileSync(TEMPLATE, JSON.stringify(tpl, null, 2));
  console.log('[OK] template marcado como v' + VERSION);
}

// ── 3. runtime: sync imediato (ou deixa pro boot) ──
if (fs.existsSync(RUNTIME)) {
  const cur = JSON.parse(fs.readFileSync(RUNTIME, 'utf8'));
  if (String(cur._templateVersion) !== VERSION) {
    fs.copyFileSync(RUNTIME, RUNTIME + '.bak-' + ts);
    cur._templateVersion = VERSION;
    fs.writeFileSync(RUNTIME, JSON.stringify(cur, null, 2));
    console.log('[OK] runtime marcado como v' + VERSION + ' (backup automático)');
  } else {
    console.log('[SKIP] runtime ja em v' + VERSION);
  }
} else {
  console.log('[INFO] runtime nao existe — o bootstrap vai criar no proximo boot');
}

try {
  execSync('pm2 restart luna-kernel', { encoding: 'utf8' });
  console.log('[OK] luna-kernel reiniciado (bootstrap executado no boot)');
} catch { console.log('⚠ pm2 restart falhou — roda manual'); }

console.log('');
console.log('✅ BOOTSTRAP NO AR. Fluxo de instalacao em PC novo:');
console.log('   git clone → npm i → pm2 start → luna-config.js roda ensurePromptConfig()');
console.log('   → config nasce copiado do template do repo. Zero manual.');
console.log('   Daqui em diante: pra atualizar o prompt de todo mundo, soh commita');
console.log('   o template com _templateVersion maior — cada PC synca sozinho no boot.');
console.log('');
console.log('Backups: *.bak-' + ts);
