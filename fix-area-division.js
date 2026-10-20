#!/usr/bin/env node
/**
 * fix-area-division.js — divisao interna code/work nas sessoes do kernel (2026-10-20)
 *
 * Modelo de dados (decreto owner): DOIS eixos independentes, nao 4 modos planos:
 *   session.area = 'code' | 'work'   ← DE ONDE veio (textarea webchat vs orchestrator)
 *   session.mode = 'instant'|'thinking' ← raciocinio (ja existia; cada area escolhe o seu)
 *
 * POST /api/chat ja aceita sessionId e reutiliza sessao (memoria/DB) — a
 * persistencia da conversa work eh GRATIS. Este patch so adiciona a etiqueta:
 * o caller passa area:'work' e a sessao fica marcada (idempotente, default code).
 *
 * USO:  node fix-area-division.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const FILE = path.join(ROOT, 'apps', 'dashboard', 'luna-chat-routes.js');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!fs.existsSync(FILE)) { console.error('Nao encontrado: ' + FILE); process.exit(1); }
fs.copyFileSync(FILE, FILE + '.bak-' + ts);
let src = fs.readFileSync(FILE, 'utf8');
const isCrlf = src.includes('\r\n');
const norm = (s) => isCrlf ? s.replace(/\n/g, '\r\n') : s;

let patches = 0;
function rep(label, OLD, NEW) {
  const o = norm(OLD), n = norm(NEW);
  const count = src.split(o).length - 1;
  if (count !== 1) { console.error('[FALHOU] ' + label + ' — ' + count + 'x'); return false; }
  src = src.split(o).join(n);
  console.log('[OK] ' + label);
  patches++;
  return true;
}

if (src.includes('area = \'code\'') || src.includes("area = 'code'")) {
  console.log('[SKIP] ja aplicado');
} else {
  rep('P1: /api/chat aceita area no body',
`  const { message, sessionId, mode = 'instant', files, messageId: clientMessageId } = req.body;`,
`  // v16.0 — divisao interna code/work (decreto owner 20/10): area = de onde
  // veio ('code' = textarea do Luna Web | 'work' = orchestrator/whatsapp).
  // mode (instant/thinking) continua sendo o raciocinio — eixo independente,
  // cada area escolhe o seu. 4 combinacoes via aninhamento, zero modos planos.
  const { message, sessionId, mode = 'instant', files, messageId: clientMessageId, area = 'code' } = req.body;`);

  rep('P2: sessao marcada com area (criacao e reuso)',
`  if (!session) {
    session = createWebSession(message.slice(0, 40), mode, 'default', sessionId || undefined);
  }
  session.mode = goalCmd ? 'goal' : mode;`,
`  if (!session) {
    session = createWebSession(message.slice(0, 40), mode, 'default', sessionId || undefined);
  }
  session.area = area; // v16.0: etiqueta interna code/work (idempotente)
  session.mode = goalCmd ? 'goal' : mode;`);

  rep('P3: POST /api/chat/session tambem aceita area',
`    const session = createWebSession(title, mode, persona || 'default', undefined, provider);`,
`    // v16.0: area vem no body (default 'code'); orchestrator manda 'work'
    const session = createWebSession(title, mode, persona || 'default', undefined, provider);
    session.area = req.body?.area || 'code';`);
}

if (patches > 0) fs.writeFileSync(FILE, src);

try {
  execSync(`node --check "${FILE}"`, { encoding: 'utf8', stdio: 'pipe' });
  console.log('[OK] node --check passou');
} catch (e) {
  console.error('[FALHOU] sintaxe: ' + (e.stderr || e.message).split('\n').slice(0, 3).join(' | '));
  process.exit(1);
}

try { execSync('pm2 restart luna-kernel', { encoding: 'utf8' }); console.log('[OK] luna-kernel reiniciado'); }
catch { console.log('pm2 restart falhou'); }

console.log('');
console.log('\x1b[32m✅ DIVISAO CODE/WORK NO KERNEL.\x1b[0m');
console.log('   POST /api/chat e /api/chat/session aceitam area (default code).');
console.log('   Proximo: orchestrator manda {sessionId: "work-<conversa>", area: "work"}.');
console.log('\x1b[90mBackup: luna-chat-routes.js.bak-' + ts + '\x1b[0m');
