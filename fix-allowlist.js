#!/usr/bin/env node
/**
 * fix-allowlist.js — EMERGENCIA (owner 20/10 22:50)
 * GUARDRAIL recusou entrega pro Nonoke: allowlist tem "Enoque" (nome do chat)
 * mas o tool resolveu o contato pro numero +34689135159 — comparacao exata
 * falhou. Fix: adicionar o numero (e alias) ao WHATSAPP_OUTBOUND_ALLOWLIST
 * no .env do whatsplay + restart oculto.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const CANDIDATES = [
  path.join(ROOT, '.env'),
  path.join(ROOT, 'apps', 'whatsplay', '.env'),
];
const ADD = ['+34689135159', '34689135159', 'Enoque', 'Nonoke (Enoque)'];
const KEY = 'WHATSAPP_OUTBOUND_ALLOWLIST';

function ok(m) { console.log('[OK] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); process.exit(1); }

let touched = false;
for (const envf of CANDIDATES) {
  if (!fs.existsSync(envf)) { console.log('[AVISO] nao existe: ' + envf); continue; }
  const src = fs.readFileSync(envf, 'utf8');
  const lines = src.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.startsWith(KEY + '='));
  if (idx === -1) {
    lines.push(KEY + '=' + ADD.join(','));
    fs.writeFileSync(envf, lines.join('\r\n'), 'utf8');
    ok('linha criada em ' + envf);
    touched = true;
    continue;
  }
  const line = lines[idx];
  if (line.includes('+34689135159')) { ok('numero ja presente em ' + envf); continue; }
  const missing = ADD.filter((a) => !line.includes(a));
  lines[idx] = line + ',' + missing.join(',');
  fs.writeFileSync(envf, lines.join('\r\n'), 'utf8');
  ok('adicionado em ' + envf + ': ' + missing.join(', '));
  touched = true;
}
if (!touched) fail('nenhum .env tocado — verifique os caminhos');

spawn('cmd.exe', ['/c', 'pm2 restart luna-whatsplay'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
ok('pm2 restart disparado');
console.log('=== AGORA: peça pra Luna reenviar a msg pro Nonoke (a anterior foi recusada) ===');
console.log('=== FIM ===');
