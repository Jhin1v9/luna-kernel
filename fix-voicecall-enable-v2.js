#!/usr/bin/env node
/* fix-voicecall-enable-v2.js — liga VOICE_CALL_ENABLED=true + restart whatsplay
   v2: pm2 via cmd.exe /c (shim .cmd do Windows quebrava spawn direto),
   walk mais amplo (HOME inteiro), e diagnostico completo do pm2 no final. */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const HOME = process.env.USERPROFILE || process.env.HOME;
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function pm2(args) {
  // pm2 no Windows e um .cmd shim — spawn direto da ENOENT; vai por cmd.exe
  return execFileSync('cmd.exe', ['/c', 'pm2'].concat(args), { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}
function walkEnv(dir, depth, out) {
  if (depth < 0 || out.files.length > 60) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', '.pnpm-store', 'chrome-profile', 'sessions', 'AppData'].includes(e.name)) continue;
      walkEnv(p, depth - 1, out);
    } else if (e.isFile() && e.name === '.env' && /whatsplay/i.test(p)) {
      out.files.push(p);
    }
  }
}

// 1) localizar
console.log('=== 1) localizando .env do whatsplay ===');
let envFile = null;
const direct = [
  path.join(HOME, 'Documents', 'luna-agent', 'apps', 'whatsplay', '.env'),
  path.join(HOME, 'Documents', 'luna-agent', '.env'),
  path.join(HOME, 'luna-agent', 'apps', 'whatsplay', '.env'),
  path.join(HOME, 'Documents', 'luna-kernel', 'apps', 'whatsplay', '.env'),
  path.join(HOME, 'Documents', 'luna-kernel', '..', 'luna-agent', 'apps', 'whatsplay', '.env'),
];
for (const c of direct) { if (fs.existsSync(c)) { envFile = c; console.log('[OK] candidato direto: ' + c); break; } }

if (!envFile) {
  const out = { files: [] };
  walkEnv(path.join(HOME, 'Documents'), 5, out);
  walkEnv(HOME, 3, out);
  const uniq = [...new Set(out.files)];
  if (uniq.length) { envFile = uniq[0]; console.log('[OK] achado no walk: ' + envFile + (uniq.length > 1 ? ' (+' + (uniq.length - 1) + ' outros: ' + uniq.slice(1).join(', ') + ')' : '')); }
}

let pmName = null, pmCwd = null, pmList = [];
try {
  pmList = JSON.parse(pm2(['jlist']));
  console.log('[OK] pm2 respondeu — processos locais: ' + pmList.map(p => p.name).join(', '));
  const proc = pmList.find(p => /whatsplay|whats-play|wa-play/i.test(p.name || ''));
  if (proc) {
    pmName = proc.name;
    pmCwd = (proc.pm2_env && proc.pm2_env.pm_cwd) || null;
    console.log('[OK] processo whatsplay local: ' + pmName + (pmCwd ? ' (cwd: ' + pmCwd + ')' : ''));
    if (!envFile && pmCwd) {
      const c = path.join(pmCwd, '.env');
      if (fs.existsSync(c)) { envFile = c; console.log('[OK] .env via pm_cwd: ' + c); }
    }
  } else {
    console.log('[IMPORTANTE] whatsplay NAO roda nesta maquina (pm2 local) → ele ta na VPS. A env tem que ser setada la: ssh na VPS, edita o .env do whatsplay em /home/nexo/luna-agent/apps/whatsplay/.env e reinicia.');
  }
} catch (e) { console.log('[AVISO] pm2 jlist falhou: ' + e.message); }

// 2) gravar flag
console.log('=== 2) VOICE_CALL_ENABLED=true ===');
if (!envFile) {
  if (pmCwd) { envFile = path.join(pmCwd, '.env'); console.log('[INFO] .env nao existe — CRIANDO em: ' + envFile); }
  else { console.log('[FAIL] sem .env local e sem cwd local. Se o whatsplay for da VPS, faz la manual (ver aviso acima).'); process.exit(1); }
}
try {
  let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  if (/^VOICE_CALL_ENABLED=true\s*$/m.test(content)) {
    console.log('[OK] ja esta =true — nada a fazer');
  } else {
    if (fs.existsSync(envFile)) fs.copyFileSync(envFile, envFile + '.bak-' + ts);
    if (/^VOICE_CALL_ENABLED=/m.test(content)) {
      content = content.replace(/^VOICE_CALL_ENABLED=.*$/m, 'VOICE_CALL_ENABLED=true');
      console.log('[OK] linha atualizada p/ true');
    } else {
      content = content.replace(/\s*$/, '') + (content.trim() ? '\n' : '') + 'VOICE_CALL_ENABLED=true\n';
      console.log('[OK] linha adicionada');
    }
    fs.writeFileSync(envFile, content);
    console.log('[OK] escrito: ' + envFile + (fs.existsSync(envFile + '.bak-' + ts) ? ' | backup: .env.bak-' + ts : ''));
  }
} catch (e) { console.log('[FAIL] gravando .env: ' + e.message); process.exit(1); }

// 3) restart
console.log('=== 3) restart ===');
if (pmName) {
  try {
    spawn('cmd.exe', ['/c', 'pm2', 'restart', pmName], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    console.log('[OK] restart disparado: ' + pmName);
  } catch (e) { console.log('[AVISO] restart falhou: ' + e.message); }
} else if (!envFile) {
  console.log('[AVISO] sem processo local pra reiniciar (whatsplay na VPS)');
}

console.log('');
console.log('=== FIM ===');
