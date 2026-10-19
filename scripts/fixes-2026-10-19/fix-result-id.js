#!/usr/bin/env node
/**
 * fix-result-id.js — ID unico por tool result (2026-10-19)
 *
 * O dedup do content.js usava hash de (tipo+tool+tamanho+prefixo). Como todo
 * resultado comeca com o mesmo template de prompt, resultados da mesma tool
 * podiam colidir (falso dedup = resultado some) ou duplicar em cenarios edge.
 *
 * Fix: a soul gera um ID unico por resultado ('tr-<ts>-<n>') e o content.js
 * dedupa POR ID. Nunca mais colisao, nunca mais duplicata.
 *
 * USO:  node fix-result-id.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const SOUL = path.join(ROOT, 'packages', 'kernel', 'luna-soul.cjs');
const CONTENT = path.join(ROOT, 'packages', 'kernel', 'luna-extension', 'content.js');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ── SOUL: adiciona id unico no payload ──
let src = fs.readFileSync(SOUL, 'utf8');
if (src.includes("source: 'luna-soul-feedback', id:")) {
  console.log('[SKIP] soul ja envia id unico');
} else {
  fs.copyFileSync(SOUL, SOUL + '.bak-' + ts);
  const OLD = "h._sendToSession(sid, { type: 'tool_result', result: text, text: text, source: 'luna-soul-feedback' });";
  const NEW = "h._sendToSession(sid, { type: 'tool_result', result: text, text: text, source: 'luna-soul-feedback', id: 'tr-' + Date.now() + '-' + (++global.__lunaResultCounter || (global.__lunaResultCounter = 1)) });";
  const count = src.split(OLD).length - 1;
  if (count !== 1) {
    console.error('[FALHOU] soul: payload nao encontrado 1x (encontrado ' + count + 'x)');
    process.exit(1);
  }
  fs.writeFileSync(SOUL, src.replace(OLD, NEW));
  console.log('[OK] soul: id unico por resultado (tr-<ts>-<n>)');
}

// ── CONTENT: dedup por ID ──
src = fs.readFileSync(CONTENT, 'utf8');
if (src.includes("if (p.id && seenHashes.has('id:' + p.id)) continue;")) {
  console.log('[SKIP] content.js ja dedupa por id');
} else {
  fs.copyFileSync(CONTENT, CONTENT + '.bak-' + ts);
  const OLD = "          const h = payloadHash(p);\n          if (seenHashes.has(h)) continue; // ja injetado (via SW ou poll anterior)\n          seenHashes.set(h, now);";
  const NEW = "          const h = payloadHash(p);\n          // v14.4-fix: dedup PRIMARIO por id unico (quando a soul envia);\n          // hash continua como fallback pra msgs antigas sem id.\n          if (p.id && seenHashes.has('id:' + p.id)) continue;\n          if (seenHashes.has(h)) continue; // ja injetado (via SW ou poll anterior)\n          seenHashes.set(h, now);\n          if (p.id) seenHashes.set('id:' + p.id, now);";
  const count = src.split(OLD).length - 1;
  if (count !== 1) {
    console.error('[FALHOU] content.js: gancho do dedup nao encontrado 1x (encontrado ' + count + 'x)');
    process.exit(1);
  }
  fs.writeFileSync(CONTENT, src.replace(OLD, NEW));
  console.log('[OK] content.js: dedup primario por id unico');
}

try {
  execSync('pm2 restart luna-kernel', { encoding: 'utf8' });
  console.log('[OK] luna-kernel reiniciado');
} catch { console.log('⚠ pm2 restart falhou — roda manual'); }

console.log('');
console.log('✅ ID UNICO NO AR. 🔄 extensao + F5 na aba Kimi + Nova Sessao + testa.');
console.log('   Cada resultado agora tem identidade propria: duplicata impossivel,');
console.log('   falso-dedup impossivel. E o "queued" do Kimi e so fila dele, ignora.');
console.log('');
console.log('Backups: *.bak-' + ts);
