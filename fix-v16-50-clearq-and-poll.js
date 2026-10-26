#!/usr/bin/env node
/* fix-v16-50-clearq-and-poll.js
 * A) whatsappClearQueue v2 (lista/uma/chat/todas, sempre mostra o que apagou)
 * B) poll de confirmacao da entrega: 20s -> 60s (o pipeline real leva 30-45s;
 *    timeout curto gerava "falhou" falso + reenvio duplicado da Luna)
 * Backup, idempotente, valida a funcao isolada + o arquivo inteiro. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const HOME = process.env.HOME || process.env.USERPROFILE;
const KDIR = path.join(HOME, 'Documents', 'luna-kernel', 'packages', 'kernel');
const wt = path.join(KDIR, 'whatsapp-tools.cjs');
const cat = path.join(KDIR, 'tool-catalog.cjs');
for (const fp of [wt, cat]) { if (!fs.existsSync(fp)) { console.error('[FAIL] nao achado: ' + fp); process.exit(1); } }
const ts = Date.now();

let src = fs.readFileSync(wt, 'utf8');

// ── B) poll 20s -> 60s (antes da funcao, string replacement unico) ──
if (src.includes('pollI < 120')) { console.log('[OK] poll ja em 60s — idempotente'); }
else if (src.includes('pollI < 40')) {
  src = src.replace('for (let pollI = 0; pollI < 40; pollI++) {', 'for (let pollI = 0; pollI < 120; pollI++) {');
  src = src.replace('NAO CONFIRMADA em 20s', 'NAO CONFIRMADA em 60s — ainda processando na fila do whatsplay; NAO reenvie, confira o chat');
  console.log('[OK] poll de confirmacao: 20s -> 60s + msg anti-reenvio');
} else { console.error('[FAIL] poll 40 iteracoes nao achado — arquivo diverge'); process.exit(1); }

// ── A) whatsappClearQueue v2 ──
if (src.includes('v16.49-clear-queue-v2') || src.includes('v16.50-clear-queue-v2')) { console.log('[OK] clearQueue v2 ja aplicada — idempotente'); }
else {
  const fnText = `async function whatsappClearQueue(params = {}) {
  // v16.50-clear-queue-v2: sem params = LISTA (nao apaga nada). modo:"uma"+id
  // apaga uma; modo:"chat"+chat apaga as de um chat; modo:"todas" zera tudo.
  // Resposta SEMPRE lista id + chat + previa do afetado.
  const safeJson = (s2) => { try { return JSON.parse(s2 || '{}'); } catch (_) { return {}; } };
  const prev = (r) => {
    const meta = safeJson(r.metadata);
    return r.id + ' | ' + (meta.chat_name || meta.chat_id || '?') + ' | "' + String(r.body).slice(0, 80) + '"';
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
}`;
  try { new vm.Script(fnText); } catch (e) { console.error('[FAIL] funcao nova invalida: ' + e.message); process.exit(1); }
  const lines = src.split(/\r?\n/);
  const s = lines.findIndex(l => l.includes('async function whatsappClearQueue'));
  if (s < 0) { console.error('[FAIL] whatsappClearQueue (v1) nao achada'); process.exit(1); }
  let e = -1;
  for (let k = s + 1; k < Math.min(s + 40, lines.length); k++) { if (lines[k].trim() === '}') { e = k; break; } }
  if (e < 0) { console.error('[FAIL] fim da funcao v1 nao achado'); process.exit(1); }
  lines.splice(s, e - s + 1, ...fnText.split('\n'));
  src = lines.join('\n');
}

try { new vm.Script(src); } catch (e) { console.error('[FAIL] whatsapp-tools inteiro invalido — NADA escrito: ' + e.message); process.exit(1); }
const bak = wt + '.bak-cq50-' + ts;
fs.copyFileSync(wt, bak);
fs.writeFileSync(wt, src);
console.log('[OK] whatsapp-tools.cjs gravado (backup: ' + bak + ')');

// ── catalog ──
let csrc = fs.readFileSync(cat, 'utf8');
const wantLine = ind => ind + '{ name: \'whatsappClearQueue\', desc: \'Fila outbound: SEM params = LISTA pendentes (id+chat+previa, nao apaga). modo:"uma"+id apaga uma; modo:"chat"+chat apaga de um chat; modo:"todas" ZERA tudo. Sempre mostra o que apagou.\', params: [\'modo?\', \'id?\', \'chat?\'] }, // v16.50-clear-queue-v2';
if (csrc.includes('v16.50-clear-queue-v2')) { console.log('[OK] catalog ja tem a entrada v2 — idempotente'); }
else {
  const cl = csrc.split(/\r?\n/);
  const i = cl.findIndex(l => l.includes("{ name: 'whatsappClearQueue'"));
  if (i < 0) { console.error('[WARN] entrada whatsappClearQueue nao achada no catalog — insira manualmente a linha:'); console.log(wantLine('    ')); }
  else {
    const ind = (cl[i].match(/^\s*/) || [''])[0];
    cl[i] = wantLine(ind);
    const out = cl.join('\n');
    try { new vm.Script(out); } catch (e) { console.error('[FAIL] catalog invalido — NADA escrito: ' + e.message); process.exit(1); }
    const cbak = cat + '.bak-cq50-' + ts;
    fs.copyFileSync(cat, cbak);
    fs.writeFileSync(cat, out);
    console.log('[OK] catalog atualizado (backup: ' + cbak + ')');
  }
}
console.log('[NEXT] pm2 restart luna-kernel && sleep 12');
