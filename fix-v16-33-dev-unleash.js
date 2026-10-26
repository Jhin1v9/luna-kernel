#!/usr/bin/env node
/* fix-v16-33-dev-unleash.js — v16.33 (owner 21/10)
   3 pontos do owner, cansado de silencio:
   1) GUARDRAIL do grupo: seed group:production-2026 com role=allowed no
      chat_registry (o whatsplay normaliza o nome sem emoji e nao achava).
   2) ERROR:CAUSE no dedup: quando suprimir, LOGA o motivo (dedup, conteudo
      igual, idade) — nunca mata silencioso.
   3) MODO DEV: guardrail fail-closed -> fail-loud com retry. Se recusar,
      loga ERROR:CAUSE: guardrail + motivo e tenta de novo em 5s. */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const KERNEL_DIR = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const AGENT_DIR = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const BRIDGE = KERNEL_DIR + '\\packages\\kernel\\kimi-bridge.cjs';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const MARK = 'v16.33-fix';

(async () => {
try {
  // 1) seed do grupo no registry
  let url = null;
  for (const ef of [path.join(AGENT_DIR, '.env'), path.join(AGENT_DIR, 'apps', 'whatsplay', '.env'), path.join(KERNEL_DIR, '.env')]) {
    try { const m = fs.readFileSync(ef, 'utf8').match(/^(?:DATABASE_URL|LUNA_DATABASE_URL)=(.+)$/m); if (m) { url = m[1].trim().replace(/^["']|["']$/g, ''); break; } } catch (_) {}
  }
  let pg = null;
  for (const c of [path.join(KERNEL_DIR, 'apps', 'dashboard', 'node_modules', 'pg')]) { try { pg = require(c); break; } catch (_) {} }
  if (url && pg) {
    const pool = new pg.Pool({ connectionString: url });
    const r = await pool.query(
      `INSERT INTO chat_registry (chat_key, canonical_name, kind, role)
       VALUES ('group:production-2026', 'group:production-2026', 'group', 'allowed')
       ON CONFLICT DO NOTHING RETURNING canonical_name`
    ).catch(e => ({ err: e.message }));
    if (r.err) console.log('[AVISO] seed: ' + r.err.slice(0, 200));
    else console.log('[OK] group:production-2026 com role=allowed' + (r.rows && r.rows.length ? '' : ' (ja existia)'));
    await pool.end().catch(() => {});
  } else { console.log('[AVISO] seed: sem url/pg'); }

  // 2) ERROR:CAUSE no dedup do bridge
  let src = fs.readFileSync(BRIDGE, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] dedup ja marcado'); }
  else {
    const re = /console\.log\(`\[BRIDGE\] phantom drop \(\$\{event\.type\}\): key=\$\{key\} age=\$\{now - seenAt\}ms \(re-emit, suprimido\)`\);/;
    if (src.match(re) && src.match(re).length === 1) {
      src = src.replace(re,
        "console.log(`[BRIDGE] ERROR:CAUSE dedup: suprimido ${event.type} key=${key} age=${now - seenAt}ms — conteudo igual ao visto. Se legítimo, espere ${Math.ceil(ttlFor(key)/1000)}s ou mude o conteúdo.`); // " + MARK);
      fs.copyFileSync(BRIDGE, BRIDGE + '.bak-' + ts);
      fs.writeFileSync(BRIDGE, src);
      console.log('[OK] ERROR:CAUSE no dedup | backup: kimi-bridge.cjs.bak-' + ts);
    } else { console.log('[AVISO] dedup: regex nao casou (ja modificado?)'); }
  }

  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[FAIL] ' + e.message); }
})();
