#!/usr/bin/env node
/* fix-guardrail-v16-41c.js — registryAllows (versao pre-v16.17, pos-revert):
   pra grupo, $1 = DIGITS do target = vazio p/ slug -> nunca casava chat_key,
   e $2 = nome stale ("Produção 2026") != canonical_name ("🏆Production...").
   Fix: 3o param = target BRUTO (slug) e group casa chat_key = $3 / LIKE $3. */
const fs = require('fs');
const { spawn } = require('child_process');

const F = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\whatsplay\\src\\outbound.ts';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const MARK = 'v16.41c-fix';

try {
  let src = fs.readFileSync(F, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] ja aplicado'); process.exit(0); }

  // 1) group casa pelo target bruto ($3)
  const re1 = /OR \(kind = 'group' AND \(\s*\r?\n\s*lower\(canonical_name\) = lower\(\$2\)\s*\r?\n\s*OR replace\(chat_key, '@g\.us', ''\) = \$1\)\)/;
  if (!src.match(re1)) { console.log('[FAIL] 1: bloco group nao achado'); process.exit(1); }
  src = src.replace(re1,
    "OR (kind = 'group' AND (\n" +
    "            lower(canonical_name) = lower($2)\n" +
    "            OR replace(chat_key, '@g.us', '') = $1\n" +
    "            OR chat_key = $3 OR chat_key LIKE '%' || $3)) // " + MARK + ": group por target BRUTO (slug)");
  console.log('[OK] 1: group casa chat_key = $3 (target bruto/slug)');

  // 2) 3o parametro = target bruto
  const re2 = /\[digits, String\(allowTarget \?\? ''\)\]/;
  if (!src.match(re2)) { console.log('[FAIL] 2: params nao achados'); process.exit(1); }
  src = src.replace(re2, "[digits, String(allowTarget ?? ''), String(target ?? '')]");
  console.log('[OK] 2: params += target bruto');

  // 3) refusal lanca erro (contrato) se ainda nao tem
  if (!src.includes('GUARDRAIL_RECUSOU')) {
    const re3 = /await mark\(messageId, 'failed', refusal\);/;
    if (src.match(re3)) {
      src = src.replace(re3,
        "await mark(messageId, 'failed', refusal);\n      throw new Error('GUARDRAIL_RECUSOU: ' + refusal); // " + MARK + ": erro real pro kernel");
      console.log('[OK] 3: refusal lanca erro');
    }
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
console.log('=== TESTE: "manda de novo pro grupo" no privado ===');
console.log('pm2 logs luna-whatsplay --lines 20 --nostream | grep -aiE "guardrail|entreg" | tail -5');
