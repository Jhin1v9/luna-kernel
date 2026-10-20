#!/usr/bin/env node
/**
 * fix-voice-call-tool.js — v16.12 (decreto owner 21/10 00:50)
 * FERRAMENTA DE CHAMADA DE VERDADE no canal work (fim dos remendos):
 * 1) whatsapp-tools.cjs: exporta resolveTarget (reuso)
 * 2) NOVO packages/kernel/voice-call-tools.cjs: voiceCallPlace({to, assunto,
 *    reply_chat}) — resolve destino, gate do Chat Registry (role=allowed),
 *    enfileira job voice.call (schema-proof) p/ worker -> whatsplay discar.
 * 3) luna-tools.cjs: merge do novo modulo.
 * 4) tool-catalog.cjs: entrada no CORE_TOOLS (com EXEMPLO) + no indice.
 * 5) luna-prompt-config.json: secao CHAMADAS (quando usar, exemplo,
 *    callRespond durante a call, transcricao no chat de origem).
 * Seguro: backups, valida node --check / JSON.parse, idempotente.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const KERNEL = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const WTOOLS = path.join(KERNEL, 'packages', 'kernel', 'whatsapp-tools.cjs');
const VTOOLS = path.join(KERNEL, 'packages', 'kernel', 'voice-call-tools.cjs');
const LTOOLS = path.join(KERNEL, 'packages', 'kernel', 'luna-tools.cjs');
const CATALOG = path.join(KERNEL, 'packages', 'kernel', 'tool-catalog.cjs');
const CONFIG = path.join(KERNEL, 'packages', 'kernel', 'config', 'luna-prompt-config.json');

const VOICE_BODY_JSON = '"\'use strict\';\\n/**\\n * Voice Call Tools \\u2014 ligacao de voz WhatsApp via job voice.call (2026-10-21).\\n * voiceCallPlace: a Luna DISCA a pedido do usuario no canal work.\\n * Contrato identico ao whatsapp-tools.cjs (pool proprio, ok/err).\\n */\\nconst { resolveTarget } = require(\'./whatsapp-tools.cjs\');\\n\\nlet _pool = null;\\nfunction db() {\\n  if (_pool) return _pool;\\n  const url = process.env.DATABASE_URL || process.env.LUNA_DATABASE_URL;\\n  if (!url) throw new Error(\'DATABASE_URL nao configurado (voice call indisponivel)\');\\n  const candidates = [\\n    process.env.LUNA_KERNEL_PG_PATH,\\n    require(\'path\').join(__dirname, \'..\', \'..\', \'apps\', \'dashboard\', \'node_modules\', \'pg\'),\\n    \'C:/Users/Abner/Documents/luna-agent/node_modules/pg\',\\n  ].filter(Boolean);\\n  let pg = null;\\n  for (const c of candidates) { try { pg = require(c); break; } catch { /* proximo */ } }\\n  if (!pg) throw new Error(\'modulo pg nao encontrado\');\\n  _pool = new pg.Pool({ connectionString: url });\\n  return _pool;\\n}\\nasync function q(sql, params = []) { return (await db().query(sql, params)).rows; }\\nfunction ok(s) { return { success: true, stdout: s }; }\\nfunction err(e) { return { success: false, error: String(e) }; }\\n\\n/** Inicia ligacao de voz. params: { to, assunto, reply_chat? } */\\nasync function voiceCallPlace(params = {}) {\\n  try {\\n    const to = params.to || params.destinatario;\\n    const assunto = params.assunto || params.contexto || \'Chamada a pedido do owner.\';\\n    const replyChat = params.reply_chat || params.replyChat || null;\\n    if (!to) return err(\'parametro \\"to\\" obrigatorio (nome do contato, numero ou jid)\');\\n    const t = await resolveTarget(to);\\n    if (!t || t.unresolved) {\\n      return err(`destino nao resolvido: \\"${to}\\". candidatos: ${JSON.stringify((t && (t.contactHints || t.groupHints)) || [])}`);\\n    }\\n    // gate do Chat Registry (espelha o pre-voo do call-executor)\\n    const reg = await q(\\n      `SELECT role, canonical_name FROM chat_registry\\n       WHERE (kind=\'individual\' AND (replace(chat_key,\'@c.us\',\'\') = $1 OR replace(coalesce(phone_e164,\'\'),\'@c.us\',\'\') = $1 OR lower(canonical_name) = lower($2)))\\n          OR (kind=\'group\' AND chat_key = $1) LIMIT 1`,\\n      [t.chatId, t.display]);\\n    if (!reg.length) return err(`destino \\"${t.display}\\" sem registro no Chat Registry \\u2014 cadastre com whatsappAllowContact.`);\\n    if (reg[0].role !== \'allowed\') return err(`destino \\"${t.display}\\" com role=${reg[0].role} no registry \\u2014 owner precisa liberar.`);\\n    const brief = {\\n      destinatario: t.display,\\n      de: \'Luna (a pedido do owner)\',\\n      assunto,\\n      reply_chat: replyChat || t.display,\\n    };\\n    const cols = (await q(\\n      `SELECT column_name FROM information_schema.columns WHERE table_schema=\'public\' AND table_name=\'jobs\'`)).map((r) => r.column_name);\\n    if (!cols.includes(\'job_type\') || !cols.includes(\'payload\')) return err(\'tabela jobs sem job_type/payload\');\\n    const id = \'call-\' + Date.now();\\n    const row = {};\\n    if (cols.includes(\'id\')) row.id = id;\\n    row.job_type = \'voice.call\';\\n    row.payload = JSON.stringify({ brief });\\n    if (cols.includes(\'status\')) row.status = \'pending\';\\n    if (cols.includes(\'idempotency_key\')) row.idempotency_key = \'vc-\' + id;\\n    if (cols.includes(\'attempts\')) row.attempts = 0;\\n    const use = Object.keys(row);\\n    const ph = use.map((k, i) => (k === \'payload\' ? `$${i + 1}::jsonb` : `$${i + 1}`));\\n    await db().query(\\n      `INSERT INTO jobs (${use.join(\',\')}) VALUES (${ph.join(\',\')})`,\\n      use.map((k) => row[k]));\\n    return ok(`\\ud83d\\udcde Ligacao iniciada para ${t.display} (${t.kind}). Roteiro: ${assunto.slice(0, 90)} \\u2014 as transcricoes chegam AQUI neste chat; durante a chamada use callRespond pra falar.`);\\n  } catch (e) {\\n    return err(e);\\n  }\\n}\\n\\nmodule.exports = { voiceCallPlace };\\n"';
function ok(m) { console.log('[OK] ' + m); }
function warn(m) { console.log('[AVISO] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); process.exit(1); }
function bak(f) {
  const b = f + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(f, b);
  return b;
}
function patch(file, anchor, replacement, checkFn) {
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(replacement.slice(0, 40))) { ok('ja aplicado: ' + path.basename(file)); return false; }
  if (src.split(anchor).length - 1 !== 1) fail('anchor nao bate 1x em ' + path.basename(file) + ': ' + anchor.slice(0, 50));
  const out = src.replace(anchor, replacement);
  if (checkFn && !checkFn(out)) fail('validacao falhou em ' + path.basename(file));
  const b = bak(file);
  fs.writeFileSync(file, out, 'utf8');
  ok('patch: ' + path.basename(file));
  ok('   backup: ' + path.basename(b));
  return true;
}

(async function main() {
  /* ---------- 1) whatsapp-tools exporta resolveTarget ---------- */
  const wt = fs.readFileSync(WTOOLS, 'utf8');
  if (!/module\.exports\s*=\s*\{[^}]*resolveTarget/s.test(wt)) {
    patch(
      WTOOLS,
      'module.exports = {',
      'module.exports = {\n  resolveTarget,',
      (out) => { try { execFileSync(process.execPath, ['--check', WTOOLS + '.tmpchk.js'], { stdio: 'pipe' }); return true; } catch { return /resolveTarget,/.test(out); } }
    );
    ok('resolveTarget exportado do whatsapp-tools');
  } else ok('resolveTarget ja exportado');

  /* ---------- 2) voice-call-tools.cjs (novo) ---------- */
  if (fs.existsSync(VTOOLS) && fs.readFileSync(VTOOLS, 'utf8').includes('voiceCallPlace')) {
    ok('voice-call-tools.cjs ja existe');
  } else {
    const body = JSON.parse(VOICE_BODY_JSON);
    fs.writeFileSync(VTOOLS, body, 'utf8');
    execFileSync(process.execPath, ['--check', VTOOLS], { stdio: 'pipe' });
    ok('voice-call-tools.cjs criado (sintaxe OK)');
  }

  /* ---------- 3) luna-tools.cjs merge ---------- */
  const lt = fs.readFileSync(LTOOLS, 'utf8');
  if (!lt.includes('voice-call-tools')) {
    if (lt.split("const whatsappTools = require('./whatsapp-tools.cjs');").length - 1 !== 1) fail('anchor whatsappTools require nao bate');
    let out = lt.replace(
      "const whatsappTools = require('./whatsapp-tools.cjs');",
      "const whatsappTools = require('./whatsapp-tools.cjs');\nconst voiceCallTools = require('./voice-call-tools.cjs');"
    );
    if (out.split('module.exports = {').length - 1 !== 1) fail('module.exports nao unico');
    out = out.replace('module.exports = {', 'module.exports = {\n  ...voiceCallTools,');
    const tmp = LTOOLS + '.tmpchk.js';
    fs.writeFileSync(tmp, out, 'utf8');
    try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
    catch (e) { try { fs.unlinkSync(tmp); } catch {} fail('sintaxe do luna-tools apos merge'); }
    try { fs.unlinkSync(tmp); } catch {}
    const b = bak(LTOOLS);
    fs.writeFileSync(LTOOLS, out, 'utf8');
    ok('luna-tools.cjs merge voiceCallTools | backup: ' + path.basename(b));
  } else ok('luna-tools ja mergeado');

  /* ---------- 4) tool-catalog.cjs ---------- */
  const cat = fs.readFileSync(CATALOG, 'utf8');
  if (!cat.includes('voiceCallPlace')) {
    if (cat.split('const CORE_TOOLS = [').length - 1 !== 1) fail('CORE_TOOLS anchor');
    let out = cat.replace('const CORE_TOOLS = [',
      "const CORE_TOOLS = [\n  // 📞 Chamada de voz (2026-10-21): a Luna DISCA a pedido do usuario; transcrição volta no chat de origem.\n  { name: 'voiceCallPlace', cat: '📞 Chamada', desc: 'INICIA ligacao de voz WhatsApp para contato VERIFICADO no Chat Registry (role=allowed). As falas chegam transcritas no chat de origem; durante a call use callRespond pra falar.', params: '{to, assunto, reply_chat?}', ex: { to: 'Ana Paula', assunto: 'recado a pedido do owner', reply_chat: 'nome do chat de origem' } },");
    const idxAnchor = "    { name: 'whatsappAllowContact', desc: 'PROTOCOLO NOVO CONTATO: add nome/número na allowlist + diretório (decree owner).', params: ['name', 'phone?', 'note?'] },";
    if (out.split(idxAnchor).length - 1 !== 1) fail('indice whatsappAllowContact nao bate');
    out = out.replace(idxAnchor, idxAnchor + "\n    { name: 'voiceCallPlace', desc: 'INICIA ligacao de voz p/ contato verificado; transcricao volta no chat de origem.', params: ['to', 'assunto', 'reply_chat?'] },");
    const tmp2 = CATALOG + '.tmpchk.js';
    fs.writeFileSync(tmp2, out, 'utf8');
    try { execFileSync(process.execPath, ['--check', tmp2], { stdio: 'pipe' }); }
    catch { try { fs.unlinkSync(tmp2); } catch {} fail('sintaxe do catalog apos patch'); }
    try { fs.unlinkSync(tmp2); } catch {}
    const b2 = bak(CATALOG);
    fs.writeFileSync(CATALOG, out, 'utf8');
    ok('tool-catalog.cjs: CORE_TOOLS + indice | backup: ' + path.basename(b2));
  } else ok('catalog ja tem voiceCallPlace');

  /* ---------- 5) prompt CHAMADAS ---------- */
  const cfgS = fs.readFileSync(CONFIG, 'utf8');
  if (cfgS.includes('v16.12-fix')) {
    ok('prompt ja tem secao CHAMADAS');
  } else {
    const anchor = '- Responda SEMPRE no mesmo chat de origem: o cabeçalho [chat: X | autor: Y] da mensagem diz de onde ela veio. Responder em outro chat só se o pedido do usuário exigir explicitamente. (v16.8-fix)';
    const esc = (s) => s.replace(/"/g, '\\"');
    const rule = esc('- 📞 CHAMADAS (v16.12-fix): para LIGAR, use voiceCallPlace {"to": "NOME", "assunto": "o que dizer", "reply_chat": "o chat do cabeçalho [chat: X]"}. Só funciona pra contato verificado (role=allowed) no Chat Registry; se não estiver, cadastre com whatsappAllowContact e avise. DURANTE a chamada use callRespond para falar. As falas da chamada chegam transcritas AUTOMATICAMENTE no chat que pediu a ligação.') + '\\n';
    if (cfgS.split(esc(anchor)).length - 1 !== 1) fail('anchor regra v16.8 no config');
    const out = cfgS.replace(esc(anchor), esc(anchor) + '\\n' + rule);
    try { JSON.parse(out); } catch { fail('JSON invalido apos patch do prompt'); }
    const b3 = bak(CONFIG);
    fs.writeFileSync(CONFIG, out, 'utf8');
    ok('prompt: secao CHAMADAS | backup: ' + path.basename(b3));
  }

  /* ---------- restart ---------- */
  spawn('cmd.exe', ['/c', 'pm2 restart luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  ok('luna-kernel reiniciado');
  console.log('');
  console.log('=== FIM — kernel pronto. Lado agent (transcricao no chat de origem) vem no proximo passo ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
