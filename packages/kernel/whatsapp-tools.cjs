'use strict';
/**
 * WhatsApp Tools — diretório, envio e onboarding de contatos (2026-10-14).
 *
 * Decreto owner (2026-10-14): a API "não entende o prompt" de WhatsApp porque
 * as tools antigas (dashboardSendWhatsApp) exigiam NÚMERO e não sabiam o que
 * existia no WhatsApp. Agora a Luna TEM:
 *   - whatsappListContacts / whatsappListGroups: VER o diretório (chat_registry
 *     + wa_group_members, colhidos do WhatsApp real pelo harvester)
 *   - whatsappGroupMembers: VER quem está num grupo
 *   - whatsappSendMessage: enviar pra NOME, jid ou número — grupo incluído
 *     (resolve o chat_key @g.us pelo registry; o whatsplay entrega por nome)
 *   - whatsallowContact (whatsappAllowContact): PROTOCOLO DE NOVO CONTATO —
 *     todo mundo que fala com a Luna no privado é perguntado o nome, entendido
 *     em contexto e ADICIONADO NA ALLOWLIST (decreto owner 2026-10-14)
 *
 * Fonte de dados: Postgres da Luna (mesmo esquema do whatsplay —
 * chat_registry, wa_group_members, conversations, messages).
 * Envio: MESMO protocolo do waSendDirect (kernel): get-or-create
 * org→client→conversation, INSERT outbound 'queued' + pg_notify('luna_outbound')
 * — o whatsplay consome a fila e entrega no WA Web.
 *
 * Contrato de retorno: { success, stdout } | { success:false, error }.
 */

const fs = require('fs');
const { execFile } = require('child_process');

// ── DB (pool próprio, sem ciclo com luna-tools.cjs) ──
let _pool = null;
function db() {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL || process.env.LUNA_DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não configurado no kernel (tools WhatsApp indisponíveis)');
  const candidates = [
    process.env.LUNA_KERNEL_PG_PATH,
    require('path').join(__dirname, '..', '..', 'apps', 'dashboard', 'node_modules', 'pg'),
    '/home/nexo/luna-kernel/apps/dashboard/node_modules/pg',
  ].filter(Boolean);
  let pg = null;
  for (const c of candidates) { try { pg = require(c); break; } catch { /* próximo */ } }
  if (!pg) throw new Error('módulo pg não encontrado');
  _pool = new pg.Pool({ connectionString: url });
  return _pool;
}
async function q(sql, params = []) { return (await db().query(sql, params)).rows; }

function ok(stdout) { return { success: true, stdout }; }
function err(error) { return { success: false, error: String(error) }; }

const LUNA_AGENT_ENV_CANDIDATES = [
  process.env.LUNA_AGENT_ENV_PATH,
  '/home/nexo/luna-agent/.env',
].filter(Boolean);
const PM2_BIN = process.env.LUNA_PM2_BIN || '/home/nexo/node24/bin/pm2';

function normName(s) { return String(s || '').replace(/[‪-‮‎‏]/g, '').trim(); }

// ── RESOLUÇÃO DE DESTINO ──
/** Resolve "to" (nome, jid ou número) → { chatId, kind, display }. */
async function resolveTarget(to) {
  const raw = String(to || '').trim();
  if (!raw) return null;

  // 1) jid direto
  if (raw.includes('@')) {
    return { chatId: raw, kind: raw.endsWith('@g.us') ? 'group' : 'individual', display: raw };
  }

  const digits = raw.replace(/\D/g, '');
  const soDigitos = /^[\d\s()+-]+$/.test(raw);

  // 2) dígitos puros → id de grupo (120363...) ou telefone
  if (soDigitos && digits.length >= 8) {
    if (digits.startsWith('120363') && digits.length >= 15) {
      // id de grupo puro → confirmar no registry pra ter o jid exato
      const g = await q(
        "SELECT chat_key, canonical_name FROM chat_registry WHERE kind='group' AND (replace(chat_key,'@g.us','') = $1 OR chat_key = $1 || '@g.us') LIMIT 1",
        [digits]
      );
      if (g.length) return { chatId: g[0].chat_key, kind: 'group', display: g[0].canonical_name };
      return { chatId: digits + '@g.us', kind: 'group', display: raw };
    }
    if (digits.length <= 15) {
      const ind = await q(
        "SELECT chat_key, canonical_name, phone_e164 FROM chat_registry WHERE kind='individual' AND (replace(coalesce(phone_e164,''),'@c.us','') = $1 OR replace(chat_key,'@c.us','') = $1) LIMIT 1",
        [digits]
      );
      if (ind.length) return { chatId: digits, kind: 'individual', display: ind[0].canonical_name };
      return { chatId: digits, kind: 'individual', display: raw };
    }
  }

  // 3) nome → registry (grupo primeiro, depois individual)
  const n = normName(raw).toLowerCase();
  // v16.38-fix (owner 21/10): unifica RESPOSTA no chat_id que LEITURA usa.
  // Consulta messages PRIMEIRO (fonte da leitura, solida) — achou o nome
  // la, usa o chat_id de la (estavel, nao muda com emoji). Nao achou,
  // cai no registry abaixo (comportamento atual, nao quebra).
  try {
    const msgMatch = await q(
      "SELECT DISTINCT metadata->>'chat_id' as cid FROM messages WHERE lower(metadata->>'chat_name') = $1 OR lower(metadata->>'chat_name') LIKE $2 LIMIT 1",
      [n, '%' + n + '%']
    );
    if (msgMatch.length && msgMatch[0].cid) {
      const cid = msgMatch[0].cid;
      if (cid.includes('@g.us') || cid.startsWith('group:')) {
        return { chatId: cid, kind: 'group', display: raw };
      }
      const digits = cid.replace(/\D/g, '');
      if (digits.length >= 8) {
        return { chatId: digits + '@c.us', kind: 'individual', display: raw };
      }
    }
  } catch (_) {}
  const groups = await q(
    "SELECT chat_key, canonical_name FROM chat_registry WHERE kind='group' AND lower(canonical_name) = $1 LIMIT 1",
    [n]
  );
  if (groups.length) return { chatId: groups[0].chat_key, kind: 'group', display: groups[0].canonical_name };
  const gLike = await q(
    "SELECT chat_key, canonical_name FROM chat_registry WHERE kind='group' AND lower(canonical_name) LIKE $1 ORDER BY length(canonical_name) LIMIT 3",
    ['%' + n + '%']
  );
  if (gLike.length === 1) return { chatId: gLike[0].chat_key, kind: 'group', display: gLike[0].canonical_name };

  const inds = await q(
    "SELECT chat_key, canonical_name, phone_e164 FROM chat_registry WHERE kind='individual' AND (lower(canonical_name) = $1 OR lower(coalesce(display_hint,'')) = $1) LIMIT 1",
    [n]
  );
  if (inds.length && inds[0].phone_e164) {
    return { chatId: inds[0].phone_e164.replace('@c.us', ''), kind: 'individual', display: inds[0].canonical_name };
  }
  const iLike = await q(
    "SELECT chat_key, canonical_name, phone_e164 FROM chat_registry WHERE kind='individual' AND lower(canonical_name) LIKE $1 AND phone_e164 IS NOT NULL ORDER BY length(canonical_name) LIMIT 3",
    ['%' + n + '%']
  );
  if (iLike.length === 1) {
    return { chatId: iLike[0].phone_e164.replace('@c.us', ''), kind: 'individual', display: iLike[0].canonical_name };
  }

  // nada achado → devolve candidatos pras dicas de erro
  return {
    unresolved: true, raw,
    groupHints: gLike.map((g) => g.canonical_name),
    contactHints: iLike.map((i) => i.canonical_name),
  };
}

// ── TOOLS ──

async function whatsappListContacts(params = {}) {
  try {
    const search = String(params.search || '').trim();
    let rows;
    if (search) {
      rows = await q(
        "SELECT canonical_name, display_hint, phone_e164, role FROM chat_registry WHERE kind='individual' AND lower(canonical_name) LIKE $1 ORDER BY canonical_name LIMIT 50",
        ['%' + search.toLowerCase() + '%']
      );
    } else {
      rows = await q(
        "SELECT canonical_name, display_hint, phone_e164, role FROM chat_registry WHERE kind='individual' ORDER BY canonical_name LIMIT 100"
      );
    }
    if (!rows.length) return ok('👤 Nenhum contato individual no diretório. O harvester roda 06:17/dia; contatos novos entram depois de falarem com a Luna ou via whatsappAllowContact.');
    const lines = rows.map((r) => {
      const tel = r.phone_e164 ? ` — ${r.phone_e164.replace('@c.us', '')}` : '';
      const hint = r.display_hint ? ` [${r.display_hint}]` : '';
      const blocked = r.role === 'blocked' ? ' 🚫' : '';
      return `- ${r.canonical_name}${hint}${tel}${blocked}`;
    });
    return ok(`👤 ${rows.length} contato(s) no diretório WhatsApp:\n${lines.join('\n')}\n\nPara enviar: whatsappSendMessage {"to": "NOME", "message": "..."}`);
  } catch (e) { return err(e.message); }
}

async function whatsappListGroups(params = {}) {
  try {
    const search = String(params.search || '').trim();
    let rows;
    if (search) {
      rows = await q(
        `SELECT g.chat_key, g.canonical_name, g.role,
                (SELECT count(*) FROM wa_group_members m WHERE m.group_jid = g.chat_key) AS membros
         FROM chat_registry g WHERE g.kind='group' AND lower(g.canonical_name) LIKE $1 ORDER BY g.canonical_name LIMIT 50`,
        ['%' + search.toLowerCase() + '%']
      );
    } else {
      rows = await q(
        `SELECT g.chat_key, g.canonical_name, g.role,
                (SELECT count(*) FROM wa_group_members m WHERE m.group_jid = g.chat_key) AS membros
         FROM chat_registry g WHERE g.kind='group' ORDER BY g.canonical_name LIMIT 100`
      );
    }
    if (!rows.length) return ok('👥 Nenhum grupo no diretório. O harvester roda 06:17/dia.');
    const lines = rows.map((r) => {
      const blocked = r.role === 'blocked' ? ' 🚫' : '';
      return `- ${r.canonical_name} (${r.membros} membros)${blocked}`;
    });
    return ok(`👥 ${rows.length} grupo(s) no diretório WhatsApp:\n${lines.join('\n')}\n\nPara enviar: whatsappSendMessage {"to": "NOME_DO_GRUPO", "message": "..."}\nPara ver membros: whatsappGroupMembers {"group": "NOME_DO_GRUPO"}`);
  } catch (e) { return err(e.message); }
}

async function whatsappGroupMembers(params = {}) {
  try {
    const group = String(params.group || '').trim();
    if (!group) return err('Informe o grupo: whatsappGroupMembers {"group": "Production"}');
    const g = await resolveTarget(group);
    if (!g || g.unresolved || g.kind !== 'group') {
      return err(`Grupo '${group}' não encontrado no diretório. Use whatsappListGroups para ver os grupos conhecidos.`);
    }
    const rows = await q(
      "SELECT member_name, member_jid, is_admin, is_superadmin FROM wa_group_members WHERE group_jid = $1 ORDER BY member_name LIMIT 200",
      [g.chatId]
    );
    if (!rows.length) return ok(`👥 Grupo '${g.display}' está no diretório mas ainda sem membros colhidos (harvester roda 06:17/dia).`);
    const lines = rows.map((r) => {
      const tel = r.member_jid ? ` — ${String(r.member_jid).replace('@c.us', '')}` : '';
      const adm = r.is_admin || r.is_superadmin ? ' ⭐' : '';
      return `- ${r.member_name || 'sem nome'}${tel}${adm}`;
    });
    return ok(`👥 ${rows.length} membro(s) de '${g.display}':\n${lines.join('\n')}`);
  } catch (e) { return err(e.message); }
}

async function whatsappClearQueue(params = {}) {
  // v16.50-clear-queue-v2: sem params = LISTA (nao apaga nada). modo:"uma"+id
  // apaga uma; modo:"chat"+chat apaga as de um chat; modo:"todas" zera tudo.
  // Resposta SEMPRE lista id + chat + previa do afetado.
  const safeJson = (s2) => { try { return JSON.parse(s2 || '{}'); } catch (_) { return {}; } };
  const prev = (r) => {
    const meta = safeJson(r.metadata);
    return (meta.owner ? String(meta.owner).toUpperCase() + ' | ' : '') + r.id + ' | ' + (meta.chat_name || meta.chat_id || '?') + ' | "' + String(r.body).slice(0, 80) + '"';
  };
  const NL = String.fromCharCode(10);
  const modo = String(params.modo || '');
  const id = String(params.id || '');
  const chat = String(params.chat || '');
  try {
    if (modo === 'todas') {
      const del = await q(
        "DELETE FROM messages WHERE direction='outbound' AND send_state <> 'delivered' RETURNING id, metadata, body",
        []
      );
      if (!del.length) return ok('[vazio] Fila ja estava vazia — nada a apagar.');
      return ok('[ZERADA] ' + del.length + ' mensagem(ns) apagada(s):' + NL + del.map(prev).join(NL));
    }
    if (modo === 'uma' && id) {
      const del = await q(
        "DELETE FROM messages WHERE id=$1 AND direction='outbound' AND send_state <> 'delivered' RETURNING id, metadata, body",
        [id]
      );
      if (!del.length) return err('id nao achado na fila (ou ja entregue): ' + id);
      return ok('[apagada 1]' + NL + prev(del[0]));
    }
    if (modo === 'chat' && chat) {
      const del = await q(
        "DELETE FROM messages WHERE direction='outbound' AND send_state <> 'delivered' AND metadata->>'chat_name' ILIKE $1 RETURNING id, metadata, body",
        ['%' + chat + '%']
      );
      if (!del.length) return ok('[vazio] Nenhuma mensagem pendente do chat "' + chat + '". Fila intacta.');
      return ok('[apagadas ' + del.length + ' do chat "' + chat + '"]' + NL + del.map(prev).join(NL));
    }
    const rows = await q(
      "SELECT id, metadata, body FROM messages WHERE direction='outbound' AND send_state <> 'delivered' ORDER BY id ASC LIMIT 50",
      []
    );
    if (!rows.length) return ok('[vazio] Fila outbound VAZIA — nada pendente.');
    const lista = rows.map((r, i) => '[' + (i + 1) + '] ' + prev(r)).join(NL);
    return ok('[fila ' + rows.length + ' pendente(s)]' + NL + lista + NL + NL + 'Apagar UMA: {"modo":"uma","id":"<uuid>"} | TODAS: {"modo":"todas"} | Por chat: {"modo":"chat","chat":"nome"}');
  } catch (e2) {
    return err('falha na operacao da fila: ' + (e2 && e2.message ? e2.message : e2));
  }
}
async function whatsappSendMessage(params = {}) {
  try {
    const to = params.to || params.contact || params.grupo || params.group || params.destinatario || '';
    const message = params.message || params.text || params.mensagem || '';
    if (!to || !message) return err('to e message são obrigatórios: whatsappSendMessage {"to": "Abner", "message": "oi"}');

    const target = await resolveTarget(to);
    if (!target) return err(`Destino vazio.`);
    if (target.unresolved) {
      let dica = `Destino '${target.raw}' não encontrado no diretório.`;
      if (target.groupHints?.length) dica += `\nGrupos parecidos: ${target.groupHints.join(', ')}`;
      if (target.contactHints?.length) dica += `\nContatos parecidos: ${target.contactHints.join(', ')}`;
      dica += '\nUse whatsappListContacts/whatsappListGroups para ver o que existe, ou whatsappAllowContact para cadastrar.';
      return err(dica);
    }

    const chatId = target.chatId;
    // Fila oficial: get-or-create org→client→conversation, INSERT queued + notify
    let org = await q("SELECT id FROM organizations WHERE slug='nexo' LIMIT 1");
    if (!org.length) org = await q("INSERT INTO organizations (name, slug) VALUES ('Nexo Digital','nexo') RETURNING id");
    let client = await q("SELECT id FROM clients WHERE code='whatsapp-direto' LIMIT 1");
    if (!client.length) client = await q("INSERT INTO clients (organization_id, name, code) VALUES ($1,'WhatsApp Direto','whatsapp-direto') RETURNING id", [org[0].id]);
    const convMeta = target.kind === 'group'
      ? JSON.stringify({ chat_id: chatId, chat_name: target.display })
      : JSON.stringify({ chat_id: chatId });
    let conv = await q("SELECT id FROM conversations WHERE channel='whatsapp' AND metadata->>'chat_id'=$1 LIMIT 1", [chatId]);
    if (!conv.length) {
      conv = await q(
        "INSERT INTO conversations (client_id, channel, subject, metadata) VALUES ($1,'whatsapp',$2,$3) RETURNING id",
        [client[0].id, `WhatsApp ${target.display || chatId}`, convMeta]
      );
    }
    const ins = await q(
      "INSERT INTO messages (conversation_id, direction, channel, sender, body, send_state, metadata) VALUES ($1,'outbound','whatsapp','luna',$2,'queued',$3) RETURNING id",
      [conv[0].id, String(message).slice(0, 900), JSON.stringify({ source: 'kernel-whatsapp-tools', chat_id: chatId, chat_name: target.display, owner: 'luna' })]
    );
    await q("SELECT pg_notify('luna_outbound', $1)", [String(ins[0].id)]);
    const tipo = target.kind === 'group' ? 'grupo' : 'contato';
    // v16.43-entrega-honesta: espera o status terminal REAL no banco (max ~20s)
    let finalState = null;
    for (let pollI = 0; pollI < 120; pollI++) {
      await new Promise(r => setTimeout(r, 500));
      const st = await q("SELECT send_state FROM messages WHERE id=$1", [ins[0].id]);
      const sv = st.length ? String(st[0].send_state || '') : '';
      if (sv && sv !== 'queued') { finalState = sv; break; }
    }
    if (/fail|error/i.test(finalState || '')) {
      return err(`❌ Entrega FALHOU pro ${tipo} '${target.display}' — whatsplay recusou/errou. NAO chegou no WhatsApp. Verifique allowlist/registry e tente novamente.`);
    }
    if (/deliver|sent|ok/i.test(finalState || '')) {
      return ok(`✅ Mensagem ENTREGUE no WhatsApp pro ${tipo} '${target.display}'.`);
    }
    return err(`⏳ Entrega pro ${tipo} '${target.display}' NAO CONFIRMADA em 60s — ainda processando na fila do whatsplay; NAO reenvie, confira o chat (status: ${finalState || 'sem resposta do whatsplay'}). Pode ter ido — confira o chat antes de repetir.`);
  } catch (e) { return err(`Envio falhou: ${e.message}`); }
}

async function whatsappAllowContact(params = {}) {
  try {
    const name = String(params.name || '').trim();
    const phone = String(params.phone || '').replace(/\D/g, '');
    const note = String(params.note || '').slice(0, 300);
    if (!name) return err('Informe o nome do contato.');

    // 1) allowlist no .env do luna-agent (ingest + outbound)
    let envPath = null;
    for (const p of LUNA_AGENT_ENV_CANDIDATES) {
      try { fs.accessSync(p); envPath = p; break; } catch { /* próximo */ }
    }
    let envOk = false;
    if (envPath) {
      const content = fs.readFileSync(envPath, 'utf8');
      const addToLine = (line, additions) => {
        const parts = line.split('=');
        if (parts.length < 2) return line;
        const key = parts[0];
        let val = parts.slice(1).join('=');
        // remove aspas envoltoras se houver
        const quoted = (val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"));
        if (quoted) val = val.slice(1, -1);
        for (const a of additions) {
          if (a && !val.split(',').map((s) => s.trim()).includes(a)) val = val ? val + ',' + a : a;
        }
        return key + '=' + val;
      };
      const lines = content.split('\n').map((line) => {
        if (line.startsWith('WHATSAPP_INGEST_ALLOWLIST=') || line.startsWith('WHATSAPP_OUTBOUND_ALLOWLIST=')) {
          envOk = true;
          return addToLine(line, [name, phone]);
        }
        return line;
      });
      fs.writeFileSync(envPath, lines.join('\n'));
    }

    // 2) registro no diretório (chat_registry)
    let regOk = false;
    try {
      const chatKey = phone ? phone + '@c.us' : name;
      await q(
        `INSERT INTO chat_registry (chat_key, kind, canonical_name, display_hint, role, phone_e164, resolved_by, note)
         VALUES ($1, 'individual', $2, $3, 'allowed', $4, 'luna-onboarding', $5)
         ON CONFLICT (chat_key, kind) DO UPDATE SET canonical_name=EXCLUDED.canonical_name, resolved_by=EXCLUDED.resolved_by, note=EXCLUDED.note`,
        [chatKey, name, note.slice(0, 80) || null, phone ? phone + '@c.us' : null, note || 'Adicionado via protocolo de onboarding da Luna']
      );
      regOk = true;
    } catch (e) { /* registry best-effort */ }

    // 3) restart do whatsplay pra aplicar a allowlist
    let restartOk = false;
    try {
      await new Promise((resolve, reject) => {
        execFile(PM2_BIN, ['restart', 'luna-whatsplay', '--update-env'], { timeout: 30000 }, (e, stdout, stderr) => {
          if (e) reject(new Error(stderr || e.message)); else resolve(stdout);
        });
      });
      restartOk = true;
    } catch (e) { /* restart best-effort — próximo ciclo pega */ }

    const partes = [
      `✅ '${name}'${phone ? ` (${phone})` : ''} adicionado à allowlist`,
      envOk ? 'env atualizado' : 'env NÃO encontrado (caminho do .env?)',
      regOk ? 'diretório atualizado' : 'diretório indisponível',
      restartOk ? 'whatsplay reiniciado' : 'whatsplay NÃO reiniciou (allowlist vale no próximo restart)',
    ];
    if (note) partes.push(`nota: ${note}`);
    return ok(partes.join(' · '));
  } catch (e) { return err(`Onboarding falhou: ${e.message}`); }
}

module.exports = {
  resolveTarget,
  whatsappListContacts,
  whatsappListGroups,
  whatsappGroupMembers,
  whatsappSendMessage,
  whatsappClearQueue,
  whatsappAllowContact,
};
