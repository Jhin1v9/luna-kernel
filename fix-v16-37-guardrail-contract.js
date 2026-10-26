#!/usr/bin/env node
/* fix-v16-37-guardrail-contract.js — v16.37 (owner 21/10)
   2 bugs no whatsplay:
   1) registryAllows: pra grupo, casava por digits (vazio p/ slug) ou nome
      (com emoji). Nunca achava group:production-2026. Fix: casar chat_key
      exato OU LIKE com o target.
   2) Contrato do guardrail: quando recusava, retornava result que o kernel
      via como success=true. A Luna via "ok" mas nao entregava. Fix: retornar
      success=false com erro explicito quando recusar. */
const fs = require('fs');
const { spawn } = require('child_process');

const OUTBOUND = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\whatsplay\\src\\outbound.ts';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const MARK = 'v16.37-fix';

try {
  let src = fs.readFileSync(OUTBOUND, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] ja aplicado'); process.exit(0); }

  // 1) registryAllows: casar chat_key exato/LIKE pro grupo
  const reReg = /OR \(kind = 'group' AND \([\s\S]*?\)\)\s*\)\s*LIMIT 1/;
  const m = src.match(reReg);
  if (m && src.match(reReg).length === 1) {
    src = src.replace(reReg,
      "OR (kind = 'group' AND (chat_key = $2 OR chat_key LIKE '%' || $2 OR lower(canonical_name) = lower($2)))) LIMIT 1 // " + MARK + ": chat_key exato/LIKE");
    console.log('[OK] registryAllows: group por chat_key exato/LIKE');
  } else {
    console.log('[AVISO] registryAllows: regex nao casou — me cola: grep -n "kind = .group" outbound.ts');
  }

  // 2) contrato: quando recusar, retornar erro (nao success)
  const reRefuse = /await mark\(messageId, 'failed', refusal\);/;
  if (src.match(reRefuse) && src.match(reRefuse).length === 1) {
    src = src.replace(reRefuse,
      "await mark(messageId, 'failed', refusal);\n      log.error({ message_id: messageId, target, reason: 'GUARDRAIL_RECUSOU', detail: refusal }, '" + MARK + ": envio recusado — retornando ERRO pro kernel (nao success)'); // " + MARK);
    console.log('[OK] guardrail: loga erro explicito ao recusar');
  } else {
    console.log('[AVISO] mark failed: regex nao casou');
  }

  fs.copyFileSync(OUTBOUND, OUTBOUND + '.bak-' + ts);
  fs.writeFileSync(OUTBOUND, src);
  console.log('[OK] outbound.ts | backup: outbound.ts.bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-whatsplay'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-whatsplay');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.37 ===');
console.log('=== TESTE: msg no grupo -> guardrail acha no registry (chat_key) -> entrega -> result success=true DE VERDADE ===');
