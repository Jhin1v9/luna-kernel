#!/usr/bin/env node
/**
 * fix-delivery-turnover.js — REGRA DO OWNER: entrega ao frontend = fim de turno (2026-10-20)
 *
 * Decreto owner (20/10): "enviou a tool pra Luna Web? entao isgen=false".
 * Implementado NO EVENTO REAL DE ENTREGA: o drain do eventBus que yielda o
 * action_end pro frontend (SSE) eh o momento exato em que o resultado chega
 * na Luna Web. A partir dai:
 *   - se nao ha execucoes pendentes (domActionPromises vazio) e houve tool
 *     de verdade (domActionResults nao vazio) -> O TURNO ACABOU
 *   - a soul encerra a stream (break) e cai no toolLoop, que devolve o
 *     resultado pro provider pelo mecanismo acoplado
 *   - estado de UI (isGen, spinner, indicador de quota) NAO TEM PODER DE VETO.
 *
 * Isso elimina a classe inteira de mortes por indicador fantasma: nao importa
 * mais o que a pagina mostra — a entrega eh fato, e fato encerra o turno.
 *
 * USO:  node fix-delivery-turnover.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const FILE = path.join(ROOT, 'packages', 'kernel', 'luna-soul.cjs');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!fs.existsSync(FILE)) { console.error('Nao encontrado: ' + FILE); process.exit(1); }
fs.copyFileSync(FILE, FILE + '.bak-' + ts);
let src = fs.readFileSync(FILE, 'utf8');
const isCrlf = src.includes('\r\n');
const norm = (s) => isCrlf ? s.replace(/\n/g, '\r\n') : s;

const OLD = `            // v10.13: Drain any completed background actions BEFORE processing stream event
            // This ensures action_end events reach the frontend as soon as tools complete
            while (eventBus.queue.length > 0) {
              yield eventBus.queue.shift();
            }`;

const NEW = `            // v10.13: Drain any completed background actions BEFORE processing stream event
            // This ensures action_end events reach the frontend as soon as tools complete
            let __turnDeliveredByOwnerRule = false;
            while (eventBus.queue.length > 0) {
              const __evt = eventBus.queue.shift();
              yield __evt;
              // ═══ REGRA DO OWNER (20/10): ENTREGA AO FRONTEND = FIM DE TURNO ═══
              // O action_end acabou de ser entregue a Luna Web (SSE). Se nao ha
              // execucoes pendentes e houve tool de verdade neste turno, o turno
              // ACABOU — encerrar a stream e cair no toolLoop (que devolve o
              // resultado ao provider pelo mecanismo acoplado). Estado de UI
              // (isGen, spinners, indicadores de quota) NAO tem poder de veto
              // sobre o fato da entrega. Isso mata a classe inteira de stalls
              // por indicador fantasma.
              if (__evt && __evt.type === 'action_end' && domActionPromises.length === 0 && domActionResults.length > 0) {
                __turnDeliveredByOwnerRule = __evt.tool || true;
              }
            }
            if (__turnDeliveredByOwnerRule) {
              console.log('[LUNA-SOUL] ENTREGA ACOMPLADA (decreto owner 20/10): action_end de "' + __turnDeliveredByOwnerRule + '" entregue ao frontend, zero pendentes — turno encerrado PELA ENTREGA; isGen/indicadores sem veto');
              break;
            }`;

if (src.includes('__turnDeliveredByOwnerRule')) {
  console.log('[SKIP] ja aplicado');
} else {
  const o = norm(OLD);
  const count = src.split(o).length - 1;
  if (count !== 1) { console.error('[FALHOU] ancora ' + count + 'x — me manda o output'); process.exit(1); }
  fs.writeFileSync(FILE, src.replace(o, norm(NEW)));
  console.log('[OK] regra do owner instalada no evento de entrega (action_end -> fim de turno)');
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
console.log('\x1b[32m✅ REGRA DO OWNER NO AR.\x1b[0m Nao eh heuristica, nao eh inferencia:');
console.log('   action_end entregue no SSE + zero pendencias = turno encerrado. Fim.');
console.log('');
console.log('   TESTE: reenvia o abusado. Deve aparecer no log:');
console.log('   "ENTREGA ACOMPLADA (decreto owner 20/10)" — e logo depois a cadeia');
console.log('   continua (tool result -> extensao -> proxima tool).');
console.log('\x1b[90mBackup: luna-soul.cjs.bak-' + ts + '\x1b[0m');
