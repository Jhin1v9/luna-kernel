#!/usr/bin/env node
/**
 * fix-prompt-format.js — remove [[action]] do prompt da Luna (2026-10-19)
 *
 * Decreto owner: o formato [[action]]/[[response]] NUNCA MAIS eh ensinado ao
 * modelo. Formato unico = code block ```json puro:
 *   {"response": "..."}  ou  {"tool": "...", "params": {...}}
 * + instrucao de usar listTools quando nao souber quais tools existem.
 *
 * O PARSER de [[action]] continua no codigo (tolerancia), mas o modelo nao
 * eh mais ensinado a emitir. Como o action caia no thinking, essa era a
 * causa do tool nao executar.
 *
 * ATENCAO: o system prompt completo soh vai na PRIMEIRA msg da sessao —
 * depois do fix, abre uma NOVA SESSAO na Luna Web pra pegar o prompt novo.
 *
 * USO:  node fix-prompt-format.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const SOUL = path.join(ROOT, 'packages', 'kernel', 'luna-soul.cjs');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
let errors = 0;

const OK = (m) => console.log('\x1b[32m  [OK]\x1b[0m ' + m);
const SKIP = (m) => console.log('\x1b[90m  [SKIP]\x1b[0m ' + m + ' — ja aplicado');
const FAIL = (m) => { console.log('\x1b[31m  [FALHOU]\x1b[0m ' + m); errors++; };
const H = (m) => console.log('\n\x1b[36m=== ' + m + ' ===\x1b[0m');

// strings com \n = newline real, \\n = literal backslash+n, \\` = literal backslash+crase
const R1_OLD = 'const DEFAULT_MINI_REMINDER = `PROTOCOLO (lembrete):\n- Tool: [[action]]\n{"tool":"nome","params":{}}\n[[/action]]\n- Resposta: [[response]]\ntexto\n[[/response]]\n- code block \\`\\`\\`json com {"tool":...} / {"response":...} equivale aos blocos.\n- NUNCA use tags XML (<luna_tool_call>, <luna_response>).\n\nApós receber um resultado, continue a tarefa.`;';
const R1_NEW = 'const DEFAULT_MINI_REMINDER = `PROTOCOLO (lembrete):\n- Tool: code block \\`\\`\\`json com {"tool":"nome","params":{}} — EXCLUSIVAMENTE este formato.\n- Resposta: code block \\`\\`\\`json com {"response":"texto"}\n- NUNCA use [[action]]/[[response]] nem tags XML — soh JSON puro no code block.\n- NAO sabe quais tools existem? Chame {"tool":"listTools","params":{}} primeiro pra ver o indice oficial.\n\nApós receber um resultado, continue a tarefa.`;';

const R2_OLD = '[FORMAT — DOIS FORMATOS ACEITOS (equivalentes, use UM deles)]\n- Response: \\`\\`\\`json\\n{"response": "Sua resposta aqui"}\\n\\`\\`\\`  — ou —  [[response]]\\nSua resposta\\n[[/response]]\n- Tool:    \\`\\`\\`json\\n{"tool": "...", "params": {...}}\\n\\`\\`\\`  — ou —  [[action]]\\n{"tool": "...", "params": {...}}\\n[[/action]]\n- Script:  \\`\\`\\`json\\n{"script": "..."}\\n\\`\\`\\`\nNUNCA use tags XML (<luna_tool_call>, <luna_response>) — nao sao o protocolo oficial.';
const R2_NEW = '[FORMAT — JSON PURO (UNICO FORMATO ACEITO)]\n- Response: \\`\\`\\`json\\n{"response": "Sua resposta aqui"}\\n\\`\\`\\`\n- Tool:    \\`\\`\\`json\\n{"tool": "...", "params": {...}}\\n\\`\\`\\`\n- Script:  \\`\\`\\`json\\n{"script": "..."}\\n\\`\\`\\`\nNUNCA use [[action]]/[[response]] nem tags XML (<luna_tool_call>, <luna_response>) — soh JSON puro no code block.\nNAO sabe quais tools existem ou quais params usar? Chame primeiro \\`\\`\\`json\\n{"tool": "listTools", "params": {}}\\n\\`\\`\\` (indice oficial) ou {"tool": "toolInfo", "params": {"name": "NOME"}} (docs da tool).';

const R3_OLD = 'Responda com EXATAMENTE UM dos formatos oficiais: um code block \\`\\`\\`json com {"response": "..."} ou {"tool": ..., "params": ...} — OU o bloco equivalente [[response]]...[[/response]] / [[action]]...[[/action]]. NUNCA use tags XML (<luna_tool_call>):';
const R3_NEW = 'Responda com EXATAMENTE UM formato oficial: um code block \\`\\`\\`json contendo SEMPRE um objeto JSON completo — {"response": "..."} pra responder ou {"tool": ..., "params": ...} pra agir. NUNCA use [[action]]/[[response]] nem tags XML. NAO sabe quais tools existem ou quais params usar? Chame primeiro {"tool": "listTools", "params": {}} (indice) ou {"tool": "toolInfo", "params": {"name": "NOME"}} (docs):';

const R4_OLD = 'loopInput = \'Formato de saída não reconhecido. Use exatamente um destes formatos:\\n\\n<luna_tool_call>\\n{"name":"tool","arguments":{}}\\n</luna_tool_call>\\n\\nou\\n\\n<luna_response>\\ntexto\\n</luna_response>\';';
const R4_NEW = 'loopInput = \'Formato de saída não reconhecido. Responda SEMPRE com UM code block \\`\\`\\`json contendo um objeto JSON completo: {"response": "texto"} para responder ou {"tool": "nome", "params": {...}} para agir. NUNCA use [[action]]/[[response]] nem tags XML. NAO sabe quais tools existem? Chame {"tool": "listTools", "params": {}} primeiro.\';';

H('Patch 1/2 — luna-soul.cjs (defaults do prompt)');
if (!fs.existsSync(SOUL)) { FAIL('nao encontrado: ' + SOUL); }
else {
  fs.copyFileSync(SOUL, SOUL + '.bak-' + ts);
  let src = fs.readFileSync(SOUL, 'utf8');
  const isCrlf = src.includes('\r\n');
  const norm = (s) => isCrlf ? s.replace(/\n/g, '\r\n') : s;

  function replaceOnce(oldS, newS, label) {
    const o = norm(oldS), n = norm(newS);
    if (src.includes(n)) { SKIP(label); return true; }
    const count = src.split(o).length - 1;
    if (count === 0) { FAIL(label + ' — padrao 0x (soul local diverge? me manda o trecho)'); return false; }
    src = src.split(o).join(n);
    OK(label + ' (' + count + 'x)');
    return true;
  }

  replaceOnce(R1_OLD, R1_NEW, 'R1: DEFAULT_MINI_REMINDER vira JSON puro + listTools');
  replaceOnce(R2_OLD, R2_NEW, 'R2: secao [FORMAT] do system prompt');
  replaceOnce(R3_OLD, R3_NEW, 'R3: templates firstMessage/followUp (2x)');
  replaceOnce(R4_OLD, R4_NEW, 'R4: prompt de reparo luna_unknown_output (ensinava XML!)');

  fs.writeFileSync(SOUL, src);
}

H('Patch 2/2 — caçando luna-prompt-config.json (sobrescreve os defaults)');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'coverage']);
const found = [];
function walk(dir, depth) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1);
    } else if (e.name.endsWith('.json') && !e.name.includes('.bak')) {
      try {
        if (fs.statSync(full).size > 1024 * 1024) continue;
        const content = fs.readFileSync(full, 'utf8');
        if (content.includes('[[action]]') || /prompt.*config|luna-prompt/i.test(e.name)) {
          found.push({ full, hasAction: content.includes('[[action]]') });
        }
      } catch {}
    }
  }
}
walk(ROOT, 0);
const lunaHome = path.join(os.homedir(), '.luna');
if (fs.existsSync(lunaHome)) walk(lunaHome, 0);

let configFixed = 0;
for (const f of found) {
  if (!f.hasAction) continue;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(f.full, 'utf8')); } catch { console.log('  [AVISO] JSON invalido (nao mexi): ' + f.full); continue; }
  let changed = false;

  if (typeof cfg.miniReminder === 'string' && cfg.miniReminder.includes('[[')) {
    delete cfg.miniReminder; // some — o default fixo do codigo (ja corrigido) assume
    changed = true;
    OK('config: miniReminder removido (default fixo assume) — ' + f.full);
  }
  const fixStr = (s) => {
    if (typeof s !== 'string' || !s.includes('[[action]]')) return s;
    let out = s.split(R3_OLD).join(R3_NEW);
    if (out !== s) changed = true;
    return out;
  };
  if (typeof cfg.systemPrompt === 'string') cfg.systemPrompt = fixStr(cfg.systemPrompt);
  if (cfg.prompts && typeof cfg.prompts === 'object') {
    for (const k of ['firstMessage', 'followUp']) {
      if (typeof cfg.prompts[k] === 'string') cfg.prompts[k] = fixStr(cfg.prompts[k]);
    }
  }
  if (changed) {
    fs.copyFileSync(f.full, f.full + '.bak-' + ts);
    fs.writeFileSync(f.full, JSON.stringify(cfg, null, 2));
    configFixed++;
    OK('config corrigido: ' + f.full);
  }
}
if (configFixed === 0) console.log('  (nenhum config com [[action]] encontrado — defaults do codigo mandam)');

H('Reiniciando luna-kernel');
try {
  execSync('pm2 restart luna-kernel', { encoding: 'utf8' });
  OK('luna-kernel reiniciado');
} catch (e) {
  console.log('\x1b[33m  ⚠ pm2 restart falhou — roda manual: pm2 restart luna-kernel\x1b[0m');
}

console.log('');
if (errors > 0) {
  console.log('\x1b[33m⚠ ' + errors + ' falha(s). Backups em *.bak-' + ts + '\x1b[0m');
  process.exit(1);
}
console.log('\x1b[32m✅ PROMPT FIXADO. AGORA: abre uma NOVA SESSAO na Luna Web (o system prompt soh vai na 1a msg da sessao) e reenvia o teste multi-tool.\x1b[0m');
console.log('\x1b[90mBackups: *.bak-' + ts + '\x1b[0m');
