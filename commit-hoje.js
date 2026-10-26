#!/usr/bin/env node
/* commit-hoje.js — commit+push de 26/10 com mensagem descritiva real.
 * Protege .env*, valida sincronia. Uso: node commit-hoje.js */
const { execSync, execFileSync } = require('child_process');
const path = require('path');
const HOME = process.env.HOME || process.env.USERPROFILE;

const MSG_KERNEL = `feat: entrega honesta + whatsappClearQueue + extensao MV3 heartbeat (26/10)

- v16.43 whatsappSendMessage: confirma entrega real no banco (poll 60s) —
  fim do status=ok falso; mensagem anti-reenvio quando ainda na fila
- v16.50b whatsappClearQueue: lista / modo:"uma" / modo:"chat" / modo:"todas" —
  resposta sempre mostra id + chat + previa do apagado
- v16.48+50b tool-catalog: whatsappClearQueue registrada pro Kimi
- extensao v13.0 heartbeat Port: content script pinga o SW a cada 15s =>
  extensao viva enquanto a pagina vive (contrato owner); alarme de 30s
  removido (era corrida com a morte do SW no MV3)`;

const MSG_AGENT = `fix: grupo nao entregava — slug nao reconhecido + busca DOM stale (26/10)

- v16.46 registryAllows reescrita clean-room: patches acumuladas quebravam a
  SQL (comentario JS dentro da string + parentese em aberto); catch agora
  loga o erro real em vez de recusar em silencio
- v16.51 openChat: WA 2026-09 renderiza resultados de busca FORA do
  #pane-side; deteccao agora procura titulos visiveis na metade esquerda
  da tela (robusta a mudanca de DOM)
- v16.52 isGroupJid reconhece formato 'group:<slug>'; resolve canonical_name
  do registry antes do contact_name (fim do slug cru indo pro openChat)`;

const REPOS = [
  { name: 'luna-kernel', dir: path.join(HOME, 'Documents', 'luna-kernel'), msg: MSG_KERNEL },
  { name: 'luna-agent',  dir: path.join(HOME, 'Documents', 'Luna cto', 'luna-agent'), msg: MSG_AGENT },
];

const run = (cmd, cwd, allowFail = false) => {
  try { return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (e) { if (allowFail) return null; throw new Error(`FALHOU: ${cmd}\n${String(e.stderr || e.message).slice(0, 400)}`); }
};
let falhou = false;

for (const r of REPOS) {
  console.log(`\n=== ${r.name} ===`);
  try { execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: r.dir, stdio: 'ignore' }); }
  catch { console.log('[FAIL] nao eh repo git'); falhou = true; continue; }

  const branch = run('git rev-parse --abbrev-ref HEAD', r.dir);
  const status = run('git status --porcelain', r.dir);
  if (!status) { console.log('limpo — nada a commitar'); }
  else {
    console.log(status.split('\n').length + ' arquivo(s) alterado(s)');
    run('git add -A', r.dir);
    const stagedEnv = run('git diff --cached --name-only', r.dir).split('\n').filter(f => /(^|\/)\.env(\.|$)|\.env\./i.test(f));
    if (stagedEnv.length) { for (const f of stagedEnv) run(`git restore --staged "${f}"`, r.dir, true); console.log('AVISO: .env* fora do stage: ' + stagedEnv.join(', ')); }
    const restante = run('git diff --cached --name-only', r.dir);
    if (!restante) console.log('so tinha .env* — commit desnecessario');
    else { run(`git commit -m "${r.msg.replace(/"/g, '\\"')}"`, r.dir); console.log('commit criado'); }
  }
  try {
    run('git push', r.dir);
    console.log('push OK');
  } catch (e) {
    console.log('[FAIL] push: ' + String(e.message).slice(0, 200));
    console.log('tente: cd "' + r.dir + '" && git pull --rebase && git push');
    falhou = true; continue;
  }
  const head = run('git rev-parse HEAD', r.dir);
  const remote = run(`git ls-remote origin ${branch}`, r.dir, true);
  const ok = remote && remote.startsWith(head);
  console.log((ok ? '[OK] ' : '[FAIL] ') + 'sincronia HEAD == origin/' + branch);
  if (!ok) falhou = true;
}
console.log(`\n=== FIM: ${falhou ? 'algo falhou — leia acima' : 'tudo commitado e pushado'} ===`);
process.exit(falhou ? 1 : 0);
