#!/usr/bin/env node
/**
 * fix-work-plain-copy.js — orchestrator limpa "plain Copy"/"JSON Copy" (2026-10-20)
 *
 * Diagnostico ao vivo (owner): modelo emitiu a tool certa, kernel executou, mas
 * a msg persistida na sessao veio como "plain Copy" (header do code block:
 * linguagem "plain" + botao "Copy"). O askKernelWorkKernel entregou isso pro
 * zap. Agora ele limpa: tira o header e, se o corpo for JSON, extrai o campo
 * "response" de verdade.
 *
 * USO:  node fix-work-plain-copy.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FILE = path.join('C:\\Users\\Abner\\Documents\\Luna cto', 'luna-agent', 'apps', 'orchestrator', 'src', 'agent', 'handler.ts');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!fs.existsSync(FILE)) { console.error('Nao encontrado: ' + FILE); process.exit(1); }
fs.copyFileSync(FILE, FILE + '.bak-' + ts);
let src = fs.readFileSync(FILE, 'utf8');
const isCrlf = src.includes('\r\n');
const norm = (s) => isCrlf ? s.replace(/\n/g, '\r\n') : s;

const OLD = `    if (arr.length > beforeCount) {
      const last = arr[arr.length - 1];
      if (last && last.role === 'assistant' && last.content) return last.content;
    }`;

const NEW = `    if (arr.length > beforeCount) {
      const last = arr[arr.length - 1];
      if (last && last.role === 'assistant' && last.content) {
        let content = last.content;
        // v16.0-fix (owner 20/10): resposta que veio so como "plain Copy"/"JSON
        // Copy" = poluicao do header do code block (linguagem + botao Copy) na
        // extracao do DOM. Limpa o header e, se o corpo for JSON, extrai o
        // campo response de verdade.
        const pollution = /^\\s*(plain|json)\\s+copy\\s*/i;
        if (pollution.test(content)) {
          const body = content.replace(pollution, '').trim();
          try {
            const parsed = JSON.parse(body);
            content = parsed.response || parsed.message || body;
          } catch {
            content = body || content;
          }
        }
        return content;
      }
    }`;

if (src.includes('pollution.test(content)')) {
  console.log('[SKIP] ja aplicado');
} else {
  const o = norm(OLD);
  const count = src.split(o).length - 1;
  if (count !== 1) { console.error('[FALHOU] ancora ' + count + 'x'); process.exit(1); }
  fs.writeFileSync(FILE, src.replace(o, norm(NEW)));
  console.log('[OK] askKernelWorkKernel limpa plain Copy/JSON Copy e extrai o response real');
}

for (const svc of ['luna-orchestrator']) {
  try { execSync(`pm2 restart ${svc}`, { encoding: 'utf8' }); console.log('[OK] ' + svc + ' reiniciado'); }
  catch { console.log('[AVISO] ' + svc + ' nao reiniciou'); }
}

console.log('');
console.log('\x1b[32m✅ PLAIN COPY FILTRADO NO WORK.\x1b[0m Raiz (kernel persistindo poluicao');
console.log('   na msg da sessao) fica pro scan14 — a UI webchat tambem se beneficia.');
console.log('\x1b[90mBackup: handler.ts.bak-' + ts + '\x1b[0m');
