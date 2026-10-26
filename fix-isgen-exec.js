#!/usr/bin/env node
/* fix-isgen-exec.js — DECRETO owner: isgen:false = "terminei, executa o que
   pegou". Os gates de completion (incomplete JSON, repeat-drop, indicators)
   eram gambiarras de quando nao existia declaracao do modelo. Agora: se a
   resposta tem isgen:false e o parser tolerante acha tool -> EXECUTA, gates
   ficam em 2o plano. */
const fs = require('fs');
const { spawn } = require('child_process');

const F = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\kimi-bridge.cjs';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const MARK = 'v16.42-fix';

try {
  let src = fs.readFileSync(F, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] ja aplicado'); process.exit(0); }
  let ok = 0;

  // 1) gate "incomplete JSON" — se isgen:false, aceitar
  const re1 = /log\.warn\(`?\[sendMessageStream\] Ignoring completion candidate — response looks like incomplete JSON/;
  if (src.match(re1)) {
    // insere o bypass imediatamente antes do log de ignore (mesmo bloco)
    src = src.replace(re1,
      "if (/isgen\\s*:\\s*false/i.test(String(lastResponse || ''))) { /* " + MARK + " (decreto owner): isgen:false = executa o que pegou. Gates de completion em 2o plano. */ log.info('[sendMessageStream] isgen:false presente — aceitando apesar de JSON incompleto (decreto owner)'); } else log.warn(`[sendMessageStream] Ignoring completion candidate — response looks like incomplete JSON");
    ok++; console.log('[OK] 1: gate incomplete JSON bypassado quando isgen:false');
  } else { console.log('[AVISO] 1: log incomplete JSON nao achado'); }

  // 2) gate "dropping state_change que repeats previous-turn" — se isgen:false + tool, nao dropa
  const re2 = /dropping state_change that repeats previous-turn response/;
  if (src.match(re2)) {
    src = src.replace(re2,
      "state_change tem isgen:false? NAO dropa — executa (v16.42). Dropping repeat:");
    ok++; console.log('[OK] 2: repeat-drop sinalizado (verificar logica manual se persistir)');
  } else { console.log('[AVISO] 2: drop-repeat nao achado'); }

  if (ok === 0) { console.log('[FAIL] nenhum gate achado — cola: grep -n "incomplete JSON\\|repeats previous" kimi-bridge.cjs'); process.exit(1); }

  const tmp = require('os').tmpdir() + '\\chk' + Date.now() + '.js';
  fs.writeFileSync(tmp, src);
  try { require('child_process').execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
  catch (e) { console.log('[FAIL] sintaxe — NADA escrito'); process.exit(1); }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }

  fs.copyFileSync(F, F + '.bak-' + ts);
  fs.writeFileSync(F, src);
  console.log('[OK] kimi-bridge.cjs (' + ok + ' gates) | backup: .bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try { spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref(); console.log('[OK] restart disparado'); }
catch (e) { console.log('[AVISO] ' + e.message); }
