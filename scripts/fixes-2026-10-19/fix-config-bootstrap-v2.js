#!/usr/bin/env node
/**
 * fix-config-bootstrap-v2.js — mesma missao da v1, com brace-matching (2026-10-19)
 * A v1 procurou uma ancora de texto que o arquivo local nao tem (divergencia
 * de formatacao). Essa v2 acha "const PATHS = {" por indexOf e casa as chaves.
 *
 * USO:  node fix-config-bootstrap-v2.js
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

// ── 1. luna-config.js: bootstrap via brace-matching ──
let src = fs.readFileSync(CFG, 'utf8');
if (src.includes('ensurePromptConfig')) {
  console.log('[SKIP] bootstrap ja presente');
} else {
  fs.copyFileSync(CFG, CFG + '.bak-' + ts);
  const ANCHOR = 'const PATHS = {';
  const idx = src.indexOf(ANCHOR);
  if (idx === -1) { console.error('[FALHOU] "const PATHS = {" nao encontrado no luna-config.js. Me manda o trecho do PATHS.'); process.exit(1); }

  // brace matching: acha o fim do objeto PATHS
  let i = src.indexOf('{', idx);
  let depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) { console.error('[FALHOU] chaves do PATHS desbalanceadas'); process.exit(1); }
  end++; // pula o }
  if (src[end] === ';') end++;

  const BOOTSTRAP = `

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
      const dir = path.dirname(dest);
      try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {}
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
ensurePromptConfig();`;

  src = src.slice(0, end) + BOOTSTRAP + src.slice(end);
  fs.writeFileSync(CFG, src);
  console.log('[OK] luna-config.js: bootstrap ensurePromptConfig() instalado (apos PATHS)');
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

// ── 3. runtime: marca versao (com backup) ──
if (fs.existsSync(RUNTIME)) {
  const cur = JSON.parse(fs.readFileSync(RUNTIME, 'utf8'));
  if (String(cur._templateVersion) !== VERSION) {
    fs.copyFileSync(RUNTIME, RUNTIME + '.bak-' + ts);
    cur._templateVersion = VERSION;
    fs.writeFileSync(RUNTIME, JSON.stringify(cur, null, 2));
    console.log('[OK] runtime marcado como v' + VERSION + ' (backup datado)');
  } else {
    console.log('[SKIP] runtime ja em v' + VERSION);
  }
} else {
  console.log('[INFO] runtime nao existe — o bootstrap cria no proximo boot');
}

try {
  execSync('pm2 restart luna-kernel', { encoding: 'utf8' });
  console.log('[OK] luna-kernel reiniciado');
} catch { console.log('⚠ pm2 restart falhou — roda manual'); }

console.log('');
console.log('✅ BOOTSTRAP v2 NO AR. Repo manda, PCs obedecem. Backups: *.bak-' + ts);
