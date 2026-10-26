#!/usr/bin/env node
/* fix-v16-30-group-chat-open.js — v16.30 (owner 21/10)
   RAIZ do "entrega no privado": openChatInner usava hdr.includes(want) pra
   decidir se o painel ja era o chat certo. Pra GRUPO, o header do WA renderiza
   "🏆Production - 2026🙏🏻 Abner" (preview de quem falou) — entao includes('Abner')
   = true pro painel ERRADO. Fix: pra nome de grupo (nao-jid), exigir que o
   header EXATO seja o nome (igualdade estrita), senao rebusca. */
const fs = require('fs');
const { spawn } = require('child_process');

const BROWSER = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\whatsplay\\src\\browser.ts';
const MARK = 'v16.30-fix';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

try {
  let src = fs.readFileSync(BROWSER, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] ja aplicado'); process.exit(0); }

  const anchor = '          earlyOk = typeof hdr === \'string\' && hdr.includes(want);';
  if (src.split(anchor).length - 1 !== 1) { console.log('[FAIL] anchor ' + (src.split(anchor).length - 1) + 'x'); process.exit(1); }

  src = src.replace(anchor,
    "          // " + MARK + " (owner 21/10): pra NOME de grupo (nao-jid), o header do WA\n" +
    "          // renderiza 'NOME_DO_GRUPO quem-falou' (preview). includes() casava o nome\n" +
    "          // do grupo com o preview do privado ('...Abner') e entregava errado.\n" +
    "          // Agora: so reutiliza o painel se o header EXATO for o nome pedido.\n" +
    "          const _norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();\n" +
    "          earlyOk = typeof hdr === 'string' && _norm(hdr) === _norm(want);");

  fs.copyFileSync(BROWSER, BROWSER + '.bak-' + ts);
  fs.writeFileSync(BROWSER, src);
  console.log('[OK] openChatInner: igualdade estrita pro nome de grupo (fim do includes falso-positivo) | backup: browser.ts.bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-whatsplay'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-whatsplay');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.30 ===');
console.log('=== TESTE: msg no GRUPO -> whatsplay abre o GRUPO (rebusca, nao confunde com privado) -> entrega NO GRUPO ===');
