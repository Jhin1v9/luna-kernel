#!/usr/bin/env node
/**
 * commit-push-luna.js — commit + push dos dois repos da Luna.
 * Uso:  node commit-push-luna.js
 *
 * - Idempotente: repo limpo = pula (diz "nada a commitar")
 * - Protege .env*: se algum entrar no stage, tira do stage e avisa
 * - Falha avisando, nunca quebra nada
 */
const { execSync, execFileSync } = require('child_process');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE;
const REPOS = [
  { name: 'luna-kernel', dir: path.join(HOME, 'Documents', 'luna-kernel') },
  { name: 'luna-agent',  dir: path.join(HOME, 'Documents', 'Luna cto', 'luna-agent') },
];
const BRANCH_FALLBACK = 'main';

const run = (cmd, cwd, allowFail = false) => {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`FALHOU: ${cmd}\n${(e.stderr || e.message || '').slice(0, 600)}`);
  }
};
const say = (ok, msg) => console.log(`${ok ? '[OK]' : '[FAIL]'} ${msg}`);

let falhouAlgum = false;

for (const repo of REPOS) {
  console.log(`\n=== ${repo.name} ===`);
  // 1) eh repo git?
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repo.dir, stdio: 'ignore' });
  } catch {
    say(false, `${repo.dir} nao eh repo git — pulando`);
    falhouAlgum = true;
    continue;
  }

  // 2) branch atual + upstream
  const branch = run('git rev-parse --abbrev-ref HEAD', repo.dir);
  const upstream = run('git rev-parse --abbrev-ref --symbolic-full-name @{u}', repo.dir, true);
  console.log(`branch: ${branch} | upstream: ${upstream || '(nenhum — vou definir)'}`);

  // 3) tem mudanca?
  const status = run('git status --porcelain', repo.dir);
  if (!status) {
    console.log('limpo — nada a commitar');
  } else {
    const n = status.split('\n').length;
    console.log(`${n} arquivo(s) modificado(s)/novo(s)`);
    run('git add -A', repo.dir);

    // 3a) protege .env* (nunca sobe segredo pro remoto)
    const stagedEnv = run('git diff --cached --name-only', repo.dir)
      .split('\n').filter(f => /(^|\/)\.env(\.|$)|\.env\./i.test(f));
    if (stagedEnv.length) {
      for (const f of stagedEnv) run(`git restore --staged "${f.replace(/"/g, '')}"`, repo.dir, true);
      console.log(`AVISO: tirado do stage (segredo, nao sobe): ${stagedEnv.join(', ')}`);
    }

    const restante = run('git diff --cached --name-only', repo.dir);
    if (!restante) {
      console.log('so tinha .env* — commit desnecessario');
    } else {
      const data = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const msg = `chore: estado local pos-fixes ${data} — see chat for details`;
      run(`git commit -m "${msg}"`, repo.dir);
      console.log('commit criado');
    }
  }

  // 4) push (com upstream ou definindo)
  const ahead = run('git rev-list --count @{u}..HEAD', repo.dir, true);
  const local = run('git rev-parse HEAD', repo.dir);
  const remote = run(`git rev-parse origin/${branch}`, repo.dir, true);
  if (local === remote) {
    console.log('ja sincronizado com origin');
  } else {
    try {
      if (upstream) {
        run('git push', repo.dir);
      } else {
        run(`git push -u origin ${branch}`, repo.dir);
      }
      console.log(`push feito (${ahead || '?'} commit(s) novos)`);
    } catch (e) {
      say(false, `push falhou no ${repo.name}: ${String(e.message).slice(0, 300)}`);
      console.log('tente manualmente: cd "' + repo.dir + '" && git pull --rebase && git push');
      falhouAlgum = true;
      continue;
    }
  }

  // 5) confirma sincronia
  const headLocal = run('git rev-parse HEAD', repo.dir);
  const headRemote = run(`git ls-remote origin ${branch}`, repo.dir, true);
  const ok = headRemote && headRemote.startsWith(headLocal);
  say(ok, `sincronia: ${ok ? 'HEAD == origin/' + branch : 'DIVERGIU — confira'}`);
  if (!ok) falhouAlgum = true;
}

console.log(`\n=== FIM: ${falhouAlgum ? 'algo falhou — leia acima' : 'tudo commitado e pushado'} ===`);
process.exit(falhouAlgum ? 1 : 0);
