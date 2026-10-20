#!/usr/bin/env node
/**
 * luna-commit-push.js — commit + push seguro dos dois repos (owner 20/10)
 * v2: git chamado DIRETO (sem cmd.exe) — elimina problema de quoting.
 * Seguranca: .env nunca sobe (tira do indice se rastreado; aborta se aparecer
 * no stage), .gitignore ganha .env + *.bak-*, sem force, sem commit vazio.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPOS = [
  {
    dir: 'C:\\Users\\Abner\\Documents\\luna-kernel',
    msg: 'fix(chat-routes): sanitizador plain Copy/JSON Copy na persistencia (luna-fix-plain-copy, todas as copias do dashboard)',
  },
  {
    dir: 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent',
    msg: 'fix(work+delivery): sweeper so evento done (v16.1), batch por autor + lock global (v16.2), cadeia de entrega 1-por-vez (v16.3), diagnostico silencioso (v16.4), enum kimi-web-local no config',
  },
];

function git(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}
function ok(m) { console.log('[OK] ' + m); }
function warn(m) { console.log('[AVISO] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); }

for (const repo of REPOS) {
  console.log('');
  console.log('===== ' + repo.dir + ' =====');
  try {
    git(['rev-parse', '--is-inside-work-tree'], repo.dir);
  } catch (e) {
    fail('nao eh um repo git — pulado');
    continue;
  }

  // 1) .env rastreado? tira do indice (fica no disco)
  try {
    const tracked = git(['ls-files', '.env'], repo.dir);
    if (tracked) {
      git(['rm', '--cached', '.env'], repo.dir);
      warn('.env estava RASTREADO — removido do indice (arquivo continua no disco).');
    }
  } catch (e) { /* ok */ }

  // 2) gitignore
  const giPath = path.join(repo.dir, '.gitignore');
  let gi = '';
  try { gi = fs.readFileSync(giPath, 'utf8'); } catch (e) { gi = ''; }
  let changed = false;
  if (!/(^|\n)\.env(\n|$)/.test(gi)) { gi += (gi.endsWith('\n') || gi === '' ? '' : '\n') + '.env\n'; changed = true; }
  if (!/(^|\n)\*\.bak-\*(\n|$)/.test(gi)) { gi += '*.bak-*\n'; changed = true; }
  if (changed) { fs.writeFileSync(giPath, gi); ok('.gitignore atualizado (.env + *.bak-*)'); }

  // 3) stage
  git(['add', '-A'], repo.dir);

  // 4) GUARDA: .env no stage = aborta
  const staged = git(['diff', '--cached', '--name-only'], repo.dir);
  const envStaged = staged.split(/\r?\n/).filter((f) => /(^|\/|\\)\.env$/.test(f.trim()));
  if (envStaged.length) {
    git(['reset'], repo.dir);
    fail('ABORTADO: .env no stage (' + envStaged.join(', ') + '). git reset feito. Resolva manual e rode de novo.');
    continue;
  }

  // 5) commit
  if (!staged) {
    ok('nada para commitar — limpo');
  } else {
    const count = staged.split(/\r?\n/).filter(Boolean).length;
    git(['commit', '-m', repo.msg], repo.dir);
    ok('commit criado (' + count + ' arquivo(s))');
  }

  // 6) push
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo.dir);
  try {
    git(['push', 'origin', branch], repo.dir);
    ok('push: origin/' + branch);
  } catch (e) {
    try {
      git(['push', '-u', 'origin', branch], repo.dir);
      ok('push (upstream setado): origin/' + branch);
    } catch (e2) {
      const err = ((e2.stderr || '') + (e2.message || '')).toString().replace(/\s+/g, ' ').slice(0, 300);
      fail('push falou — rode: git push origin ' + branch + ' | ' + err);
    }
  }
}
console.log('');
console.log('=== FIM ===');
