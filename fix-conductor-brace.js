#!/usr/bin/env node
/**
 * fix-conductor-brace.js — fecha o if do reply_chat (owner 21/10 01:33)
 * Bug: bloco inserido em call-conductor.ts ficou sem o '}' final ->
 * "Expected identifier but found end of file" -> whatsplay crash-loop.
 * Fix: insere '    }' apos o '.catch(() => {});' do bloco v1.13.
 * Validacao: esbuild (do node_modules do agent) transformando o arquivo
 * INTEIRO — so escreve se o resultado parsear. Depois restart whatsplay.
 */
const fs = require('fs');
const path = require('path');

const AGENT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const FILE = path.join(AGENT, 'apps', 'whatsplay', 'src', 'voice', 'call-conductor.ts');

function ok(m) { console.log('[OK] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); process.exit(1); }

// carrega esbuild de onde estiver no .pnpm
function loadEsbuild() {
  const tries = [path.join(AGENT, 'node_modules', 'esbuild')];
  try {
    const pnpmDir = path.join(AGENT, 'node_modules', '.pnpm');
    for (const d of fs.readdirSync(pnpmDir)) {
      if (d.startsWith('esbuild@')) tries.push(path.join(pnpmDir, d, 'node_modules', 'esbuild'));
    }
  } catch { }
  for (const t of tries) {
    try { return require(t); } catch { }
  }
  return null;
}

(async function main() {
  const esbuild = loadEsbuild();
  const src = fs.readFileSync(FILE, 'utf8');

  // valida estado atual
  if (esbuild) {
    try {
      await esbuild.transform(src, { loader: 'ts' });
      ok('arquivo JA parseia — nada a fazer');
      return;
    } catch (e) {
      console.log('[INFO] sintaxe atual quebrada (esperado): ' + String(e.message).split('\n')[0]);
    }
  } else {
    console.log('[AVISO] esbuild nao achado — aplicando fix sem validacao previa');
  }

  // localiza o bloco v1.13
  const marker = "else this.say('reply_chat sem conversa correspondente";
  const i = src.indexOf(marker);
  if (i === -1) fail('marcador do bloco v1.13 nao achado — arquivo diferente do esperado');
  const catchStr = '        .catch(() => {});';
  const catchAt = src.indexOf(catchStr, i);
  if (catchAt === -1) fail('.catch do bloco v1.13 nao achado');
  const insertAt = catchAt + catchStr.length;
  const out = src.slice(0, insertAt) + '\n    }' + src.slice(insertAt);

  // valida DEPOIS, antes de escrever
  if (esbuild) {
    try {
      await esbuild.transform(out, { loader: 'ts' });
      ok('validacao esbuild: sintaxe OK apos fix');
    } catch (e) {
      fail('apos o fix ainda quebrado: ' + String(e.message).split('\n')[0] + ' — NADA foi escrito; restore manual do .bak');
    }
  }

  const b = FILE + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(FILE, b);
  fs.writeFileSync(FILE, out, 'utf8');
  ok('} inserido (bloco if fechado) | backup: ' + path.basename(b));

  const { spawn } = require('child_process');
  spawn('cmd.exe', ['/c', 'pm2 restart luna-whatsplay'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  ok('whatsplay reiniciado');
  console.log('=== AGUARDE 10s E CONFIRA: pm2 logs luna-whatsplay --lines 8 --nostream (sem FATAL) ===');
  console.log('=== FIM ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
