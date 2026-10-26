#!/usr/bin/env node
/* fix-v16-51-search-results.js — openChat (browser.ts): o check de "busca vazia"
 * procurava resultados DENTRO de #pane-side/#side, mas o WA renderiza fora
 * (o proprio codigo admite no comentario do Enter) => hasResult sempre falso
 * => todo envio abortava com "busca SEM resultado". Agora detecta titulos de
 * resultado VISIVEIS na METADE ESQUERDA da tela (robusto a mudanca de DOM). */
const fs = require('fs'), path = require('path');
const HOME = process.env.HOME || process.env.USERPROFILE;
const f = path.join(HOME, 'Documents', 'Luna cto', 'luna-agent', 'apps', 'whatsplay', 'src', 'browser.ts');
if (!fs.existsSync(f)) { console.error('[FAIL] nao achado: ' + f); process.exit(1); }
let src = fs.readFileSync(f, 'utf8');
if (src.includes('v16.51-search-fix')) { console.log('[OK] v16.51 ja aplicado — idempotente'); process.exit(0); }
const bak = f + '.bak-search-' + Date.now();
fs.copyFileSync(f, bak);
const lines = src.split(/\r?\n/);
const s = lines.findIndex(l => l.includes('const searchEmpty = await evalWithArg('));
if (s < 0) { console.error('[FAIL] inicio do searchEmpty nao achado'); process.exit(1); }
let e = -1;
for (let k = s + 1; k < Math.min(s + 40, lines.length); k++) { if (lines[k].includes(').catch(() => false);')) { e = k; break; } }
if (e < 0) { console.error('[FAIL] fim do searchEmpty nao achado'); process.exit(1); }
const block = [
  '      const searchEmpty = await evalWithArg(',
  '        page,',
  '        `(_) => {',
  '          // v16.51-search-fix: o WA renderiza resultados FORA do #pane-side',
  '          // (mudanca 2026-09 ja documentada no caminho do Enter abaixo). A deteccao',
  '          // antiga ficou escopada no #pane-side => hasResult sempre falso =>',
  '          // todo envio abortava como "busca SEM resultado". Agora procura titulos',
  '          // de resultado VISIVEIS na METADE ESQUERDA da tela, independente do DOM.',
  '          const titles = Array.from(document.querySelectorAll(\'[data-testid="cell-frame-title"]\'));',
  '          const hasResult = titles.some((el) => {',
  '            const r = el.getBoundingClientRect();',
  '            return r.width > 0 && r.left < window.innerWidth / 2;',
  '          });',
  '          if (hasResult) return false;',
  '          const t = (document.body.textContent || \'\').toLowerCase();',
  "          const saidNone = t.includes('ningún chat') || t.includes('no se encontró') ||",
  "            t.includes('nenhum chat') || t.includes('nenhum resultado') ||",
  "            t.includes('no results found') || t.includes('no chats found');",
  '          return saidNone || !hasResult;',
  '        }`,',
  '        null,',
  '      ).catch(() => false);',
];
lines.splice(s, e - s + 1, ...block);
const out = lines.join('\n');
// validacao leve: backticks pares no trecho inserido + contagem global preservada
const bt = (out.match(/`/g) || []).length;
if (bt % 2 !== 0) { console.error('[FAIL] backticks desbalanceados apos patch (' + bt + ') — NADA escrito'); process.exit(1); }
fs.writeFileSync(f, out);
console.log('[OK] searchEmpty reescrito (linhas ' + (s + 1) + '..' + (e + 1) + ' — backup ' + bak + ')');
console.log('[NEXT] rm -rf "C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\node_modules\\.cache" "$TEMP/tsx" 2>/dev/null; pm2 restart luna-whatsplay; sleep 15');
console.log('[VALIDA] pm2 logs luna-whatsplay --lines 15 --nostream | grep -aiE "pronto|erro" | tail -3');
