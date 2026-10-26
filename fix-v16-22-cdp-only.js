#!/usr/bin/env node
/* fix-v16-22-cdp-only.js — v16.22 (owner 21/10)
   DECRETO: cérebro da Luna = Playwright/CDP somente, sem API externa.
   Grava direto no .env do kernel (a mesma gravacao que o painel tenta,
   mas sem depender do roundtrip bugado do toggle — o kernel nem expõe
   o endpoint de leitura, entao o painel sempre re-renderiza ON).
   Cadeia resultante: painel(3101) -> kernel /v1 (127.0.0.1:3458, loopback)
   -> CDP/Playwright na aba Kimi do Chrome. */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const KERNEL_DIR = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const ENV_CANDIDATES = [
  path.join(KERNEL_DIR, '.env'),                          // raiz (onde DATABASE_URL mora — o live)
  path.join(KERNEL_DIR, 'packages', 'kernel', '.env'),    // cwd do processo
];

const SET = [
  ['LUNA_WEB_USE_AGENT_CONFIG', 'false', 'fora da roda da agent — modo manual'],
  ['LUNA_TRANSPORT', 'cdp', 'Playwright/CDP na aba Kimi do Chrome'],
  ['LUNA_API_BASE_URL', 'http://127.0.0.1:3458/v1', 'loopback do proprio kernel (zero API externa)'],
  ['LUNA_API_MODEL', 'kimi-for-coding', 'modelo selecionado no painel'],
  ['LUNA_API_KEY', '', 'sem key (local)'],
];
const REMOVE_KEYS = []; // LUNA_RODA_CONFIG nao removido — com USE_AGENT_CONFIG=false ele nem é consultado

function applyToContent(content) {
  let lines = content.split(/\r?\n/);
  const out = [];
  const done = new Set();
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)\s*=/);
    if (m) {
      const key = m[1];
      const hit = SET.find(([k]) => k === key);
      if (hit) { out.push(key + '=' + hit[1]); done.add(key); continue; }
      if (REMOVE_KEYS.includes(key)) { continue; }
    }
    out.push(line);
  }
  for (const [k, v] of SET) if (!done.has(k)) out.push(k + '=' + v);
  return out.join('\n') + '\n';
}

let wrote = false;
for (const envFile of ENV_CANDIDATES) {
  try {
    if (!fs.existsSync(envFile)) continue;
    const before = fs.readFileSync(envFile, 'utf8');
    const after = applyToContent(before);
    if (after !== before) {
      fs.copyFileSync(envFile, envFile + '.bak-' + ts);
      const tmp = envFile + '.tmp-' + Date.now();
      fs.writeFileSync(tmp, after);
      fs.renameSync(tmp, envFile);
      console.log('[OK] escrito: ' + envFile + ' | backup: .env.bak-' + ts);
      wrote = true;
    } else {
      console.log('[OK] ja estava correto: ' + envFile);
      wrote = true;
    }
  } catch (e) { console.log('[AVISO] ' + envFile + ': ' + e.message); }
}
if (!wrote) { console.log('[FAIL] nenhum .env encontrado em ' + KERNEL_DIR); process.exit(1); }

console.log('[OK] valores:');
for (const [k, v, why] of SET) console.log('     ' + k + '=' + v + '   # ' + why);

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.22 — cerebro = CDP/Playwright somente ===');
console.log('=== O "Failed to load config for roda" deve sumir do log do kernel ===');
console.log('=== PROXIMA cirurgia (v16.22b): endpoint GET /api/luna-web/providers no kernel ===');
console.log('=== pra o painel refletir o estado real e o toggle parar de voltar pra ON ===');
