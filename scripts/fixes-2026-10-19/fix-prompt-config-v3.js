#!/usr/bin/env node
/**
 * fix-prompt-config-v3.js — descontaminacao completa dos configs (2026-10-19)
 *
 * A v2 falhou porque os configs guardam o prompt em forma RUNTIME (backticks
 * sem escape), e as variantes da v2 tinham backtick escapado do codigo-fonte.
 * Essa v3: parseia o JSON e aplica regras regex em TODOS os campos de string
 * (recursivo), convertendo qualquer mencao a [[action]]/[[response]] em
 * code block JSON puro.
 *
 * USO:  node fix-prompt-config-v3.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// frase R3 em forma runtime (backticks simples)
const R3_OLD = 'Responda com EXATAMENTE UM dos formatos oficiais: um code block ```json com {"response": "..."} ou {"tool": ..., "params": ...} — OU o bloco equivalente [[response]]...[[/response]] / [[action]]...[[/action]]. NUNCA use tags XML (<luna_tool_call>):';
const R3_NEW = 'Responda com EXATAMENTE UM formato oficial: um code block ```json contendo SEMPRE um objeto JSON completo — {"response": "..."} pra responder ou {"tool": ..., "params": ...} pra agir. NUNCA use [[action]]/[[response]] nem tags XML. NAO sabe quais tools existem ou quais params usar? Chame primeiro {"tool": "listTools", "params": {}} (indice) ou {"tool": "toolInfo", "params": {"name": "NOME"}} (docs):';

// regras de descontaminacao (ordem importa!)
const RULES = [
  // blocos delimitados completos: [[action]] {...} [[/action]] -> code block json
  [/\[\[action\]\]\s*(\{[\s\S]*?\})\s*\[\[\/action\]\]/g,
   (m, j) => 'code block ```json\n' + j + '\n```'],
  // [[response]] texto [[/response]] -> texto puro
  [/\[\[response\]\]\s*([\s\S]*?)\s*\[\[\/response\]\]/g, '$1'],
  // fragmentos comuns de ensino
  [/\(\[\[response\]\]\s*ou\s*(\{"response":[^)]*\})\)/g, '(code block ```json $1)'],
  [/\(\[\[action\]\]\)/g, '(code block ```json {"tool": "NOME", "params": {...}})'],
  // tags soltas viram exemplo JSON
  [/\[\[action\]\]/g, 'code block ```json {"tool": "NOME", "params": {...}}'],
  [/\[\[response\]\]/g, 'code block ```json {"response": "texto"}'],
  [/\[\[\/action\]\]|\[\[\/response\]\]/g, ''],
  // sobra do formato "A — ou — B"
  [/\s+—\s+ou\s+—\s+/g, ' '],
];

function decontaminate(s) {
  if (typeof s !== 'string' || !s.includes('[[')) return s;
  let out = s;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  // frase R3
  out = out.split(R3_OLD).join(R3_NEW);
  return out;
}

function walkStrings(obj, cb, prefix) {
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    const p = prefix ? prefix + '.' + k : k;
    if (typeof v === 'string') {
      const nv = cb(v, p);
      if (nv !== v) obj[k] = nv;
    } else if (v && typeof v === 'object') {
      walkStrings(v, cb, p);
    }
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'coverage']);
const files = [];
function walkDir(dir, depth) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkDir(full, depth + 1); }
    else if (e.name.endsWith('.json') && !e.name.includes('.bak')) {
      try {
        if (fs.statSync(full).size > 1024 * 1024) continue;
        if (fs.readFileSync(full, 'utf8').includes('[[')) files.push(full);
      } catch {}
    }
  }
}
walkDir(ROOT, 0);
const lunaHome = path.join(os.homedir(), '.luna');
if (fs.existsSync(lunaHome)) walkDir(lunaHome, 0);

if (files.length === 0) {
  console.log('\x1b[32m✅ Nenhum .json com [[ ... ]] encontrado. Limpo!\x1b[0m');
} else {
  console.log('Arquivos com [[ ... ]] encontrados:');
  files.forEach(f => console.log('  📄 ' + f));
}

for (const f of files) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { console.log('\x1b[31m  [FALHOU]\x1b[0m ' + f + ' — JSON invalido, nao mexi'); continue; }

  let trocados = 0;
  const campos = [];
  walkStrings(cfg, (v, p) => {
    if (!v.includes('[[') && !v.includes(R3_OLD)) return v;
    const nv = decontaminate(v);
    if (nv !== v) { trocados++; campos.push(p); }
    return nv;
  });

  // garante dica de listTools no systemPrompt se ele foi mexido
  try {
    if (cfg.systemPrompt && campos.includes('systemPrompt') && !cfg.systemPrompt.includes('listTools')) {
      cfg.systemPrompt += '\n\nNÃO sabe quais tools existem ou quais params usar? Chame primeiro {"tool": "listTools", "params": {}} (índice oficial) ou {"tool": "toolInfo", "params": {"name": "NOME"}} (docs da tool).';
      campos.push('systemPrompt(+listTools)');
    }
  } catch {}

  if (trocados > 0) {
    fs.copyFileSync(f, f + '.bak-' + ts);
    fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
    console.log('\x1b[32m  [OK]\x1b[0m ' + f);
    console.log('      campos: ' + campos.join(', '));
  }

  // restantes?
  let restantes = [];
  walkStrings(cfg, (v, p) => { if (v.includes('[[')) restantes.push(p); return v; });
  if (restantes.length) {
    console.log('\x1b[33m  ⚠ ainda tem [[ em: ' + restantes.join(', ') + ' — me manda o trecho\x1b[0m');
  }
}

console.log('');
try {
  execSync('pm2 restart luna-kernel', { encoding: 'utf8' });
  console.log('\x1b[32m✅ luna-kernel reiniciado. NOVA SESSAO na Luna Web + retesta o multi-tool.\x1b[0m');
} catch (e) {
  console.log('\x1b[33m⚠ pm2 restart falhou — roda manual: pm2 restart luna-kernel\x1b[0m');
}
console.log('\x1b[90mBackups: *.bak-' + ts + '\x1b[0m');
