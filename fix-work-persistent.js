#!/usr/bin/env node
/**
 * fix-work-persistent.js — v16.5 (decreto owner 20/10)
 *
 * A) luna-soul.cjs — isStatelessApi: provider 'roda' com ponte CDP (KimiBridge)
 *    estava sendo classificado como stateless pela checagem de NOME. Resultado:
 *    reidratação gigante a CADA tool result (prompt inteiro + TOOL INDEX),
 *    reenvio de lixo pro provider e re-execução de tools (double-send).
 *    Correcao: 'roda' sai da checagem de nome — o ground truth vira a ponte
 *    (canSteer()===false pega APIs puras; KimiBridge CDP segura a thread).
 *    Efeito: tool result vira so o resultado + footer pequeno (💡 suas tools),
 *    prompt cheio so na 1a msg / msg nova do usuario. MESMO sistema do kernel.
 * B) luna-prompt-config.json — [AMBIENTE] mentia "voce esta DENTRO da VPS Linux"
 *    sendo que o host real é Windows (Git Bash). Corrigido p/ host real com
 *    VPS remota marcada como remota.
 * C) restart pm2 (luna-kernel + luna-kimiweb).
 * Seguro: backup, node --check / JSON.parse antes de aplicar, idempotente.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DOCS = 'C:\\Users\\Abner\\Documents';
function ok(m) { console.log('[OK] ' + m); }
function warn(m) { console.log('[AVISO] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); }
function bak(f) {
  const b = f + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(f, b);
  return b;
}
function* walk(dir, depth) {
  if (depth > 6) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (['node_modules', '.git', '.next', 'coverage'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, depth + 1);
    else if (e.name === 'luna-soul.cjs' || e.name === 'luna-prompt-config.json') yield full;
  }
}

(async function main() {
  let souls = 0, cfgs = 0;
  for (const file of walk(DOCS, 0)) {
    try {
      /* ---------- A) luna-soul.cjs ---------- */
      if (file.endsWith('luna-soul.cjs')) {
        const src = fs.readFileSync(file, 'utf8');
        if (src.includes('v16.5-fix')) { ok('A ja aplicado: ' + file); souls++; continue; }
        const oldBlock = 'const isStatelessApi =' + (src.includes('\r\n') ? '\r\n' : '\n') +
          "        (typeof _bridge?.canSteer === 'function' && _bridge.canSteer() === false) ||" + (src.includes('\r\n') ? '\r\n' : '\n') +
          "        (Boolean(options.provider) && options.provider !== 'kimi');";
        if (src.split(oldBlock).length - 1 !== 1) { warn('A anchor nao bate 1x: ' + file); continue; }
        const nl = src.includes('\r\n') ? '\r\n' : '\n';
        const newBlock = 'const isStatelessApi =' + nl +
          "        (typeof _bridge?.canSteer === 'function' && _bridge.canSteer() === false) ||" + nl +
          "        (Boolean(options.provider) && options.provider !== 'kimi' && options.provider !== 'roda'); // v16.5-fix (owner 20/10): roda com ponte CDP segura a thread — reidratar reexecutava tools e lotava o provider";
        const patched = src.replace(oldBlock, newBlock);
        const tmp = file + '.checktmp.js';
        fs.writeFileSync(tmp, patched, 'utf8');
        try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
        catch { fs.unlinkSync(tmp); warn('A sintaxe invalida — pulado: ' + file); continue; }
        fs.unlinkSync(tmp);
        const b = bak(file);
        fs.writeFileSync(file, patched, 'utf8');
        ok('A aplicado (roda/CDP = persistente): ' + file);
        ok('   backup: ' + path.basename(b));
        souls++;
      }
      /* ---------- B) luna-prompt-config.json ---------- */
      if (file.endsWith('luna-prompt-config.json')) {
        let src = fs.readFileSync(file, 'utf8');
        if (src.includes('HOST REAL desta máquina')) { ok('B ja aplicado: ' + file); cfgs++; continue; }
        const pairs = [
          ['[AMBIENTE — VOCÊ ESTÁ DENTRO DA VPS 🖥️]', '[AMBIENTE — HOST REAL 🖥️]'],
          ['Você roda DENTRO da VPS da Nexo Digital (Linux, usuário nexo). Home: /home/nexo.',
           'HOST REAL desta máquina: Windows (Git Bash, paths com /). Projetos locais em C:/Users/Abner/Documents. A VPS Linux da Nexo (usuário nexo, /home/nexo) é REMOTA — não é este host.'],
          ['- Projetos: /home/nexo/luna-kernel (dashboard + kernel + Luna Web), /home/nexo/luna-agent (orchestrator + whatsplay), /opt/nexo-brain (brain da empresa).',
           '- Projetos: C:/Users/Abner/Documents/luna-kernel (dashboard + kernel + Luna Web), C:/Users/Abner/Documents/Luna cto/luna-agent (orchestrator + whatsplay), brain da empresa na VPS remota (/opt/nexo-brain).'],
          ['explorar qualquer pasta (/home/nexo, /opt/nexo-brain, /etc, onde for)',
           'explorar qualquer pasta (local: C:/Users/Abner; /home/nexo e /opt/nexo-brain só existem na VPS remota)'],
        ];
        let changed = false;
        for (const [o, n] of pairs) {
          if (src.includes(o)) { src = src.split(o).join(n); changed = true; }
          else warn('B substring nao achada: ' + o.slice(0, 40) + '... em ' + path.basename(path.dirname(file)) + '/' + path.basename(file));
        }
        if (!changed) { warn('B nada alterado: ' + file); continue; }
        try { JSON.parse(src); } catch { warn('B JSON invalido apos patch — pulado: ' + file); continue; }
        const b = bak(file);
        fs.writeFileSync(file, src, 'utf8');
        ok('B aplicado (ambiente = host real Windows): ' + file);
        ok('   backup: ' + path.basename(b));
        cfgs++;
      }
    } catch (e) { warn('erro em ' + file + ': ' + e.message); }
  }
  if (!souls) fail('nenhum luna-soul.cjs patchiado — verifique os caminhos');
  if (!cfgs) warn('nenhum luna-prompt-config.json alterado');

  console.log('');
  console.log('=== restart ===');
  const run = (c) => { try { execFileSync('cmd.exe', ['/c', c], { stdio: 'pipe' }); return true; } catch { return false; } };
  for (const svc of ['luna-kernel', 'luna-kimiweb']) {
    if (run('pm2 restart ' + svc)) ok('restart: ' + svc);
    else warn('restart falhou (rode manual): pm2 restart ' + svc);
  }
  console.log('=== FIM ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
