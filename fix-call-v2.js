#!/usr/bin/env node
/**
 * fix-call-v2.js — RECOVERY (owner 21/10 01:00)
 * Completa o que os dois scripts anteriores deixaram pela metade:
 * A) conductor: adiciona o METODO mirrorTurno (versao concat, sem template
 *    literal — o arquivo local chama this.mirrorTurno no loop mas o metodo
 *    faltava; sem ele o conductor quebra no restart).
 * B) executor: repassa brief.reply_chat pro conductor (ficou pendente).
 * C) kernel voice-call-tools.cjs: brief.objetivo (executor le objetivo).
 * D) voice-call-end: o break do externalEnd no poll (anchor tolerante ao
 *    arquivo local) + release do client.
 * Idempotente por etapa. Falha avisando, nunca deixa pela metade sem aviso.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const AGENT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const KERNEL_TOOL = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\voice-call-tools.cjs';
const CONDUCTOR = path.join(AGENT, 'apps', 'whatsplay', 'src', 'voice', 'call-conductor.ts');
const EXECUTOR = path.join(AGENT, 'apps', 'whatsplay', 'src', 'voice', 'call-executor.ts');

function ok(m) { console.log('[OK] ' + m); }
function warn(m) { console.log('[AVISO] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); process.exit(1); }
function bak(f) {
  const b = f + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(f, b);
  return b;
}
function balanced(x) { return x.split('{').length === x.split('}').length && x.split('(').length === x.split(')').length; }
function applyTs(file, anchor, replacement, label) {
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(replacement.slice(0, 45).trim())) { ok('ja aplicado: ' + label); return; }
  const n = src.split(anchor).length - 1;
  if (n !== 1) fail(label + ': anchor ' + n + 'x (esperado 1)');
  const out = src.replace(anchor, replacement);
  if (!balanced(out)) fail(label + ': desbalanceamento');
  const b = bak(file);
  fs.writeFileSync(file, out, 'utf8');
  ok(label + ' | backup: ' + path.basename(b));
}

(async function main() {
  /* ---------- A) mirrorTurno (metodo que faltava) ---------- */
  {
    const src = fs.readFileSync(CONDUCTOR, 'utf8');
    if (src.includes('private async mirrorTurno')) { ok('A ja aplicado'); }
    else {
      if (!src.includes('this.mirrorTurno(turno).catch(() => {});')) fail('A: loop chama mirrorTurno mas nao achei a chamada — arquivo diferente do esperado');
      const anchor = '  /** Liga o loop da conductora. Retorna handle com stop(). */';
      if (src.split(anchor).length - 1 !== 1) fail('A: anchor doc start nao bate');
      const method =
        '  /** v1.13 (owner 21/10): espelha cada fala da chamada como msg no chat' + '\n' +
        '   *  que pediu a ligacao. Outbound enfileirado — o whatsplay entrega no' + '\n' +
        '   *  chat de origem; cadeia de entrega + guardas do banco cuidam do resto. */' + '\n' +
        '  private async mirrorTurno(turno: ConductorTurn): Promise<void> {' + '\n' +
        '    if (!this.convId || !this.deps.pool) return;' + '\n' +
        '    const body = \'[📞 chamada] \' + turno.speaker + \': "\' + turno.text.slice(0, 280) + \'"\';' + '\n' +
        '    try {' + '\n' +
        '      const r = await this.deps.pool.query(' + '\n' +
        '        "INSERT INTO messages (conversation_id, direction, channel, sender, body, author_name, metadata, send_state) " +' + '\n' +
        '        "VALUES ($1, \'outbound\', \'whatsapp\', \'luna\', $2, \'Luna\', $3::jsonb, \'queued\') RETURNING id",' + '\n' +
        '        [this.convId, body, JSON.stringify({ source: \'voice_call\' })]);' + '\n' +
        '      const id = r.rows[0] && r.rows[0].id;' + '\n' +
        '      if (id) {' + '\n' +
        '        try { await this.deps.pool.query(\'SELECT pg_notify($1, $2)\', [\'luna_outbound\', id]); } catch { /* noop */ }' + '\n' +
        '      }' + '\n' +
        '    } catch (e) {' + '\n' +
        '      this.say(\'mirrorTurno falhou (best-effort)\', { erro: String(e).slice(0, 80) });' + '\n' +
        '    }' + '\n' +
        '  }' + '\n' +
        '\n' +
        '  /** Liga o loop da conductora. Retorna handle com stop(). */';
      const out = src.replace(anchor, method);
      if (!balanced(out)) fail('A: desbalanceamento');
      const b = bak(CONDUCTOR);
      fs.writeFileSync(CONDUCTOR, out, 'utf8');
      ok('A: metodo mirrorTurno adicionado | backup: ' + path.basename(b));
    }
  }

  /* ---------- B) executor: reply_chat repass ---------- */
  applyTs(EXECUTOR,
    "        tom: 'parceira de time, direta, PT-BR',",
    "        tom: 'parceira de time, direta, PT-BR',\n        reply_chat: (brief as { reply_chat?: string | null }).reply_chat ?? null,",
    'B: executor reply_chat');

  /* ---------- C) kernel tool: objetivo no brief ---------- */
  {
    const src = fs.readFileSync(KERNEL_TOOL, 'utf8');
    if (src.includes('objetivo: assunto')) ok('C ja aplicado');
    else {
      if (src.split('      assunto,').length - 1 !== 1) fail('C anchor');
      const out = src.replace('      assunto,', '      assunto,\n      objetivo: assunto,');
      const tmp = KERNEL_TOOL + '.tmpchk.js';
      fs.writeFileSync(tmp, out, 'utf8');
      try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
      catch { try { fs.unlinkSync(tmp); } catch {} fail('C sintaxe'); }
      try { fs.unlinkSync(tmp); } catch {}
      const b = bak(KERNEL_TOOL);
      fs.writeFileSync(KERNEL_TOOL, out, 'utf8');
      ok('C: brief.objetivo | backup: ' + path.basename(b));
    }
  }

  /* ---------- D) voice-call-end: break do externalEnd + release ---------- */
  {
    const src = fs.readFileSync(EXECUTOR, 'utf8');
    if (src.includes('externalEnd')) {
      if (!src.includes('if (externalEnd) break;')) {
        const anchor = '      for (;;) {\n        await new Promise((r) => setTimeout(r, 5_000));';
        if (src.split(anchor).length - 1 !== 1) fail('D anchor poll (for+sleep) ' + src.split(anchor).length + 'x');
        const out = src.replace(anchor, anchor + '\n        if (externalEnd) break; // v1.14: owner pediu pra desligar pelo chat');
        if (!balanced(out)) fail('D desbalanceamento');
        const b = bak(EXECUTOR);
        fs.writeFileSync(EXECUTOR, out, 'utf8');
        ok('D1: break do externalEnd no poll | backup: ' + path.basename(b));
      } else ok('D1 ja aplicado');
      if (!src.includes('ctrlClient.release()') && !fs.readFileSync(EXECUTOR, 'utf8').includes('ctrlClient.release()')) {
        const anchor2 = '      handle.stop();';
        const cur = fs.readFileSync(EXECUTOR, 'utf8');
        if (cur.split(anchor2).length - 1 !== 1) fail('D2 anchor handle.stop');
        const out2 = cur.replace(anchor2, '      handle.stop();\n      try { if (ctrlClient) (ctrlClient as { release: () => void }).release(); } catch { /* noop */ }');
        if (!balanced(out2)) fail('D2 desbalanceamento');
        const b2 = bak(EXECUTOR);
        fs.writeFileSync(EXECUTOR, out2, 'utf8');
        ok('D2: release do ctrlClient | backup: ' + path.basename(b2));
      } else ok('D2 ja aplicado');
    } else {
      warn('D: bloco LISTEN/externalEnd ausente — rode fix-voice-call-end.js antes (D anchor 1 de la precisa bater)');
    }
  }

  for (const svc of ['luna-kernel', 'luna-whatsplay', 'luna-worker']) {
    spawn('cmd.exe', ['/c', 'pm2 restart ' + svc], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    ok('restart: ' + svc);
  }
  console.log('=== FIM — recovery completo ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
