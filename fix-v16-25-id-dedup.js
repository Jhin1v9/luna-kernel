#!/usr/bin/env node
/* fix-v16-25-id-dedup.js — v16.25 (owner 21/10)
   DEDUP POR IDENTIDADE, NAO POR CONTEUDO (decreto owner, apos v16.24 ter
   suprimido acao legitima repetida em <120s — o bug que ele mesmo previu).
   O protocolo delimitado da extensao ja manda toolId por emissao:
   - mesmo toolId re-detectado = PHANTOM do bloco antigo -> suprime (10min)
   - toolId NOVO com conteudo identico = acao legitima -> EXECUTA
   Sem toolId (fontes antigas): conteudo vira so near-dup de 2s (v12.5). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const KEY = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\lib\\tool-dedup-key.cjs';
const BRIDGE = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\kimi-bridge.cjs';
const MARK = 'v16.25-fix';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
function count(src, a) { return src.split(a).length - 1; }
function syntaxCheckJS(src) {
  const tmp = path.join(os.tmpdir(), 'luna-check-' + Date.now() + '.js');
  fs.writeFileSync(tmp, src);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); return true; }
  catch (e) { return false; }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

// ── T1: key builder com identidade toolId ──
try {
  let src = fs.readFileSync(KEY, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] T1 ja aplicado'); }
  else {
    const a1 = 'function makeDomEventDedupKey(event) {';
    if (count(src, a1) !== 1) { console.log('[FAIL] T1 anchor ' + count(src, a1) + 'x'); process.exit(1); }
    src = src.replace(a1,
      'function makeDomEventDedupKey(event) {\n' +
      '  // ' + MARK + ' (owner 21/10): identidade por toolId (protocolo delimitado).\n' +
      '  // Mesmo toolId re-detectado = phantom do MESMO bloco -> suprime.\n' +
      '  // toolId novo com conteudo identico = acao legitima nova -> executa (decreto).\n' +
      '  if (event && event.toolId) return event.type + \':tid:\' + String(event.toolId);');
    if (!syntaxCheckJS(src)) { console.log('[FAIL] T1 sintaxe — NADA escrito'); process.exit(1); }
    fs.copyFileSync(KEY, KEY + '.bak-' + ts);
    fs.writeFileSync(KEY, src);
    console.log('[OK] T1: chave de dedup = toolId quando presente | backup: tool-dedup-key.cjs.bak-' + ts);
  }
} catch (e) { console.log('[FAIL] T1: ' + e.message); process.exit(1); }

// ── T2: TTL por tipo de chave no enqueue ──
try {
  let src = fs.readFileSync(BRIDGE, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] T2 ja aplicado'); }
  else {
    let ttlAnchor = null;
    if (src.includes('const SEEN_TTL_MS = 120 * 1000;')) ttlAnchor = 'const SEEN_TTL_MS = 120 * 1000;';
    else if (src.includes('const SEEN_TTL_MS = 2 * 1000;')) ttlAnchor = 'const SEEN_TTL_MS = 2 * 1000;';
    if (!ttlAnchor) { console.log('[FAIL] T2: SEEN_TTL_MS nao achado'); process.exit(1); }
    src = src.replace(ttlAnchor,
      "// " + MARK + " (owner 21/10): dedup por IDENTIDADE. toolId = phantom (janela longa);\n" +
      "        // sem toolId = conteudo so como near-dup de 2s. Acao legitima repetida NUNCA suprimida.\n" +
      "        const ttlFor = (k) => k.startsWith('tid:') ? 10 * 60 * 1000 : 2 * 1000;");
    const a2 = 'if (seenAt !== undefined && now - seenAt < SEEN_TTL_MS) {';
    if (count(src, a2) !== 1) { console.log('[FAIL] T2.b ' + count(src, a2) + 'x'); process.exit(1); }
    src = src.replace(a2, 'if (seenAt !== undefined && now - seenAt < ttlFor(key)) {');
    if (!syntaxCheckJS(src)) { console.log('[FAIL] T2 sintaxe — NADA escrito'); process.exit(1); }
    fs.copyFileSync(BRIDGE, BRIDGE + '.bak-' + ts);
    fs.writeFileSync(BRIDGE, src);
    console.log('[OK] T2: TTL por tipo (tid=10min, conteudo=2s) | backup: kimi-bridge.cjs.bak-' + ts);
  }
} catch (e) { console.log('[FAIL] T2: ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.25 ===');
console.log('=== Teste: repete a pergunta de clientes 2-3x seguidas — TODAS devem executar (toolId novo) ===');
console.log('=== E o phantom (bloco velho re-renderizado) morre pelo toolId igual ===');
