#!/usr/bin/env node
/* fix-guardrail-v16-41b.js — reaplica o registryAllows por $1 (target/slug),
   perdido no revert do outbound.ts pro backup pre-v16.41 (caos auto-repair).
   Sem auto-repair dessa vez. + contrato de erro (throw) no refusal. */
const fs = require('fs');
const { spawn } = require('child_process');

const F = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\whatsplay\\src\\outbound.ts';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const MARK = 'v16.41b-fix';

try {
  let src = fs.readFileSync(F, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] ja aplicado'); process.exit(0); }

  // T1: registryAllows group por $1 (target) — regex na query atual (pos-revert)
  const re1 = /OR \(kind = 'group' AND \(chat_key = \$2[^\n]*\n?[^\n]*LIMIT 1/;
  const m1 = src.match(re1);
  if (!m1) { console.log('[FAIL] T1: query group nao achada — cola: sed -n "13,32p" outbound.ts'); process.exit(1); }
  src = src.replace(re1,
    "OR (kind = 'group' AND (chat_key = $1 OR chat_key = $2 OR chat_key LIKE '%' || $1 OR chat_key LIKE '%' || $2 OR lower(canonical_name) = lower($2) OR lower(canonical_name) = lower($1)))) LIMIT 1 // " + MARK + ": group por target($1)/nome($2)");
  console.log('[OK] T1: registryAllows group por $1 (slug casa com chat_key)');

  // T2: throw no refusal (contrato de erro pro kernel)
  if (!src.includes("GUARDRAIL_RECUSOU")) {
    const re2 = /await mark\(messageId, 'failed', refusal\);/;
    if (src.match(re2)) {
      src = src.replace(re2,
        "await mark(messageId, 'failed', refusal);\n      throw new Error('GUARDRAIL_RECUSOU: ' + refusal); // " + MARK + ": erro real pro kernel");
      console.log('[OK] T2: refusal lanca erro (kernel ve, nao success fantasma)');
    } else { console.log('[AVISO] T2: mark failed nao achado (pode ja ter)'); }
  }

  fs.copyFileSync(F, F + '.bak-' + ts);
  fs.writeFileSync(F, src);
  console.log('[OK] outbound.ts | backup: outbound.ts.bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-whatsplay'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-whatsplay');
} catch (e) { console.log('[AVISO] ' + e.message); }

console.log('');
console.log('=== TESTE: pede no privado "manda de novo pro grupo" — o guardrail tem que LIBERAR ===');
console.log('pm2 logs luna-whatsplay --lines 20 --nostream | grep -aiE "guardrail|entreg|Production" | tail -6');
