#!/usr/bin/env node
/* fix-v16-17-registry-guardrail.js — v16.17-fix (owner 21/10)
   Guardrail do whatsplay passa a consultar o chat_registry (fonte canônica,
   mesma lógica do voiceCallPlace): destino com role=allowed no registry é
   liberado mesmo fora da env. Env vira override de emergência; sem env E sem
   registry = recusado com hint do decreto (fail-closed intacto).
   whatsappAllowContact já escreve no registry — o ciclo do decreto fecha. */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const OUTBOUND = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\whatsplay\\src\\outbound.ts';
const KERNEL_DIR = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const AGENT_DIR = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const MARK = 'v16.17-fix';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function count(src, a) { return src.split(a).length - 1; }

// ── T1: outbound.ts — registry como fonte canônica ──
try {
  let src = fs.readFileSync(OUTBOUND, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] T1 ja aplicado (' + MARK + ')'); }
  else {
    const a1 = "import { matchesAllowlist, parseAllowlist } from './allowlist.js';";
    if (count(src, a1) !== 1) { console.log('[FAIL] T1.a anchor ' + count(src, a1) + 'x'); throw new Error('T1a'); }
    src = src.replace(a1, a1 + "\n" +
      "\n" +
      "// " + MARK + " (owner 21/10): chat_registry é a fonte canônica da allowlist\n" +
      "// (decreto ADR-020 ciculado: whatsappAllowContact -> registry -> guardrail).\n" +
      "// Destino com role='allowed' no registry libera; env vira só override de emergência.\n" +
      "async function registryAllows(pool: any, target: any, allowTarget: any): Promise<boolean> {\n" +
      "  try {\n" +
      "    const digits = String(target ?? '').replace(/\\D/g, '');\n" +
      "    const { rows } = await pool.query(\n" +
      "      `SELECT 1 FROM chat_registry WHERE role = 'allowed' AND (\n" +
      "         (kind = 'individual' AND (\n" +
      "            replace(chat_key, '@c.us', '') = $1\n" +
      "            OR replace(coalesce(phone_e164, ''), '@c.us', '') = $1\n" +
      "            OR lower(canonical_name) = lower($2)))\n" +
      "         OR (kind = 'group' AND (\n" +
      "            lower(canonical_name) = lower($2)\n" +
      "            OR replace(chat_key, '@g.us', '') = $1))\n" +
      "       ) LIMIT 1`,\n" +
      "      [digits, String(allowTarget ?? '')]\n" +
      "    );\n" +
      "    return rows.length > 0;\n" +
      "  } catch { return false; }\n" +
      "}\n");

    const a2 = '    const refusal = (await refusedByAllowlist(allowTarget)) && !(await notifySendExempt(messageId, target))';
    if (count(src, a2) !== 1) { console.log('[FAIL] T1.b anchor ' + count(src, a2) + 'x'); throw new Error('T1b'); }
    src = src.replace(a2, '    let refusal = (await refusedByAllowlist(allowTarget)) && !(await notifySendExempt(messageId, target))');

    const a3 = '    if (refusal) {';
    if (count(src, a3) !== 1) { console.log('[FAIL] T1.c anchor ' + count(src, a3) + 'x'); throw new Error('T1c'); }
    src = src.replace(a3,
      "    // " + MARK + ": registry canônico — role=allowed libera; recusa ganha hint do decreto.\n" +
      "    if (refusal) {\n" +
      "      const registryHit = await registryAllows(pool, target, allowTarget);\n" +
      "      if (registryHit) refusal = null;\n" +
      "      else refusal = String(refusal) + ' — sem role=allowed no chat_registry (libere com whatsappAllowContact)';\n" +
      "    }\n" +
      a3);

    fs.copyFileSync(OUTBOUND, OUTBOUND + '.bak-' + ts);
    fs.writeFileSync(OUTBOUND, src);
    console.log('[OK] T1: guardrail consulta chat_registry (role=allowed) | backup: outbound.ts.bak-' + ts);
  }
} catch (e) { if (!String(e.message).startsWith('T1')) console.log('[FAIL] T1: ' + e.message); }

// ── T2: seed do owner no registry (best-effort, idempotente) ──
(async () => {
try {
  const ENV_FILES = [
    path.join(AGENT_DIR, '.env'),
    path.join(AGENT_DIR, 'apps', 'whatsplay', '.env'),
    path.join(KERNEL_DIR, '.env'),
  ];
  let url = null;
  for (const ef of ENV_FILES) {
    try {
      const txt = fs.readFileSync(ef, 'utf8');
      const m = txt.match(/^(?:DATABASE_URL|LUNA_DATABASE_URL)=(.+)$/m);
      if (m) { url = m[1].trim().replace(/^["']|["']$/g, ''); console.log('[OK] T2: DATABASE_URL vinda de ' + ef); break; }
    } catch (_) {}
  }
  if (!url) { console.log('[AVISO] T2: DATABASE_URL não achada nos .env — pulando seed (o protocolo automático do whatsappAllowContact cadastra no primeiro contato)'); }
  else {
    let pg = null;
    const cands = [
      process.env.LUNA_KERNEL_PG_PATH,
      path.join(KERNEL_DIR, 'apps', 'dashboard', 'node_modules', 'pg'),
    ].filter(Boolean);
    for (const c of cands) { try { pg = require(c); break; } catch (_) {} }
    if (!pg) { console.log('[AVISO] T2: módulo pg não achado — pulando seed'); }
    else {
      const pool = new pg.Pool({ connectionString: url });
      const r = await pool.query(
        `INSERT INTO chat_registry (chat_key, canonical_name, kind, role, phone_e164)
         VALUES ('34685093192@c.us', 'Abner', 'individual', 'allowed', '+34685093192')
         ON CONFLICT DO NOTHING RETURNING canonical_name`
      ).catch(e => ({ err: e.message }));
      if (r && r.err) console.log('[AVISO] T2: seed falhou (schema diverge?) — erro: ' + r.err.slice(0, 200) + ' — me cola que eu ajusto');
      else console.log('[OK] T2: owner (Abner +34 685 09 31 92) com role=allowed no registry' + (r && r.rows && r.rows.length ? '' : ' (já existia)'));
      await pool.end().catch(() => {});
    }
  }
} catch (e) { console.log('[AVISO] T2: ' + e.message); }
})().catch(e => console.log('[AVISO] T2: ' + e.message));

console.log('');
console.log('=== FIM v16.17 ===');
console.log('=== Agora: pm2 start all  (a frota tá quase toda parada) e teste de envio ===');
