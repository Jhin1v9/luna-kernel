#!/usr/bin/env node
/**
 * fix-call-v3.js — RECOVERY DEFINITIVO (owner 21/10 01:00)
 * Estado real: kernel OK (voiceCallPlace/End + catalog + prompt).
 * Agent: conductor/executor SEM NENHUM patch (v2/v1 morreram antes de
 * escrever por causa de checks defeituosos). Este script:
 * A) conductor: convId + resolucao reply_chat + mirrorTurno no loop +
 *    METODO mirrorTurno (idempotencia por marcador unico 'mirrorTurno')
 * B) executor: repassa reply_chat; LISTEN voice_call_control + break +
 *    release (idempotencia por 'externalEnd')
 * C) kernel tool: brief.objetivo
 * SEM cheque de balanceamento global (template literals quebram a contagem
 * ingenua). Ancoras 1x sao a seguranca; backups permitem restore.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const AGENT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const KERNEL_TOOL = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\voice-call-tools.cjs';
const CONDUCTOR = path.join(AGENT, 'apps', 'whatsplay', 'src', 'voice', 'call-conductor.ts');
const EXECUTOR = path.join(AGENT, 'apps', 'whatsplay', 'src', 'voice', 'call-executor.ts');

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
  if (src.split(anchor).length - 1 !== 1) fail(label + ': anchor ' + src.split(anchor).length + 'x');
  const out = src.replace(anchor, anchor + addition);
  const b = bak(file);
  fs.writeFileSync(file, out, 'utf8');
  ok(label + ' | backup: ' + path.basename(b));
}

(async function main() {
  /* ---------- A) conductor (4 insercões) ---------- */
  put(CONDUCTOR, 'private convId', '  private pendingInvestigation: string | null = null;',
    '\n  private convId: string | null = null;',
    'A1 conductor: convId');

  put(CONDUCTOR, 'replyChat = (brief as', '    const pollMs = this.deps.pollMs ?? 3_000;',
    '\n' +
    '    // v1.13 (owner 21/10): reply_chat -> conversation_id (chat que pediu a ligacao)\n' +
    '    const replyChat = (brief as { reply_chat?: string | null }).reply_chat ?? null;\n' +
    '    if (replyChat && this.deps.pool) {\n' +
    '      this.deps.pool\n' +
    '        .query(\n' +
    '          `SELECT cv.id FROM conversations cv LEFT JOIN contacts ct ON ct.id = cv.contact_id\n' +
    '           WHERE ct.name = $1 OR ct.name ILIKE $2 ORDER BY cv.created_at DESC LIMIT 1`,\n' +
    '          [replyChat, \'%\' + replyChat + \'%\'])\n' +
    '        .then((r) => {\n' +
    '          this.convId = r.rows[0]?.id ?? null;\n' +
    '          if (this.convId) this.say(\'transcricao da chamada espelhada no chat: \' + replyChat, { replyChat, conversation_id: this.convId });\n' +
    '          else this.say(\'reply_chat sem conversa correspondente — transcricao NAO espelhada\', { replyChat });\n' +
    '        })\n' +
    '        .catch(() => {});',
    'A2 conductor: resolucao reply_chat');

  put(CONDUCTOR, 'this.mirrorTurno(turno).catch(() => {});',
    '              this.history.push(`- ${turno.speaker}: ${turno.text}`.slice(0, 200));',
    '\n              this.mirrorTurno(turno).catch(() => {});',
    'A3 conductor: chamada no loop');

  {
    const src = fs.readFileSync(CONDUCTOR, 'utf8');
    if (src.includes('private async mirrorTurno')) ok('ja aplicado: A4 metodo');
    else {
      const anchor = '  /** Liga o loop da conductora. Retorna handle com stop(). */';
      if (src.split(anchor).length - 1 !== 1) fail('A4 anchor');
      const method =
        '  /** v1.13 (owner 21/10): espelha cada fala da chamada como msg no chat que pediu a ligacao. */\n' +
        '  private async mirrorTurno(turno: ConductorTurn): Promise<void> {\n' +
        '    if (!this.convId || !this.deps.pool) return;\n' +
        '    const body = \'[📞 chamada] \' + turno.speaker + \': "\' + turno.text.slice(0, 280) + \'"\'; // ' + '\n' +
        '    try {\n' +
        '      const r = await this.deps.pool.query(\n' +
        '        "INSERT INTO messages (conversation_id, direction, channel, sender, body, author_name, metadata, send_state) " +\n' +
        '        "VALUES ($1, \'outbound\', \'whatsapp\', \'luna\', $2, \'Luna\', $3::jsonb, \'queued\') RETURNING id",\n' +
        '        [this.convId, body, JSON.stringify({ source: \'voice_call\' })]);\n' +
        '      const id = r.rows[0] && r.rows[0].id;\n' +
        '      if (id) {\n' +
        '        try { await this.deps.pool.query(\'SELECT pg_notify($1, $2)\', [\'luna_outbound\', id]); } catch { /* noop */ }\n' +
        '      }\n' +
        '    } catch (e) {\n' +
        '      this.say(\'mirrorTurno falhou (best-effort)\', { erro: String(e).slice(0, 80) });\n' +
        '    }\n' +
        '  }\n\n' +
        anchor;
      const out = src.replace(anchor, method);
      const b = bak(CONDUCTOR);
      fs.writeFileSync(CONDUCTOR, out, 'utf8');
      ok('A4 conductor: metodo mirrorTurno | backup: ' + path.basename(b));
    }
  }

  /* ---------- B) executor (3 insercões) ---------- */
  put(EXECUTOR, 'reply_chat: (brief as', "        tom: 'parceira de time, direta, PT-BR',",
    '\n        reply_chat: (brief as { reply_chat?: string | null }).reply_chat ?? null,',
    'B1 executor: reply_chat repass');

  put(EXECUTOR, 'externalEnd', '      // encerra quando a chamada cair (poll do estado) — o owner também pode desligar na janela',
    '\n' +
    '      // v1.14 (owner 21/10): "luna desliga" pelo chat -> sinal externo encerra a chamada;\n' +
    '      // o cascade abaixo fecha o lado ChatGPT junto (decreto 26/09).\n' +
    '      let externalEnd = false;\n' +
    '      let ctrlClient: import(\'pg\').PoolClient | null = null;\n' +
    '      try {\n' +
    '        ctrlClient = await pool.connect();\n' +
    '        await ctrlClient.query(\'LISTEN voice_call_control\');\n' +
    '        ctrlClient.on(\'notification\', () => { externalEnd = true; log.info(\'voice.call: pedido externo de desligar (chat)\'); });\n' +
    '      } catch { ctrlClient = null; }',
    'B2 executor: LISTEN voice_call_control');

  put(EXECUTOR, 'if (externalEnd) break;', '      for (;;) {\n        await new Promise((r) => setTimeout(r, 5_000));',
    '\n        if (externalEnd) break; // v1.14: owner pediu pra desligar pelo chat',
    'B3 executor: break do externalEnd');

  put(EXECUTOR, 'ctrlClient.release()', '      handle.stop();',
    '\n      try { if (ctrlClient) (ctrlClient as { release: () => void }).release(); } catch { /* noop */ }',
    'B4 executor: release ctrlClient');

  /* ---------- C) kernel tool: objetivo ---------- */
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

  for (const svc of ['luna-kernel', 'luna-whatsplay', 'luna-worker']) {
    spawn('cmd.exe', ['/c', 'pm2 restart ' + svc], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    ok('restart: ' + svc);
  }
  console.log('=== DEPOIS: pm2 list (whatsplay online, restarts parados) + grep de conferencia abaixo ===');
  console.log('=== FIM ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
