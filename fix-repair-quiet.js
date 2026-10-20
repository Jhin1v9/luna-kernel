#!/usr/bin/env node
/**
 * fix-repair-quiet.js — v16.4 (owner 20/10)
 * Sessoes de diagnostico do auto-repair eram personas completas com tools:
 * analisavam a falha e MANDAVAM O DIAGNOSTICO PRO ZAP DO OWNER + abriam aba
 * Kimi nova a cada falha. Reforço de prompt: diagnostico e SILENCIOSO —
 * proibido usar tool, proibido enviar mensagem, saida = so o JSON.
 * Seguro: backup, idempotente (marker v16.4-fix), falha avisando.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\whatsplay\\src\\auto-repair.ts';

function ok(m) { console.log('[OK] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); }

(async function main() {
  if (!fs.existsSync(FILE)) { fail('nao achei ' + FILE); process.exit(1); }
  const NL = fs.readFileSync(FILE, 'utf8').includes('\r\n') ? '\r\n' : '\n';
  let src = fs.readFileSync(FILE, 'utf8');
  if (src.includes('v16.4-fix')) { ok('ja aplicado'); }
  else {
    const anchor = "    'Responda APENAS um JSON: {\"diagnosis\": \"causa provavel em uma frase\",";
    const real = '    \'Responda APENAS um JSON: {"diagnosis": "causa provável em uma frase",';
    const a = src.includes(real) ? real : (src.includes(anchor) ? anchor : null);
    if (!a) { fail('anchor do prompt nao bate — cola o trecho do ANALYSIS_PROMPT'); process.exit(1); }
    const add = [
      "    'REGRAS DURAS (v16.4-fix): voce e um diagnostico SILENCIOSO.',",
      "    'PROIBIDO usar qualquer tool. PROIBIDO enviar mensagem para qualquer',",
      "    'pessoa (inclusive o owner). PROIBIDO abrir chat ou chamar contato.',",
      "    'Sua unica saida e o JSON abaixo — nada de texto fora dele, nenhuma',",
      "    'acao externa. Seja invisivel.',",
    ].join(NL) + NL;
    src = src.replace(a, add + a);
    const b = FILE + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(FILE, b);
    fs.writeFileSync(FILE, src, 'utf8');
    ok('prompt de diagnostico reforcado (silencioso, sem tools, sem msgs)');
    ok('backup: ' + path.basename(b));
  }
  console.log('=== restart ===');
  const run = (c) => { try { execFileSync('cmd.exe', ['/c', c], { stdio: 'pipe' }); return true; } catch { return false; } };
  if (run('pm2 restart luna-whatsplay')) ok('luna-whatsplay reiniciado');
  else fail('restart manual: pm2 restart luna-whatsplay');
  console.log('=== FIM ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
