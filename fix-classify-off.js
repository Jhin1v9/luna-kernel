#!/usr/bin/env node
/**
 * fix-classify-off.js — v16.9 (decreto owner 20/10 23:20)
 * Auto-classify DESLIGADO: a cada msg respondida o handler enfileirava
 * conversation.classify, que classificava o HISTORICO INTEIRO (sujo) de
 * novo, abria aba Kimi nova por execucao e spammava. Agora o sobe com
 * LUNA_CLASSIFY_ENABLED=1 no .env (reativar quando classificar so a
 * ultima troca). Tambem drena jobs classify pendentes.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const AGENT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const HANDLER = path.join(AGENT, 'apps', 'orchestrator', 'src', 'agent', 'handler.ts');
function ok(m) { console.log('[OK] ' + m); }
function warn(m) { console.log('[AVISO] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); process.exit(1); }
function bak(f) {
  const b = f + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(f, b);
  return b;
}

(async function main() {
  /* ---------- A) handler.ts: classify vira opt-in ---------- */
  console.log('=== A: auto-classify off ===');
  if (!fs.existsSync(HANDLER)) fail('nao achei handler.ts');
  const src = fs.readFileSync(HANDLER, 'utf8');
  if (src.includes('v16.9-fix')) {
    ok('A ja aplicado');
  } else {
    const NL = src.includes('\r\n') ? '\r\n' : '\n';
    const oldBlock = [
      '      // §27: classificação pós-conversa — job pro worker (cola, §7.12).',
      '      await enqueueJob(db, {',
      "        job_type: 'conversation.classify',",
      '        payload: {',
      '          conversation_id: conversationId,',
      '          client_id: event.client_id,',
      '          correlation_id: event.correlation_id,',
      '        },',
      '        idempotency_key: `classify:${event.event_id}`,',
      '      });',
    ].join(NL);
    if (src.split(oldBlock).length - 1 !== 1) fail('A anchor nao bate 1x — handler.ts mudou?');
    const newBlock = [
      '      // v16.9-fix (owner 20/10): auto-classify DESLIGADO por padrao —',
      '      // classificava o historico inteiro (sujo) a cada msg, abria aba',
      '      // nova por execucao e spammava. Reativar so quando o job classificar',
      '      // a ultima troca (nao o historico): LUNA_CLASSIFY_ENABLED=1 no .env.',
      "      if (process.env.LUNA_CLASSIFY_ENABLED === '1') {",
      '        await enqueueJob(db, {',
      "          job_type: 'conversation.classify',",
      '          payload: {',
      '            conversation_id: conversationId,',
      '            client_id: event.client_id,',
      '            correlation_id: event.correlation_id,',
      '          },',
      '          idempotency_key: `classify:${event.event_id}`,',
      '        });',
      '      }',
    ].join(NL);
    const out = src.replace(oldBlock, newBlock);
    const o = out.split('{').length - out.split('}').length;
    const p = out.split('(').length - out.split(')').length;
    if (o !== 0 || p !== 0) fail('A: desbalanceamento ({ ' + o + ', ( ' + p + ') — abortado');
    const b = bak(HANDLER);
    fs.writeFileSync(HANDLER, out, 'utf8');
    ok('A aplicado — classify sobe so com LUNA_CLASSIFY_ENABLED=1');
    ok('   backup: ' + path.basename(b));
  }

  /* ---------- B) drena jobs classify pendentes ---------- */
  console.log('');
  console.log('=== B: dreno dos jobs de classify pendentes ===');
  try {
    let pg = null;
    try { pg = require(path.join(AGENT, 'node_modules', 'pg')); } catch { }
    if (!pg) throw new Error('pg nao achado');
    let url = process.env.DATABASE_URL || '';
    for (const envf of [path.join(AGENT, '.env'), path.join(AGENT, 'apps', 'orchestrator', '.env')]) {
      if (url) break;
      try {
        for (const line of fs.readFileSync(envf, 'utf8').split(/\r?\n/)) {
          const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/);
          if (m) { url = m[1]; break; }
        }
      } catch { }
    }
    if (!url) throw new Error('DATABASE_URL nao achado');
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const has = await pool.query("SELECT to_regclass('jobs') AS t");
      if (!has.rows[0].t) { warn('tabela jobs nao existe — nada a drenar'); }
      else {
        const r = await pool.query(
          "UPDATE jobs SET status = 'done' WHERE job_type = 'conversation.classify' AND status <> 'done'"
        );
        ok('jobs classify marcados done: ' + r.rowCount);
      }
    } finally { await pool.end(); }
  } catch (e) { warn('B falhou (nao critico): ' + e.message.slice(0, 140)); }

  /* ---------- C) restarts ---------- */
  console.log('');
  console.log('=== C: restarts ===');
  for (const svc of ['luna-orchestrator', 'luna-worker']) {
    spawn('cmd.exe', ['/c', 'pm2 restart ' + svc], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    ok('restart: ' + svc);
  }
  console.log('=== ACABOU O SPAM DO CLASSIFICADOR. Testa: manda msg q nao abre aba de classify nova ===');
  console.log('=== FIM ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
