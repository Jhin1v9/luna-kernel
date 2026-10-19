#!/usr/bin/env node
/**
 * pre-commit-audit.js — auditoria completa antes do commit v15.7 (2026-10-19)
 *
 * Verifica TODOS os patches da sessao, lista artefatos sujos e mostra o
 * estado do git. Cola o output inteiro pro Kimi que ele te libera o commit.
 *
 * USO:  node pre-commit-audit.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';

let pass = 0, fail = 0, warn = 0;
function check(label, ok, detail) {
  if (ok === true)  { pass++; console.log('  \x1b[32m[OK]\x1b[0m   ' + label + (detail ? ' — ' + detail : '')); }
  else if (ok === 'warn') { warn++; console.log('  \x1b[33m[AVISO]\x1b[0m ' + label + (detail ? ' — ' + detail : '')); }
  else { fail++; console.log('  \x1b[31m[FALTA]\x1b[0m ' + label + (detail ? ' — ' + detail : '')); }
}
function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8'); }
  catch { return null; }
}
function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', cwd: ROOT }).trim(); }
  catch (e) { return '(erro: ' + (e.message || '').split('\n')[0].slice(0, 80) + ')'; }
}

console.log('\x1b[36m╔══════════════════════════════════════════╗');
console.log('║  PRE-COMMIT AUDIT — luna-kernel v15.7    ║');
console.log('╚══════════════════════════════════════════╝\x1b[0m');

// ═══════════ 1. PATCHES NA SOUL ═══════════
console.log('\n\x1b[36m── 1. SOUL (luna-soul.cjs) ──\x1b[0m');
const soul = read('packages/kernel/luna-soul.cjs');
if (soul === null) check('soul existe', false);
else {
  check('K3a circuit breaker removido', soul.includes('decreto owner: sem breaker'));
  check('K3b toolLoop CDP sem historico', soul.includes('isToolResult && !isStatelessApi'));
  check('K3c nao cancela stream c/ tools', soul.includes('STREAM_CANCEL_SKIPPED'));
  check('K3d v2ResponseComplete guard', soul.includes('v2ResponseComplete && domActionResults.length === 0'));
  check('R1 miniReminder JSON puro', soul.includes('EXCLUSIVAMENTE este formato'));
  check('R2 [FORMAT] JSON puro', soul.includes('[FORMAT — JSON PURO'));
  check('R3 templates JSON puro', !soul.includes('OU o bloco equivalente [[response]]'));
  check('R4 reparo sem XML', !soul.includes('<luna_tool_call>'));
  check('S1 helper entrega acoplada', soul.includes('ENTREGA ACOPLADA') && soul.includes('_sendToolResultViaExtension'));
  check('S2 ganchos (skipBridgeSubmit)', (soul.match(/__skipBridgeSubmit/g) || []).length >= 3, (soul.match(/__skipBridgeSubmit/g) || []).length + ' refs');
  check('S3 skipSubmit no stream', soul.includes('skipSubmit: _skipSubmitOnce'));
  check('ID unico por resultado', soul.includes("'tr-' + Date.now()"));
}

// ═══════════ 2. BRIDGE ═══════════
console.log('\n\x1b[36m── 2. BRIDGE (kimi-bridge.cjs) ──\x1b[0m');
const bridge = read('packages/kernel/kimi-bridge.cjs');
if (bridge === null) check('bridge existe', false);
else {
  check('K3e drain 10s', bridge.includes('PROCESSING_DRAIN_TIMEOUT_MS = 10_000'));
  check('B1 skipSubmit gate', bridge.includes("options.skipSubmit"));
}

// ═══════════ 3. EXTENSAO ═══════════
console.log('\n\x1b[36m── 3. EXTENSAO ──\x1b[0m');
const content = read('packages/kernel/luna-extension/content.js');
if (content === null) check('content.js existe', false);
else {
  check('K1a stopForwarding recuperavel', content.includes('scheduleRecoveryCheck'));
  check('K1 fallback HTTP direto', content.includes('directFallbackFlush'));
  check('Poll direto 2s', content.includes('setInterval(directPoll, 2000)'));
  check('LNA targetAddressSpace', content.includes("targetAddressSpace: 'local'"));
  check('Dedup por ID', content.includes("'id:' + p.id"));
  check('injectToolResult', content.includes('injectToolResult'));
}
const bg = read('packages/kernel/luna-extension/background.js');
if (bg === null) check('background.js existe', false);
else {
  check('K2a polling 3s real', bg.includes('setInterval(pollServer, 3000)'));
  check('K2b drop sem tabId loga', bg.includes('SEM tabId'));
}

// ═══════════ 4. SERVER + HANDLER ═══════════
console.log('\n\x1b[36m── 4. SERVER + HANDLER ──\x1b[0m');
const server = read('apps/dashboard/luna-server.js');
if (server === null) check('luna-server.js existe', false);
else {
  check('K4a exit(1) uncaught', server.includes('process.exit(1)') || server.includes('process.exit( 1 )'));
  check('K4b server.on(error) EADDRINUSE', server.includes("err.code === 'EADDRINUSE'"));
}
const handler = read('apps/dashboard/luna-extension-handler.cjs');
if (handler === null) check('handler existe', false);
else {
  check('CORS /ext/*', handler.includes('Access-Control-Allow-Origin'));
}

// ═══════════ 5. PROMPTS ═══════════
console.log('\n\x1b[36m── 5. PROMPTS ──\x1b[0m');
const mp = read('packages/kernel/LUNA_MASTER_PROMPT.md');
if (mp === null) check('LUNA_MASTER_PROMPT.md existe', false);
else {
  check('Master prompt v7.3', mp.includes('v7.3') && mp.includes('JSON PURO'));
  check('v7.3 sem ensino de [[action]]', !mp.includes('[[action]]') || mp.split('[[action]]').length - 1 <= 4, (mp.split('[[action]]').length - 1) + ' mencoes (esperado <=4, todas negativas)');
}
const tpl = read('packages/kernel/config/luna-prompt-config.json');
if (tpl === null) check('template config existe', false);
else {
  check('Template sem [[action]]', !tpl.includes('[['), (tpl.split('[[').length - 1) + ' restantes');
  check('Template toolLoop minimal', tpl.includes('NÃO SABE QUAL TOOL USAR'));
  check('Template _templateVersion', tpl.includes('_templateVersion'));
}
const rt = (() => { try { return fs.readFileSync(path.join(os.homedir(), '.luna', 'kernel', 'config', 'luna-prompt-config.json'), 'utf8'); } catch { return null; } })();
if (rt === null) check('runtime config existe', false, 'bootstrap vai criar no boot');
else {
  check('Runtime sem [[action]]', !rt.includes('[['), (rt.split('[[').length - 1) + ' restantes');
  check('Runtime toolLoop minimal', rt.includes('NÃO SABE QUAL TOOL USAR'));
  check('Runtime _templateVersion', rt.includes('_templateVersion'));
}

// ═══════════ 6. BOOTSTRAP ═══════════
console.log('\n\x1b[36m── 6. BOOTSTRAP DE CONFIG ──\x1b[0m');
const cfgjs = read('packages/kernel/config/luna-config.js');
if (cfgjs === null) check('luna-config.js existe', false);
else check('ensurePromptConfig() instalado', cfgjs.includes('ensurePromptConfig'));

// ═══════════ 7. HIGIENE DO REPO ═══════════
console.log('\n\x1b[36m── 7. HIGIENE (artefatos pra limpar antes do commit) ──\x1b[0m');
const bakFiles = sh('git ls-files --others --exclude-standard | grep -c "\\\\.bak-" || true');
check('Sem .bak novos no git', bakFiles === '0', bakFiles + ' arquivos .bak');
const fixRoot = sh('ls fix-*.js luna-scan*.js 2>/dev/null | wc -l');
check('Scripts de fix fora da raiz', fixRoot === '0', fixRoot + ' ainda na raiz');
const teste = sh('ls teste-multi.txt backup-teste 2>/dev/null | wc -l');
check('Artefatos de teste removidos', teste === '0', teste + ' restantes');
const gi = read('.gitignore');
if (gi) check('.gitignore tem *.bak-*', gi.includes('*.bak-*'));
else check('.gitignore existe', false);

// ═══════════ 8. GIT STATUS ═══════════
console.log('\n\x1b[36m── 8. GIT (o que vai pro commit) ──\x1b[0m');
console.log(sh('git status --short | head -30'));
console.log('\nDiff stats:');
console.log(sh('git diff --stat | tail -15'));

// ═══════════ 9. RUNTIME ═══════════
console.log('\n\x1b[36m── 9. RUNTIME ──\x1b[0m');
console.log(sh('pm2 list | grep -E "luna-kernel|name" | head -3'));
console.log(sh('netstat -ano | findstr :3458 | findstr LISTENING'));

// ═══════════ RESUMO ═══════════
console.log('\n\x1b[36m══════════════════════════════════════════\x1b[0m');
console.log('\x1b[32m  PASS: ' + pass + '\x1b[0m  |  \x1b[33mAVISOS: ' + warn + '\x1b[0m  |  \x1b[31mFALTANDO: ' + fail + '\x1b[0m');
if (fail === 0) console.log('\n  ✅ LIBERADO pra commit (avisos sao so informativos)');
else console.log('\n  ⚠ Resolve os [FALTA] antes de commitar (ou me manda o output)');
console.log('');
