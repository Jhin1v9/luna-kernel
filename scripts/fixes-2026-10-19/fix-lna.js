#!/usr/bin/env node
/**
 * fix-lna.js — content.js: fetch com targetAddressSpace pra passar pelo LNA (2026-10-19)
 *
 * Chrome Local Network Access (LNA) bloqueia sites externos (kimi.ai) de
 * acessar localhost sem permissao. O proprio aviso do Chrome diz: marcar o
 * fetch com targetAddressSpace: 'local' permite a requisicao.
 *
 * Se mesmo assim bloquear no teu Chrome, alternativa manual:
 *   chrome://flags/#local-network-access-check → Disabled → reiniciar Chrome
 *
 * USO:  node fix-lna.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const CONTENT = path.join(ROOT, 'packages', 'kernel', 'luna-extension', 'content.js');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!fs.existsSync(CONTENT)) { console.error('Nao encontrado: ' + CONTENT); process.exit(1); }
fs.copyFileSync(CONTENT, CONTENT + '.bak-' + ts);

let src = fs.readFileSync(CONTENT, 'utf8');

const OLD = "        const r = await fetch('http://localhost:3458/ext/poll?sessionId=' + encodeURIComponent(DIRECT_SID));";
const NEW = "        // v14.4-fix (2026-10-19): targetAddressSpace marca o fetch como rede\n"
          + "        // LOCAL — sem isso o Chrome LNA (Local Network Access) BLOQUEIA o poll\n"
          + "        // (site publico acessando localhost). Navegadores sem suporte ignoram a opcao.\n"
          + "        const r = await fetch('http://localhost:3458/ext/poll?sessionId=' + encodeURIComponent(DIRECT_SID), { targetAddressSpace: 'local' });";

if (src.includes(NEW)) {
  console.log('[SKIP] targetAddressSpace ja aplicado');
} else if (src.includes(OLD)) {
  fs.writeFileSync(CONTENT, src.replace(OLD, NEW));
  console.log('[OK] fetch do poll direto marcado como targetAddressSpace: local');
} else {
  console.error('[FALHOU] padrao do fetch nao encontrado — o fix-ext-direct-poll.js rodou?');
  process.exit(1);
}

console.log('');
console.log('✅ RECARREGA A EXTENSAO (chrome://extensions → 🔄) + F5 na aba Kimi + Nova Sessao + testa.');
console.log('');
console.log('Se AINDA bloquear (Chrome antigo/novo demais), plano B:');
console.log('  chrome://flags/#local-network-access-check → Disabled → reiniciar Chrome');
console.log('');
console.log('Backup: content.js.bak-' + ts);
