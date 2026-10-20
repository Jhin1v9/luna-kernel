#!/usr/bin/env node
/**
 * fix-call-transcript-mirror.js — v1.13 (decreto owner 21/10 01:00)
 * TRANSCRICAO DA CHAMADA NO CHAT DE ORIGEM:
 * A) call-conductor.ts: resolve reply_chat -> conversation_id (contacts join)
 *    e espelha CADA fala da chamada como msg outbound enfileirada no chat
 *    que pediu a ligacao (whatsplay entrega; cadeia+guardas cuidam do resto).
 * B) call-executor.ts: repassa brief.reply_chat pro conductor.
 * tsx = transpile-only (sem typecheck) — validacao por balanceamento.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const AGENT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const CONDUCTOR = path.join(AGENT, 'apps', 'whatsplay', 'src', 'voice', 'call-conductor.ts');
const EXECUTOR = path.join(AGENT, 'apps', 'whatsplay', 'src', 'voice', 'call-executor.ts');
const KERNEL_TOOL = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\voice-call-tools.cjs';

function ok(m) { console.log('[OK] ' + m); }
function warn(m) { console.log('[AVISO] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); process.exit(1); }
function bak(f) {
  const b = f + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(f, b);
  return b;
}
function balanced(s) {
  return s.split('{').length === s.split('}').length && s.split('(').length === s.split(')').length;
}
function patchTs(file, anchor, replacement, label) {
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(replacement.slice(0, 40))) { ok('ja aplicado: ' + label); return; }
  if (src.split(anchor).length - 1 !== 1) fail('anchor nao bate 1x (' + label + '): ' + anchor.slice(0, 50));
  const out = src.replace(anchor, replacement);
  if (!balanced(out)) fail('desbalanceamento apos ' + label);
  const b = bak(file);
  fs.writeFileSync(file, out, 'utf8');
  ok(label + ' | backup: ' + path.basename(b));
}

(async function main() {
  /* ---------- A) call-conductor.ts ---------- */
  patchTs(CONDUCTOR,
    '  private pendingInvestigation: string | null = null;',
    '  private pendingInvestigation: string | null = null;\n  private convId: string | null = null;',
    'conductor: campo convId');

  patchTs(CONDUCTOR,
    '    const pollMs = this.deps.pollMs ?? 3_000;',
    '    const pollMs = this.deps.pollMs ?? 3_000;\n' +
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
    '        .catch(() => {});\n' +
    '    }',
    'conductor: resolucao reply_chat');

  patchTs(CONDUCTOR,
    '              this.history.push(`- ${turno.speaker}: ${turno.text}`.slice(0, 200));',
    '              this.history.push(`- ${turno.speaker}: ${turno.text}`.slice(0, 200));\n              this.mirrorTurno(turno).catch(() => {});',
    'conductor: espelhamento no loop');

  patchTs(CONDUCTOR,
    '  /** Liga o loop da conductora. Retorna handle com stop(). */',
    '  /** v1.13 (owner 21/10): espelha cada fala da chamada como msg no chat\n   *  que pediu a ligacao. Outbound enfileirado — o whatsplay entrega no\n   *  chat de origem; cadeia de entrega + guardas do banco cuidam do resto. */\n' +
    '  private async mirrorTurno(turno: ConductorTurn): Promise<void> {\n' +
    '    if (!this.convId || !this.deps.pool) return;\n' +
    '    const body = `[📞 chamada] ${turno.speaker}: "${turno.text.slice(0, 280)}"`;\n' +
    '    try {\n' +
    '      const r = await this.deps.pool.query(\n' +
    `        \`INSERT INTO messages (conversation_id, direction, channel, sender, body, author_name, metadata, send_state)\n` +
    `         VALUES (\$1, 'outbound', 'whatsapp', 'luna', \$2, 'Luna', \$3, 'queued') RETURNING id\`,\n` +
    '        [this.convId, body, JSON.stringify({ source: \'voice_call\' })]);\n' +
    '      const id = r.rows[0]?.id;\n' +
    '      if (id) await this.deps.pool.query(\'SELECT pg_notify($1, $2)\', [\'luna_outbound\', id]).catch(() => {});\n' +
    '    } catch (e) {\n' +
    '      this.say(\'mirrorTurno falhou (best-effort)\', { erro: String(e).slice(0, 80) });\n' +
    '    }\n' +
    '  }\n\n  /** Liga o loop da conductora. Retorna handle com stop(). */',
    'conductor: metodo mirrorTurno');

  /* ---------- B) call-executor.ts: repassa reply_chat ---------- */
  patchTs(EXECUTOR,
    "        tom: 'parceira de time, direta, PT-BR',\n      });",
    "        tom: 'parceira de time, direta, PT-BR',\n        reply_chat: (brief as { reply_chat?: string | null }).reply_chat ?? null,\n      });",
    'executor: reply_chat no brief do conductor');

  /* ---------- C) kernel tool: brief ganha objetivo (executor le brief.objetivo) ---------- */
  const kt = fs.readFileSync(KERNEL_TOOL, 'utf8');
  if (!kt.includes('objetivo: assunto')) {
    if (kt.split('      assunto,').length - 1 !== 1) fail('anchor assunto no kernel tool');
    const out = kt.replace('      assunto,', '      assunto,\n      objetivo: assunto,');
    const { execFileSync } = require('child_process');
    fs.writeFileSync(KERNEL_TOOL + '.tmpchk.js', out, 'utf8');
    try { execFileSync(process.execPath, ['--check', KERNEL_TOOL + '.tmpchk.js'], { stdio: 'pipe' }); }
    catch { try { fs.unlinkSync(KERNEL_TOOL + '.tmpchk.js'); } catch {} fail('sintaxe kernel tool apos objetivo'); }
    try { fs.unlinkSync(KERNEL_TOOL + '.tmpchk.js'); } catch {}
    const b = bak(KERNEL_TOOL);
    fs.writeFileSync(KERNEL_TOOL, out, 'utf8');
    ok('kernel tool: brief.objetivo | backup: ' + path.basename(b));
  } else ok('kernel tool ja tem objetivo');

  /* ---------- restarts ---------- */
  for (const svc of ['luna-whatsplay', 'luna-worker', 'luna-kernel']) {
    spawn('cmd.exe', ['/c', 'pm2 restart ' + svc], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    ok('restart: ' + svc);
  }
  console.log('');
  console.log('=== FIM — fluxo completo: Luna pede voiceCallPlace -> disca -> falas espelhadas NO chat que pediu ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
