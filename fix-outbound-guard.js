#!/usr/bin/env node
/**
 * fix-outbound-guard.js — guarda de outbound no Postgres (owner 20/10)
 *
 * Dois danos cronicos, uma origem comum (sessao work reidrata e re-executa):
 * 1) "Sem resposta" do nada no zap = placeholder da UI webchat capturado
 *    como se fosse resposta -> virava mensagem outbound.
 * 2) Mensagem repetida minutos depois = reidratação de turno re-executando
 *    whatsappSendMessage (tool) -> segunda row identica na fila.
 *
 * Solucao na camada do banco (cobre TODA fonte de insert): trigger
 * BEFORE INSERT que marca 'failed' (nao envia) qualquer outbound:
 *   - corpo vazio / "Sem resposta" (placeholder)
 *   - identico (mesma conversa + mesmo body) nos ultimos 3 min
 * Idempotente: DROP TRIGGER IF EXISTS antes. Sem tocar em codigo TS.
 */
const fs = require('fs');
const path = require('path');

const AGENT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
function ok(m) { console.log('[OK] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); }

(async function main() {
  let pg = null;
  for (const base of [path.join(AGENT, 'node_modules', 'pg')]) {
    try { pg = require(base); break; } catch (_) {}
  }
  if (!pg) { fail('modulo pg nao achado'); process.exit(1); }
  let url = process.env.DATABASE_URL || '';
  for (const envf of [path.join(AGENT, '.env'), path.join(AGENT, 'apps', 'orchestrator', '.env'), path.join(AGENT, 'apps', 'whatsplay', '.env')]) {
    if (url) break;
    try {
      for (const line of fs.readFileSync(envf, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/);
        if (m) { url = m[1]; break; }
      }
    } catch (_) {}
  }
  if (!url) { fail('DATABASE_URL nao achado'); process.exit(1); }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(`
      CREATE OR REPLACE FUNCTION luna_outbound_guard() RETURNS trigger AS $t$
      BEGIN
        IF NEW.direction = 'outbound' AND NEW.send_state = 'queued' THEN
          IF NEW.body IS NULL OR btrim(NEW.body) = '' OR btrim(NEW.body) = 'Sem resposta' THEN
            NEW.send_state := 'failed';
            NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) || '{"guard":"placeholder_ou_vazio"}'::jsonb;
            RETURN NEW;
          END IF;
          IF EXISTS (
            SELECT 1 FROM messages
            WHERE conversation_id = NEW.conversation_id
              AND direction = 'outbound'
              AND body = NEW.body
              AND created_at > now() - interval '3 minutes'
            LIMIT 1
          ) THEN
            NEW.send_state := 'failed';
            NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) || '{"guard":"dedupe_3min"}'::jsonb;
            RETURN NEW;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $t$ LANGUAGE plpgsql;
    `);
    await pool.query('DROP TRIGGER IF EXISTS trg_outbound_guard ON messages');
    await pool.query(`CREATE TRIGGER trg_outbound_guard
      BEFORE INSERT ON messages
      FOR EACH ROW EXECUTE FUNCTION luna_outbound_guard();`);
    ok('trigger trg_outbound_guard ativa — placeholder e duplicata nunca mais sao enviados');

    // limpa o que ja escapou
    const c1 = (await pool.query("SELECT COUNT(*)::int AS c FROM messages WHERE send_state = 'queued'")).rows[0].c;
    if (c1 > 0) {
      await pool.query("UPDATE messages SET send_state = 'failed' WHERE send_state = 'queued'");
      ok(c1 + ' msg(s) queued antigas marcadas failed');
    }
    const c2 = (await pool.query("SELECT COUNT(*)::int AS c FROM kimiwork_inbox WHERE status IN ('pending','processing')")).rows[0].c;
    if (c2 > 0) {
      await pool.query("UPDATE kimiwork_inbox SET status = 'done', processed_at = now(), result = COALESCE(result, '{}'::jsonb) || '{\"drained\":true}' WHERE status IN ('pending','processing')");
      ok('kimiwork_inbox: ' + c2 + ' zerado(s)');
    }
    // diagnostico do corte de mensagem
    const rows = (await pool.query(
      "SELECT id, conversation_id, length(body) AS len, left(body, 40) AS inicio FROM messages WHERE direction = 'outbound' ORDER BY created_at DESC LIMIT 5"
    )).rows;
    console.log('');
    console.log('=== ultimas 5 outbound (diagnostico do corte) ===');
    for (const r of rows) console.log('  len=' + r.len + '  ' + r.inicio.replace(/\n/g, ' '));
  } finally {
    await pool.end();
  }
  console.log('=== FIM ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
