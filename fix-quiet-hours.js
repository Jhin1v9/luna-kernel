#!/usr/bin/env node
/**
 * fix-quiet-hours.js — QUIET HOURS 20:00->08:00 no orchestrator (2026-10-20)
 *
 * Decreto owner: fora do expediente (20h as 8h, local) a Luna NAO responde
 * clientes nem grupos no WhatsApp. Gate no inicio do processLocked (antes
 * de qualquer turno de IA). Bypass:
 *   - autor na allowlist (QUIET_HOURS_ALLOWED, ex.: Abner)
 *   - pedido explicito de humano (§8.1 — escalacao chama o time, nao é
 *     resposta a cliente)
 * Config via .env: QUIET_START_HOUR (20), QUIET_END_HOUR (8),
 * QUIET_HOURS_ALLOWED (nomes separados por virgula).
 *
 * USO:  node fix-quiet-hours.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const FILE = path.join(ROOT, 'apps', 'orchestrator', 'src', 'agent', 'handler.ts');
const ENV = path.join(ROOT, '.env');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ── 1. Patch no handler.ts ──
console.log('\x1b[36m=== 1/3 — patch no handler.ts ===\x1b[0m');
if (!fs.existsSync(FILE)) { console.error('  [FALHOU] nao encontrado: ' + FILE); process.exit(1); }
fs.copyFileSync(FILE, FILE + '.bak-' + ts);
let src = fs.readFileSync(FILE, 'utf8');
const isCrlf = src.includes('\r\n');
const norm = (s) => isCrlf ? s.replace(/\n/g, '\r\n') : s;

if (src.includes('isQuietHoursNow')) {
  console.log('  [SKIP] quiet hours ja instalado');
} else {
  // Patch A: helpers antes do createMessageHandler
  const A_OLD = 'export function createMessageHandler(deps: MessageHandlerDeps) {';
  const A_NEW = `// ── QUIET HOURS (decreto owner 20/10): fora de 20:00→08:00 (hora local)
// a Luna NÃO responde clientes nem grupos — segura tudo em silêncio até o
// fim da janela. Bypass: autor na allowlist (QUIET_HOURS_ALLOWED, ex.: o
// owner) e pedido explícito de humano (§8.1 — escalación chama o TIME,
// não é resposta a cliente, então passa).
const QUIET_START_HOUR = Number(process.env.QUIET_START_HOUR ?? 20);
const QUIET_END_HOUR = Number(process.env.QUIET_END_HOUR ?? 8);
function isQuietHoursNow(): boolean {
  const h = new Date().getHours();
  return QUIET_START_HOUR > QUIET_END_HOUR
    ? h >= QUIET_START_HOUR || h < QUIET_END_HOUR
    : h >= QUIET_START_HOUR && h < QUIET_END_HOUR;
}

export function createMessageHandler(deps: MessageHandlerDeps) {`;
  const aCount = src.split(norm(A_OLD)).length - 1;
  if (aCount !== 1) { console.error('  [FALHOU] ancora A ' + aCount + 'x'); process.exit(1); }
  src = src.replace(norm(A_OLD), norm(A_NEW));
  console.log('  [OK] helpers isQuietHoursNow instalados');

  // Patch B: gate no inicio do processLocked (apos `const text = ...`)
  const B_OLD = "    const text = payload.text ?? '';";
  const B_NEW = `    const text = payload.text ?? '';

    // QUIET HOURS (decreto owner 20/10) — 20:00→08:00: silêncio total para
    // clientes/grupos. Allowlist de autores e §8.1 (humano explícito) passam.
    if (isQuietHoursNow()) {
      const allowed = (process.env.QUIET_HOURS_ALLOWED ?? '')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const author = (payload.author_name ?? '').toLowerCase();
      if (!allowed.includes(author) && !isExplicitHumanRequest(text)) {
        log.info(
          { event_id: event.event_id, author: payload.author_name, is_group: payload.is_group === true },
          'QUIET HOURS — fora do expediente: mensagem segurada sem resposta (decreto owner 20/10)',
        );
        await recordAudit(db, {
          actor: 'orchestrator',
          action: 'agent.reply.quiet_hours_held',
          tool: 'message_handler',
          client_id: event.client_id,
          correlation_id: event.correlation_id,
          result: 'success',
          metadata: {
            event_id: event.event_id,
            author: payload.author_name ?? null,
            is_group: payload.is_group === true,
            text: text.slice(0, 120),
          },
        });
        return;
      }
    }`;
  const bCount = src.split(norm(B_OLD)).length - 1;
  if (bCount !== 1) { console.error('  [FALHOU] ancora B ' + bCount + 'x'); process.exit(1); }
  src = src.replace(norm(B_OLD), norm(B_NEW));
  fs.writeFileSync(FILE, src);
  console.log('  [OK] gate QUIET HOURS no inicio do processLocked');
}

// ── 2. Env vars ──
console.log('\n\x1b[36m=== 2/3 — env vars ===\x1b[0m');
const envAdds = [
  ['QUIET_START_HOUR', '20'],
  ['QUIET_END_HOUR', '8'],
  ['QUIET_HOURS_ALLOWED', 'Abner'],
];
let envContent = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
let added = 0;
for (const [k, v] of envAdds) {
  if (new RegExp('^' + k + '=', 'm').test(envContent)) {
    console.log('  [SKIP] ' + k + ' ja existe');
  } else {
    envContent += '\n# quiet hours (fix 2026-10-20) — fora dessa janela a Luna nao responde clientes/grupos\n' + k + '=' + v + '\n';
    added++;
    console.log('  [OK] ' + k + '=' + v);
  }
}
if (added > 0) {
  fs.copyFileSync(ENV, ENV + '.bak-' + ts);
  fs.writeFileSync(ENV, envContent);
}

// ── 3. Restart ──
console.log('\n\x1b[36m=== 3/3 — restart ===\x1b[0m');
try {
  execSync('pm2 restart luna-orchestrator --update-env', { encoding: 'utf8' });
  console.log('  [OK] luna-orchestrator reiniciado');
} catch { console.log('  [FALHOU] pm2 restart'); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  await sleep(9000);
  const list = execSync('pm2 list', { encoding: 'utf8' });
  for (const line of list.split('\n')) {
    if (/luna-orchestrator/.test(line)) console.log('  ' + line.trim());
  }
  const logs = execSync('pm2 logs luna-orchestrator --lines 8 --nostream', { encoding: 'utf8' });
  console.log('\n  ultimas linhas do orchestrator:');
  console.log(logs.trim().split('\n').slice(-8).map(l => '  ' + l).join('\n'));
  console.log('');
  console.log('\x1b[32m✅ QUIET HOURS NO AR: 20:00→08:00 silencio total (clientes E grupos).\x1b[0m');
  console.log('   Bypass: autores em QUIET_HOURS_ALLOWED (agora: Abner) + pedido explicito de humano.');
  console.log('   Depois das 08:00 ela volta a responder sozinha.');
  console.log('\x1b[90mBackups: handler.ts.bak-' + ts + ' / .env.bak-' + ts + '\x1b[0m');
})();
