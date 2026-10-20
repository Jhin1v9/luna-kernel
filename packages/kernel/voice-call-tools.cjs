'use strict';
/**
 * Voice Call Tools — ligacao de voz WhatsApp via job voice.call (2026-10-21).
 * voiceCallPlace: a Luna DISCA a pedido do usuario no canal work.
 * Contrato identico ao whatsapp-tools.cjs (pool proprio, ok/err).
 */
const { resolveTarget } = require('./whatsapp-tools.cjs');

let _pool = null;
function db() {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL || process.env.LUNA_DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL nao configurado (voice call indisponivel)');
  const candidates = [
    process.env.LUNA_KERNEL_PG_PATH,
    require('path').join(__dirname, '..', '..', 'apps', 'dashboard', 'node_modules', 'pg'),
    'C:/Users/Abner/Documents/luna-agent/node_modules/pg',
  ].filter(Boolean);
  let pg = null;
  for (const c of candidates) { try { pg = require(c); break; } catch { /* proximo */ } }
  if (!pg) throw new Error('modulo pg nao encontrado');
  _pool = new pg.Pool({ connectionString: url });
  return _pool;
}
async function q(sql, params = []) { return (await db().query(sql, params)).rows; }
function ok(s) { return { success: true, stdout: s }; }
function err(e) { return { success: false, error: String(e) }; }

/** Inicia ligacao de voz. params: { to, assunto, reply_chat? } */
async function voiceCallPlace(params = {}) {
  try {
    const to = params.to || params.destinatario;
    const assunto = params.assunto || params.contexto || 'Chamada a pedido do owner.';
    const replyChat = params.reply_chat || params.replyChat || null;
    if (!to) return err('parametro "to" obrigatorio (nome do contato, numero ou jid)');
    const t = await resolveTarget(to);
    if (!t || t.unresolved) {
      return err(`destino nao resolvido: "${to}". candidatos: ${JSON.stringify((t && (t.contactHints || t.groupHints)) || [])}`);
    }
    // gate do Chat Registry (espelha o pre-voo do call-executor)
    const reg = await q(
      `SELECT role, canonical_name FROM chat_registry
       WHERE (kind='individual' AND (replace(chat_key,'@c.us','') = $1 OR replace(coalesce(phone_e164,''),'@c.us','') = $1 OR lower(canonical_name) = lower($2)))
          OR (kind='group' AND chat_key = $1) LIMIT 1`,
      [t.chatId, t.display]);
    if (!reg.length) return err(`destino "${t.display}" sem registro no Chat Registry — cadastre com whatsappAllowContact.`);
    if (reg[0].role !== 'allowed') return err(`destino "${t.display}" com role=${reg[0].role} no registry — owner precisa liberar.`);
    const brief = {
      destinatario: t.display,
      de: 'Luna (a pedido do owner)',
      assunto,
      objetivo: assunto,
      reply_chat: replyChat || t.display,
    };
    const cols = (await q(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='jobs'`)).map((r) => r.column_name);
    if (!cols.includes('job_type') || !cols.includes('payload')) return err('tabela jobs sem job_type/payload');
    const id = 'call-' + Date.now();
    const row = {};
    if (cols.includes('id')) row.id = id;
    row.job_type = 'voice.call';
    row.payload = JSON.stringify({ brief });
    if (cols.includes('status')) row.status = 'pending';
    if (cols.includes('idempotency_key')) row.idempotency_key = 'vc-' + id;
    if (cols.includes('attempts')) row.attempts = 0;
    const use = Object.keys(row);
    const ph = use.map((k, i) => (k === 'payload' ? `$${i + 1}::jsonb` : `$${i + 1}`));
    await db().query(
      `INSERT INTO jobs (${use.join(',')}) VALUES (${ph.join(',')})`,
      use.map((k) => row[k]));
    return ok(`📞 Ligacao iniciada para ${t.display} (${t.kind}). Roteiro: ${assunto.slice(0, 90)} — as transcricoes chegam AQUI neste chat; durante a chamada use callRespond pra falar.`);
  } catch (e) {
    return err(e);
  }
}

/** Encerra a chamada de voz ativa (a pedido do owner no chat). */
async function voiceCallEnd() {
  try {
    await db().query(`SELECT pg_notify('voice_call_control', 'end')`);
    return ok('📞 Encerrando a chamada ativa — o lado do operador/ChatGPT desliga junto.');
  } catch (e) { return err(e); }
}

module.exports = { voiceCallPlace, voiceCallEnd };
