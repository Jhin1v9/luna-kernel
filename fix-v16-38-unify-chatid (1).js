#!/usr/bin/env node
/* v16.38 — unifica RESPOSTA no chat_id da LEITURA + limpa dados.
   T1: resolveTarget consulta messages primeiro (chat_id estavel).
   T2: limpa registry (dedup, corrige kinds, normaliza chat_keys). */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const WT = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\whatsapp-tools.cjs';
const KERNEL_DIR = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const AGENT_DIR = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const MARK = 'v16.38-fix';

(async () => {
try {
  // ── T1: resolveTarget pela messages (fonte da leitura) ──
  let src = fs.readFileSync(WT, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] T1 ja aplicado'); }
  else {
    const anchor = /const n = normName\(raw\)\.toLowerCase\(\);\s*\n\s*const groups = await q\(/;
    const m = src.match(anchor);
    if (!m || src.match(anchor).length !== 1) { console.log('[FAIL] T1 anchor ' + (m ? src.match(anchor).length : 0) + 'x'); process.exit(1); }
    src = src.replace(anchor,
      "const n = normName(raw).toLowerCase();\n" +
      "  // " + MARK + " (owner 21/10): unifica RESPOSTA no chat_id que LEITURA usa.\n" +
      "  // Consulta messages PRIMEIRO (fonte da leitura) — achou, usa o chat_id de la.\n" +
      "  try {\n" +
      "    const msgMatch = await q(\n" +
      "      \"SELECT DISTINCT metadata->>'chat_id' as cid FROM messages WHERE lower(metadata->>'chat_name') = $1 OR lower(metadata->>'chat_name') LIKE $2 LIMIT 1\",\n" +
      "      [n, '%' + n + '%']\n" +
      "    );\n" +
      "    if (msgMatch.length && msgMatch[0].cid) {\n" +
      "      const cid = msgMatch[0].cid;\n" +
      "      if (cid.includes('@g.us') || cid.startsWith('group:')) {\n" +
      "        return { chatId: cid, kind: 'group', display: raw };\n" +
      "      }\n" +
      "      const digits = cid.replace(/\\D/g, '');\n" +
      "      if (digits.length >= 8) {\n" +
      "        return { chatId: digits + '@c.us', kind: 'individual', display: raw };\n" +
      "      }\n" +
      "    }\n" +
      "  } catch (_) {}\n" +
      "  const groups = await q(");
    fs.copyFileSync(WT, WT + '.bak-' + ts);
    fs.writeFileSync(WT, src);
    console.log('[OK] T1: resolveTarget consulta messages primeiro | backup: whatsapp-tools.cjs.bak-' + ts);
  }

  // ── T2: limpa registry (dedup, corrige kinds, normaliza) ──
  let url = null;
  for (const ef of [path.join(AGENT_DIR, '.env'), path.join(AGENT_DIR, 'apps', 'whatsplay', '.env'), path.join(KERNEL_DIR, '.env')]) {
    try { const m = fs.readFileSync(ef, 'utf8').match(/^(?:DATABASE_URL|LUNA_DATABASE_URL)=(.+)$/m); if (m) { url = m[1].trim().replace(/^["']|["']$/g, ''); break; } } catch (_) {}
  }
  let pg = null;
  for (const c of [path.join(KERNEL_DIR, 'apps', 'dashboard', 'node_modules', 'pg')]) { try { pg = require(c); break; } catch (_) {} }
  if (!url || !pg) { console.log('[AVISO] T2: sem conexao, pulando limpeza'); }
  else {
    const pool = new pg.Pool({ connectionString: url });
    // remove duplicatas e entradas invalidas
    const r1 = await pool.query(`DELETE FROM chat_registry WHERE chat_key = '34685093192'`).catch(e => ({ err: e.message }));
    if (r1.err) console.log('[AVISO] T2 del 34685093192: ' + r1.err.slice(0,100)); else console.log('[OK] T2: removido duplicado 34685093192 (sem @c.us)');
    const r2 = await pool.query(`DELETE FROM chat_registry WHERE chat_key LIKE '🏆%'`).catch(e => ({ err: e.message }));
    if (r2.err) console.log('[AVISO] T2 del emoji: ' + r2.err.slice(0,100)); else console.log('[OK] T2: removido individual com emoji (era grupo)');
    const r3 = await pool.query(`DELETE FROM chat_registry WHERE chat_key LIKE 'blocked:%'`).catch(e => ({ err: e.message }));
    if (r3.err) console.log('[AVISO] T2 del blocked: ' + r3.err.slice(0,100)); else console.log('[OK] T2: removido blocked:meu-amorzinho');
    // garante group:production-2026 allowed e com nome certo
    const r4 = await pool.query(`UPDATE chat_registry SET role='allowed', kind='group', canonical_name='🏆Production - 2026🙏🏻' WHERE chat_key='group:production-2026'`).catch(e => ({ err: e.message }));
    if (r4.err) console.log('[AVISO] T2 upd group: ' + r4.err.slice(0,100)); else console.log('[OK] T2: group:production-2026 allowed + nome emoji');
    await pool.end().catch(() => {});
  }

  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }
})();
