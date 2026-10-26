#!/usr/bin/env node
/* fix-v16-52-slug-group.js — grupos no formato 'group:<slug>' (padrao atual do
 * kernel) nao eram reconhecidos pelo isGroupJid (só via JID @g.us/120363) =>
 * resolução de nome pulada => openChat buscava o slug e abortava todo envio
 * em grupo. Agora: slug conta como grupo + resolve canonical_name do registry
 * ANTES do contact_name (verdade oficial, sem emoji mangled). Backup + idem. */
const fs = require('fs'), path = require('path');
const HOME = process.env.HOME || process.env.USERPROFILE;
const f = path.join(HOME, 'Documents', 'Luna cto', 'luna-agent', 'apps', 'whatsplay', 'src', 'outbound.ts');
if (!fs.existsSync(f)) { console.error('[FAIL] nao achado: ' + f); process.exit(1); }
let src = fs.readFileSync(f, 'utf8');
if (src.includes('v16.52-slug')) { console.log('[OK] v16.52 ja aplicado — idempotente'); process.exit(0); }
const bak = f + '.bak-slug-' + Date.now();
fs.copyFileSync(f, bak);
const lines = src.split(/\r?\n/);

// T1: isGroupJid ganha a condicao de slug + const slugMatch
const a = lines.findIndex(l => l.includes('const isGroupJid ='));
if (a < 0) { console.error('[FAIL] isGroupJid nao achado'); process.exit(1); }
let aEnd = -1;
for (let k = a + 1; k < Math.min(a + 8, lines.length); k++) { if (lines[k].trim().endsWith(';') && lines[k].includes('test(')) { aEnd = k; break; } }
if (aEnd < 0) { console.error('[FAIL] fim do isGroupJid nao achado'); process.exit(1); }
lines.splice(a, aEnd - a + 1,
  '    // v16.52-slug: grupos no formato \'group:<slug>\' (padrao atual do kernel)',
  '    // tambem sao grupo — antes o check so via JID e o slug ia cru pro openChat.',
  "    const slugMatch = /^group:/.test(row.conversation_chat_id ?? '') ? String(row.conversation_chat_id) : null;",
  '    const isGroupJid =',
  "      /@g\\.us$/.test(row.address ?? '') ||",
  "      /@g\\.us$/.test(row.conversation_chat_id ?? '') ||",
  "      /^120363\\d{9,}$/.test(row.conversation_chat_id ?? '') ||",
  '      !!slugMatch;');

// T2: resolucao — slug pelo registry ANTES do contact_name
const b = lines.findIndex(l => l.includes('let groupName: string | null = row.contact_name ?? null;'));
if (b < 0) { console.error('[FAIL] groupName nao achado'); process.exit(1); }
lines.splice(b, 1,
  '      // v16.52: slug resolve pelo registry PRIMEIRO (canonical_name = nome oficial',
  '      // intacto no banco, sem emoji mangled do extrator); contact_name pode ser stale.',
  '      let groupName: string | null = null;',
  '      if (slugMatch) {',
  '        try {',
  '          const reg = await pool.query<{ canonical_name: string }>(',
  "            `SELECT canonical_name FROM chat_registry WHERE kind = 'group' AND chat_key = $1 LIMIT 1`,",
  '            [slugMatch],',
  '          );',
  '          groupName = reg.rows[0]?.canonical_name ?? null;',
  '        } catch { groupName = null; }',
  '      }',
  '      if (!groupName) groupName = row.contact_name ?? null;');

const out = lines.join('\n');
// validacao leve: ocorrencias unicas dos marcadores
const c1 = (out.match(/v16\.52-slug/g) || []).length;
if (c1 !== 1) { console.error('[FAIL] marcador v16.52-slug ' + c1 + 'x (esperado 1)'); process.exit(1); }
const c2 = (out.match(/slugMatch/g) || []).length;
if (c2 < 4) { console.error('[FAIL] slugMatch so ' + c2 + 'x — splices incompletos'); process.exit(1); }
fs.writeFileSync(f, out);
console.log('[OK] v16.52 aplicado: isGroupJid reconhece slug + resolucao pelo registry (backup ' + bak + ')');
console.log('[NEXT] rm -rf "C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\node_modules\\.cache" "$TEMP/tsx" 2>/dev/null; pm2 restart luna-whatsplay; sleep 15');
console.log('[VALIDA] pm2 logs luna-whatsplay --lines 15 --nostream | grep -aiE "pronto|erro|syntax" | tail -4');
console.log('[ROLLBACK] se o boot quebrar: cp "' + bak + '" "' + f + '" && pm2 restart luna-whatsplay');
