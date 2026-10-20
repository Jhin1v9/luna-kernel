#!/usr/bin/env node
/**
 * fix-luna-catalog-token.js — fim do "catalogo Luna Web indisponivel: Nao autorizado" (2026-10-20)
 *
 * Sintoma: orchestrator boota com "catalogo Luna Web indisponivel — so lunaweb.* ativas"
 * (401 ao buscar o catalogo de tools no kernel). A ponte de token que plantamos
 * antes pode ter: (a) valor divergente (painel reescreveu o .env do kernel),
 * (b) variavel ERRADA (o kernel valida com outro nome e LUNA_KERNEL_TOKEN no
 * .env dele nao eh lido por ninguem).
 *
 * O que faz:
 *   1. Greps o AGENT (codigo local) -> acha o fetch do catalogo: URL, header,
 *      variavel de env que ele usa
 *   2. Greps o KERNEL -> acha a rota do catalogo e QUAL env var ela valida
 *   3. Sincroniza: grava no .env do KERNEL a var que A ROTA DELE valida,
 *      com o valor do token do agent
 *   4. VERIFICA: curl real no catalog com o token — tem que voltar NAO-401
 *
 * USO:  node fix-luna-catalog-token.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const KERNEL_DIR = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const AGENT_DIR = path.join(os.homedir(), 'Documents', 'Luna cto', 'luna-agent');
const KERNEL_ENV = path.join(KERNEL_DIR, '.env');
const AGENT_ENV = path.join(AGENT_DIR, '.env');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function grep(dir, pattern, globs) {
  try {
    return execSync(
      `grep -rn ${pattern} ${dir} ${globs} 2>/dev/null | grep -v node_modules | head -15`,
      { encoding: 'utf8', shell: 'bash' }
    ).trim();
  } catch { return ''; }
}
function envVal(envFile, key) {
  try {
    const m = fs.readFileSync(envFile, 'utf8').match(new RegExp('^' + key + '=(.+)$', 'm'));
    return m ? m[1].trim() : null;
  } catch { return null; }
}
function setEnv(envFile, key, val) {
  let c = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const re = new RegExp('^' + key + '=.*$', 'm');
  if (re.test(c)) c = c.replace(re, key + '=' + val);
  else c += '\n# fix-luna-catalog-token ' + ts + '\n' + key + '=' + val + '\n';
  fs.writeFileSync(envFile, c);
}

console.log('\x1b[36m=== 1/4 — lado AGENT: como ele chama o catalogo ===\x1b[0m');
const agentGrep = grep(AGENT_DIR, '-iE "luna.?web.?catalog|LUNA_KERNEL_TOKEN"', '--include=*.ts --include=*.js -r');
console.log(agentGrep || '(nada achado)');
// URL que o agent chama
let catalogUrl = null;
const urlM = agentGrep.match(/(['"`])(\/api\/[a-z0-9\-\/]*catalog[a-z0-9\-\/]*)\1/i) || agentGrep.match(/localhost:3458(\/[^'"`\s)]+)/i);
if (urlM) catalogUrl = urlM[2] || urlM[1];

console.log('\n\x1b[36m=== 2/4 — lado KERNEL: rota do catalogo + auth ===\x1b[0m');
const serverFile = path.join(KERNEL_DIR, 'apps', 'dashboard', 'luna-server.js');
const handlerFile = path.join(KERNEL_DIR, 'apps', 'dashboard', 'luna-extension-handler.cjs');
let kernelAuth = '';
for (const f of [serverFile, handlerFile]) {
  try {
    const c = fs.readFileSync(f, 'utf8');
    const lines = c.split('\n');
    lines.forEach((l, i) => {
      if (/catalog/i.test(l)) kernelAuth += f.split('\\').pop() + ':' + (i + 1) + ' | ' + l.trim().slice(0, 120) + '\n';
    });
  } catch {}
}
console.log(kernelAuth || '(nenhuma mencao a catalog no server/handler)');

// qual var o KERNEL valida perto de catalog/auth (heuristica: process.env.X na mesma regiao)
let kernelVar = null;
try {
  const c = fs.readFileSync(serverFile, 'utf8');
  const m = c.match(/catalog[\s\S]{0,600}?process\.env\.([A-Z_]+)/i) || c.match(/process\.env\.([A-Z_]+)[\s\S]{0,600}?catalog/i);
  if (m) kernelVar = m[1];
} catch {}
const agentToken = envVal(AGENT_ENV, 'LUNA_KERNEL_TOKEN');
const kernelTokenSame = envVal(KERNEL_ENV, 'LUNA_KERNEL_TOKEN');
console.log('\n  var que o KERNEL parece validar: ' + (kernelVar || '(nao identificada)'));
console.log('  token do AGENT (LUNA_KERNEL_TOKEN): ' + (agentToken ? agentToken.slice(0, 14) + '...' : 'AUSENTE'));
console.log('  token no .env do KERNEL: ' + (kernelTokenSame ? (kernelTokenSame === agentToken ? 'IDENTICO' : 'DIFERENTE!') : 'ausente'));

console.log('\n\x1b[36m=== 3/4 — sincronizando ===\x1b[0m');
if (!agentToken) {
  console.error('  [FALHOU] agent nao tem LUNA_KERNEL_TOKEN no .env');
  process.exit(1);
}
fs.copyFileSync(KERNEL_ENV, KERNEL_ENV + '.bak-' + ts);
if (kernelVar && kernelVar !== 'LUNA_KERNEL_TOKEN') {
  setEnv(KERNEL_ENV, kernelVar, agentToken);
  console.log('  [OK] KERNEL .env: ' + kernelVar + ' = <token do agent> (a rota valida essa var, nao LUNA_KERNEL_TOKEN)');
}
setEnv(KERNEL_ENV, 'LUNA_KERNEL_TOKEN', agentToken);
console.log('  [OK] KERNEL .env: LUNA_KERNEL_TOKEN garantido identico ao agent');

try { execSync('pm2 restart luna-kernel', { encoding: 'utf8' }); console.log('  [OK] luna-kernel reiniciado'); }
catch { console.log('  pm2 restart falhou'); }

console.log('\n\x1b[36m=== 4/4 — VERIFICACAO REAL (curl no catalog) ===\x1b[0m');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  await sleep(9000);
  const paths = [catalogUrl, '/api/luna-web/catalog', '/ext/catalog', '/api/tools/catalog'].filter(Boolean);
  let ok = false;
  for (const p of paths) {
    try {
      const out = execSync(
        `curl -s -m 8 -o NUL -w "%{http_code}" -H "Authorization: Bearer ${agentToken}" http://localhost:3458${p}`,
        { encoding: 'utf8', shell: 'cmd.exe' }
      ).trim();
      console.log('  ' + p + ' -> HTTP ' + out);
      if (out !== '401' && out !== '000') { ok = true; }
    } catch (e) {
      console.log('  ' + p + ' -> erro: ' + String(e.message).split('\n')[0].slice(0, 60));
    }
  }
  console.log('');
  if (ok) {
    console.log('\x1b[32m✅ CATALOG ACESSIVEL — token validado com HTTP real. Reinicia o orchestrator:\x1b[0m');
    console.log('   pm2 restart luna-orchestrator');
    console.log('   (o boot dele deve vir SEM o warn "catalogo indisponivel")');
  } else {
    console.log('\x1b[33m⚠ Catalog ainda 401 em todos os paths tentados. Me manda a saida — ajusto com o path exato.\x1b[0m');
  }
  console.log('\x1b[90mBackup: .env.bak-' + ts + '\x1b[0m');
})();
