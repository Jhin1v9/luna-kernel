#!/usr/bin/env node
/**
 * fix-group-routing.js — v16.8 (decreto owner 20/10 23:10)
 * A) handler.ts: work nao sabia a origem — respondia no privado msg do grupo.
 *    Prefixa [chat: X | autor: Y] no prompt do kernel (sessao work).
 * B) luna-prompt-config.json: regra 4 — responda SEMPRE no chat de origem.
 * C) .env do orchestrator: QUIET_HOURS_ALLOWED ganha o time (enoque, elias,
 *    nonoke) — cliente CONTUA bloqueado depois das 20h (decreto owner).
 * D) restarts ocultos.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const AGENT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const DOCS = 'C:\\Users\\Abner\\Documents';
const HANDLER = path.join(AGENT, 'apps', 'orchestrator', 'src', 'agent', 'handler.ts');
function ok(m) { console.log('[OK] ' + m); }
function warn(m) { console.log('[AVISO] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); process.exit(1); }
function bak(f) {
  const b = f + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(f, b);
  return b;
}

(async function main() {
  /* ---------- A) handler.ts: contexto de origem ---------- */
  console.log('=== A: origem no prompt do work ===');
  if (!fs.existsSync(HANDLER)) { fail('nao achei handler.ts'); }
  let src = fs.readFileSync(HANDLER, 'utf8');
  if (src.includes('v16.8-fix')) {
    ok('A ja aplicado');
  } else {
    const anchor = '      const answerText = await askKernelWorkKernel(batchText, conversationId, log);';
    if (src.split(anchor).length - 1 !== 1) { fail('A anchor nao bate 1x — handler.ts mudou?'); }
    const NL = src.includes('\r\n') ? '\r\n' : '\n';
    const block = [
      '      // v16.8-fix (owner 20/10): origem da msg no prompt do work — sem isso',
      '      // a Luna respondia no privado mensagens que vieram do grupo.',
      '      let sourceLabel = null;',
      '      try {',
      '        const convRow = await db.query(',
      '          `SELECT ct.name FROM conversations cv LEFT JOIN contacts ct ON ct.id = cv.contact_id WHERE cv.id = $1 LIMIT 1`,',
      '          [conversationId],',
      '        );',
      '        sourceLabel = (convRow.rows[0] && (convRow.rows[0] as { name?: string | null }).name) || null;',
      '      } catch { /* segue sem nome */ }',
      "      const originTag = '[chat: ' + (sourceLabel || conversationId) + (payload.author_name ? ' | autor: ' + payload.author_name : '') + ']';",
      "      const answerText = await askKernelWorkKernel(originTag + '\\n' + batchText, conversationId, log);",
    ].join(NL);
    const out = src.replace(anchor, block);
    fs.writeFileSync(HANDLER + '.syntaxcheck', out, 'utf8');
    // validacao leve: balanceamento global do arquivo (mesma contagem de chaves)
    const o = out.split('{').length - out.split('}').length;
    const p = out.split('(').length - out.split(')').length;
    try { fs.unlinkSync(HANDLER + '.syntaxcheck'); } catch {}
    if (o !== 0 || p !== 0) { fail('A: desbalanceamento apos patch ({ ' + o + ', ( ' + p + ') — abortado'); }
    const b = bak(HANDLER);
    fs.writeFileSync(HANDLER, out, 'utf8');
    ok('A aplicado — work recebe [chat | autor]');
    ok('   backup: ' + path.basename(b));
  }

  /* ---------- B) regra 4 no prompt ---------- */
  console.log('');
  console.log('=== B: regra "responda no chat de origem" ===');
  function* walk(dir, depth) {
    if (depth > 6) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (['node_modules', '.git', '.next', 'coverage'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) yield* walk(full, depth + 1);
      else if (e.name === 'luna-prompt-config.json') yield full;
    }
  }
  const RULE3 = '- Não invente regras (horário, permissão, decreto) que não existam nas suas tools: se a tool permitir, execute. Dúvida de regra = anote no brain e avise o owner via whatsappSendMessage.';
  const RULE4 = '- Responda SEMPRE no mesmo chat de origem: o cabeçalho [chat: X | autor: Y] da mensagem diz de onde ela veio. Responder em outro chat só se o pedido do usuário exigir explicitamente. (v16.8-fix)';
  let bCount = 0;
  for (const file of walk(DOCS, 0)) {
    try {
      const cfg = fs.readFileSync(file, 'utf8');
      if (cfg.includes('v16.8-fix')) { ok('B ja aplicado: ' + file); bCount++; continue; }
      if (cfg.split(RULE3.replace(/"/g, '\\"')).length - 1 === 0) { warn('B: regra v16.7 nao achada (rode fix-work-prompt.js antes): ' + file); continue; }
      const needle = RULE3.replace(/"/g, '\\"');
      const at = cfg.indexOf(needle);
      if (at === -1) { warn('B anchor falhou: ' + file); continue; }
      const out2 = cfg.slice(0, at + needle.length) + '\\n' + RULE4.replace(/"/g, '\\"') + cfg.slice(at + needle.length);
      try { JSON.parse(out2); } catch { warn('B JSON invalido — pulado: ' + file); continue; }
      const b = bak(file);
      fs.writeFileSync(file, out2, 'utf8');
      ok('B aplicado: ' + file);
      bCount++;
    } catch (e) { warn('B erro em ' + file + ': ' + e.message); }
  }
  if (!bCount) warn('B: nenhum config alterado (rode fix-work-prompt.js antes se ainda nao rodou)');

  /* ---------- C) QUIET_HOURS_ALLOWED ---------- */
  console.log('');
  console.log('=== C: allowlist do time (cliente continua bloqueado) ===');
  const TEAM = ['abner', 'enoque', 'nonoke', 'elias'];
  for (const envf of [path.join(AGENT, '.env'), path.join(AGENT, 'apps', 'orchestrator', '.env')]) {
    if (!fs.existsSync(envf)) { warn('C: nao existe ' + envf); continue; }
    const lines = fs.readFileSync(envf, 'utf8').split(/\r?\n/);
    const idx = lines.findIndex((l) => l.startsWith('QUIET_HOURS_ALLOWED='));
    if (idx === -1) {
      lines.push('QUIET_HOURS_ALLOWED=' + TEAM.join(','));
      fs.writeFileSync(envf, lines.join('\r\n'), 'utf8');
      ok('C: linha criada em ' + envf);
    } else {
      const cur = lines[idx].slice('QUIET_HOURS_ALLOWED='.length).toLowerCase();
      const items = cur.split(',').map((s) => s.trim()).filter(Boolean);
      const missing = TEAM.filter((t) => !items.includes(t));
      if (!missing.length) { ok('C: ja completo em ' + envf); continue; }
      items.push(...missing);
      lines[idx] = 'QUIET_HOURS_ALLOWED=' + items.join(',');
      fs.writeFileSync(envf, lines.join('\r\n'), 'utf8');
      ok('C: adicionado em ' + envf + ': ' + missing.join(', '));
    }
  }

  /* ---------- D) restarts ---------- */
  console.log('');
  console.log('=== D: restarts ===');
  for (const svc of ['luna-orchestrator', 'luna-kernel', 'luna-kimiweb']) {
    spawn('cmd.exe', ['/c', 'pm2 restart ' + svc], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    ok('restart disparado: ' + svc);
  }
  console.log('=== AGUARDE 10s E TESTE: mande msg no GRUPO Production e veja ela responder NO GRUPO ===');
  console.log('=== FIM ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
