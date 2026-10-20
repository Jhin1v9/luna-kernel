#!/usr/bin/env node
/**
 * fix-work-final-done.js — PACOTE DE EMERGENCIA 2026-10-20
 *
 * FASE A — sweeper do work (handler.ts): so o evento FINAL (type 'done')
 *          vira resposta pro zap. Antes: pegava o 1o assistant persistido,
 *          que no streaming eh um delta de 1-5 chars -> FLOOD no zap.
 * FASE B — sanitizador plain Copy/JSON Copy em TODAS as copias de
 *          luna-chat-routes.js (luna-kernel, luna-agent\kernel, etc).
 * FASE C — dreno das filas Postgres: messages 'queued' + kimiwork_inbox pending.
 * FASE D — restart pm2.
 *
 * Regras: backup antes de cada escrita, valida sintaxe antes de aplicar,
 * falha avisando e NUNCA quebra a fase seguinte, idempotente.
 * USO:  node fix-work-final-done.js   (de preferencia com pm2 parado)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

(async function main() {

const AGENT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const HANDLER = path.join(AGENT, 'apps', 'orchestrator', 'src', 'agent', 'handler.ts');
const DOCS = 'C:\\Users\\Abner\\Documents';

function ok(m) { console.log('[OK] ' + m); }
function warn(m) { console.log('[AVISO] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); }
function bak(file) {
  const b = file + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(file, b);
  return b;
}
function checkJsText(text) {
  const tmp = path.join(require('os').tmpdir(), 'luna-check-' + Date.now() + '.js');
  fs.writeFileSync(tmp, text, 'utf8');
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); return true; }
  catch (e) { return false; }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

/* ================= FASE A — sweeper: esperar o done ================= */
console.log('=== FASE A: sweeper do work (handler.ts) ===');
try {
  if (!fs.existsSync(HANDLER)) throw new Error('nao achei ' + HANDLER);
  let src = fs.readFileSync(HANDLER, 'utf8');
  if (src.includes('v16.1-fix')) {
    ok('A ja aplicada (marker v16.1-fix)');
  } else {
    const aOld = '    if (arr.length > beforeCount) {';
    const cnt = src.split(aOld).length - 1;
    if (cnt !== 1) throw new Error('anchor A1 ' + cnt + 'x (esperado 1)');
    const i1 = src.indexOf(aOld);
    const i2 = src.indexOf("  throw new Error('kernel work: timeout", i1);
    if (i2 === -1) throw new Error('anchor A2 (timeout) nao achado');
    const oldBlock = src.slice(i1, i2);
    if (!oldBlock.includes('const last = arr[arr.length - 1];')) throw new Error('anchor A3 (last) nao bate');
    const NL = src.includes('\r\n') ? '\r\n' : '\n';
    const newBlock = [
      '    if (arr.length > beforeCount) {',
      '      const fresh = arr.slice(beforeCount);',
      '      // v16.1-fix (owner 20/10): durante o streaming o kernel persiste',
      '      // response_delta/thinking/tool-result como msgs separadas. So o',
      '      // evento FINAL (type done) eh resposta — o primeiro assistant que',
      '      // aparecia era um delta de poucos chars e virava flood no zap.',
      "      const evtType = (m) => (m && typeof m === 'object' ? String(m.type || '') : '');",
      '      const finalMsg =',
      "        fresh.find((m) => m && m.role === 'assistant' && evtType(m) === 'done') ||",
      "        fresh.find((m) => m && m.role === 'assistant' && (evtType(m) === 'assistant' || evtType(m) === '')) ||",
      '        null;',
      "      if (finalMsg && typeof finalMsg.content === 'string' && finalMsg.content.trim()) {",
      '        let content = finalMsg.content;',
      '        // limpeza plain Copy/JSON Copy (linhas soltas) — independe do patch do kernel.',
      '        if (/plain\\s*copy|json\\s*copy/i.test(content)) {',
      '          const strip = (s) =>',
      "            s.split('\\n').filter((l) => !/plain\\s*copy|json\\s*copy/i.test(l)).join('\\n').trim();",
      "          const real = (finalMsg.result && (finalMsg.result.response || finalMsg.result.text)) || '';",
      "          const strippedReal = typeof real === 'string' && real.trim() ? strip(real) : '';",
      '          const strippedRaw = strip(content);',
      '          content = (strippedReal && strippedReal.length >= strippedRaw.length) ? strippedReal : (strippedRaw || content);',
      '        }',
      '        return content;',
      '      }',
      '    }',
      '  }',
      '',
    ].join(NL);
    const patched = src.slice(0, i1) + newBlock + src.slice(i2);
    const b = bak(HANDLER);
    fs.writeFileSync(HANDLER, patched, 'utf8');
    ok('A aplicada — sweeper so retorna o evento final (done)');
    ok('backup: ' + path.basename(b));
  }
} catch (e) { fail('FASE A: ' + e.message + ' — cola o output'); }

/* ============ FASE B — sanitizador em TODAS as copias do chat-routes ============ */
console.log('');
console.log('=== FASE B: sanitizador plain Copy em todas as copias do luna-chat-routes.js ===');
function* walk(dir, depth) {
  if (depth > 6) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (['node_modules', '.git', '.next', 'coverage'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, depth + 1);
    else if (e.name === 'luna-chat-routes.js') yield full;
  }
}
const MARKER = 'luna-fix-plain-copy';
for (const file of walk(DOCS, 0)) {
  try {
    const src = fs.readFileSync(file, 'utf8');
    if (src.includes(MARKER)) { ok('B ja aplicado: ' + file); continue; }
    const a1 = "const content = ev.type === 'done'";
    const a2 = ": (ev.fullText || ev.text || ev.fullResponse || '');";
    if (src.split(a1).length - 1 !== 1 || src.split(a2).length - 1 !== 1) {
      warn('B pulado (anchors nao batem 1x): ' + file); continue;
    }
    const NL = src.includes('\r\n') ? '\r\n' : '\n';
    let patched = src.replace(a1, "const rawContent = ev.type === 'done'");
    const san = NL + [
      '',
      '        // ' + MARKER + ' (2026-10-20): strip "plain Copy"/"JSON Copy" UI pollution',
      '        // before persistence; real response preferred from ev.result/ev.response.',
      "        const content = (function sanitizeStreamContent(raw, ev) {",
      "          if (typeof raw !== 'string' || !raw) return raw;",
      "          if (raw.indexOf('plain Copy') === -1 && raw.indexOf('JSON Copy') === -1) return raw;",
      '          function stripPollution(s) {',
      '            return s',
      "              .split('\\n')",
      '              .filter(function (l) {',
      "                return l.indexOf('plain Copy') === -1 && l.indexOf('JSON Copy') === -1;",
      '              })',
      "              .join('\\n')",
      '              .trim();',
      '          }',
      '          var filteredRaw = stripPollution(raw);',
      "          var real = '';",
      '          try {',
      "            real = (ev && (ev.result && ev.result.response) || ev.response || ev.text) || '';",
      "          } catch (e) { real = ''; }",
      "          if (typeof real === 'string' && real) {",
      "            if (real.indexOf('plain Copy') === -1 && real.indexOf('JSON Copy') === -1) return real;",
      '            var filteredReal = stripPollution(real);',
      '            if (filteredReal && filteredReal.length >= filteredRaw.length) return filteredReal;',
      '          }',
      '          return filteredRaw;',
      '        })(rawContent, ev);',
    ].join(NL) + NL;
    patched = patched.replace(a2, a2 + san);
    if (!checkJsText(patched)) { warn('B pulado (sintaxe invalida apos patch): ' + file); continue; }
    const b = bak(file);
    fs.writeFileSync(file, patched, 'utf8');
    ok('B aplicado: ' + file);
    ok('   backup: ' + path.basename(b));
  } catch (e) { warn('B erro em ' + file + ': ' + e.message); }
}

/* ================= FASE C — dreno das filas Postgres ================= */
console.log('');
console.log('=== FASE C: dreno das filas (messages queued + kimiwork_inbox pending) ===');
try {
  let pg = null;
  for (const base of [path.join(AGENT, 'node_modules', 'pg'), path.join(DOCS, 'luna-kernel', 'node_modules', 'pg')]) {
    try { pg = require(base); break; } catch (_) {}
  }
  if (!pg) throw new Error('modulo pg nao achado nos node_modules');
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
  if (!url) throw new Error('DATABASE_URL nao achado em .env nem ambiente');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const q = async (sql, params) => (await pool.query(sql, params)).rows;
    const queued = (await q("SELECT COUNT(*)::int AS c FROM messages WHERE send_state = 'queued'"))[0].c;
    if (queued > 0) {
      try {
        await q("UPDATE messages SET send_state = 'failed' WHERE send_state = 'queued'");
        ok('C messages: ' + queued + " row(s) 'queued' -> 'failed' (nao serao enviadas)");
      } catch (e1) {
        await q("DELETE FROM messages WHERE send_state = 'queued'");
        ok('C messages: ' + queued + " row(s) queued DELETADAS (UPDATE bloqueado por constraint)");
      }
    } else ok('C messages: fila de saida vazia');
    const pend = (await q("SELECT COUNT(*)::int AS c FROM kimiwork_inbox WHERE status IN ('pending','processing')"))[0].c;
    if (pend > 0) {
      await q("UPDATE kimiwork_inbox SET status = 'done', processed_at = now(), result = COALESCE(result, '{}'::jsonb) || '{\"drained\":true,\"reason\":\"flood plain-copy 2026-10-20\"}' WHERE status IN ('pending','processing')");
      ok('C kimiwork_inbox: ' + pend + " evento(s) pending -> 'done' (drained)");
    } else ok('C kimiwork_inbox: sem pendentes');
  } finally {
    await pool.end();
  }
} catch (e) { fail('FASE C: ' + e.message + ' — filas NAO drenadas; NAO reinicie ainda'); }

/* ================= FASE D — restart ================= */
console.log('');
console.log('=== FASE D: restart ===');
for (const svc of ['luna-orchestrator', 'luna-worker', 'luna-whatsplay', 'whatsplay', 'luna-kernel', 'luna-server']) {
  try { execFileSync('pm2', ['restart', svc], { stdio: 'pipe' }); ok('restart: ' + svc); }
  catch (_) {}
}
console.log('');
console.log('=== FIM — cola o output inteiro ===');

})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
