#!/usr/bin/env node
/* fix-v16-29-route-at-source.js — v16.29 (owner 21/10)
   RAIZ do "redirecionamento": a lei de roteamento (v16.26) so foi gravada no
   bloco followUp-light (4853) — mas o fluxo de fora pega outros caminhos
   (isToolResult/toolLoop/1st/sem options) e monta o prompt por outros
   templates SEM a lei. A lei fica IRREDUTIVEL na funcao _buildContext
   (aplicada uma vez, antes de qualquer template), cobrindo TODOS os caminhos.
   + PERSONALIDADE (owner): alegre, calida, proxima, zoeira, descontraida,
   escrita humanizada nao-padrao; adapta-se a quem fala (ex.: Juninho
   religioso -> "Deus abençoe"); usa brain (brainSearch/brainRead) pra conhecer
   quem ta falando. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const SOUL = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\luna-soul.cjs';
const MARK = 'v16.29-fix';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
function syntaxCheckJS(src) {
  const tmp = path.join(os.tmpdir(), 'luna-check-' + Date.now() + '.js');
  fs.writeFileSync(tmp, src);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); return true; }
  catch (e) { return false; }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

const ROUTE = '[ROTEAMENTO — INEGOCIAVEL]: responda SEMPRE no chat de origem do cabecalho [chat: X | autor: Y]. to do whatsappSendMessage = EXATAMENTE o nome do chat X. NUNCA pro privado do autor Y. (Enoque no chat Production -> to=Production.) PRIORIDADE MAIOR que qualquer padrao do historico.\n\n';
const PERSONA = '[PERSONALIDADE — owner]: alegre, calida, proxima, descontraida, com zoeira leve. Escrita humanizada, NAO padrao — curta, viva, com emoji quando couber. Adapte-se a quem ta falando (ex.: Juninho religioso -> "Deus abençoe"). Use brainSearch/brainRead pra conhecer quem fala (fichas em luna/contatos-pessoais e luna/clientes).\n\n';

try {
  let src = fs.readFileSync(SOUL, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] ja aplicado'); process.exit(0); }

  const anchor = '    // Build conversation history\n    const historyLines = [];';
  if (src.split(anchor).length - 1 !== 1) { console.log('[FAIL] anchor buildContext ' + (src.split(anchor).length - 1) + 'x'); process.exit(1); }
  src = src.replace(anchor,
    "    // " + MARK + " (owner 21/10): lei de roteamento + persona IRREDUTIVEIS —\n" +
    "    // aplicadas UMA vez aqui, cobrem TODOS os caminhos (followUp, toolResult,\n" +
    "    // toolLoop, 1st message, sem options). Antes so no followUp-light (v16.26),\n" +
    "    // o fluxo de fora pegava outros templates sem a lei e mandava no privado.\n" +
    "    const _v1629Route = " + JSON.stringify(ROUTE) + ";\n" +
    "    const _v1629Persona = " + JSON.stringify(PERSONA) + ";\n" +
    "    userInput = _v1629Route + _v1629Persona + userInput;\n\n" +
    anchor);

  if (!syntaxCheckJS(src)) { console.log('[FAIL] sintaxe — NADA escrito'); process.exit(1); }
  fs.copyFileSync(SOUL, SOUL + '.bak-' + ts);
  fs.writeFileSync(SOUL, src);
  console.log('[OK] lei de roteamento + persona irredutiveis em _buildContext | backup: luna-soul.cjs.bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.29 ===');
