#!/usr/bin/env node
/* fix-v16-31b-error-feedback.js — v16.31b (owner 21/10)
   NADA de mastigar. Error feedback educativo: se whatsappSendMessage falhar
   com "nao encontrado", o erro volta dizendo que o nome estava errado e pra
   usar o nome EXATO do cabecalho [chat: X] ou listTools. O modelo APRENDE a
   usar o nome certo (do header, verdade) em vez do diretorio (stale).
   Substitui a mentalidade do v16.31 (normalizacao = mastigar). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const CFG = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\config\\luna-prompt-config.json';
const SOUL = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\luna-soul.cjs';
const MARK = 'v16.31b-fix';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
function syntaxCheckJS(src) {
  const tmp = path.join(os.tmpdir(), 'luna-check-' + Date.now() + '.js');
  fs.writeFileSync(tmp, src);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); return true; }
  catch (e) { return false; }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

// T1: error feedback no toolResultPrompt
try {
  const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  if (cfg.toolResultPrompt.includes(MARK)) { console.log('[OK] T1 ja aplicado'); }
  else {
    const add = '\n\nERRO = SEU, NAO MASTIGADO (' + MARK + '): se a tool falhou com "nao encontrado no diretorio", o nome que voce usou estava ERRADO. Use o nome EXATO do cabecalho [chat: X | autor: Y] como "to" — NAO invente, NAO use nome do diretorio se diferente. Se nao sabe o nome certo, rode whatsappListGroups ou whatsappListContacts pra ver o real. O nome do grupo no cabecalho e a verdade.';
    cfg.toolResultPrompt += add;
    const novo = JSON.stringify(cfg, null, 2); JSON.parse(novo);
    fs.copyFileSync(CFG, CFG + '.bak-' + ts);
    fs.writeFileSync(CFG, novo);
    console.log('[OK] T1: error feedback educativo no toolResultPrompt | backup: luna-prompt-config.json.bak-' + ts);
  }
} catch (e) { console.log('[FAIL] T1: ' + e.message); }

// T2: reforco no systemPrompt (nome do header = verdade)
try {
  const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  if (cfg.systemPrompt.includes(MARK)) { console.log('[OK] T2 ja aplicado'); }
  else {
    const add = '\n\nNOME DE CHAT (' + MARK + '): o nome do chat no cabecalho [chat: X | autor: Y] e a VERDADE. O diretorio (whatsappListGroups/Contacts) pode estar stale. Se o "to" do whatsappSendMessage for rejeitado, voce usou o nome errado — use o EXATO do cabecalho.';
    cfg.systemPrompt += add;
    const novo = JSON.stringify(cfg, null, 2); JSON.parse(novo);
    fs.writeFileSync(CFG, novo);
    console.log('[OK] T2: nome do header = verdade (systemPrompt)');
  }
} catch (e) { console.log('[FAIL] T2: ' + e.message); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.31b — error feedback, nada mastigado ===');
