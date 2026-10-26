#!/usr/bin/env node
/* fix-voicecall-enable.js — liga a chamada de voz (owner 21/10)
   1) acha o .env do whatsplay (walk no Documents + pm_cwd do processo pm2)
   2) grava VOICE_CALL_ENABLED=true (cria o .env se nao existir)
   3) restarta o processo whatsplay pra carregar a env
   Idempotente: se ja estiver =true, nao reescreve. Backup antes de mexer. */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const HOME = process.env.USERPROFILE || process.env.HOME;
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function walkEnvFiles(dir, depth, out) {
  if (depth < 0 || !out.dirs && out.files.length > 40) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', '.pnpm-store', 'chrome-profile', 'sessions'].includes(e.name)) continue;
      walkEnvFiles(p, depth - 1, out);
    } else if (e.isFile() && e.name === '.env' && /whatsplay/i.test(p)) {
      out.files.push(p);
    }
  }
}

// 1) achar o .env
console.log('=== 1) localizando .env do whatsplay ===');
let envFile = null;

// 1a) candidatos diretos
const direct = [
  path.join(HOME, 'Documents', 'luna-agent', 'apps', 'whatsplay', '.env'),
  path.join(HOME, 'Documents', 'luna-agent', '.env'),
  path.join(HOME, 'luna-agent', 'apps', 'whatsplay', '.env'),
  path.join(HOME, 'Documents', 'luna-kernel', 'apps', 'whatsplay', '.env'),
];
for (const c of direct) { if (fs.existsSync(c)) { envFile = c; console.log('[OK] candidato direto: ' + c); break; } }

// 1b) walk no Documents
if (!envFile) {
  const out = { files: [] };
  walkEnvFiles(path.join(HOME, 'Documents'), 5, out);
  if (out.files.length) { envFile = out.files[0]; console.log('[OK] achado no walk: ' + envFile + (out.files.length > 1 ? ' (+' + (out.files.length - 1) + ' outros)' : '')); }
}

// 1c) pm_cwd do processo pm2 whatsplay
let pmName = null, pmCwd = null;
try {
  const list = JSON.parse(execFileSync('pm2', ['jlist'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString());
  const proc = list.find(p => /whatsplay|whats-play|wa-play/i.test(p.name || ''));
  if (proc) {
    pmName = proc.name;
    pmCwd = (proc.pm2_env && proc.pm2_env.pm_cwd) || null;
    console.log('[OK] processo pm2: ' + pmName + (pmCwd ? ' (cwd: ' + pmCwd + ')' : ''));
    if (!envFile && pmCwd) {
      const c = path.join(pmCwd, '.env');
      if (fs.existsSync(c)) { envFile = c; console.log('[OK] .env via pm_cwd: ' + c); }
    }
  } else {
    console.log('[AVISO] nenhum processo pm2 com "whatsplay" no nome — pm2 list pra conferir');
  }
} catch (e) { console.log('[AVISO] pm2 jlist falhou: ' + e.message); }

// 2) gravar a flag
console.log('=== 2) VOICE_CALL_ENABLED=true ===');
if (!envFile) {
  if (pmCwd) { envFile = path.join(pmCwd, '.env'); console.log('[INFO] .env nao existe — vou CRIAR em: ' + envFile); }
  else { console.log('[FAIL] nao achei nem o .env nem o cwd do whatsplay. Rode "pm2 list" e me fala o nome do processo.'); process.exit(1); }
}
try {
  let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  if (/^VOICE_CALL_ENABLED=true\s*$/m.test(content)) {
    console.log('[OK] ja esta =true — nada a fazer');
  } else {
    if (fs.existsSync(envFile)) fs.copyFileSync(envFile, envFile + '.bak-' + ts);
    if (/^VOICE_CALL_ENABLED=/m.test(content)) {
      content = content.replace(/^VOICE_CALL_ENABLED=.*$/m, 'VOICE_CALL_ENABLED=true');
      console.log('[OK] linha existente atualizada p/ true');
    } else {
      content = content.replace(/\s*$/, '') + (content.trim() ? '\n' : '') + 'VOICE_CALL_ENABLED=true\n';
      console.log('[OK] linha adicionada');
    }
    fs.writeFileSync(envFile, content);
    console.log('[OK] escrito: ' + envFile + (fs.existsSync(envFile + '.bak-' + ts) ? ' | backup: .env.bak-' + ts : ''));
  }
  const tail = fs.readFileSync(envFile, 'utf8').trim().split('\n').slice(-3).join(' | ');
  console.log('[OK] tail do .env: ' + tail);
} catch (e) { console.log('[FAIL] gravando .env: ' + e.message); process.exit(1); }

// 3) restart
console.log('=== 3) restart do whatsplay ===');
if (pmName) {
  try {
    spawn('cmd.exe', ['/c', 'pm2', 'restart', pmName], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    console.log('[OK] restart disparado: ' + pmName);
  } catch (e) { console.log('[AVISO] restart falhou: ' + e.message + ' — rode manual: pm2 restart ' + pmName); }
} else {
  console.log('[AVISO] sem nome pm2 — rode manual: pm2 restart <nome-do-whatsplay>');
}

console.log('');
console.log('=== FIM — manda "luna liga pra mim. assunto: teste da chamada" e cola o que ela responder ===');
