#!/usr/bin/env node
/**
 * fix-kill-healer.js — DECRETO OWNER 21/10 01:10: self-heal DESLIGADO
 * O auto-heal do worker (ADR-013) fazia rollback com 'git reset --hard' pro
 * LKG ao falhar — destruindo TRABALHO NAO COMMITADO do owner (aconteceu
 * ao vivo: comeu enum fix + patches). Medidas:
 * A) runHeal: kill-switch — so executa com HEAL_ENABLED=1 explicito
 *    (padrao: loga e retorna sem tocar em nada).
 * B) rollback LKG: 'git reset --hard' substituido por alerta — nunca mais
 *    destruicao automatica de worktree (revisao humana).
 * Ancoras de LINHA UNICA (CRLF-safe). Idempotente por marcador unico.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const AGENT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const HEAL = path.join(AGENT, 'apps', 'worker', 'src', 'selfheal', 'heal.ts');

function ok(m) { console.log('[OK] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); process.exit(1); }
function bak(f) {
  const b = f + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(f, b);
  return b;
}
function put(file, marker, anchor, addition, label) {
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(marker)) { ok('ja aplicado: ' + label); return; }
  const n = src.split(anchor).length - 1;
  if (n !== 1) fail(label + ': anchor ' + n + 'x');
  const out = src.replace(anchor, anchor + addition);
  const b = bak(file);
  fs.writeFileSync(file, out, 'utf8');
  ok(label + ' | backup: ' + path.basename(b));
}

(async function main() {
  put(HEAL, 'HEAL_ENABLED',
    '  const { pool, log, exec } = deps;',
    '\n' +
    '  // 2026-10-21 (decreto owner): self-heal DESLIGADO por padrao. O rollback' + '\n' +
    '  // git reset --hard destruia trabalho nao commitado do owner (incidentes' + '\n' +
    '  // ao vivo 20-21/10). So roda com HEAL_ENABLED=1 explicito no ambiente.' + '\n' +
    '  if (process.env.HEAL_ENABLED !== \'1\') {' + '\n' +
    "    log.warn({ service: input.service }, 'selfheal DESLIGADO (decreto owner 21/10 — rollback destrutivo. HEAL_ENABLED=1 pra reativar)');" + '\n' +
    '    return { healed: false, attempts: 0 };' + '\n' +
    '  }',
    'A: kill-switch no runHeal');

  put(HEAL, 'rollback pro LKG NAO executado',
    "      await exec('git', ['-C', root, 'reset', '--hard', lkg]).catch(() => {});",
    '\n' +
    '      // 2026-10-21 (decreto owner): rollback destrutivo DESATIVADO — nunca' + '\n' +
    '      // mais git reset --hard automatico. So alerta; worktree fica como' + '\n' +
    '      // esta pra revisao humana.' + '\n' +
    "      log.error({ service: input.service, lkg }, 'selfheal: rollback pro LKG NAO executado (decreto owner — revisao humana necessaria)');",
    'B: rollback git reset --hard desativado');

  for (const svc of ['luna-worker', 'luna-watchdog']) {
    spawn('cmd.exe', ['/c', 'pm2 start ' + svc], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    ok('start: ' + svc);
  }
  console.log('=== DEPOIS: pm2 list (worker/watchdog online) e NADA mais faz git reset sozinho ===');
  console.log('=== PROTECAO FINAL: node luna-commit-push.js (commitado = reset --hard nao pode comer) ===');
  console.log('=== FIM ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
