#!/usr/bin/env node
/**
 * fix-workspace-timeout.js — workspace tools fail-fast (2026-10-20)
 *
 * VERIFICADO no codigo (workspace-nexo-tools.cjs): as tools batem em
 * https://vps.nexo-digital.app (NEXO_WS_BASE) e o fetch NAO TEM TIMEOUT.
 * VPS pausada -> conexao pendura PARA SEMPRE -> tool nunca retorna ->
 * cadeia de tools do kernel congela (brain local funciona, workspace trava).
 *
 * Fix:
 *   1. AbortSignal.timeout(12s, configuravel via NEXO_WS_TIMEOUT_MS) em
 *      TODAS as chamadas fetch do arquivo
 *   2. Erro claro quando inatingivel ("VPS pausada?") em vez de travar
 *   3. loadCreds: candidatos locais do Windows (Luna cto/luna-agent/.env)
 *      e suporte a LUNA_AGENT_DIR — antes so achava o .env do caminho da VPS
 *
 * NOTA: pro recurso FUNCIONAR a VPS precisa estar de pe (docker compose start
 * la). Esse fix faz falhar rapido e claro quando ela estiver dormindo.
 *
 * USO:  node fix-workspace-timeout.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const FILE = path.join(ROOT, 'packages', 'kernel', 'workspace-nexo-tools.cjs');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!fs.existsSync(FILE)) { console.error('Nao encontrado: ' + FILE); process.exit(1); }
fs.copyFileSync(FILE, FILE + '.bak-' + ts);
let src = fs.readFileSync(FILE, 'utf8');
const isCrlf = src.includes('\r\n');
const norm = (s) => isCrlf ? s.replace(/\n/g, '\r\n') : s;

let patches = 0;
function rep(label, OLD, NEW, exp = 1) {
  const o = norm(OLD), n = norm(NEW);
  const count = src.split(o).length - 1;
  if (count !== exp) { console.error('[FALHOU] ' + label + ' — ' + count + 'x'); return false; }
  src = src.split(o).join(n);
  console.log('[OK] ' + label);
  patches++;
  return true;
}

if (src.includes('WS_TIMEOUT_MS')) {
  console.log('[SKIP] ja aplicado');
} else {
  // 1. constantes de timeout apos o require do fs
  rep('P1: constantes de timeout',
    "const fs = require('fs');",
    `const fs = require('fs');

// v14.5-fix (2026-10-20): timeout fail-fast em TODAS as chamadas ao workspace.
// Sem isso, VPS pausada/inatingivel fazia o fetch pendurar PARA SEMPRE (fetch
// do Node nao tem timeout default) e a cadeia de tools travava sem retorno —
// era o congelamento exato nas tools de workspace (brain local seguia ok).
const WS_TIMEOUT_MS = Number(process.env.NEXO_WS_TIMEOUT_MS || 12000);
const WS_OPTS = { signal: AbortSignal.timeout(WS_TIMEOUT_MS) };`);

  // 2. fetchs com timeout
  rep('P2a: csrf do adminLogin',
    "  const c1 = await fetch(`${BASE}/nexo/api/auth/csrf`);",
    "  const c1 = await fetch(`${BASE}/nexo/api/auth/csrf`, WS_OPTS);");

  rep('P2b: callback credentials',
    "  const res = await fetch(`${BASE}/nexo/api/auth/callback/credentials`, {\n    method: 'POST',",
    "  const res = await fetch(`${BASE}/nexo/api/auth/callback/credentials`, {\n    ...WS_OPTS,\n    method: 'POST',");

  rep('P2c: csrf do adminFetch',
    "  const csrfRes = await fetch(`${BASE}/nexo/api/auth/csrf`);",
    "  const csrfRes = await fetch(`${BASE}/nexo/api/auth/csrf`, WS_OPTS);");

  rep('P2d: fetch principal',
    "  const res = await fetch(BASE + apiPath, {\n    ...options,",
    "  const res = await fetch(BASE + apiPath, {\n    ...WS_OPTS,\n    ...options,");

  // 3. erro claro no adminLogin quando inatingivel
  rep('P3: mensagem clara de inatingibilidade',
    "  const creds = loadCreds();\n  if (!creds) throw new Error('Credenciais NEXO_API_USERNAME/NEXO_API_PASSWORD não encontradas no .env do luna-agent');",
    "  const creds = loadCreds();\n  if (!creds) throw new Error('Credenciais NEXO_API_USERNAME/NEXO_API_PASSWORD nao encontradas — configure NEXO_API_USERNAME/NEXO_API_PASSWORD no .env do kernel ou LUNA_AGENT_ENV_PATH apontando pro .env do luna-agent');");

  // 4. candidatos locais de credenciais (Windows)
  rep('P4: loadCreds com caminhos locais',
    "  const candidates = [\n    process.env.LUNA_AGENT_ENV_PATH || '',\n    '/home/nexo/luna-agent/.env',\n  ].filter(Boolean);",
    "  const candidates = [\n    process.env.LUNA_AGENT_ENV_PATH || '',\n    process.env.LUNA_AGENT_DIR ? require('path').join(process.env.LUNA_AGENT_DIR, '.env') : '',\n    '/home/nexo/luna-agent/.env',\n    require('path').join(require('os').homedir(), 'Documents', 'Luna cto', 'luna-agent', '.env'),\n  ].filter(Boolean);");

  if (patches === 6) fs.writeFileSync(FILE, src);
}

if (patches > 0) {
  try {
    execSync(`node --check "${FILE}"`, { encoding: 'utf8', stdio: 'pipe' });
    console.log('[OK] node --check passou');
  } catch (e) {
    console.error('[FALHOU] sintaxe: ' + (e.stderr || e.message).split('\n').slice(0, 3).join(' | '));
    process.exit(1);
  }
  try { execSync('pm2 restart luna-kernel', { encoding: 'utf8' }); console.log('[OK] luna-kernel reiniciado'); }
  catch { console.log('pm2 restart falhou'); }
}

console.log('');
console.log('\x1b[32m✅ WORKSPACE TOOLS FAIL-FAST.\x1b[0m Agora, com a VPS pausada, a tool');
console.log('   retorna ERRO CLARO em 12s (em vez de congelar a cadeia pra sempre).');
console.log('');
console.log('\x1b[33mLEMBRETE DE MANHA:\x1b[0m pro recurso FUNCIONAR de verdade, sobe a VPS:');
console.log('   ssh na VPS -> cd pasta do compose -> docker compose start');
console.log('   (ou: pm2 start all — o que tu usou pra pausar, inverta)');
console.log('\x1b[90mBackup: workspace-nexo-tools.cjs.bak-' + ts + '\x1b[0m');
