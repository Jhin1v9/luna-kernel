#!/usr/bin/env node
/* fix-v16-43-entrega-honesta.js — whatsappSendMessage so responde ok DEPOIS
 * que o whatsplay marcar o status terminal no banco (delivered/failed).
 * Fail-closed: nao confirmou = err. Idempotente, backup, valida sintaxe. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const HOME = process.env.HOME || process.env.USERPROFILE;
const f = path.join(HOME, 'Documents', 'luna-kernel', 'packages', 'kernel', 'whatsapp-tools.cjs');
if (!fs.existsSync(f)) { console.error('[FAIL] nao achado: ' + f); process.exit(1); }
const src = fs.readFileSync(f, 'utf8');
if (src.includes('v16.43-entrega-honesta')) { console.log('[OK] ja aplicado — idempotente'); process.exit(0); }
const crlf = src.includes('\r\n');
const N = crlf ? '\r\n' : '\n';
const bak = f + '.bak-entregahonesta-' + Date.now();
fs.copyFileSync(f, bak);
const anchor = "await q(\"SELECT pg_notify('luna_outbound', $1)\", [String(ins[0].id)]);";
const i = src.indexOf(anchor);
if (i < 0) { console.error('[FAIL] anchor pg_notify nao achado'); process.exit(1); }
const after = src.slice(i + anchor.length);
const tipoIdx = after.indexOf('const tipo = target.kind');
if (tipoIdx < 0 || tipoIdx > 600) { console.error('[FAIL] bloco const tipo nao achado perto do anchor'); process.exit(1); }
const marker = 'entrega no WA).`);';
const mIdx = after.indexOf(marker, tipoIdx);
if (mIdx < 0) { console.error('[FAIL] fim do return ok nao achado'); process.exit(1); }
const endPos = mIdx + marker.length;
const novo = [
  "    const tipo = target.kind === 'group' ? 'grupo' : 'contato';",
  "    // v16.43-entrega-honesta: espera o status terminal REAL no banco (max ~20s)",
  "    let finalState = null;",
  "    for (let pollI = 0; pollI < 40; pollI++) {",
  "      await new Promise(r => setTimeout(r, 500));",
  "      const st = await q(\"SELECT send_state FROM messages WHERE id=$1\", [ins[0].id]);",
  "      const sv = st.length ? String(st[0].send_state || '') : '';",
  "      if (sv && sv !== 'queued') { finalState = sv; break; }",
  "    }",
  "    if (/fail|error/i.test(finalState || '')) {",
  "      return err(`❌ Entrega FALHOU pro \${tipo} '\${target.display}' — whatsplay recusou/errou. NAO chegou no WhatsApp. Verifique allowlist/registry e tente novamente.`);",
  "    }",
  "    if (/deliver|sent|ok/i.test(finalState || '')) {",
  "      return ok(`✅ Mensagem ENTREGUE no WhatsApp pro \${tipo} '\${target.display}'.`);",
  "    }",
  "    return err(`⏳ Entrega pro \${tipo} '\${target.display}' NAO CONFIRMADA em 20s (status: \${finalState || 'sem resposta do whatsplay'}). Pode ter ido — confira o chat antes de repetir.`);"
].join(N);
const out = src.slice(0, i + anchor.length) + N + novo + after.slice(endPos);
try { new vm.Script(out); } catch (e) { console.error('[FAIL] sintaxe quebrada — NADA foi escrito: ' + e.message); process.exit(1); }
fs.writeFileSync(f, out);
console.log('[OK] v16.43-entrega-honesta aplicado');
console.log('[OK] backup: ' + bak);
console.log('[NEXT] pm2 restart luna-kernel');
