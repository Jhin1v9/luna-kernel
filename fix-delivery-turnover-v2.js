#!/usr/bin/env node
/**
 * fix-delivery-turnover-v2.js — regra do owner SEM depender da maquinaria de UI (2026-10-20)
 *
 * Insight do owner (Instant mode NEM TEM thinking — a camada de detecção de
 * UI-state eh teatro): a v1 da regra ainda consultava domActionPromises, que
 * pode nao esvaziar mid-stream. A v2 depende SO dos fatos da entrega:
 *   - action_end acabou de ser yieldado pro frontend (SSE)  = entrega aconteceu
 *   - TODAS as tools do turno tem resultado (domActionResults.every(r => r.result))
 *     — entries nascem no inicio da execucao e so tem .result quando completam
 * => turno acabou. break. Sem consultar promise-array, isGen, spinner, quota.
 *
 * USO:  node fix-delivery-turnover-v2.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const FILE = path.join(ROOT, 'packages', 'kernel', 'luna-soul.cjs');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!fs.existsSync(FILE)) { console.error('Nao encontrado: ' + FILE); process.exit(1); }
fs.copyFileSync(FILE, FILE + '.bak-v2-' + ts);
let src = fs.readFileSync(FILE, 'utf8');
const isCrlf = src.includes('\r\n');
const norm = (s) => isCrlf ? s.replace(/\n/g, '\r\n') : s;

const OLD = `              if (__evt && __evt.type === 'action_end' && domActionPromises.length === 0 && domActionResults.length > 0) {
                __turnDeliveredByOwnerRule = __evt.tool || true;
              }`;

const NEW = `              // v2: so fatos — toda tool do turno completou (entry nasce no
              // inicio e so tem .result quando termina) + entrega acontecendo.
              if (__evt && __evt.type === 'action_end' && domActionResults.length > 0 && domActionResults.every(r => r && r.result !== undefined)) {
                __turnDeliveredByOwnerRule = __evt.tool || true;
              }`;

if (!src.includes('__turnDeliveredByOwnerRule')) {
  console.error('[FALHOU] v1 nao encontrada — roda fix-delivery-turnover.js primeiro');
  process.exit(1);
}
if (src.includes('v2: so fatos')) {
  console.log('[SKIP] v2 ja aplicado');
} else {
  const o = norm(OLD);
  const count = src.split(o).length - 1;
  if (count !== 1) { console.error('[FALHOU] ancora v1 ' + count + 'x'); process.exit(1); }
  fs.writeFileSync(FILE, src.replace(o, norm(NEW)));
  console.log('[OK] v2: regra depende so dos fatos (action_end + resultados completos)');
}

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
console.log('\x1b[32m✅ REGRA V2 — SÓ FATOS.\x1b[0m action_end no SSE + todas as tools com');
console.log('   resultado = turno encerrado. Zero consulta a UI-state.');
console.log('');
console.log('   Confere depois do teste:');
console.log('   grep -a "ENTREGA ACOMPLADA\\|TOOL_FINISHED\\|tool result ->" ~/.pm2/logs/luna-kernel-out.log | tail -8');
console.log('\x1b[90mBackup: luna-soul.cjs.bak-v2-' + ts + '\x1b[0m');
