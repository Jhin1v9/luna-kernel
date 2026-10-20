#!/usr/bin/env node
/**
 * fix-webchat-plain-copy.js — luna-kernel
 * MATA A POLUICAO NA FONTE: luna-chat-routes.js
 *
 * O scan (luna-scan14.js) mostrou que o content calculado nas linhas ~600-606
 * vai direto pro addMessageToSession (~617), persistindo o lixo do
 * "plain Copy" / "JSON Copy" (texto da UI de thinking da Luna) na sessao.
 *
 * Este patch insere um sanitizador ENTRE o calculo do content e a persistencia:
 *   - se nao ha poluicao -> passa intacto (zero custo)
 *   - se ha poluicao -> tenta extrair o response real de ev.result/ev.response
 *   - se o real tambem esta poluido -> remove as linhas poluidas
 *
 * Seguro por padrao:
 *   - backup automatico (.bak-<timestamp>)
 *   - valida sintaxe com `node --check` num arquivo temporario ANTES de aplicar
 *   - se qualquer anchor nao bate 1x -> [FAIL] e NAO altera nada
 *   - tolera CRLF
 *   - idempotente (marker luna-fix-plain-copy)
 *
 * Uso (Git Bash, ~/Documents/luna-kernel):
 *   node fix-webchat-plain-copy.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MARKER = 'luna-fix-plain-copy';

// --- Localiza luna-chat-routes.js recursivamente a partir do cwd -------------
function findTarget(dir, depth) {
  if (depth > 6) return [];
  let out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out = out.concat(findTarget(full, depth + 1));
    else if (ent.name === 'luna-chat-routes.js') out.push(full);
  }
  return out;
}

const hits = findTarget(process.cwd(), 0);
if (hits.length === 0) {
  console.log('[FAIL] luna-chat-routes.js nao encontrado a partir de: ' + process.cwd());
  console.log('[FAIL] roda de dentro da pasta luna-kernel (onde fica o package.json).');
  process.exit(1);
}
if (hits.length > 1) {
  console.log('[FAIL] mais de um luna-chat-routes.js encontrado:');
  hits.forEach(function (h) { console.log('  - ' + h); });
  console.log('[FAIL] apaga os que nao sao o oficial e roda de novo.');
  process.exit(1);
}
const FILE = hits[0];

function ok(msg) { console.log('[OK] ' + msg); }
function fail(msg) {
  console.log('[FAIL] ' + msg);
  console.log('[FAIL] arquivo NAO alterado. Cola esse output que eu ajusto o padrao.');
  process.exit(1);
}

if (!fs.existsSync(FILE)) {
  console.log('[FAIL] luna-chat-routes.js nao encontrado em: ' + process.cwd());
  process.exit(1);
}

console.log('[OK] alvo: ' + FILE);
let src = fs.readFileSync(FILE, 'utf8');
const hadCRLF = src.indexOf('\r\n') !== -1;
const NL = hadCRLF ? '\r\n' : '\n';

// --- Idempotencia -------------------------------------------------------------
if (src.indexOf(MARKER) !== -1) {
  ok('patch ja aplicado (marker "' + MARKER + '" encontrado) — nada a fazer');
  process.exit(0);
}

// --- Anchor 1: renomeia `const content` -> `const rawContent` ------------------
const a1 = "const content = ev.type === 'done'";
const n1 = src.split(a1).length - 1;
if (n1 !== 1) {
  fail('anchor 1 ("const content = ev.type ...") encontrado ' + n1 + 'x (esperado 1x). Padrao do arquivo mudou?');
}
src = src.replace(a1, "const rawContent = ev.type === 'done'");

// --- Anchor 2: terminador do ternario -----------------------------------------
const a2 = ": (ev.fullText || ev.text || ev.fullResponse || '');";
const n2 = src.split(a2).length - 1;
if (n2 !== 1) {
  fail('anchor 2 (terminador do ternario) encontrado ' + n2 + 'x (esperado 1x).');
}

// --- Sanitizador a inserir -----------------------------------------------------
const sanitizer = [
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
  '          } catch (e) { real = \'\'; }',
  "          if (typeof real === 'string' && real) {",
  "            if (real.indexOf('plain Copy') === -1 && real.indexOf('JSON Copy') === -1) return real;",
  '            var filteredReal = stripPollution(real);',
  '            if (filteredReal && filteredReal.length >= filteredRaw.length) return filteredReal;',
  '          }',
  '          return filteredRaw;',
  '        })(rawContent, ev);',
  '',
].join(NL);

src = src.replace(a2, a2 + sanitizer);

// --- Validacao de sintaxe ANTES de tocar o original -----------------------------
const tmp = FILE + '.patch-check-' + Date.now() + '.js';
fs.writeFileSync(tmp, src, 'utf8');
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (e) {
  try { fs.unlinkSync(tmp); } catch (_) {}
  const detail = String((e && e.stderr) || e.message || e).slice(0, 600);
  fail('validacao de sintaxe FALHOU (node --check) — nada foi alterado. Detalhe: ' + detail);
}
try { fs.unlinkSync(tmp); } catch (_) {}

// --- Backup + aplica -------------------------------------------------------------
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const bak = FILE + '.bak-' + ts;
fs.copyFileSync(FILE, bak);
fs.writeFileSync(FILE, src, 'utf8');
ok('sanitizador inserido entre o calculo do content (~l.606) e addMessageToSession (~l.617)');
ok('backup: ' + path.basename(bak));

// --- Restart do servico (pm2 se disponivel) -------------------------------------
let restarted = false;
const attempts = [
  function () { execFileSync('pm2', ['restart', 'luna-orchestrator'], { stdio: 'pipe' }); },
  function () { execFileSync('cmd.exe', ['/c', 'pm2', 'restart', 'luna-orchestrator'], { stdio: 'pipe' }); },
];
for (const a of attempts) {
  if (restarted) break;
  try { a(); restarted = true; } catch (_) {}
}
if (restarted) ok('luna-orchestrator reiniciado (pm2)');
else console.log('[INFO] nao consegui reiniciar sozinho — roda: pm2 restart luna-orchestrator');

console.log('');
console.log('✅ FONTE SANITIZADA. Agora o webchat tambem para de mostrar "plain Copy",');
console.log('   e o fix-work-plain-copy.js vira so cinto-e-suspensorio no work.');
