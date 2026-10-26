#!/usr/bin/env node
/* v16.41 — registryAllows group por $1 (target/slug) + REMOVE auto-repair.
   1) registryAllows: group usa $1 (target slug), nao $2 (nome com emoji).
   2) auto-repair REMOVIDO: deixa de envolver o transport (comportamento direto). */
const fs = require('fs');
const { spawn } = require('child_process');

const OUTBOUND = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\whatsplay\\src\\outbound.ts';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const MARK = 'v16.41-fix';

try {
  let src = fs.readFileSync(OUTBOUND, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] ja aplicado'); process.exit(0); }

  // T1: registryAllows — group por $1 (target), nao $2 (allowTarget/nome)
  const re1 = /OR \(kind = 'group' AND \(chat_key = \$2 OR chat_key LIKE '%' \|\| \$2 OR lower\(canonical_name\) = lower\(\$2\)\)\)/;
  if (src.match(re1) && src.match(re1).length === 1) {
    src = src.replace(re1,
      "OR (kind = 'group' AND (chat_key = $1 OR chat_key LIKE '%' || $1 OR chat_key = $2 OR chat_key LIKE '%' || $2 OR lower(canonical_name) = lower($2) OR lower(canonical_name) = lower($1)))) // " + MARK + ": group por target($1)/allowTarget($2)");
    console.log('[OK] T1: registryAllows group por $1 (target slug)');
  } else { console.log('[AVISO] T1: regex nao casou (ja corrigido?)'); }

  // T2: REMOVE auto-repair — deixa de envolver o transport
  // remove o import
  const reImport = /import \{ withAutoRepair, type RepairableTransport \} from '\.\/auto-repair\.js';/;
  if (src.match(reImport)) {
    src = src.replace(reImport, "// " + MARK + ": auto-repair REMOVIDO (decreto owner)");
    console.log('[OK] T2a: import do auto-repair removido');
  }
  // remove o withAutoRepair(...) envolvendo o transport — procurar o uso
  const reWrap = /withAutoRepair\(\s*transport\s*,/g;
  if (src.match(reWrap)) {
    src = src.replace(reWrap, "/* " + MARK + " no-autorepair */ transport, //");
    console.log('[OK] T2b: withAutoRepair desativado');
  } else {
    // tenta outro padrao: const transport = withAutoRepair(...)
    const reWrap2 = /const\s+(\w+)\s*=\s*withAutoRepair\(/;
    if (src.match(reWrap2)) {
      src = src.replace(reWrap2, "const $1 = /* " + MARK + " no-autorepair */ (");
      console.log('[OK] T2b: withAutoRepair desativado (padrao 2)');
    } else {
      console.log('[AVISO] T2b: withAutoRepair nao achado — pode ja estar removido');
    }
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
console.log('=== FIM v16.41 ===');
console.log('=== registryAllows group por $1 + auto-repair REMOVIDO ===');
console.log('=== TESTE: msg no grupo -> registryAllows acha (chat_key = target) -> entrega -> success REAL ===');
