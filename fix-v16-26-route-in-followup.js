#!/usr/bin/env node
/* fix-v16-26-route-in-followup.js — v16.26 (owner 21/10)
   RAIZ do "responde no privado": numa sessao CDP PERSISTENTE, o
   firstMessage (com o protocolo de roteamento) so entra UMA vez; os turnos
   seguintes vao so com userInput (v16.13b, certo p/ custo). Sem a lei de
   roteamento visivel, o modelo imita o padrao do historico poluido
   (cheio de to:"Abner" do periodo em que o grupo nao era permitido) e manda
   no privado. systemPrompt NAO chega na thread persistente.
   Fix: a lei de roteamento viaja DENTRO do followUp-light (que ja carrega o
   header [chat|autor] a cada turno). Inegociavel, visivel em todo turno. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const SOUL = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\luna-soul.cjs';
const MARK = 'v16.26-fix';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
function syntaxCheckJS(src) {
  const tmp = path.join(os.tmpdir(), 'luna-check-' + Date.now() + '.js');
  fs.writeFileSync(tmp, src);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); return true; }
  catch (e) { return false; }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

try {
  let src = fs.readFileSync(SOUL, 'utf8');
  if (src.includes(MARK)) { console.log('[OK] ja aplicado'); process.exit(0); }

  const anchor = "        prompt = userInput;\n        systemPrompt = isToolResult ? '[TOOL LOOP]' : '[FOLLOW UP]';";
  if (src.split(anchor).length - 1 !== 1) { console.log('[FAIL] anchor ' + (src.split(anchor).length - 1) + 'x'); process.exit(1); }

  const route = "[ROTEAMENTO — INEGOCIAVEL (" + MARK + ")]: toda resposta a um usuario vai pro CHAT de origem do cabecalho [chat: X | autor: Y] — o campo 'to' do whatsappSendMessage = EXATAMENTE o nome do chat X. NUNCA pro privado do autor Y. (Ex.: autor Enoque no chat 'Production' -> to='Production', nao 'Enoque'.) Prioridade MAIOR que qualquer padrao do historico.\\n\\n";
  src = src.replace(anchor, "        prompt = " + JSON.stringify(route) + " + userInput;\n        systemPrompt = isToolResult ? '[TOOL LOOP]' : '[FOLLOW UP]';");

  if (!syntaxCheckJS(src)) { console.log('[FAIL] sintaxe — NADA escrito'); process.exit(1); }
  fs.copyFileSync(SOUL, SOUL + '.bak-' + ts);
  fs.writeFileSync(SOUL, src);
  console.log('[OK] lei de roteamento agora viaja em todo followUp-light | backup: luna-soul.cjs.bak-' + ts);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.26 ===');
console.log('=== TESTE: manda msg no GRUPO -> resposta NO GRUPO (to = nome do chat do header) ===');
