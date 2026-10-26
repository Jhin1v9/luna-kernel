#!/usr/bin/env node
/* fix-v16-16-marker-spec.js — v16.16 (owner 21/10)
   Semantica correta dos marcadores (goal-oriented):
   - Toda tool em code block json DEVE ser seguida, no MESMO output, pelas
     linhas: isgen:false  e  done:false|done:true
   - isgen:false = "soul, EXECUTE esta tool agora" — NUNCA sem tool junto
   - done:true = OBJETIVO concluido (sucesso) ou falha definitiva — so na
     ultima acao, junto da tool final
   - Texto livre + marker sem tool = PROIBIDO
   Substitui a spec ambigua do v16.15 nos 3 pontos onde ela mora. */
const fs = require('fs');
const { spawn } = require('child_process');

const CFG = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\config\\luna-prompt-config.json';
const CLASSIFY_TS = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\worker\\src\\jobs\\classify.ts';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const NEW_SYS_BLOCK = [
  '',
  'PROTOCOLO DE EXECUCAO (v16.16, decreto owner):',
  '1. Leia a mensagem do usuario e identifique o OBJETIVO da tarefa.',
  '2. Toda tool em code block json DEVE ser seguida, no MESMO output, pelas linhas:',
  '   isgen:false',
  '   done:false   (ou done:true, se esta for a ULTIMA acao do objetivo)',
  '3. isgen:false significa: soul, EXECUTE esta tool agora. Por isso isgen:false NUNCA aparece sem tool no mesmo output.',
  '4. done:true significa: o OBJETIVO foi concluido com sucesso OU falhou de todas as formas. So entao done:true — sempre acompanhando a ultima tool.',
  '5. PROIBIDO escrever texto livre + isgen:false sem tool. Confirmacao ao usuario = whatsappSendMessage como ultima acao, seguido de isgen:false + done:true.',
  '6. Nao sabe qual tool usar? Emita listTools {} + isgen:false + done:false.'
].join('\n');

const NEW_TRP = [
  '[TOOL RESULT]',
  '{"status": "{{successCount}}/{{totalCount}}", "tool": "{{toolsUsed}}", "result": "{{outputText}}"}',
  '[/TOOL RESULT]',
  'Decida pelo OBJETIVO da tarefa:',
  '- AINDA NAO CONCLUIDO? Emita a PROXIMA tool em code block json AGORA, seguida das linhas isgen:false e done:false. Sem texto, sem pedir confirmacao.',
  '- CONCLUIDO (sucesso) OU FALHA DEFINITIVA? Sua ultima acao: responda o usuario via whatsappSendMessage, seguida das linhas isgen:false e done:true.',
  '- Regra de ouro: isgen:false e done:true NUNCA aparecem sem tool no mesmo output.',
  '- Sem dado? busque ou escale — nunca finja.'
].join('\n');

// ── T1+T2: config ──
try {
  const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  let mexeu = false;

  if (typeof cfg.systemPrompt === 'string' && !cfg.systemPrompt.includes('PROTOCOLO DE EXECUCAO (v16.16')) {
    let sp = cfg.systemPrompt;
    const idx = sp.indexOf('\n\nFIM DE ACAO (v16.15-fix');
    if (idx >= 0) sp = sp.slice(0, idx); // remove bloco ambiguo do v16.15
    cfg.systemPrompt = sp + NEW_SYS_BLOCK;
    mexeu = true;
    console.log('[OK] T1: systemPrompt = spec v16.16 (bloco v16.15 ambiguo removido)');
  } else if (cfg.systemPrompt && cfg.systemPrompt.includes('v16.16')) {
    console.log('[OK] T1: ja em v16.16');
  } else { console.log('[FAIL] T1: systemPrompt ausente'); }

  if (cfg.toolResultPrompt !== NEW_TRP) {
    cfg.toolResultPrompt = NEW_TRP;
    mexeu = true;
    console.log('[OK] T2: toolResultPrompt = decisao por OBJETIVO (v16.16)');
  } else {
    console.log('[OK] T2: toolResultPrompt ja em v16.16');
  }

  if (mexeu) {
    const novo = JSON.stringify(cfg, null, 2); JSON.parse(novo);
    fs.copyFileSync(CFG, CFG + '.bak-' + ts);
    fs.writeFileSync(CFG, novo);
    console.log('[OK] config salvo | backup: luna-prompt-config.json.bak-' + ts);
  }
} catch (e) { console.log('[FAIL] config: ' + e.message); }

// ── T3: CLASSIFY_PROMPT (worker) ──
try {
  let src = fs.readFileSync(CLASSIFY_TS, 'utf8');
  const aVelha = "    'REGRAS DURAS (v16.15-fix): PROIBIDO usar whatsappSendMessage ou qualquer envio — a classificação NUNCA vai pro WhatsApp (read-only). Leia ao vivo com dashboardGetWhatsAppHistory. Enquanto houver leitura pendente, última linha: done:false; quando TODAS as leituras terminarem, última linha: done:true. Depois do done:true, o output final é APENAS o JSON.',";
  if (src.includes('v16.16')) {
    console.log('[OK] T3: classify ja em v16.16');
  } else if (src.split(aVelha).length - 1 === 1) {
    src = src.replace(aVelha, "    'REGRAS DURAS (v16.16): PROIBIDO usar whatsappSendMessage ou qualquer envio — a classificação NUNCA vai pro WhatsApp (read-only). Leia ao vivo com dashboardGetWhatsAppHistory — a tool DEVE ser seguida das linhas isgen:false e done:false. Quando TODAS as leituras terminarem e o JSON da classificação estiver pronto: output = APENAS o JSON + linha done:true. done:true NUNCA antes do JSON final.',");
    fs.copyFileSync(CLASSIFY_TS, CLASSIFY_TS + '.bak-' + ts);
    fs.writeFileSync(CLASSIFY_TS, src);
    console.log('[OK] T3: CLASSIFY_PROMPT = spec v16.16 | backup: classify.ts.bak-' + ts);
  } else {
    console.log('[FAIL] T3: anchor da linha v16.15 != 1x — me cola o trecho atual do CLASSIFY_PROMPT');
  }
} catch (e) { console.log('[FAIL] T3: ' + e.message); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== FIM v16.16 — semantica dos marcadores corrigida nos 3 pontos ===');
console.log('=== Lembrete: a raiz da REENTREGA do tool result ([LUNA-RESCUE]/stream error) continua aberta — proxima cirurgia ===');
