#!/usr/bin/env node
/**
 * fix-work-prompt.js — v16.7 (decreto owner 20/10 23:05)
 * "Rebeldia" do work: o modelo respondia o usuário com TEXTO PURO em vez da
 * tool whatsappSendMessage (o histórico da thread ensinava o padrão errado),
 * repetia respostas quando o mesmo tool result chegava 2x (redelivery), e
 * inventou uma regra de horário que não existe nas tools (recusou envio).
 * Fix: 3 regras duras no PROTOCOLO DE SAÍDA do systemPrompt.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DOCS = 'C:\\Users\\Abner\\Documents';
const MARKER = 'v16.7-fix';
const ANCHOR = '- Responder alguém: {\\"tool\\": \\"whatsappSendMessage\\", \\"params\\": {\\"to\\": \\"NOME\\", \\"message\\": \\"texto\\"}}';
const RULES = [
  '- REGRA DE OURO DO CANAL WORK (' + MARKER + '): PROIBIDO responder o usuário com texto solto — toda resposta ao usuário É um whatsappSendMessage. Texto fora de tool é só raciocínio interno, nunca resposta final.',
  '- Se o MESMO tool result chegar de novo, isso é redelivery: NÃO repita nem reenvie a resposta anterior — aquela tool já está concluída. Siga em frente ou fique em silêncio.',
  '- Não invente regras (horário, permissão, decreto) que não existam nas suas tools: se a tool permitir, execute. Dúvida de regra = anote no brain e avise o owner via whatsappSendMessage.',
];

function ok(m) { console.log('[OK] ' + m); }
function warn(m) { console.log('[AVISO] ' + m); }
function bak(f) {
  const b = f + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(f, b);
  return b;
}
function* walk(dir, depth) {
  if (depth > 6) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (['node_modules', '.git', '.next', 'coverage'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, depth + 1);
    else if (e.name === 'luna-prompt-config.json') yield full;
  }
}

(async function main() {
  let touched = 0;
  for (const file of walk(DOCS, 0)) {
    try {
      const src = fs.readFileSync(file, 'utf8');
      if (src.includes(MARKER)) { ok('ja aplicado: ' + file); touched++; continue; }
      const firstAt = src.indexOf(ANCHOR);
      if (firstAt === -1) { warn('anchor nao achado: ' + file); continue; }
      const insertion = ANCHOR + '\\n' + RULES.map((r) => r.replace(/"/g, '\\"')).join('\\n');
      const out = src.slice(0, firstAt) + insertion + src.slice(firstAt + ANCHOR.length);
      try { JSON.parse(out); } catch { warn('JSON invalido apos patch — pulado: ' + file); continue; }
      const b = bak(file);
      fs.writeFileSync(file, out, 'utf8');
      ok('regras v16.7 inseridas: ' + file);
      ok('   backup: ' + path.basename(b));
      touched++;
    } catch (e) { warn('erro em ' + file + ': ' + e.message); }
  }
  if (!touched) { console.log('[FAIL] nada patchiado'); process.exit(1); }
  spawn('cmd.exe', ['/c', 'pm2 restart luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  spawn('cmd.exe', ['/c', 'pm2 restart luna-kimiweb'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  ok('restarts disparados');
  console.log('=== FIM ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
