#!/usr/bin/env node
/**
 * fix-prompt-config-v2.js — varre TODO o JSON de config (qualquer campo) (2026-10-19)
 *
 * A v1 soh trocava systemPrompt/firstMessage/followUp parseados — a frase velha
 * sobrou em OUTROS campos e com aspas escapadas (formato JSON.stringify).
 * Essa v2 faz replace em nivel de TEXTO BRUTO do arquivo, com todas as
 * variantes de escaping, e caça qualquer .json no repo + ~/.luna que
 * contenha [[action]].
 *
 * USO:  node fix-prompt-config-v2.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const R3_OLD = 'Responda com EXATAMENTE UM dos formatos oficiais: um code block \\`\\`\\`json com {"response": "..."} ou {"tool": ..., "params": ...} — OU o bloco equivalente [[response]]...[[/response]] / [[action]]...[[/action]]. NUNCA use tags XML (<luna_tool_call>):';
const R3_NEW = 'Responda com EXATAMENTE UM formato oficial: um code block \\`\\`\\`json contendo SEMPRE um objeto JSON completo — {"response": "..."} pra responder ou {"tool": ..., "params": ...} pra agir. NUNCA use [[action]]/[[response]] nem tags XML. NAO sabe quais tools existem ou quais params usar? Chame primeiro {"tool": "listTools", "params": {}} (indice) ou {"tool": "toolInfo", "params": {"name": "NOME"}} (docs):';

const R2_OLD = '[FORMAT — DOIS FORMATOS ACEITOS (equivalentes, use UM deles)]\\n- Response: \\`\\`\\`json\\n{"response": "Sua resposta aqui"}\\n\\`\\`\\`  — ou —  [[response]]\\nSua resposta\\n[[/response]]\\n- Tool:    \\`\\`\\`json\\n{"tool": "...", "params": {...}}\\n\\`\\`\\`  — ou —  [[action]]\\n{"tool": "...", "params": {...}}\\n[[/action]]';
const R2_NEW = '[FORMAT — JSON PURO (UNICO FORMATO ACEITO)]\\n- Response: \\`\\`\\`json\\n{"response": "Sua resposta aqui"}\\n\\`\\`\\`\\n- Tool:    \\`\\`\\`json\\n{"tool": "...", "params": {...}}\\n\\`\\`\\`\\n- Script:  \\`\\`\\`json\\n{"script": "..."}\\n\\`\\`\\`\\nNUNCA use [[action]]/[[response]] nem tags XML — soh JSON puro no code block.\\nNAO sabe quais tools existem? Chame primeiro {"tool": "listTools", "params": {}} (indice oficial).';

// gera todas as variantes de escaping que podem aparecer num JSON
function variants(s) {
  const v = new Set();
  v.add(s);
  v.add(s.replace(/"/g, '\\"'));
  v.add(s.replace(/\n/g, '\\n'));
  v.add(s.replace(/"/g, '\\"').replace(/\n/g, '\\n'));
  return [...v];
}

const PAIRS = [];
for (const o of variants(R3_OLD)) for (const n of variants(R3_NEW)) if (o.length > 10) { PAIRS.push([o, n]); break; }
for (const o of variants(R2_OLD)) for (const n of variants(R2_NEW)) if (o.length > 10) { PAIRS.push([o, n]); break; }

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'coverage']);
const files = [];
function walk(dir, depth) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1); }
    else if (e.name.endsWith('.json') && !e.name.includes('.bak')) {
      try {
        if (fs.statSync(full).size > 1024 * 1024) continue;
        const c = fs.readFileSync(full, 'utf8');
        if (c.includes('[[action]]')) files.push(full);
      } catch {}
    }
  }
}
walk(ROOT, 0);
const lunaHome = path.join(os.homedir(), '.luna');
if (fs.existsSync(lunaHome)) walk(lunaHome, 0);

if (files.length === 0) {
  console.log('\x1b[32m✅ Nenhum .json com [[action]] encontrado em lugar nenhum.\x1b[0m');
} else {
  console.log('Arquivos com [[action]] encontrados:');
  files.forEach(f => console.log('  📄 ' + f));
}

for (const f of files) {
  let raw = fs.readFileSync(f, 'utf8');
  let changed = 0;
  for (const [o, n] of PAIRS) {
    const cnt = raw.split(o).length - 1;
    if (cnt > 0) { raw = raw.split(o).join(n); changed += cnt; }
  }
  // remove miniReminder contaminado se sobrou
  try {
    const cfg = JSON.parse(raw);
    if (typeof cfg.miniReminder === 'string' && cfg.miniReminder.includes('[[')) {
      delete cfg.miniReminder; changed++;
      raw = JSON.stringify(cfg, null, 2);
    }
  } catch {}
  if (changed > 0) {
    fs.copyFileSync(f, f + '.bak-' + ts);
    fs.writeFileSync(f, raw);
    console.log('\x1b[32m  [OK]\x1b[0m ' + f + ' — ' + changed + ' ocorrencia(s) trocada(s)');
  }
  const restantes = raw.split('[[action]]').length - 1;
  if (restantes > 0) {
    console.log('\x1b[33m  ⚠ ' + f + ' — ainda tem ' + restantes + 'x [[action]].\x1b[0m');
    // mostra onde
    try {
      const cfg = JSON.parse(raw);
      (function dig(obj, p) {
        for (const k of Object.keys(obj || {})) {
          const v = obj[k];
          if (typeof v === 'string' && v.includes('[[action]]')) {
            const i = v.indexOf('[[action]]');
            console.log('\x1b[33m    campo: ' + (p ? p + '.' : '') + k + '\x1b[0m');
            console.log('\x1b[90m    trecho: ' + v.slice(Math.max(0, i - 120), i + 120).replace(/\n/g, ' ') + '\x1b[0m');
          } else if (v && typeof v === 'object') dig(v, (p ? p + '.' : '') + k);
        }
      })(cfg, '');
    } catch { console.log('\x1b[90m    (JSON invalido pra inspecao)\x1b[0m'); }
  }
}

console.log('');
try {
  execSync('pm2 restart luna-kernel', { encoding: 'utf8' });
  console.log('\x1b[32m✅ luna-kernel reiniciado. Abre NOVA SESSAO na Luna Web e retesta o multi-tool.\x1b[0m');
} catch (e) {
  console.log('\x1b[33m⚠ pm2 restart falhou — roda manual: pm2 restart luna-kernel\x1b[0m');
}
console.log('\x1b[90mBackups: *.bak-' + ts + '\x1b[0m');
