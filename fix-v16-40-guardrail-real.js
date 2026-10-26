#!/usr/bin/env node
/* v16.40 — corrige registryAllows (group por target) + deliverOne (recusa = erro real).
   Bug 1: registryAllows usava $2 (allowTarget=nome) pro group. Agora usa $1 (target=slug).
   Bug 2: deliverOne logava erro mas retornava void (kernel via success=true). Agora throw. */
const fs = require('fs');
const { spawn } = require('child_process');

const OUTBOUND = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\whatsplay\\src\\outbound.ts';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const MARK = 'v16.40-fix';

try {
  let src = fs.readFileSync(OUTBOUND, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] ja aplicado'); process.exit(0); }

  // T1: registryAllows — group casa por target ($1) também
  const re1 = /OR \(kind = 'group' AND \(chat_key = \$2 OR chat_key LIKE '%' \|\| \$2 OR lower\(canonical_name\) = lower\(\$2\)\)\)/;
  if (src.match(re1) && src.match(re1).length === 1) {
    src = src.replace(re1,
      "OR (kind = 'group' AND (chat_key = $1 OR chat_key = $2 OR chat_key LIKE '%' || $1 OR chat_key LIKE '%' || $2 OR lower(canonical_name) = lower($2) OR lower(canonical_name) = lower($1))) // " + MARK + ": group por target(slug) ou allowTarget(nome)");
    console.log('[OK] T1: registryAllows group por target/allowTarget');
  } else { console.log('[AVISO] T1: regex nao casou'); }

  // T2: deliverOne — quando recusar, THROW (nao so logar)
  const re2 = /await mark\(messageId, 'failed', refusal\);/;
  if (src.match(re2) && src.match(re2).length === 1) {
    src = src.replace(re2,
      "await mark(messageId, 'failed', refusal);\n      throw new Error('GUARDRAIL_RECUSOU: ' + refusal); // " + MARK + ": recusa = erro real pro kernel (nao success)");
    console.log('[OK] T2: recusa lanca excecao (kernel ve erro, nao success)');
  } else { console.log('[AVISO] T2: mark failed nao casou'); }

  fs.copyFileSync(OUTBOUND, OUTBOUND + '.bak-' + ts);
  fs.writeFileSync(OUTBOUND, src);
  console.log('[OK] outbound.ts | backup: outbound.ts.bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-whatsplay'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-whatsplay');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.40 ===');
console.log('=== TESTE: msg no grupo -> registryAllows acha (target slug) -> entrega -> result success=true REAL ===');
console.log('=== E se recusar: kernel ve ERRO (nao success falso) ===');
