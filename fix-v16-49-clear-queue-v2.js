#!/usr/bin/env node
/* fix-v16-49-clear-queue-v2.js — whatsappClearQueue v2:
 * SEM params = LISTA a fila (nao apaga nada). modo:"uma"+id = apaga uma.
 * modo:"chat"+chat = apaga as de um chat. modo:"todas" = zera tudo.
 * Toda resposta lista id + chat + previa do afetado (owner: a IA tem que
 * saber o que apagou). Substitui a v1 (linha-a-linha) e atualiza o catalog. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const HOME = process.env.HOME || process.env.USERPROFILE;
const KDIR = path.join(HOME, 'Documents', 'luna-kernel', 'packages', 'kernel');
const wt = path.join(KDIR, 'whatsapp-tools.cjs');
const cat = path.join(KDIR, 'tool-catalog.cjs');
for (const fp of [wt, cat]) { if (!fs.existsSync(fp)) { console.error('[FAIL] nao achado: ' + fp); process.exit(1); } }
const ts = Date.now();

// ── whatsapp-tools.cjs: substitui a funcao v1 pela v2 ──
let src = fs.readFileSync(wt, 'utf8');
if (src.includes('v16.49-clear-queue-v2')) { console.log('[OK] whatsapp-tools ja tem a v2 — idempotente'); }
else {
  const bak = wt + '.bak-cqv2-' + ts;
  fs.copyFileSync(wt, bak);
  const lines = src.split(/\r?\n/);
  const s = lines.findIndex(l => l.includes('async function whatsappClearQueue'));
  if (s < 0) { console.error('[FAIL] whatsappClearQueue nao achada'); process.exit(1); }
  let e = -1;
  for (let k = s + 1; k < Math.min(s + 40, lines.length); k++) { if (lines[k].trim() === '}') { e = k; break; } }
  if (e < 0) { console.error('[FAIL] fim da funcao nao achado'); process.exit(1); }
  const fn = [
    'async function whatsappClearQueue(params = {}) {',
    '  // v16.49-clear-queue-v2: sem params = LISTA (nao apaga). modo:"uma"+id |',
    '  // modo:"chat"+chat | modo:"todas". Resposta SEMPRE lista id+chat+previa.',
    '  const safeJson = (s2) => { try { return JSON.parse(s2 || \'\'); } catch (_) { return {}; } };',
    '  const prev = (r) => {',
    '    const meta = safeJson(r.metadata);',
    "    return r.id + ' | ' + (meta.chat_name || meta.chat_id || '?') + ' | \"' + String(r.body).slice(0, 80) + '\"';",
    '  };',
    "  const modo = String(params.modo || '');",
    "  const id = String(params.id || '');",
    "  const chat = String(params.chat || '');",
    '  try {',
    "    if (modo === 'todas') {",
    '      const del = await q(',
    '        "DELETE FROM messages WHERE direction=\'outbound\' AND send_state <> \'delivered\' RETURNING id, metadata, body",',
    '        []',
    '      );',
    "      if (!del.length) return ok('🧹 Fila ja estava vazia — nada a apagar.');",
    "      return ok('🧹 Fila ZERADA — ' + del.length + ' mensagem(ns) apagada(s):\\n' + del.map(prev).join('\\n'));",
    '    }',
    "    if (modo === 'uma' && id) {",
    '      const del = await q(',
    '        "DELETE FROM messages WHERE id=$1 AND direction=\'outbound\' AND send_state <> \'delivered\' RETURNING id, metadata, body",',
    '        [id]',
    '      );',
    "      if (!del.length) return err('id nao achado na fila (ou ja entregue): ' + id);",
    "      return ok('🧹 Apagada 1 mensagem:\\n' + prev(del[0]));",
    '    }',
    "    if (modo === 'chat' && chat) {",
    '      const del = await q(',
    '        "DELETE FROM messages WHERE direction=\'outbound\' AND send_state <> \'delivered\' AND metadata->>\'chat_name\' ILIKE $1 RETURNING id, metadata, body",',
    "        ['%' + chat + '%']",
    '      );',
    "      if (!del.length) return ok('Nenhuma mensagem pendente do chat \"' + chat + '\". Fila intacta.');",
    "      return ok('🧹 Apagadas ' + del.length + ' do chat \"' + chat + '\":\\n' + del.map(prev).join('\\n'));",
    '    }',
    '    // padrao: LISTA sem apagar nada',
    '    const rows = await q(',
    '      "SELECT id, metadata, body FROM messages WHERE direction=\'outbound\' AND send_state <> \'delivered\' ORDER BY id ASC LIMIT 50",',
    '      []',
    '    );',
    "    if (!rows.length) return ok('✅ Fila outbound VAZIA — nada pendente.');",
    "    const lista = rows.map((r, i) => '[' + (i + 1) + '] ' + prev(r)).join('\\n');",
    "    return ok('📋 Fila outbound (' + rows.length + ' pendente(s)):\\n' + lista + '\\n\\nApagar UMA: {\"modo\":\"uma\",\"id\":\"<uuid>\"} | TODAS: {\"modo\":\"todas\"} | Por chat: {\"modo\":\"chat\",\"chat\":\"nome\"}');",
    '  } catch (e2) {',
    "    return err('falha na operacao da fila: ' + (e2 && e2.message ? e2.message : e2));",
    '  }',
    '}',
  ];
  lines.splice(s, e - s + 1, ...fn);
  const out = lines.join('\n');
  try { new vm.Script(out); } catch (err) { console.error('[FAIL] whatsapp-tools sintaxe quebrada — NADA escrito: ' + err.message); process.exit(1); }
  fs.writeFileSync(wt, out);
  console.log('[OK] whatsappClearQueue v2 aplicada no whatsapp-tools.cjs (backup: ' + bak + ')');
}

// ── tool-catalog.cjs: atualiza a entrada ──
let csrc = fs.readFileSync(cat, 'utf8');
if (csrc.includes('v16.49-clear-queue-v2') || csrc.includes('LISTA e ZERA')) { console.log('[OK] catalog ja tem a entrada v2 — idempotente'); }
else {
  const bak = cat + '.bak-cqv2-' + ts;
  fs.copyFileSync(cat, bak);
  const cl = csrc.split(/\r?\n/);
  const i = cl.findIndex(l => l.includes("{ name: 'whatsappClearQueue'"));
  if (i < 0) { console.error('[FAIL] entrada whatsappClearQueue nao achada no catalog'); process.exit(1); }
  const ind = (cl[i].match(/^\s*/) || [''])[0];
  cl[i] = ind + `{ name: 'whatsappClearQueue', desc: 'Fila outbound: SEM params = LISTA pendentes (id+chat+previa, nao apaga). modo:"uma"+id apaga uma; modo:"chat"+chat apaga de um chat; modo:"todas" ZERA tudo. Sempre mostra o que apagou.', params: ['modo?', 'id?', 'chat?'] }, // v16.49-clear-queue-v2`;
  const out = cl.join('\n');
  try { new vm.Script(out); } catch (err) { console.error('[FAIL] catalog sintaxe quebrada — NADA escrito: ' + err.message); process.exit(1); }
  fs.writeFileSync(cat, out);
  console.log('[OK] catalog atualizado (backup: ' + bak + ')');
}
console.log('[NEXT] pm2 restart luna-kernel && sleep 12');
