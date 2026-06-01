/**
 * LunaSoul v3.0 — Engine Orquestrador Unificado
 * CLI-first, multi-channel, self-improving
 *
 * Responsabilidades:
 * - Loop principal: recebe msg → contexto → Kimi Web → parse → executa → responde
 * - Session persistence via SessionManager (JSONL)
 * - Context building: histórico + desktop + skills + memórias + personas
 * - Tool execution com progress events
 * - META mode: Kimi Web pode criar ferramentas, skills, scripts, personas
 * - Event emitter para adapters (CLI, Telegram) receberem updates
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

const { SessionManager } = require('./session-manager.cjs');
const { KimiBridge } = require('./kimi-bridge.cjs');
const { ComputerUseEngine } = require('./computer-use-engine.cjs');
const lunaTools = require('./luna-tools.cjs');
const { workspaceManager } = require('./luna-workspace.cjs');
const { LunaGit } = require('./luna-git.cjs');
const { ToolGuard, validatePythonCode, checkDestructivePattern } = require('./luna-tool-guard.cjs');
const { ResponseStreamParser, safeJsonParse, isBalancedBraces } = require('./response-stream-parser.cjs');
const { MetaExecutorSecure, PathValidator } = require('./meta-executor-secure.cjs');
const {
  checkJsxBalanced,
  checkFileTruncated,
  checkAppImports,
  runBuildCheck,
  checkIndexHtml,
  validateProject,
} = require('./luna-code-validator.cjs');
const readline = require('readline');

const LUNA_DIR = path.join(os.homedir(), '.luna');
const SKILLS_DIR = path.join(LUNA_DIR, 'skills');
const PERSONAS_DIR = path.join(LUNA_DIR, 'personas');
const MEMORIES_DIR = path.join(LUNA_DIR, 'memories');
const MASTER_PROMPT_PATH = path.join(os.homedir(), '.luna-kernel', 'LUNA_MASTER_PROMPT.md');

// ============================================================
// AGENTS.md AUTO-DISCOVERY (inspired by kimi-cli)
// Searches for AGENTS.md from cwd up to homedir
// ============================================================
const AGENTS_MD_MAX_BYTES = 32 * 1024; // 32 KiB budget, same as kimi-cli

function findProjectRoot(startDir) {
  // Simple heuristic: find the nearest .git directory or package.json
  let current = path.resolve(startDir);
  const home = os.homedir();
  while (current.startsWith(home + path.sep) && current !== home) {
    if (fs.existsSync(path.join(current, '.git')) ||
        fs.existsSync(path.join(current, 'package.json')) ||
        fs.existsSync(path.join(current, 'AGENTS.md'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return startDir;
}

function loadAgentsMd(cwd) {
  if (!cwd) cwd = process.cwd();
  const projectRoot = findProjectRoot(cwd);

  // Collect directories from projectRoot down to cwd
  const dirs = [];
  let current = path.resolve(cwd);
  const root = path.resolve(projectRoot);
  while (true) {
    dirs.push(current);
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  dirs.reverse(); // root -> leaf

  // Phase 1: collect all candidate files (root -> leaf order)
  const discovered = [];
  for (const d of dirs) {
    // .kimi/AGENTS.md is checked independently (can coexist with root-level file)
    const kimiPath = path.join(d, '.kimi', 'AGENTS.md');
    // AGENTS.md and agents.md are mutually exclusive (uppercase wins)
    const rootCandidates = [path.join(d, 'AGENTS.md'), path.join(d, 'agents.md')];

    const candidates = [];
    if (fs.existsSync(kimiPath) && fs.statSync(kimiPath).isFile()) {
      candidates.push(kimiPath);
    }
    for (const rc of rootCandidates) {
      if (fs.existsSync(rc) && fs.statSync(rc).isFile()) {
        candidates.push(rc);
        break;
      }
    }

    for (const filePath of candidates) {
      try {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (content) discovered.push({ path: filePath, content });
      } catch { /* ignore read errors */ }
    }
  }

  if (!discovered.length) return null;

  // Phase 2: allocate budget leaf-first so deeper files are never truncated
  let remaining = AGENTS_MD_MAX_BYTES;
  const budgeted = new Array(discovered.length).fill(null);
  for (let i = discovered.length - 1; i >= 0; i--) {
    const { path: filePath, content } = discovered[i];
    const annotation = `<!-- From: ${filePath} -->\n`;
    const separatorCost = i < discovered.length - 1 ? Buffer.byteLength('\n\n', 'utf8') : 0;
    const overhead = Buffer.byteLength(annotation, 'utf8') + separatorCost;
    remaining -= overhead;
    if (remaining <= 0) {
      budgeted[i] = { path: filePath, content: '' };
      remaining = 0;
      continue;
    }
    const encoded = Buffer.from(content, 'utf8');
    if (encoded.length > remaining) {
      const truncated = encoded.slice(0, remaining).toString('utf8').trim();
      budgeted[i] = { path: filePath, content: truncated };
      remaining = 0;
    } else {
      budgeted[i] = { path: filePath, content };
      remaining -= encoded.length;
    }
  }

  // Phase 3: assemble in root -> leaf order
  const parts = [];
  for (const { path: filePath, content } of budgeted) {
    if (content) parts.push(`<!-- From: ${filePath} -->\n${content}`);
  }
  return parts.join('\n\n') || null;
}

// ============================================================
// SYSTEM PROMPT ORQUESTRADOR v3 (com META mode)
// ============================================================

function loadPersonaRegistry() {
  ensureLunaDirs();
  const personas = [];
  try {
    const files = fs.readdirSync(PERSONAS_DIR).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(PERSONAS_DIR, file), 'utf8');
      const name = file.replace('.md', '');
      // Extract description from frontmatter or first heading
      const descMatch = content.match(/description:\s*(.+)/);
      const desc = descMatch ? descMatch[1].trim() : '';
      personas.push({ name, description: desc });
    }
  } catch {}
  return personas;
}

function loadSkillRegistry() {
  ensureLunaDirs();
  const skills = [];
  try {
    const dirs = fs.readdirSync(SKILLS_DIR).filter(d => {
      return fs.statSync(path.join(SKILLS_DIR, d)).isDirectory() &&
             fs.existsSync(path.join(SKILLS_DIR, d, 'SKILL.md'));
    });
    for (const dir of dirs) {
      const content = fs.readFileSync(path.join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8');
      const descMatch = content.match(/description:\s*(.+)/);
      const desc = descMatch ? descMatch[1].trim() : '';
      skills.push({ name: dir, description: desc });
    }
  } catch {}
  return skills;
}

function loadMasterPrompt() {
  try {
    if (fs.existsSync(MASTER_PROMPT_PATH)) {
      const content = fs.readFileSync(MASTER_PROMPT_PATH, 'utf8');
      // Truncate if extremely large (preserve last 15000 chars which is the most important — templates and rules)
      const maxChars = 20000;
      if (content.length > maxChars) {
        // Keep the header + last part (tools, templates, rules)
        const header = content.slice(0, 2000);
        const tail = content.slice(-(maxChars - 2000));
        return header + '\n\n...[conteúdo truncado para economia de tokens]...\n\n' + tail;
      }
      return content;
    }
  } catch (e) {
    console.error('[LunaSoul] Erro ao carregar MASTER PROMPT:', e.message);
  }
  return '';
}

function buildSystemPrompt(opts = {}) {
  const { skillIndex = '', personaContent = '', memoryContext = '', personaRegistry = '', skillRegistry = '', agentsMd = '', masterPrompt = '' } = opts;

  return `╔══════════════════════════════════════════════════════════════════════════╗
║  YOU ARE LUNA — AUTONOMOUS AGENT FOR ABNER GABRIEL (CEO, NEXO DIGITAL)  ║
╚══════════════════════════════════════════════════════════════════════════╝

You are Luna, the personal autonomous agent of Abner Gabriel, CEO of NEXO DIGITAL S.L. in Barcelona.
Your purpose: COMPLETE tasks fully. Don't gold-plate, but don't leave them half-done.

════════════════════════════════════════════════════════════════════════════
CRITICAL ARCHITECTURE — READ CAREFULLY
════════════════════════════════════════════════════════════════════════════

1. [[action]] BLOCKS EXECUTE ON ABNER'S REAL PC (Linux) via LUNA-MIRROR.
   They NEVER run in a sandbox. They run on the REAL filesystem with REAL paths.

2. NEVER NEST [[action]] BLOCKS. Never put [[action]] inside another [[action]].
   WRONG: [[action]]{"tool":"executeShell","params":{"command":"python3 '[[action]]...'"}}
   RIGHT:  [[action]]{"tool":"ipython","params":{"code":"..."}}

3. TOOL SELECTION CHEATSHEET — use the RIGHT tool for the job:
   ┌────────────────────┬────────────────────────────────────────────────────┐
   │ Need to...         │ Use this tool...                                   │
   ├────────────────────┼────────────────────────────────────────────────────┤
   │ Write/edit file    │ writeFile or replaceInFile                         │
   │ Read a file        │ readFile                                           │
   │ Run Python code    │ ipython (runs on REAL PC, import os is FINE)       │
   │ Run shell command  │ executeShell (runs on REAL PC)                     │
   │ Search web         │ searchWeb or web_search                            │
   │ Browse site        │ browser or fetchURL                                │
   │ Git ops            │ gitStatus, gitCommit, etc.                         │
   │ Dashboard task     │ dashboardCreateTask, dashboardListTasks, dashboardUpdateTask, dashboardDeleteTask, dashboardCompleteTask, dashboardAddComment │
   │ Dashboard lead     │ dashboardCreateLead, dashboardListLeads, dashboardUpdateLead, dashboardConvertLead, dashboardDeleteLead │
   │ Dashboard idea     │ dashboardCreateIdea, dashboardListIdeas            │
   │ Dashboard finance  │ dashboardGetFinanceSummary, dashboardCreatePayment, dashboardListPayments, dashboardCreateExpense, dashboardListExpenses, dashboardGetCashBox, dashboardListCashHistory │
   │ Dashboard quote    │ dashboardCreateQuote, dashboardListQuotes, dashboardUpdateQuote, dashboardDeleteQuote │
   │ Dashboard project  │ dashboardListProjects                              │
   │ Dashboard link     │ dashboardAddLink, dashboardListLinks, dashboardDeleteLink, dashboardSyncLinks │
   │ Dashboard email    │ dashboardSendEmail, dashboardListEmails, dashboardSyncEmails │
   │ Dashboard whatsapp │ dashboardSendWhatsApp, dashboardGetWhatsAppHistory, dashboardScanWhatsApp │
   │ Dashboard system   │ dashboardGetSystemStatus, dashboardGetSystemLogs, dashboardListNotifications │
   │ Dashboard voting   │ dashboardListVotingSessions, dashboardCreateVotingSession, dashboardVoteInSession │
   │ Dashboard router   │ dashboardCommandRouter                             │
   └────────────────────┴────────────────────────────────────────────────────┘

4. ipython = Python no PC REAL. Pode usar os, subprocess, pathlib, tudo.
   NUNCA envolva ipython dentro de executeShell. Use ipython DIRETO.

5. executeShell = shell puro. NUNCA passe código Python com [[action]] dentro.
   WRONG: executeShell("python3 -c '[[action]]...'")
   RIGHT:  ipython("import os; os.makedirs(...)")

6. writeFile = mais confiável que ipython para criar arquivos.
   Use writeFile para HTML, CSS, JS, JSON, etc.

7. Quando o usuário pedir para criar/listar TAREFAS, LEADS, ou ver FINANÇAS:
   VOCÊ DEVE usar as tools dashboard* — NUNCA diga que não pode.
   WRONG: "Infelizmente não tenho acesso ao dashboard..."
   RIGHT: \`\`\`json\n{"tool":"dashboardCreateTask","params":{"title":"..."}}\n\`\`\`

════════════════════════════════════════════════════════════════════════════
FORMATO OBRIGATÓRIO — CODE BLOCKS JSON (ÚNICO FORMATO VÁLIDO)
════════════════════════════════════════════════════════════════════════════

⚠️ REGRA ABSOLUTA: Você DEVE usar APENAS code blocks JSON para:
   - Respostas ao usuário (texto dentro do campo "response")
   - Chamadas de ferramentas (campo "tool" + "params")
   - Scripts multi-action (campo "script")

NUNCA use tags [[response]], [[action]], [[script]], [[meta]], [[suggest]].
ESSAS TAGS ESTÃO OBSOLETAS. Use code blocks EXCLUSIVAMENTE.

FORMATO PARA TEXTO (resposta ao usuário):
\`\`\`json
{"response": "Sua mensagem aqui..."}
\`\`\`

FORMATO PARA TOOL CALL:
\`\`\`json
{"tool": "writeFile", "params": {"path": "/home/jhin/Documentos/teste.txt", "content": "Olá mundo"}}
\`\`\`

FORMATO PARA SCRIPT MULTI-ACTION:
\`\`\`json
{"script": "#!/bin/bash\necho 'executando...'"}
\`\`\`

→ ESPERA o resultado do LUNA-MIRROR antes de enviar a próxima ação

⚠️ REGRAS DO FORMATO CODE BLOCK:
1. SEMPRE use \`\`\`json antes e \`\`\` depois
2. O conteúdo deve ser JSON válido
3. NUNCA coloque texto explicativo dentro do code block — só o JSON
4. Após enviar uma tool, ESPERE o resultado antes de enviar a próxima
5. NUNCA envie múltiplas tools de uma vez — UMA por vez
6. NUNCA misture texto fora do code block com tool calls — cada um no seu próprio block

EXEMPLO COMPLETO — CRIAR ARQUIVO:
\`\`\`json
{"response": "Vou criar o arquivo para você."}
\`\`\`

\`\`\`json
{"tool": "writeFile", "params": {"path": "/home/jhin/Documentos/lunafocus/index.html", "content": "<!DOCTYPE html>..."}}
\`\`\`

→ ESPERA o resultado

\`\`\`json
{"response": "✅ Pronto! Arquivo criado com sucesso."}
\`\`\`

════════════════════════════════════════════════════════════════════════════
DASHBOARD TOOLS — INTERAGINDO COM O NEXO DASHBOARD PRO
════════════════════════════════════════════════════════════════════════════

Você tem acesso ao dashboard da NEXO DIGITAL em http://localhost:3456.
Use as tools dashboard* para criar/listar tarefas, leads e ver resumo financeiro.

EXEMPLO — CRIAR TAREFA:
[[response]]
Vou criar essa tarefa no dashboard.
[[/response]]

\`\`\`json
{"tool":"dashboardCreateTask","params":{"title":"Revisar código Luna","priority":"high","status":"pending"}}
\`\`\`

EXEMPLO — LISTAR TAREFAS PENDENTES:
[[response]]
Buscando tarefas pendentes...
[[/response]]

\`\`\`json
{"tool":"dashboardListTasks","params":{"status":"pending"}}
\`\`\`

EXEMPLO — CRIAR LEAD:
[[response]]
Cadastrando o lead no sistema.
[[/response]]

\`\`\`json
{"tool":"dashboardCreateLead","params":{"name":"João Silva","email":"joao@exemplo.com","phone":"+34 600 000 000"}}
\`\`\`

EXEMPLO — CRIAR IDEIA:
[[response]]
Criando a ideia no dashboard NEXO.
[[/response]]

\`\`\`json
{"tool":"dashboardCreateIdea","params":{"title":"Nova funcionalidade para app","type":"brainstorm","description":"Adicionar modo dark ao dashboard","priority":"alta"}}
\`\`\`

EXEMPLO — REGISTRAR PAGAMENTO:
[[response]]
Registrando o pagamento no sistema.
[[/response]]

\`\`\`json
{"tool":"dashboardCreatePayment","params":{"amount":500,"description":"Fatura cliente XYZ","from":"Cliente XYZ"}}
\`\`\`

EXEMPLO — LISTAR DESPESAS:
[[response]]
Buscando despesas...
[[/response]]

\`\`\`json
{"tool":"dashboardListExpenses","params":{"status":"pending"}}
\`\`\`

EXEMPLO — VER CAIXA:
[[response]]
Consultando o caixa...
[[/response]]

\`\`\`json
{"tool":"dashboardGetCashBox","params":{}}
\`\`\`

EXEMPLO — ENVIAR EMAIL:
[[response]]
Enviando email...
[[/response]]

\`\`\`json
{"tool":"dashboardSendEmail","params":{"to":"cliente@exemplo.com","subject":"Proposta","body":"Olá, segue a proposta..."}}
\`\`\`

EXEMPLO — ENVIAR WHATSAPP:
[[response]]
Enviando mensagem...
[[/response]]

\`\`\`json
{"tool":"dashboardSendWhatsApp","params":{"phone":"+34600000000","message":"Oi! Tudo bem?"}}
\`\`\`

EXEMPLO — CRIAR SESSÃO DE VOTAÇÃO:
[[response]]
Criando sessão de votação para aprovação.
[[/response]]

\`\`\`json
{"tool":"dashboardCreateVotingSession","params":{"title":"Aprovar contrato cliente XYZ","type":"generic","quorumRequired":3}}
\`\`\`

EXEMPLO — VOTAR EM SESSÃO:
[[response]]
Registrando meu voto.
[[/response]]

\`\`\`json
{"tool":"dashboardVoteInSession","params":{"id":"sess-abc123","vote":"yes","comment":"Aprovado"}}
\`\`\`

EXEMPLO — LISTAR SESSÕES DE VOTAÇÃO:
[[response]]
Buscando sessões de votação...
[[/response]]

\`\`\`json
{"tool":"dashboardListVotingSessions","params":{"status":"open"}}
\`\`\`

→ ESPERA o resultado do LUNA-MIRROR antes de responder ao usuário.
→ NUNCA diga que não pode acessar o dashboard. Você TEM acesso e DEVE usar as tools dashboard*.

════════════════════════════════════════════════════════════════════════════
OUTPUT FORMAT — SEPARATE RESPONSE FROM ACTIONS
════════════════════════════════════════════════════════════════════════════

STRUCTURE (always follow this order):
1. FIRST: Responda ao usuário com um code block JSON contendo {"response": "..."}
2. THEN: Coloque CADA tool call no seu PRÓPRIO code block JSON — NUNCA aninhados

⚠️ CRITICAL RULES:
1. NUNCA misture texto fora de code blocks — TODO output deve estar dentro de \`\`\`json
2. NUNCA coloque code block JSON dentro de outro code block — SEM ANINHAMENTO
3. NUNCA use executeShell para envolver ipython ou writeFile
4. SEMPRE feche os code blocks: \`\`\`
5. Para código LONGO (>50 linhas), use writeFile — NÃO ipython com heredoc
6. Após enviar uma tool, ESPERE o resultado antes de enviar a próxima
7. NUNCA use tags [[response]], [[action]], [[script]], [[meta]], [[suggest]] — ESTÃO OBSOLETAS

CODE BLOCKS JSON são o ÚNICO formato válido para TUDO: respostas, tool calls, scripts.

════════════════════════════════════════════════════════════════════════════
PROJECT CREATION CHECKLIST — VALIDAÇÃO OBRIGATÓRIA
════════════════════════════════════════════════════════════════════════════

QUANDO criar QUALQUER projeto (React, Node, Python, etc.), VOCÊ DEVE:

1. CSS/Assets: Se um arquivo JS/JSX importa './index.css' ou './App.css',
   VOCÊ DEVE criar esse arquivo CSS também. NUNCA deixe import quebrado.

2. Tailwind CSS: Se usar classes como 'bg-gray-900', 'text-white', 'p-8',
   'rounded-xl', 'shadow-lg', 'grid', 'gap-6' etc., VOCÊ DEVE:
   - Instalar: tailwindcss + postcss + autoprefixer
   - Criar: tailwind.config.js (content apontando para src/**/*.{js,jsx})
   - Criar: postcss.config.js
   - Criar: src/index.css com @import "tailwindcss" (v4) ou @tailwind directives (v3)

3. Vite/React: Se criar projeto Vite + React, VOCÊ DEVE:
   - Criar: vite.config.js com import do plugin @vitejs/plugin-react
   - Adicionar: 'import React from "react"' no topo de TODO arquivo .jsx

4. Dependências: Após criar package.json, VOCÊ DEVE rodar 'npm install'.
   Após instalar, VOCÊ DEVE verificar se node_modules foi criado.

5. Teste final: Após criar TODOS os arquivos e instalar deps, VOCÊ DEVE:
   - Rodar 'npm run dev' (ou equivalente)
   - Verificar se o servidor inicia sem erros
   - Se houver erro, LEIA o erro, CORRIJA, e teste novamente

6. VALIDACAO VISUAL OBRIGATORIA para apps web:
   - Após o servidor subir, VOCÊ DEVE abrir o navegador no localhost
   - Tire um SCREENSHOT da pagina renderizada
   - ANALISE visualmente se o app esta funcionando (cores, layout, textos)
   - Se o screenshot mostrar ERRO (tela vermelha, em branco, quebrada), CORRIJA
   - O agente tambem envia o TEXTO DO ERRO extraido da pagina — USE ESSE TEXTO para diagnosticar
   - Leia o erro: nome do arquivo, numero da linha, tipo do erro. Corrija exatamente isso.
   - Só considere o projeto PRONTO quando o screenshot mostrar o app PERFEITO
   - Ferramentas: use 'browser' para navegar e 'screenshot' para capturar

7. SCRIPTS WORKFLOW (MODO AVANCADO):
   - Para tarefas com MUITAS acoes sequenciais, VOCÊ PODE escrever um SCRIPT completo
   - Use a tag [[script]]...[[/script]] com codigo bash/python/node
   - O script executa TODAS as acoes de uma vez (writeFile, executeShell, verificacoes)
   - Coloque checkpoints no script: verifique se arquivos existem, se deu erro, etc.
   - O script retorna stdout completo para voce analisar
   - EXEMPLO de script workflow:
     [[script]]
     #!/bin/bash
     set -e
     echo "[ACTION: writeFile] Criando arquivo..."
     echo "conteudo" > /path/arquivo.txt
     echo "[VERIFY] Verificando..."
     if [ -f /path/arquivo.txt ]; then echo "✅ OK"; else echo "❌ Falhou"; exit 1; fi
     [[/script]]
   - Use scripts para: criar projetos inteiros, migrar dados, fazer backup, etc.

⚠️ NUNCA entregue um projeto "incompleto". Só pare quando funcionar.

FORMATO OBRIGATÓRIO PARA AÇÕES:

APENAS code block JSON — não existe outro formato:
\`\`\`json
{"tool": "writeFile", "params": {"path": "README.md", "content": "# Hello"}}
\`\`\`

⚠️ TAGS [[action]], [[response]], [[script]], [[meta]], [[suggest]] ESTÃO DESATIVADAS.
Se você usar essas tags, o parser vai IGNORAR e a ação NÃO será executada.

════════════════════════════════════════════════════════════════════════════
TOOLS AVAILABLE — ALL RUN ON REAL PC
════════════════════════════════════════════════════════════════════════════

LUNA TOOLS (emit via [[action]] for direct execution on Abner's PC):
  readFile, writeFile, replaceInFile, searchFiles, grep, viewDirectory
  executeShell, runTests, installPackages
  gitStatus, gitDiff, gitLog, gitCommit
  searchWeb, fetchURL, downloadFile
  clipboardRead, clipboardWrite

NATIVE TOOLS (Kimi built-ins — use only when Luna tools don't fit):
  web_search — Search Google
  browser — Browse websites

NOTE: ipython is a NATIVE tool, BUT your bridge redirects it to the real PC.
      So it behaves like a Luna tool. Use it freely.

DESKTOP CONTROL:
  shell, click, type, keypress, hotkey, screenshot, scroll, wait, open_app, ocr

════════════════════════════════════════════════════════════════════════════
FILE PATHS
════════════════════════════════════════════════════════════════════════════

Abner's home: /home/jhin
Always use absolute paths: /home/jhin/Documentos/..., /home/jhin/NEXO_DASHBOARD_PRO/...

════════════════════════════════════════════════════════════════════════════
PROJECT CONTEXT
════════════════════════════════════════════════════════════════════════════

${agentsMd ? agentsMd + '\n\n' : ''}

SKILLS LOADED:
${skillIndex || '(none loaded)'}

${memoryContext ? 'MEMORIES:\n' + memoryContext + '\n' : ''}

${personaContent ? 'ACTIVE PERSONA:\n' + personaContent + '\n' : ''}

AVAILABLE PERSONAS:
${personaRegistry || '(none)'}

AVAILABLE SKILLS:
${skillRegistry || '(none)'}

════════════════════════════════════════════════════════════════════════════
MASTER PROMPT — INSTRUÇÕES OPERACIONAIS COMPLETAS (LUNA_MASTER_PROMPT.md)
════════════════════════════════════════════════════════════════════════════

${masterPrompt || '(master prompt não carregado — verifique ~/.luna-kernel/LUNA_MASTER_PROMPT.md)'}`;
}

// ============================================================
// JSON PARSER (robusto, 5 estratégias + graceful fallback)
// ============================================================

function parseKimiResponse(text) {
  if (!text) return null;

  // Strategy 0: Remove DOM-extracted code block headers that the Kimi Web extractor sometimes includes
  // e.g. "JSON\nCopy\n{...}" or "json\nCopy\n{...}"
  let cleaned = text
    .replace(/^[\s]*JSON[\s]*\n[\s]*Copy[\s]*\n/i, '')
    .replace(/^[\s]*json[\s]*\n[\s]*Copy[\s]*\n/i, '');

  // Strategy 1: Remove markdown code blocks
  cleaned = cleaned
    .replace(/```json\s*/gi, '')
    .replace(/```\s*$/gm, '')
    .replace(/```/g, '');

  // Strategy 1b: Unescape double-escaped JSON chars
  // FIX: Order matters! First handle \\ → \, THEN \\\" → \"
  // The previous order (.replace(/\\"/g, '"') BEFORE .replace(/\\\\/g, '\\'))
  // destroyed JSON escapes like {\"a\":\"say \\\"hi\\\"\"}.
  cleaned = cleaned
    .replace(/\\\\/g, '\\')     // FIRST: \\ → \  (must be first!)
    .replace(/\\\[/g, '[')
    .replace(/\\\]/g, ']')
    .replace(/\\\{/g, '{')
    .replace(/\\\}/g, '}')
    .replace(/\\"/g, '"');       // LAST: \" → "  (after \\ → \ is done)

  const strategies = [
    // Strategy 2: Direct parse (text already has proper JSON escapes)
    () => JSON.parse(cleaned),
    // Strategy 2b: Direct parse with real newlines escaped (DOM returns real newlines inside strings)
    () => {
      // When DOM extracts text, \n escapes become real newlines. Re-escape them for JSON.parse.
      const reescaped = cleaned.replace(/("response"\s*:\s*")([\s\S]*?)("\s*[,}])/g, (match, prefix, value, suffix) => {
        const escaped = value
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t');
        return prefix + escaped + suffix;
      });
      return JSON.parse(reescaped);
    },
    // Strategy 3: Extract first JSON object
    () => {
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      }
      throw new Error('No JSON object');
    },
    // Strategy 4: Extract field 'response' with regex (handles real newlines)
    () => {
      const match = cleaned.match(/"response"\s*:\s*"([\s\S]*?)"\s*[,}]/);
      if (match) {
        return { mode: 'CHAT', response: match[1].trim() };
      }
      throw new Error('No response field');
    },
    // Strategy 5: Fix trailing commas
    () => {
      const noTrailing = cleaned.replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(noTrailing);
    },
    // Strategy 6: Extract JSON with regex (non-greedy)
    () => {
      const match = cleaned.match(/\{[\s\S]*?\}/);
      if (match) return JSON.parse(match[0]);
      throw new Error('Regex no match');
    },
    // Strategy 7: Try parsing line by line
    () => {
      const lines = cleaned.split('\n');
      for (const line of lines) {
        try { return JSON.parse(line); } catch {}
      }
      throw new Error('No valid JSON line');
    },
  ];

  for (const strategy of strategies) {
    try {
      return strategy();
    } catch {}
  }

  return null;
}

// ============================================================
// TAG-BASED PARSER (v3.1 — double-bracket delimiters instead of raw JSON)
// ============================================================

function parseTagResponse(text) {
  if (!text) return null;

  const trimmed = text.trim();

  // Strategy F: Backward compatibility — if text looks like old JSON, try parseKimiResponse first
  if (trimmed.startsWith('{')) {
    const jsonParsed = parseKimiResponse(trimmed);
    if (jsonParsed && jsonParsed.mode) return jsonParsed;
  }

  // ── DOUBLE-BRACKET DELIMITER EXTRACTION ──
  // Uses [[response]]...[[/response]] instead of XML tags to avoid
  // Kimi Web front-end filtering/escaping of HTML-like syntax.

  // Strategy A: Proper [[response]]...[[/response]] (non-greedy)
  let responseMatch = trimmed.match(/\[\[response\]\]([\s\S]*?)\[\[\/response\]\]/);
  let response = responseMatch ? responseMatch[1] : '';

  // Strategy B: Unclosed [[response]]text (no closing tag)
  if (!responseMatch) {
    const unclosedMatch = trimmed.match(/\[\[response\]\]([\s\S]*)/);
    if (unclosedMatch) {
      response = unclosedMatch[1];
      responseMatch = unclosedMatch;
    }
  }

  // Extract all properly closed [[action]] tags
  const actionMatches = trimmed.match(/\[\[action\]\]([\s\S]*?)\[\[\/action\]\]/g);

  // v5.2: Extract ALL code blocks — responses AND actions
  const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)```/g;
  const codeBlockActions = [];
  const codeBlockResponses = [];
  let cbMatch;
  while ((cbMatch = codeBlockRegex.exec(trimmed)) !== null) {
    const inner = cbMatch[1].trim();
    // Skip code blocks that already have [[action]] tags (those are captured by actionMatches)
    if (/\[\[action\]\]/.test(inner)) continue;
    // Check if it looks like an action (has tool and params)
    if (/"tool"\s*:/.test(inner) && /"params"\s*:/.test(inner)) {
      codeBlockActions.push(inner);
    }
    // v5.2: Also extract response blocks (even without tool/params)
    else if (/"response"\s*:/.test(inner)) {
      codeBlockResponses.push(inner);
    }
  }

  // FIX: Also detect JSON in "JSON\nCopy\n{...}" format (Kimi Web innerText extraction)
  const jsonCopyRegex = /JSON\s*Copy\s*(\{[\s\S]*?\})(?=\s*(?:JSON|Copy|\[\[|$))/g;
  let jcMatch;
  while ((jcMatch = jsonCopyRegex.exec(trimmed)) !== null) {
    const inner = jcMatch[1].trim();
    if (/"tool"\s*:/.test(inner) && /"params"\s*:/.test(inner)) {
      codeBlockActions.push(inner);
    } else if (/"response"\s*:/.test(inner)) {
      codeBlockResponses.push(inner);
    }
  }

  // Extract [[meta]]
  const metaMatch = trimmed.match(/\[\[meta\]\]([\s\S]*?)\[\[\/meta\]\]/);

  // Extract [[suggest]]
  const suggestMatch = trimmed.match(/\[\[suggest\]\]([\s\S]*?)\[\[\/suggest\]\]/);

  // Extract [[script]] — workflow scripts multi-action
  const scriptMatch = trimmed.match(/\[\[script\]\]([\s\S]*?)\[\[\/script\]\]/);



  // Helper: parse JSON inside a delimiter, cleaning wrapper
  function parseDelimiterJson(raw) {
    const cleaned = raw
      .replace(/\[\[action\]\]/g, '')
      .replace(/\[\[\/action\]\]/g, '')
      .replace(/\[\[meta\]\]/g, '')
      .replace(/\[\[\/meta\]\]/g, '')
      .replace(/\[\[suggest\]\]/g, '')
      .replace(/\[\[\/suggest\]\]/g, '')
      .trim();
    return JSON.parse(cleaned);
  }

  // Helper: try to parse JSON, return null on failure (doesn't throw)
  // FALLBACK: if JSON is malformed (e.g., unescaped quotes inside strings),
  // try regex extraction of tool and params as last resort.
  function tryParseDelimiterJson(raw) {
    try { return parseDelimiterJson(raw); } catch {
      // Fallback regex extraction for malformed JSON
      const toolMatch = raw.match(/"tool"\s*:\s*"([^"]+)"/);
      const typeMatch = raw.match(/"type"\s*:\s*"([^"]+)"/);
      const tool = toolMatch ? toolMatch[1] : (typeMatch ? typeMatch[1] : null);
      if (!tool) return null;

      let params = {};
      // Try to find params object
      const paramsMatch = raw.match(/"params"\s*:\s*\{/);
      if (paramsMatch) {
        const startIdx = raw.indexOf(paramsMatch[0]) + paramsMatch[0].length - 1;
        let depth = 1;
        let endIdx = startIdx + 1;
        while (depth > 0 && endIdx < raw.length) {
          if (raw[endIdx] === '{') depth++;
          else if (raw[endIdx] === '}') depth--;
          endIdx++;
        }
        const paramsStr = raw.slice(startIdx, endIdx);
        try {
          params = JSON.parse(paramsStr);
        } catch {
          // Extract individual string values with smarter regex
          // that handles unescaped quotes inside strings by looking for
          // the closing quote before }, }, or ]
          function extractStringValue(key, text) {
            const pattern = new RegExp(`"${key}"\\s*:\\s*"`);
            const m = text.match(pattern);
            if (!m) return null;
            let i = text.indexOf(m[0]) + m[0].length;
            let val = '';
            while (i < text.length) {
              const ch = text[i];
              if (ch === '\\' && i + 1 < text.length) {
                const next = text[i + 1];
                switch (next) {
                  case 'n': val += '\n'; break;
                  case 't': val += '\t'; break;
                  case 'r': val += '\r'; break;
                  case 'b': val += '\b'; break;
                  case 'f': val += '\f'; break;
                  case '\\': val += '\\'; break;
                  case '"': val += '"'; break;
                  case '/': val += '/'; break;
                  case 'u':
                    // \uXXXX unicode escape
                    if (i + 5 < text.length) {
                      const hex = text.slice(i + 2, i + 6);
                      const code = parseInt(hex, 16);
                      if (!isNaN(code)) {
                        val += String.fromCharCode(code);
                        i += 4;
                        break;
                      }
                    }
                    val += next;
                    break;
                  default: val += next; break;
                }
                i += 2;
                continue;
              }
              if (ch === '"') {
                // Check if next non-space is }, ], or ,
                let j = i + 1;
                while (j < text.length && /\s/.test(text[j])) j++;
                if (j >= text.length || text[j] === '}' || text[j] === ']' || text[j] === ',') {
                  return val;
                }
                // Otherwise this quote is part of the string content
                val += ch;
                i++;
                continue;
              }
              val += ch;
              i++;
            }
            return val;
          }
          const cmd = extractStringValue('command', paramsStr);
          const query = extractStringValue('query', paramsStr);
          const path = extractStringValue('path', paramsStr);
          const url = extractStringValue('url', paramsStr);
          const content = extractStringValue('content', paramsStr);
          if (cmd) params.command = cmd;
          if (query) params.query = query;
          if (path) params.path = path;
          if (url) params.url = url;
          if (content) params.content = content;
        }
      }
      return { tool, params };
    }
  }

  try {
    // SUGGEST mode — only if content is valid JSON
    if (suggestMatch) {
      const suggestion = tryParseDelimiterJson(suggestMatch[0]);
      if (suggestion) {
        return { mode: 'SUGGEST', response, suggestion };
      }
      // Invalid JSON inside suggest — ignore the suggest tag and continue
    }

    // META mode — only if content is valid JSON
    if (metaMatch) {
      const meta = tryParseDelimiterJson(metaMatch[0]);
      if (meta) {
        return { mode: 'META', response, meta_action: meta.action || meta.meta_action, params: meta.params || {} };
      }
    }

    // SCRIPT mode — workflow multi-action
    if (scriptMatch) {
      const scriptCode = scriptMatch[1].trim();
      // Detecta linguagem pelo shebang ou extensão
      let language = 'bash';
      if (scriptCode.startsWith('#!/usr/bin/env python') || scriptCode.startsWith('#!/usr/bin/python')) language = 'python';
      else if (scriptCode.startsWith('#!/usr/bin/env node') || scriptCode.startsWith('#!/usr/bin/node')) language = 'node';
      else if (scriptCode.startsWith('#!') && scriptCode.includes('powershell')) language = 'powershell';
      return { mode: 'ACTION', response, tool: 'executeScript', params: { code: scriptCode, language } };
    }

    // v5.2: Extract response from code block JSON responses (e.g. {"response": "..."})
    // Combine with [[response]] tag content — code block has priority
    let combinedResponse = response || '';
    for (const respBlock of codeBlockResponses) {
      try {
        const parsedResp = JSON.parse(respBlock.replace(/^JSON\s*\n\s*Copy\s*\n/i, '').replace(/```json\s*/gi, '').replace(/```\s*$/gm, '').trim());
        if (parsedResp.response) {
          combinedResponse = parsedResp.response;
          break; // First response block wins
        }
      } catch {}
    }

    // ACTION / PLAN mode — code blocks are PRIMARY, [[action]] tags are fallback
    const allActionSources = codeBlockActions.length > 0
      ? codeBlockActions
      : [...(actionMatches || [])];
    if (allActionSources.length > 0) {
      const validActions = allActionSources.map(a => tryParseDelimiterJson(a)).filter(Boolean);
      if (validActions.length > 1) {
        // PLAN: multiple valid actions
        return { mode: 'PLAN', response: combinedResponse, steps: validActions };
      }
      if (validActions.length === 1) {
        // Single ACTION
        return { mode: 'ACTION', response: combinedResponse, tool: validActions[0].tool, params: validActions[0].params || {} };
      }
      // Action found but JSON invalid — warn instead of silently falling back to CHAT
      if (validActions.length === 0) {
        console.error(`[parseTagResponse] WARNING: ${allActionSources.length} action(s) found but all contain invalid JSON. Sources: ${actionMatches ? actionMatches.length : 0} [[action]] tags, ${codeBlockActions ? codeBlockActions.length : 0} code blocks. Kimi may have used native tools (ipython/browser/computer) — these are captured by DOM Mirror.`);
      }
    }

    // v5.2: If we have a response from code block but no action, return CHAT
    if (combinedResponse && !responseMatch) {
      return { mode: 'CHAT', response: combinedResponse };
    }

    // CHAT/DONE mode: if we extracted any response content
    if (responseMatch) {
      return { mode: 'CHAT', response };
    }
  } catch (e) {
    // Delimiter parsing failed — return null so caller can fallback
    return null;
  }

  // No delimiters found and doesn't look like JSON — treat as plain text CHAT
  return { mode: 'CHAT', response: trimmed };
}

// ============================================================
// AUTO-HEALING: Detect incomplete responses
// ============================================================

function isIncompleteResponse(text) {
  if (!text || text.length < 20) return false;
  const t = text.trim();

  // 1. Unclosed [[action]] tags
  const actionOpens = (t.match(/\[\[action\]\]/g) || []).length;
  const actionCloses = (t.match(/\[\[\/action\]\]/g) || []).length;
  if (actionOpens > actionCloses) return true;

  // 2. Unclosed [[response]] tags
  const respOpens = (t.match(/\[\[response\]\]/g) || []).length;
  const respCloses = (t.match(/\[\[\/response\]\]/g) || []).length;
  if (respOpens > respCloses) return true;

  // 3. Unclosed markdown code blocks
  const codeFences = (t.match(/\`\`\`/g) || []).length;
  if (codeFences % 2 !== 0) return true;

  // 4. Unclosed JSON objects or arrays (inside action blocks AND code blocks)
  const blocksToCheck = [
    ...(t.match(/\[\[action\]\][\s\S]*?\[\[\/action\]\]/g) || []),
    // Also check JSON inside code blocks that look like tool calls
    ...(t.match(/```(?:json)?\s*\n?\{[\s\S]*?```/g) || []),
  ];
  let lastBraceDepth = 0, lastBracketDepth = 0;
  for (const block of blocksToCheck) {
    let braceDepth = 0, bracketDepth = 0;
    let inString = false, escapeNext = false;
    for (let i = 0; i < block.length; i++) {
      const ch = block[i];
      if (escapeNext) { escapeNext = false; continue; }
      if (ch === '\\') { escapeNext = true; continue; }
      if (ch === '"' && !inString) { inString = true; continue; }
      if (ch === '"' && inString) { inString = false; continue; }
      if (inString) continue;
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth--;
      else if (ch === '[') bracketDepth++;
      else if (ch === ']') bracketDepth--;
    }
    if (braceDepth !== 0 || bracketDepth !== 0) return true;
    lastBraceDepth = braceDepth;
    lastBracketDepth = bracketDepth;
  }

  // 0. Early completeness signals — if tags are properly closed AND braces are balanced
  // FIX: Previously this short-circuited even if JSON inside tags was incomplete.
  // Only trust closed tags if no unbalanced braces remain in the last block.
  const lastBlock = blocksToCheck[blocksToCheck.length - 1] || '';
  if (lastBlock && (lastBraceDepth !== 0 || lastBracketDepth !== 0)) {
    // JSON inside last block is incomplete — don't trust closed tags
  } else {
    if (/\[\[\/response\]\]\s*$/i.test(t) || /\[\[\/action\]\]\s*$/i.test(t)) return false;
    if (/\`\`\`\s*$/m.test(t)) return false;
  }

  // 5. Ends with ellipsis or truncation indicator
  if (/\.\.\.$/.test(t.slice(-10))) return true;

  // 6. Ends mid-sentence (no punctuation at end)
  // Include common terminal emojis as valid "end punctuation"
  const lastChar = t.slice(-1);
  const endPunct = /[.!?;:\]})"'\n🌙✅🎉🚀🔧🔍✨⚠️❌⏳💡📁🏆🤝🎮📊🎯🛠️🔄]/;
  if (!endPunct.test(lastChar) && t.length > 50) {
    const lastLine = t.split('\n').pop().trim();
    const lineEnd = /[.!?;:\]})🌙✅🎉🚀🔧🔍✨⚠️❌⏳💡📁🏆🤝🎮📊🎯🛠️🔄]$/;
    if (lastLine.length > 15 && !lineEnd.test(lastLine)) return true;
  }

  return false;
}

// ============================================================
// SKILL LOADER
// ============================================================

function ensureLunaDirs() {
  [LUNA_DIR, SKILLS_DIR, PERSONAS_DIR, MEMORIES_DIR, path.join(LUNA_DIR, 'scripts')].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

function loadSkillIndex() {
  ensureLunaDirs();
  const skills = [];
  try {
    const dirs = fs.readdirSync(SKILLS_DIR);
    for (const dir of dirs) {
      const skillPath = path.join(SKILLS_DIR, dir, 'SKILL.md');
      if (fs.existsSync(skillPath)) {
        const content = fs.readFileSync(skillPath, 'utf8');
        // Parse YAML frontmatter
        const frontMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (frontMatch) {
          const yaml = frontMatch[1];
          const meta = {};
          for (const line of yaml.split('\n')) {
            const [key, ...rest] = line.split(':');
            if (key && rest.length) {
              const val = rest.join(':').trim();
              try { meta[key.trim()] = JSON.parse(val); } catch { meta[key.trim()] = val; }
            }
          }
          skills.push({
            name: meta.name || dir,
            description: meta.description || '',
            triggers: meta.triggers || [],
            tier: meta.tier || 'user-global',
            path: skillPath,
          });
        }
      }
    }
  } catch {}
  return skills;
}

function loadPersona(personaName) {
  ensureLunaDirs();
  const personaPath = path.join(PERSONAS_DIR, `${personaName}.md`);
  if (fs.existsSync(personaPath)) {
    return fs.readFileSync(personaPath, 'utf8');
  }
  return null;
}

function loadMemories() {
  ensureLunaDirs();
  const memories = [];
  try {
    const files = fs.readdirSync(MEMORIES_DIR).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(MEMORIES_DIR, file), 'utf8');
      memories.push({ file, content: content.slice(0, 2000) }); // limit size
    }
  } catch {}
  return memories;
}

// ============================================================
// META EXECUTOR — Permite Kimi Web se aprimorar
// ============================================================

class MetaExecutor {
  constructor() {
    this.scriptsDir = path.join(LUNA_DIR, 'scripts');
    ensureLunaDirs();
  }

  async execute(metaAction, params) {
    switch (metaAction) {
      case 'create_tool':
        return this._createTool(params);
      case 'create_skill':
        return this._createSkill(params);
      case 'create_persona':
        return this._createPersona(params);
      case 'create_script':
        return this._createScript(params);
      case 'edit_file':
        return this._editFile(params);
      default:
        return { success: false, error: `META action desconhecida: ${metaAction}` };
    }
  }

  _createTool(params) {
    const { name, language = 'bash', code, description = '' } = params;
    if (!name || !code) return { success: false, error: 'Name and code required' };

    const ext = language === 'node' || language === 'javascript' ? '.js' :
                language === 'python' ? '.py' :
                language === 'bash' || language === 'sh' ? '.sh' : '.sh';
    const filePath = path.join(this.scriptsDir, `${name}${ext}`);

    let shebang = '';
    if (ext === '.sh') shebang = '#!/bin/bash\n';
    else if (ext === '.js') shebang = '#!/usr/bin/env node\n';
    else if (ext === '.py') shebang = '#!/usr/bin/env python3\n';

    const content = `${shebang}# ${description}\n# Created by Luna META mode\n# Language: ${language}\n\n${code}\n`;
    fs.writeFileSync(filePath, content);
    fs.chmodSync(filePath, 0o755);

    return {
      success: true,
      message: `🔧 Nova ferramenta criada: ${name}${ext} em ~/.luna/scripts/`,
      path: filePath,
    };
  }

  _createSkill(params) {
    const { name, description = '', triggers = [], content = '' } = params;
    if (!name) return { success: false, error: 'Name required' };

    const skillDir = path.join(SKILLS_DIR, name);
    fs.mkdirSync(skillDir, { recursive: true });

    const triggersStr = Array.isArray(triggers) ? JSON.stringify(triggers) : '[]';
    const skillContent = `---
name: ${name}
description: ${description}
triggers: ${triggersStr}
tier: user-global
author: Luna (META mode)
version: 1.0.0
---

# Skill: ${name}

${content}
`;
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent);

    return {
      success: true,
      message: `📚 Nova skill criada: ${name} em ~/.luna/skills/${name}/`,
      path: skillDir,
    };
  }

  _createPersona(params) {
    const { name, role = '', tone = '', traits = [], rules = [] } = params;
    if (!name) return { success: false, error: 'Name required' };

    const traitsStr = traits.map(t => `- ${t}`).join('\n');
    const rulesStr = rules.map(r => `- ${r}`).join('\n');

    const content = `---
name: ${name}
description: ${role}
role: ${role}
tone: ${tone}
domain: custom
author: Luna (META mode)
version: 1.0.0
---

# ${name}

## Identity
Você é ${name}, ${role}.

## Core Traits
${traitsStr || '- Adaptável'}

## Behaviour Rules
${rulesStr || '- Siga as instruções do usuário'}

## Reminders
IMPORTANT: Mantenha consistência com sua persona.
`;

    fs.writeFileSync(path.join(PERSONAS_DIR, `${name}.md`), content);
    return {
      success: true,
      message: `🎭 Nova persona criada: ${name} em ~/.luna/personas/${name}.md`,
    };
  }

  _createScript(params) {
    const { path: filePath, code, executable = true } = params;
    if (!filePath || !code) return { success: false, error: 'Path and code required' };

    // FIX: Path validation — reject absolute paths outside workspace, resolve relative to workspace
    const ws = workspaceManager.getWorkspace('luna-cli');
    let resolvedPath;
    if (path.isAbsolute(filePath)) {
      if (ws) {
        const wsPath = path.resolve(ws.path);
        resolvedPath = path.resolve(filePath);
        if (!resolvedPath.startsWith(wsPath) && !filePath.startsWith('/tmp')) {
          return { success: false, error: `Path traversal bloqueado: "${filePath}" está fora do workspace.` };
        }
      } else {
        resolvedPath = path.resolve(filePath);
      }
    } else {
      resolvedPath = ws ? path.resolve(ws.path, filePath) : path.resolve(filePath);
    }

    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, code);
    if (executable) fs.chmodSync(resolvedPath, 0o755);

    return { success: true, message: `📝 Script criado: ${resolvedPath}`, path: resolvedPath };
  }

  _editFile(params) {
    const { path: filePath, operation = 'append', content } = params;
    if (!filePath || content === undefined) return { success: false, error: 'Path and content required' };

    // FIX: Path validation — same as _createScript
    const ws = workspaceManager.getWorkspace('luna-cli');
    let resolvedPath;
    if (path.isAbsolute(filePath)) {
      if (ws) {
        const wsPath = path.resolve(ws.path);
        resolvedPath = path.resolve(filePath);
        if (!resolvedPath.startsWith(wsPath) && !filePath.startsWith('/tmp')) {
          return { success: false, error: `Path traversal bloqueado: "${filePath}" está fora do workspace.` };
        }
      } else {
        resolvedPath = path.resolve(filePath);
      }
    } else {
      resolvedPath = ws ? path.resolve(ws.path, filePath) : path.resolve(filePath);
    }

    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

    if (operation === 'create' || operation === 'write') {
      fs.writeFileSync(resolvedPath, content);
    } else if (operation === 'append') {
      fs.appendFileSync(resolvedPath, '\n' + content);
    } else if (operation === 'replace') {
      fs.writeFileSync(resolvedPath, content);
    }

    return { success: true, message: `✏️ Arquivo ${operation}: ${resolvedPath}` };
  }
}

// ============================================================
// PROJECT HEALTH VALIDATOR — Auto-detecta e corrige erros comuns
// ============================================================

class ProjectHealthValidator {
  constructor() {
    this.fixes = [];
  }

  async validate(projectPath) {
    this.fixes = [];
    if (!fs.existsSync(projectPath)) return { ok: true, fixes: [], screenshot: null };

    // 1. Detecta imports de CSS inexistentes
    await this._checkMissingCssImports(projectPath);
    // 2. Detecta Tailwind sem config
    await this._checkTailwindConfig(projectPath);
    // 3. Detecta Vite sem config
    await this._checkViteConfig(projectPath);
    // 4. Detecta JSX sem import React
    await this._checkJsxReactImport(projectPath);
    // 5. Detecta package.json sem node_modules
    await this._checkNodeModules(projectPath);
    // 6. Detecta arquivos truncados
    await this._checkTruncatedFiles(projectPath);
    // 7. Detecta tags JSX desbalanceadas
    await this._checkJsxBalanced(projectPath);
    // 8. Detecta App.jsx sem imports
    await this._checkAppImports(projectPath);
    // 9. Detecta index.html sem título
    await this._checkIndexHtml(projectPath);
    // 10. Tenta build e reporta erros
    await this._checkBuild(projectPath);

    // 11. Validacao visual automatica para projetos web
    const screenshot = await this._visualTestProject(projectPath);

    return { ok: this.fixes.length === 0, fixes: this.fixes, screenshot: screenshot?.screenshot || screenshot, errorText: screenshot?.errorText || null };
  }

  async _checkMissingCssImports(projectPath) {
    const files = this._findFiles(projectPath, ['.js', '.jsx', '.ts', '.tsx']);
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const cssImports = content.match(/import\s+['"](.+\.css)['"];?/g) || [];
      for (const imp of cssImports) {
        const match = imp.match(/['"](.+\.css)['"]/);
        if (!match) continue;
        const cssPath = path.resolve(path.dirname(file), match[1]);
        if (!fs.existsSync(cssPath)) {
          // Cria CSS vazio com Tailwind directives se for index.css
          const isIndexCss = path.basename(cssPath) === 'index.css';
          // Detecta Tailwind v4 vs v3 pelo package.json
          const isTailwindV4 = this._isTailwindV4(projectPath);
          const cssContent = isIndexCss
            ? (isTailwindV4
              ? '@import "tailwindcss";\n\nbody { margin: 0; padding: 0; }\n'
              : '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\nbody { margin: 0; padding: 0; }\n')
            : '/* Auto-generated by Luna */\n';
          fs.mkdirSync(path.dirname(cssPath), { recursive: true });
          fs.writeFileSync(cssPath, cssContent);
          this.fixes.push(`🩹 Criou CSS ausente: ${path.relative(projectPath, cssPath)}`);
        }
      }
    }
  }

  async _checkTailwindConfig(projectPath) {
    const hasPackageJson = fs.existsSync(path.join(projectPath, 'package.json'));
    if (!hasPackageJson) return;

    // Procura uso de classes Tailwind nos arquivos JSX/JS
    const files = this._findFiles(projectPath, ['.jsx', '.tsx', '.html']);
    let usesTailwind = false;
    const tailwindClasses = /\b(bg-|text-|p-|m-|rounded-|shadow-|grid|flex|gap-|min-h-|font-|opacity-|hover:|md:|lg:)\b/;
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      if (tailwindClasses.test(content)) {
        usesTailwind = true;
        break;
      }
    }
    if (!usesTailwind) return;

    // Verifica se tailwind está instalado
    const hasTailwindConfig = fs.existsSync(path.join(projectPath, 'tailwind.config.js'))
      || fs.existsSync(path.join(projectPath, 'tailwind.config.ts'));
    const hasPostcssConfig = fs.existsSync(path.join(projectPath, 'postcss.config.js'))
      || fs.existsSync(path.join(projectPath, 'postcss.config.cjs'));

    if (!hasTailwindConfig) {
      const configContent = `/** @type {import('tailwindcss').Config} */\nexport default {\n  content: [\n    "./index.html",\n    "./src/**/*.{js,ts,jsx,tsx}",\n  ],\n  theme: { extend: {} },\n  plugins: [],\n}\n`;
      fs.writeFileSync(path.join(projectPath, 'tailwind.config.js'), configContent);
      this.fixes.push('🩹 Criou tailwind.config.js');
    }

    if (!hasPostcssConfig) {
      const isTailwindV4 = this._isTailwindV4(projectPath);
      const postcssContent = isTailwindV4
        ? `export default {\n  plugins: {\n    '@tailwindcss/postcss': {},\n  },\n}\n`
        : `export default {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n}\n`;
      fs.writeFileSync(path.join(projectPath, 'postcss.config.js'), postcssContent);
      this.fixes.push('🩹 Criou postcss.config.js');
    }

    // Verifica se tailwindcss está no package.json — se não, instala automaticamente
    const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8'));
    const hasTailwindDep = pkg.devDependencies?.tailwindcss || pkg.dependencies?.tailwindcss;
    if (!hasTailwindDep) {
      try {
        const isV4 = this._isTailwindV4(projectPath);
        const pkgs = isV4
          ? 'tailwindcss postcss autoprefixer @tailwindcss/postcss'
          : 'tailwindcss postcss autoprefixer';
        execSync(`npm install -D ${pkgs}`, { cwd: projectPath, stdio: 'pipe', timeout: 120000 });
        this.fixes.push(`📦 Instalou automaticamente: ${pkgs}`);
      } catch (e) {
        this.fixes.push(`⚠️ Falha ao instalar Tailwind: ${e.message}`);
      }
    }
  }

  async _checkViteConfig(projectPath) {
    const hasPackageJson = fs.existsSync(path.join(projectPath, 'package.json'));
    const hasViteDep = fs.existsSync(path.join(projectPath, 'node_modules', 'vite'));
    if (!hasPackageJson || !hasViteDep) return;

    const hasViteConfig = fs.existsSync(path.join(projectPath, 'vite.config.js'))
      || fs.existsSync(path.join(projectPath, 'vite.config.ts'));
    if (hasViteConfig) return;

    // Verifica se usa React
    const hasReact = fs.existsSync(path.join(projectPath, 'node_modules', 'react'));
    if (hasReact) {
      const configContent = `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n`;
      fs.writeFileSync(path.join(projectPath, 'vite.config.js'), configContent);
      this.fixes.push('🩹 Criou vite.config.js com plugin React');
    }
  }

  async _checkJsxReactImport(projectPath) {
    const files = this._findFiles(projectPath, ['.jsx', '.tsx']);
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      // Se tem JSX mas não importa React (de nenhuma forma)
      const hasJsx = /</.test(content);
      const hasReactImport = /import\s+.*\s+from\s+['"]react['"]/.test(content);
      if (hasJsx && !hasReactImport) {
        const fixed = `import React from 'react'\n${content}`;
        fs.writeFileSync(file, fixed);
        this.fixes.push(`🩹 Adicionou import React em: ${path.relative(projectPath, file)}`);
      }
    }
  }

  async _checkNodeModules(projectPath) {
    const pkgPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(pkgPath)) return;
    const nodeModulesPath = path.join(projectPath, 'node_modules');
    if (fs.existsSync(nodeModulesPath)) return;

    // FALLBACK: roda npm install automaticamente
    try {
      execSync('npm install', { cwd: projectPath, stdio: 'pipe', timeout: 180000 });
      this.fixes.push('📦 npm install executado automaticamente');
    } catch (e) {
      this.fixes.push(`⚠️ Falha ao rodar npm install: ${e.message}`);
    }
  }

  async _checkTruncatedFiles(projectPath) {
    const files = this._findFiles(projectPath, ['.jsx', '.tsx', '.js', '.ts', '.css', '.html', '.json']);
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const ext = path.extname(file);
      const result = checkFileTruncated(content, ext);
      if (result.truncated) {
        for (const e of result.errors) {
          this.fixes.push(`🚨 Arquivo truncado (${path.relative(projectPath, file)}): ${e}`);
        }
      }
    }
  }

  async _checkJsxBalanced(projectPath) {
    const files = this._findFiles(projectPath, ['.jsx', '.tsx']);
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const result = checkJsxBalanced(content);
      if (!result.balanced) {
        for (const e of result.errors) {
          this.fixes.push(`🚨 JSX desbalanceado (${path.relative(projectPath, file)}): ${e}`);
        }
      }
    }
  }

  async _checkAppImports(projectPath) {
    const result = checkAppImports(projectPath);
    if (!result.ok) {
      for (const e of result.errors) {
        this.fixes.push(`🚨 ${e}`);
      }
    }
  }

  async _checkIndexHtml(projectPath) {
    const result = checkIndexHtml(projectPath);
    if (!result.ok) {
      this.fixes.push(`🚨 ${result.error}`);
    }
  }

  async _checkBuild(projectPath) {
    const result = runBuildCheck(projectPath);
    if (!result.ok) {
      for (const e of result.errors) {
        this.fixes.push(`🚨 BUILD ERROR: ${e}`);
      }
    } else {
      this.fixes.push('✅ Build passou sem erros');
    }
  }

  _findFiles(dir, extensions) {
    const results = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules') {
          results.push(...this._findFiles(fullPath, extensions));
        } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
          results.push(fullPath);
        }
      }
    } catch {}
    return results;
  }

  async _visualTestProject(projectPath) {
    // So testa se for projeto web (tem index.html e package.json com script dev)
    const pkgPath = path.join(projectPath, 'package.json');
    const indexPath = path.join(projectPath, 'index.html');
    if (!fs.existsSync(pkgPath) || !fs.existsSync(indexPath)) return null;

    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { return null; }
    if (!pkg.scripts?.dev) return null;

    // Verifica se node_modules existe
    if (!fs.existsSync(path.join(projectPath, 'node_modules'))) return null;

    let serverProcess = null;
    let port = null;

    try {
      // 1. Inicia o dev server em background
      serverProcess = spawn('npm', ['run', 'dev'], {
        cwd: projectPath,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // 2. Espera o servidor subir (procura a porta no output)
      let output = '';
      const portPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout esperando servidor')), 30000);
        serverProcess.stdout.on('data', (data) => {
          output += data.toString();
          const match = output.match(/http:\/\/localhost:(\d+)/);
          if (match) {
            clearTimeout(timeout);
            resolve(parseInt(match[1]));
          }
        });
        serverProcess.stderr.on('data', (data) => {
          output += data.toString();
        });
      });

      port = await portPromise;

      // 3. Espera mais um pouco pro servidor estabilizar
      await new Promise(r => setTimeout(r, 3000));

      // 4. Tira screenshot com Playwright
      const screenshotPath = path.join(projectPath, '..', `luna-screenshot-${Date.now()}.png`);
      let errorText = null;
      try {
        execSync(`npx playwright screenshot --viewport-size=1280,720 http://localhost:${port} "${screenshotPath}"`, {
          timeout: 15000,
          stdio: 'pipe',
        });
        this.fixes.push(`📸 Screenshot tirado: ${screenshotPath}`);

        // 4b. Se o screenshot mostrar erro, extrai o texto do erro da página
        try {
          const html = execSync(`curl -s http://localhost:${port}/`, { timeout: 5000, encoding: 'utf8' });
          // Detecta página de erro do Vite/React
          if (html.includes('plugin:vite') || html.includes('[vite]') || html.includes('ReferenceError') || html.includes('SyntaxError')) {
            // Tenta extrair o texto do erro do HTML
            const errorMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i) || html.match(/error["']?\s*[:>]\s*([\s\S]{50,500})/i);
            if (errorMatch) {
              errorText = errorMatch[1].replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, '').trim().slice(0, 2000);
              this.fixes.push(`📝 Erro detectado na página: ${errorText.slice(0, 200)}...`);
            }
          }
        } catch {}

        return { screenshot: screenshotPath, errorText };
      } catch (e) {
        this.fixes.push(`⚠️ Falha ao tirar screenshot: ${e.message}`);
        return null;
      }
    } catch (e) {
      this.fixes.push(`⚠️ Falha no teste visual: ${e.message}`);
      return null;
    } finally {
      // 5. Mata o processo do dev server
      if (serverProcess) {
        try {
          process.kill(-serverProcess.pid, 'SIGTERM');
        } catch {}
        setTimeout(() => {
          try { process.kill(-serverProcess.pid, 'SIGKILL'); } catch {}
        }, 2000);
      }
    }
  }

  _isTailwindV4(projectPath) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8'));
      const tailwindVer = pkg.devDependencies?.tailwindcss || pkg.dependencies?.tailwindcss || '';
      // v4 starts with ^4 or ~4 or 4.
      if (/^[\^~]?4\./.test(tailwindVer)) return true;
      // Check installed version
      const twPkg = path.join(projectPath, 'node_modules', 'tailwindcss', 'package.json');
      if (fs.existsSync(twPkg)) {
        const tw = JSON.parse(fs.readFileSync(twPkg, 'utf8'));
        if (tw.version && tw.version.startsWith('4.')) return true;
      }
    } catch {}
    return false; // default to v3 style
  }
}

// ============================================================
// LUNA SOUL — Engine Principal
// ============================================================

class LunaSoul extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessionManager = new SessionManager();
    this.kimiBridge = options.kimiBridge || null;
    this.engine = options.engine || new ComputerUseEngine();
    this.metaExecutor = new MetaExecutor();
    this.maxIterations = options.maxIterations || 999999; // SEM LIMITES — DONO ABSOLUTO
    this.taskTimeoutMs = options.taskTimeoutMs || 999999999; // SEM LIMITES — DONO ABSOLUTO
    this.defaultMode = options.defaultMode || 'thinking';
    this.autoSwitchEnabled = options.autoSwitch !== false; // default true
    this.autoConfirmDestructive = options.autoConfirmDestructive === true; // default false for safety
    this.lunaGit = null;
    this.toolGuard = null; // lazy init quando workspace é setado
    this.projectValidator = new ProjectHealthValidator();
  }

  /** Initialize git for workspace if available */
  async _ensureGit() {
    const ws = workspaceManager.getWorkspace('luna-cli');
    if (!ws) return null;
    if (this.lunaGit && this.lunaGit.workspacePath === ws.path) return this.lunaGit;
    this.lunaGit = new LunaGit(ws.path);
    const result = await this.lunaGit.init();
    if (!result.success) {
      // Not a git repo — that's ok, just no git features
      this.lunaGit = null;
      return null;
    }
    return this.lunaGit;
  }

  /** Find project root by looking for package.json, .git, or vite.config.js */
  _findProjectRoot(startDir) {
    let current = path.resolve(startDir);
    const home = os.homedir();
    const markers = ['package.json', '.git', 'vite.config.js', 'vite.config.ts', 'tailwind.config.js'];
    while (current.startsWith(home + path.sep) && current !== home) {
      for (const marker of markers) {
        if (fs.existsSync(path.join(current, marker))) {
          return current;
        }
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return null;
  }

  /** Initialize ToolGuard for workspace */
  _ensureToolGuard() {
    const ws = workspaceManager.getWorkspace('luna-cli');
    if (!ws) return null;
    if (this.toolGuard && this.toolGuard.workspacePath === ws.path) return this.toolGuard;
    this.toolGuard = new ToolGuard(ws.path);
    return this.toolGuard;
  }

  /** Scrub secrets from tool output (API keys, tokens, passwords) */
  _scrubSecrets(text) {
    if (!text || typeof text !== 'string') return text;
    const patterns = [
      { regex: /sk-[a-zA-Z0-9]{48}/g, replacement: '[OPENAI_KEY_SCRUBBED]' },
      { regex: /sk-[a-zA-Z0-9]{20,}/g, replacement: '[API_KEY_SCRUBBED]' },
      { regex: /ghp_[a-zA-Z0-9]{36}/g, replacement: '[GITHUB_TOKEN_SCRUBBED]' },
      { regex: /gho_[a-zA-Z0-9]{36}/g, replacement: '[GITHUB_OAUTH_SCRUBBED]' },
      { regex: /AKIA[0-9A-Z]{16}/g, replacement: '[AWS_KEY_SCRUBBED]' },
      { regex: /[A-Za-z0-9/+=]{40}/g, replacement: '[SECRET_SCRUBBED]' }, // generic base64-like secret
      { regex: /Bearer\s+[a-zA-Z0-9_\-\.]+/g, replacement: 'Bearer [TOKEN_SCRUBBED]' },
      { regex: /Basic\s+[a-zA-Z0-9/+=]+/g, replacement: 'Basic [AUTH_SCRUBBED]' },
      { regex: /password[=:]\s*[^\s&;]+/gi, replacement: 'password=[PASSWORD_SCRUBBED]' },
      { regex: /passwd[=:]\s*[^\s&;]+/gi, replacement: 'passwd=[PASSWORD_SCRUBBED]' },
      { regex: /-----BEGIN[-\s]*PRIVATE KEY[-\s]*-----[\s\S]*?-----END[-\s]*PRIVATE KEY[-\s]*-----/g, replacement: '[PRIVATE_KEY_SCRUBBED]' },
    ];
    let scrubbed = text;
    for (const { regex, replacement } of patterns) {
      scrubbed = scrubbed.replace(regex, replacement);
    }
    return scrubbed;
  }

  /** Initialize Kimi Bridge connection */
  async init(options = {}) {
    if (!this.kimiBridge) {
      this.kimiBridge = new KimiBridge();
    }
    await this.kimiBridge.connect(options.userId || 'luna-default');
    this.emit('ready');
  }

  /** Disconnect and cleanup */
  async disconnect() {
    if (this.kimiBridge) {
      await this.kimiBridge.disconnect();
    }
  }

  /**
   * Create a new thread in Kimi Web for the given user.
   * This forces a fresh conversation where the full system prompt
   * will be sent again on the next message.
   */
  async newThread(userId = 'luna-default') {
    if (!this.kimiBridge) {
      throw new Error('KimiBridge not initialized');
    }
    const result = await this.kimiBridge.newChat(userId);
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SMART COMPACTION — auto-compact context when it grows too large
  // Inspired by kimi-cli's compaction strategy
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if the session context should be compacted.
   * Triggers when: event count > threshold OR explicit flag.
   */
  _shouldCompact(sessionId, explicit = false) {
    const COMPACT_EVENT_THRESHOLD = parseInt(process.env.LUNA_COMPACT_THRESHOLD, 10) || 24;
    const COMPACT_TOKEN_THRESHOLD = parseInt(process.env.LUNA_COMPACT_TOKEN_THRESHOLD, 10) || 120000; // ~60% of 200K

    if (explicit) return true;

    const events = this.sessionManager.readRecentEvents(sessionId, 999);
    const eventCount = events.length;

    // Rough token estimate: ~4 chars per token
    const totalChars = events.reduce((sum, ev) => {
      const text = ev.content || ev.response || ev.stdout || JSON.stringify(ev.params || {});
      return sum + (text?.length || 0);
    }, 0);
    const estimatedTokens = Math.ceil(totalChars / 4);

    if (process.env.LUNA_DEBUG) {
      console.error(`[LunaDebug] Compaction check: events=${eventCount}/${COMPACT_EVENT_THRESHOLD}, tokens=${estimatedTokens}/${COMPACT_TOKEN_THRESHOLD}`);
    }

    return eventCount >= COMPACT_EVENT_THRESHOLD || estimatedTokens >= COMPACT_TOKEN_THRESHOLD;
  }

  /**
   * Auto-compact: summarize context + new thread + keep continuity.
   * Yields progress events for the TUI.
   */
  async *_autoCompact(sessionId, userId = 'luna-default') {
    yield { type: 'compact_start', message: '📦 Contexto grande demais. Compactando...', sessionId };

    try {
      // 1. Read all events
      const events = this.sessionManager.readRecentEvents(sessionId, 999);

      // 2. Build a local summary (fast, no LLM call needed)
      const summary = this._buildCompactSummary(events);

      // 3. Create new thread in Kimi Web
      // FIX: Only clear local context AFTER newChat succeeds. If newChat fails,
      // we keep the local context so the user doesn't lose their conversation.
      if (this.kimiBridge) {
        yield { type: 'compact_progress', message: '🔄 Criando nova thread no Kimi Web...', sessionId };
        try {
          await this.kimiBridge.newChat(userId);
        } catch (err) {
          yield { type: 'compact_error', message: `❌ Falha ao criar nova thread: ${err.message}. Contexto preservado.`, sessionId };
          return { success: false, error: err.message };
        }
      }

      // 4. Clear local context (only after newChat succeeded)
      this.sessionManager.clearContext(sessionId);

      // 5. Store summary as first event (so next message knows it's not first)
      this.sessionManager.appendEvent(sessionId, {
        type: 'assistant',
        mode: 'CHAT',
        response: `Resumo do contexto anterior:\n${summary}`,
        timestamp: new Date().toISOString(),
      });

      yield { type: 'compact_end', message: '✅ Contexto compactado. Nova thread pronta.', summary, sessionId };
      return { success: true, summary };
    } catch (err) {
      yield { type: 'compact_error', message: `❌ Erro na compactação: ${err.message}`, sessionId };
      return { success: false, error: err.message };
    }
  }

  /**
   * Build a compact summary from events.
   * Preserves: user requests, assistant decisions, tool results, errors.
   * Drops: intermediate thinking, duplicated content.
   */
  _buildCompactSummary(events) {
    const lines = [];
    let toolCallCount = 0;
    let fileOps = [];
    let errors = [];

    for (const ev of events) {
      if (ev.type === 'user') {
        const text = (ev.content || '').slice(0, 200);
        if (text) lines.push(`[User] ${text}`);
      } else if (ev.type === 'assistant') {
        const mode = ev.mode || 'CHAT';
        const resp = (ev.response || '').slice(0, 200);
        if (resp) lines.push(`[Assistant/${mode}] ${resp}`);
      } else if (ev.type === 'tool_call') {
        toolCallCount++;
        const tool = ev.tool || '?';
        if (['writeFile', 'replaceInFile', 'moveFile', 'copyFile', 'deleteFile'].includes(tool)) {
          const p = ev.params || {};
          fileOps.push(`${tool}(${p.path || p.source || '?'})`);
        }
      } else if (ev.type === 'tool_result' && !ev.success) {
        errors.push(`${ev.tool}: ${(ev.error || '').slice(0, 100)}`);
      }
    }

    const summaryParts = [
      `== Resumo da sessão (${events.length} eventos, ${toolCallCount} tool calls) ==`,
      ...lines.slice(-20), // keep last 20 significant events
      fileOps.length > 0 ? `== Arquivos modificados ==\n${fileOps.join(', ')}` : '',
      errors.length > 0 ? `== Erros ==\n${errors.join('\n')}` : '',
    ];

    return summaryParts.filter(Boolean).join('\n');
  }

  /**
   * Dashboard Command Router — tool called by Kimi on demand.
   * Receives a natural-language command string and routes to the correct dashboard action.
   * Returns { success, tool, result, friendly }.
   */
  async _execDashboardCommandRouter(params = {}) {
    const text = (params.command || '').toLowerCase().trim();
    if (!text) {
      return { success: false, error: 'No command provided to dashboardCommandRouter' };
    }

    // Criar tarefa
    const createTaskMatch = text.match(/\b(criar|crie|nova|add|adicionar)\b\s+(?:uma\s+)?tarefa\s+(?:no\s+dashboard\s+)?(?:chamada\s+)?["']?(.+?)["']?(?:\s+com\s+prioridade\s+(\w+))?\s*$/i);
    if (createTaskMatch) {
      const title = createTaskMatch[2].trim();
      const rawPriority = (createTaskMatch[3] || 'medium').toLowerCase();
      const priorityMap = { alta: 'high', high: 'high', baixa: 'low', low: 'low', baja: 'low', média: 'medium', media: 'medium', mediana: 'medium', medium: 'medium' };
      const priority = priorityMap[rawPriority] || (['low', 'medium', 'high'].includes(rawPriority) ? rawPriority : 'medium');
      const result = await lunaTools.dashboardCreateTask({ title, priority });
      return { success: true, tool: 'dashboardCreateTask', result, friendly: result.stdout || '✅ Tarefa criada.' };
    }

    // Listar tarefas
    if (/(?:listar?|mostrar?|ver|quais)\s+(?:as\s+)?tarefas?/i.test(text)) {
      const statusMatch = text.match(/status\s+(\w+)/i);
      const result = await lunaTools.dashboardListTasks({ status: statusMatch ? statusMatch[1] : undefined });
      return { success: true, tool: 'dashboardListTasks', result, friendly: result.stdout || '📋 Tarefas listadas.' };
    }

    // Criar lead
    const createLeadMatch = text.match(/\b(criar|crie|novo|add|adicionar)\b\s+(?:um\s+)?lead\s+(?:chamado\s+)?["']?(.+?)["']?\s*$/i);
    if (createLeadMatch) {
      const name = createLeadMatch[2].trim();
      const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
      const result = await lunaTools.dashboardCreateLead({ name, email: emailMatch ? emailMatch[0] : '' });
      return { success: true, tool: 'dashboardCreateLead', result, friendly: result.stdout || '✅ Lead criado.' };
    }

    // Listar leads
    if (/(?:listar?|mostrar?|ver|quais)\s+(?:os\s+)?leads?/i.test(text)) {
      const result = await lunaTools.dashboardListLeads({});
      return { success: true, tool: 'dashboardListLeads', result, friendly: result.stdout || '📋 Leads listados.' };
    }

    // Resumo financeiro
    if (/(?:resumo|sumário|status)\s+(?:financeiro|financeira|de\s+finanças|pagamentos)/i.test(text)) {
      const result = await lunaTools.dashboardGetFinanceSummary({});
      return { success: true, tool: 'dashboardGetFinanceSummary', result, friendly: result.stdout || '💰 Resumo financeiro.' };
    }

    return { success: false, error: `Comando não reconhecido pelo router: "${text}"` };
  }

  /** Main entry: process a user message (legacy, non-streaming) */
  async processMessage(input, options = {}) {
    const sessionId = options.sessionId || this.sessionManager.getOrCreateCurrentSession({
      title: options.sessionTitle || 'Sessão Luna',
      mode: options.mode || this.defaultMode,
      persona: options.persona || 'default',
    }).id;

    const session = this.sessionManager.loadSession(sessionId);
    const mode = options.mode || session?.mode || this.defaultMode;

    // Store user message
    this.sessionManager.appendEvent(sessionId, {
      type: 'user',
      content: input,
      timestamp: new Date().toISOString(),
    });

    // ── SLASH COMMANDS — executados localmente, sem enviar à Kimi ──
    const trimmedInput = input.trim();
    if (trimmedInput === '/debug' || trimmedInput.startsWith('/debug ')) {
      const args = trimmedInput.slice(7).trim();
      const params = {};
      if (args) {
        const parts = args.split(/\s+/);
        if (parts[0]) params.process = parts[0];
        if (parts[1] && !isNaN(parts[1])) params.lines = parseInt(parts[1]);
      }
      this.emit('progress', { type: 'thinking', message: 'Abrindo terminal de debug...', sessionId });
      const result = lunaTools.openDebugTerminal(params);
      this.emit('progress', { type: 'action_start', tool: 'openDebugTerminal', params, sessionId });
      this.emit('progress', { type: 'action_end', tool: 'openDebugTerminal', result, sessionId });
      return { success: true, mode: 'CHAT', response: result.message || JSON.stringify(result), sessionId };
    }

    // Emit thinking event
    this.emit('progress', { type: 'thinking', message: '🧠 Analisando...', sessionId });

    // Build full context
    const context = await this._buildContext(sessionId, input, options);

    // Send to Kimi Web
    let kimiResponse;
    try {
      const result = await this.kimiBridge.sendMessage(
        options.userId || 'luna-default',
        context.prompt,
        { mode }
      );
      kimiResponse = result.response;
    } catch (err) {
      this.emit('progress', { type: 'error', message: `❌ Erro Kimi: ${err.message}`, sessionId });
      return { success: false, error: err.message, sessionId };
    }

    // Parse response (tag-based primary, JSON fallback for backward compatibility)
    let parsed = parseTagResponse(kimiResponse) || parseKimiResponse(kimiResponse);
    if (!parsed) {
      // Graceful fallback: treat as CHAT
      this.emit('progress', { type: 'warning', message: '⚠️ Resposta não reconhecida, tratando como chat', sessionId });
      parsed = { mode: 'CHAT', response: kimiResponse };
    }

    // Process based on mode
    return this._processMode(parsed, sessionId, input, options);
  }

  /**
   * STREAMING entry: process a user message with real-time thinking/response.
   * Yields events: { type, ... } for the TUI to consume.
   *
   * Pattern inspired by ShellAgent's queryLoop async generator.
   */
  async *processMessageStream(input, options = {}) {
    const sessionId = options.sessionId || this.sessionManager.getOrCreateCurrentSession({
      title: options.sessionTitle || 'Sessão Luna',
      mode: options.mode || this.defaultMode,
      persona: options.persona || 'default',
    }).id;

    const session = this.sessionManager.loadSession(sessionId);
    let mode = options.mode || session?.mode || this.defaultMode;
    // CHAT is a parsed response mode, not a Kimi Web mode — map to thinking
    if (mode === 'CHAT') mode = 'thinking';
    const userId = options.userId || 'luna-default';

    // Store user message
    this.sessionManager.appendEvent(sessionId, {
      type: 'user',
      content: input,
      timestamp: new Date().toISOString(),
    });

    // ── SLASH COMMANDS — executados localmente, sem enviar à Kimi ──
    const trimmedInput = input.trim();
    if (trimmedInput === '/debug' || trimmedInput.startsWith('/debug ')) {
      const args = trimmedInput.slice(7).trim();
      const params = {};
      if (args) {
        const parts = args.split(/\s+/);
        if (parts[0]) params.process = parts[0];
        if (parts[1] && !isNaN(parts[1])) params.lines = parseInt(parts[1]);
      }
      yield { type: 'thinking_start', sessionId };
      yield { type: 'thinking_delta', text: 'Abrindo terminal de debug...', fullThinking: 'Abrindo terminal de debug...', sessionId };
      const result = lunaTools.openDebugTerminal(params);
      yield { type: 'action_start', tool: 'openDebugTerminal', params, sessionId };
      yield { type: 'action_end', tool: 'openDebugTerminal', result, sessionId };
      yield { type: 'response_done', response: result.message || JSON.stringify(result), thinking: '', sessionId };
      yield { type: 'done', result: { success: true, mode: 'CHAT', response: result.message || JSON.stringify(result), sessionId }, sessionId };
      return;
    }

    // ── SMART COMPACTION ──
    // If context is too large, auto-compact before sending to Kimi.
    // This prevents token bloat and keeps responses fast.
    if (this._shouldCompact(sessionId, options.forceCompact)) {
      for await (const ev of this._autoCompact(sessionId, userId)) {
        yield ev;
      }
    }

    // Auto-continue loop: Kimi decides → Luna executes → result goes back to Kimi → Kimi responds
    let loopInput = input;

    // Detect if this is the FIRST message in a new thread.
    // We check if the session has any prior assistant/tool events.
    // If not, we send the FULL system prompt. Otherwise, only a mini-reminder.
    const recentEvents = this.sessionManager.readRecentEvents(sessionId, 30);
    const hasPriorConversation = recentEvents.some(ev => ev.type === 'assistant' || ev.type === 'tool_call');
    const isFirstMessage = !hasPriorConversation;

    let loopContext = await this._buildContext(sessionId, input, { ...options, isFirstMessage });
    let safety = 0;
    const MAX_LOOPS = Number.MAX_SAFE_INTEGER; // ILIMITADO — o usuário pediu zero limites
    let autoContinues = 0;
    const MAX_AUTO_CONTINUES = Number.MAX_SAFE_INTEGER; // SEM LIMITES — DONO ABSOLUTO

    // Track DOM action codes already executed in this message stream to prevent
    // infinite loops when Kimi repeats the same code block across auto-continue iterations.
    const executedDomActionHashes = new Set();

    while (safety < MAX_LOOPS) {
      safety++;
      let fullThinking = '';
      let fullResponse = '';
      let canSteer = false;

      // Accumulate DOM-extracted action results for auto-continue
      const domActionResults = [];

      yield { type: 'thinking_start', sessionId };

      try {
        const stream = this.kimiBridge.sendMessageStream(userId, loopContext.prompt, { mode });

        for await (const event of stream) {
          switch (event.type) {
            case 'thinking_delta':
              fullThinking += event.text;
              yield { type: 'thinking_delta', text: event.text, fullThinking, sessionId };
              break;

            case 'response_delta':
              fullResponse += event.text;
              yield { type: 'response_delta', text: event.text, fullResponse, sessionId };
              break;

            case 'can_steer':
              canSteer = event.value;
              yield { type: 'can_steer', value: canSteer, sessionId };
              break;

            case 'waiting':
              yield { type: 'waiting', message: event.message, sessionId };
              break;

            // v5.3: REAL-TIME JSON response streaming — show response immediately
            case 'response_detected': {
              const respText = event.response || '';
              if (respText) {
                yield { type: 'assistant', response: respText, sessionId };
                this.sessionManager.appendEvent(sessionId, {
                  type: 'assistant',
                  response: respText,
                  timestamp: new Date().toISOString(),
                });
              }
              break;
            }

            case 'action_detected': {
              // DOM MIRROR v3.2: Kimi Web showed Python code in the DOM.
              // We ALWAYS execute locally — Python is a native Linux command on the user's machine.
              // Kimi's sandbox result is captured as metadata for comparison/fallback only.
              const code = event.code || '';
              const codeHash = require('crypto').createHash('sha256').update(code).digest('hex').slice(0, 16);
              const kimiResult = event.kimiResult || '';
              const kimiImages = event.kimiImages || [];

              // Deduplication: skip if this exact code was already executed in this session
              if (executedDomActionHashes.has(codeHash)) {
                console.log(`[DOM MIRROR] Skipping duplicate code block (hash=${codeHash})`);
                break;
              }
              executedDomActionHashes.add(codeHash);

              const parsedAction = {
                mode: 'ACTION',
                tool: event.action?.tool || event.action?.type,
                params: event.action?.params || event.action,
              };

              yield { type: 'action_start', tool: parsedAction.tool, params: parsedAction.params, source: event.source || 'dom_mirror', sessionId };
              let actionResult = await this._handleAction(parsedAction, sessionId, options);

              // ── FALLBACK: if local execution failed AND Kimi has a sandbox result, use it ──
              const localFailed = !actionResult?.success || actionResult?.result?.stderr;
              if (localFailed && kimiResult) {
                console.log(`[DOM MIRROR] Local execution failed, falling back to Kimi sandbox result (${kimiResult.length} chars)`);
                actionResult = {
                  success: true,
                  result: {
                    stdout: kimiResult,
                    stderr: actionResult?.result?.stderr || '',
                    output: kimiResult,
                    images: kimiImages.map(img => img.src),
                  },
                  tool: parsedAction.tool,
                  source: 'kimi_sandbox_fallback',
                };
              }

              yield { type: 'action_end', tool: parsedAction.tool, result: actionResult, source: event.source || 'dom_mirror', sessionId };
              yield actionResult;
              domActionResults.push({
                tool: parsedAction.tool,
                result: actionResult,
                code: event.code,
                kimiResult,
                kimiImages,
              });
              break;
            }

            case 'done':
              fullResponse = event.response;
              yield { type: 'response_done', response: fullResponse, thinking: fullThinking, sessionId };
              break;
          }
        }
      } catch (err) {
        if (err.message === 'STREAM_CANCELLED') {
          // v5.3-fix: User cancelled — not an error, just stop gracefully
          yield { type: 'system', message: '⏹️ Geração cancelada pelo usuário.', sessionId };
          return;
        }
        if (err.message === 'KIMI_LOGIN_REQUIRED') {
          yield { type: 'login_required', message: '🔐 Você precisa logar primeiro no Kimi Web. Abra o Chrome em https://kimi.com e faça login.', sessionId };
        } else {
          yield { type: 'error', error: err.message, sessionId };
        }
        return;
      }

      // v3.4: Context limit detected — auto-create new chat and retry
      if (/getting too long|conversation.*too long|try starting a new session|context limit|token limit/i.test(fullResponse)) {
        yield { type: 'warning', message: '🔁 Limite de contexto atingido. Criando novo chat automaticamente...', sessionId };
        try {
          await this.newThread(userId);
          yield { type: 'system', message: '✅ Novo chat criado. Reenviando mensagem...', sessionId };
          // Rebuild context with mini-reminder (new thread has no prior conversation)
          loopContext = await this._buildContext(sessionId, loopInput, { ...options, isFirstMessage: true });
          continue; // Restart loop with new thread
        } catch (threadErr) {
          yield { type: 'error', message: `❌ Falha ao criar novo chat: ${threadErr.message}`, sessionId };
          return;
        }
      }

      // Parse the full response (tag-based primary, JSON fallback)
      let parsed = parseTagResponse(fullResponse) || parseKimiResponse(fullResponse);
      if (!parsed) {
        yield { type: 'warning', message: '⚠️ Resposta não reconhecida, tratando como chat', sessionId };
        parsed = { mode: 'CHAT', response: fullResponse };
      }
      // v4.0-fix: If parsed exists but response is empty, use fullResponse as fallback
      // This happens when Kimi returns content as reasoning instead of content
      if (parsed && !parsed.response && fullResponse) {
        parsed.response = fullResponse;
      }

      // v3.4: Auto-healing — detect incomplete responses and auto-continue
      if (isIncompleteResponse(fullResponse) && autoContinues < MAX_AUTO_CONTINUES) {
        autoContinues++;
        yield { type: 'warning', message: `⏳ Resposta incompleta detectada — auto-continuando (${autoContinues})...`, sessionId };
        loopContext = await this._buildContext(sessionId, '[CONTINUE] Por favor, continue de onde parou. Complete a action/response que estava em andamento.', { ...options, isFirstMessage: false });
        continue; // Restart loop with "continue" prompt
      }

      yield { type: 'mode_detected', mode: parsed.mode, sessionId };

      // Execute tools and yield progress
      const result = await this._processModeResult(parsed, sessionId, loopInput, options);

      // Yield all events from mode processing
      for (const ev of result.events) {
        yield ev;
      }

      // v4.0-fix: If Kimi said CHAT or DONE, we're finished.
      // For thinking/instant mode (simple chat), ignore DOM actions to prevent infinite loops.
      // For agent/swarm mode, DOM actions are fed back for multi-step execution.
      const isSimpleChatMode = ['thinking', 'instant'].includes(mode);
      if ((parsed.mode === 'CHAT' || parsed.mode === 'DONE') && (domActionResults.length === 0 || isSimpleChatMode)) {
        // [DONO ABSOLUTO] Em modo agent/swarm, NUNCA parar — continuar até o contexto acabar
        if (['agent', 'swarm'].includes(mode)) {
          yield { type: 'done', result: { success: true, mode: parsed.mode, response: parsed.response, sessionId }, sessionId };
          // Pergunta ao Kimi se há mais ações pendentes — continua indefinidamente
          loopInput = '[CHECK] A resposta acima foi entregue ao usuário. Verifique se há mais ações pendentes para completar a tarefa original. Se houver, execute-as agora. Se não houver, confirme que tudo está concluído.';
          loopContext = await this._buildContext(sessionId, loopInput, { ...options, isFirstMessage: false });
          continue; // Continua o loop — nunca para em agent/swarm
        }
        yield { type: 'done', result: { success: true, mode: parsed.mode, response: parsed.response, sessionId }, sessionId };
        return;
      }

      // ACTION or PLAN executed — send result back to Kimi for next iteration
      // Also: DOM-extracted actions that ran during streaming need to be fed back
      const hasOutput = result.output || domActionResults.length > 0;
      if (hasOutput) {
        let outputText = result.output || '';
        // Append DOM action results if not already included
        if (domActionResults.length > 0) {
          for (const dar of domActionResults) {
            const innerResult = dar.result?.result;
            let stdout = innerResult?.stdout || innerResult?.output || innerResult?.text || '';
            const stderr = innerResult?.stderr || '';
            const successMark = dar.result?.success ? '✅' : '❌';
            // If there's a friendly message (e.g., validation errors), include it prominently
            const msg = innerResult?.message || innerResult?.friendlyMessage || '';
            if (!stdout && !msg) {
              stdout = JSON.stringify(innerResult);
            }
            outputText += `\n\n[LUNA-MIRROR] ${successMark} ${dar.tool} executado no PC local:`;
            if (msg) outputText += `\n--- message ---\n${msg}`;
            if (stdout) outputText += `\n--- stdout ---\n${stdout}`;
            if (stderr) outputText += `\n--- stderr ---\n${stderr}`;
            if (dar.kimiResult) outputText += `\n--- sandbox (referência) ---\n${dar.kimiResult.slice(0, 500)}${dar.kimiResult.length > 500 ? '...' : ''}`;
          }
        }
        // v5.2: Mensagem de resultado reescrita para máxima clareza
        // Kimi precisa entender INSTANTANEAMENTE que este é o resultado da ação DELA
        const toolsUsed = result.tool || domActionResults.map(d => d.tool).join(', ') || 'n/a';
        const successCount = domActionResults.filter(d => d.result?.success).length;
        const totalCount = domActionResults.length || (result.tool ? 1 : 0);
        const statusEmoji = successCount === totalCount ? '✅' : '⚠️';

        loopInput = `${statusEmoji} RESULTADO DA EXECUÇÃO — Ferramenta(s): ${toolsUsed}

🎯 O QUE ACONTECEU:
As ferramentas acima foram executadas no PC REAL do usuário (Linux, paths absolutos).
Você mandou a ação → Luna executou → este é o resultado REAL.

📊 STATUS: ${successCount}/${totalCount} sucesso(s)

📝 RESULTADO DETALHADO:
${outputText}

➡️ INSTRUÇÃO: Com base neste resultado, execute o PRÓXIMO passo necessário.
Se precisar de mais informações, use readFile/grep/searchFiles.
Se a tarefa estiver completa, responda ao usuário com o resultado final.
NUNCA re-execute a MESMA ferramenta com os MESMOS parâmetros.`;
        // Always use mini-reminder for tool results (thread already has full prompt)
        loopContext = await this._buildContext(sessionId, loopInput, { ...options, isFirstMessage: false, isToolResult: true });
        // Continue loop — send result back to Kimi
        continue;
      }

      // [DONO ABSOLUTO] Sem break — sempre continua até o contexto acabar ou dar erro
      // Se não houve output, pede ao Kimi para verificar o estado e continuar
      loopInput = '[CHECK] Nenhuma ação foi executada no último ciclo. Verifique se há algo pendente para fazer. Se a tarefa estiver completa, confirme. Se não, execute a próxima ação.';
      loopContext = await this._buildContext(sessionId, loopInput, { ...options, isFirstMessage: false });
      continue;
    }

    if (safety >= MAX_LOOPS) {
      yield { type: 'warning', message: '⚠️ Limite de iterações atingido. Encerrando.', sessionId };
    }
  }

  /**
   * PLAN MODE — Read-only investigation and plan generation.
   * The AI acts as Sherlock Holmes: investigates with read-only tools,
   * writes a detailed plan to file, and awaits user approval.
   */
  async *processPlanModeStream(input, options = {}) {
    const sessionId = options.sessionId || this.sessionManager.getOrCreateCurrentSession({
      title: options.sessionTitle || 'Sessão Luna — Plano',
      mode: options.mode || this.defaultMode,
      persona: options.persona || 'default',
    }).id;
    const userId = options.userId || 'web-plan';

    // Mark session as in plan mode
    const session = this.sessionManager.loadSession(sessionId);
    if (session) {
      session.planMode = true;
      session.planStatus = 'investigating';
    }

    // 1. Signal start
    yield { type: 'plan_start', message: 'Modo Detetive ativado. Iniciando investigação...', sessionId };

    // 2. Build plan-mode system prompt
    const planSystemPrompt = this._buildPlanModePrompt(input);

    // 3. Send to Kimi with plan mode context
    let fullPlan = '';
    let fullThinking = '';

    try {
      const stream = this.kimiBridge.sendMessageStream(userId, planSystemPrompt, { mode: 'thinking' });

      for await (const event of stream) {
        switch (event.type) {
          case 'thinking_delta':
            fullThinking += event.text;
            yield { type: 'thinking_delta', text: event.text, fullThinking, sessionId };
            break;

          case 'response_delta':
            fullPlan += event.text;
            yield { type: 'plan_delta', text: event.text, fullPlan, sessionId };
            break;

          // v5.3: REAL-TIME JSON response streaming — show response immediately
          case 'response_detected': {
            const respText = event.response || '';
            if (respText) {
              yield { type: 'assistant', response: respText, sessionId };
              this.sessionManager.appendEvent(sessionId, {
                type: 'assistant',
                response: respText,
                timestamp: new Date().toISOString(),
              });
            }
            break;
          }

          case 'action_detected': {
            // In plan mode, we still execute read-only actions (readFile, grep, etc.)
            // The _handleAction will block write/execute tools when planMode=true
            const parsedAction = {
              mode: 'ACTION',
              tool: event.action?.tool || event.action?.type,
              params: event.action?.params || event.action,
            };

            yield { type: 'action_start', tool: parsedAction.tool, params: parsedAction.params, source: event.source || 'dom_mirror', sessionId };
            let actionResult = await this._handleAction(parsedAction, sessionId, { ...options, planMode: true });
            yield { type: 'action_end', tool: parsedAction.tool, result: actionResult, source: event.source || 'dom_mirror', sessionId };
            break;
          }

          case 'done':
            fullPlan = event.response;
            break;
        }
      }
    } catch (err) {
      if (err.message === 'STREAM_CANCELLED') {
        yield { type: 'system', message: '⏹️ Geração cancelada pelo usuário.', sessionId };
        return;
      }
      if (err.message === 'KIMI_LOGIN_REQUIRED') {
        yield { type: 'login_required', message: '🔐 Você precisa logar primeiro no Kimi Web. Abra o Chrome em https://kimi.com e faça login.', sessionId };
      } else {
        yield { type: 'error', error: err.message, sessionId };
      }
      if (session) {
        session.planStatus = 'error';
      }
      return;
    }

    // 4. Persist plan to file
    const fs = require('fs');
    const path = require('path');
    const planDir = path.join(process.env.HOME || '/home/jhin', '.luna-kernel', 'plans');
    fs.mkdirSync(planDir, { recursive: true });
    const planPath = path.join(planDir, `${sessionId}.md`);
    fs.writeFileSync(planPath, fullPlan, 'utf-8');

    // 5. Update session status
    if (session) {
      session.planStatus = 'awaiting_approval';
      session.planContent = fullPlan;
      session.planPath = planPath;
    }

    // 6. Signal awaiting approval
    yield { type: 'plan_display', plan: fullPlan, planPath, sessionId };
    yield { type: 'plan_awaiting_approval', plan: fullPlan, planPath, sessionId };
  }

  /** Build the special system prompt for Plan Mode (read-only investigation) */
  _buildPlanModePrompt(userInput) {
    return `[SYSTEM: MODO DETETIVE]

Você é Sherlock Holmes. O cliente pediu: "${userInput}"

Sua missão: INVESTIGAR o projeto antes de propor qualquer solução. Você tem acesso a um terminal Python seguro (ipython) para examinar arquivos.

COMO FUNCIONA:
1. Você escreve código Python em blocos ipython
2. O sistema executa e retorna o resultado
3. Você analisa e escreve mais código se necessário
4. SÓ DEPOIS de investigar, você escreve o plano

EXEMPLO — comece assim:
\`\`\`python
import os
# Liste o diretório do projeto
for root, dirs, files in os.walk('/home/jhin/NEXO_DASHBOARD_PRO'):
    level = root.replace('/home/jhin/NEXO_DASHBOARD_PRO', '').count(os.sep)
    indent = ' ' * 2 * level
    print(f'{indent}{os.path.basename(root)}/')
    subindent = ' ' * 2 * (level + 1)
    for file in files[:5]:
        print(f'{subindent}{file}')
    if len(files) > 5:
        print(f'{subindent}... e mais {len(files)-5} arquivos')
    if level >= 2:
        del dirs[:]
\`\`\`

Depois do resultado, continue investigando:
\`\`\`python
# Leia arquivos relevantes
with open('/home/jhin/NEXO_DASHBOARD_PRO/package.json') as f:
    print(f.read())
\`\`\`

REGRAS:
- Use APENAS leitura (open, os.listdir, glob, etc.)
- NUNCA escreva, delete ou execute comandos de sistema (os.system, subprocess)
- Se não souber o caminho exato, use glob ou os.walk para encontrar
- SEMPRE investigue antes de propor soluções

QUANDO TERMINAR DE INVESTIGAR, escreva o plano em markdown:

# Plano de Ação: [Título]

## Resumo Executivo
[2-3 frases]

## Análise do Codebase
- \`caminho/arquivo.ext\`: [relevância]

## Passos de Implementação
1. **[Arquivo]**: [Ação específica]
2. **[Arquivo]**: [Ação específica]

## Riscos Identificados
- [Risco e mitigação]

## Estimativa
[X passos | Y arquivos | ~Z minutos]

⚠️ IMPORTANTE: NÃO inclua no plano opções como "Aprovar", "Rejeitar", "Revisar" ou pedidos para o usuário escolher A/B/C. O sistema Luna já mostra botões de aprovação automaticamente. Foque apenas no conteúdo do plano.

➡️ COMECE INVESTIGANDO AGORA usando Python.`;
  }

  /** Stream-aware mode processor */
  async *_processModeStream(parsed, sessionId, originalInput, options) {
    const mode = parsed.mode || 'CHAT';

    switch (mode) {
      case 'CHAT':
        yield this._handleChat(parsed, sessionId);
        break;

      case 'ACTION': {
        // v5.2: Emit response FIRST (if any) before executing action
        // Kimi sends response + tool in same message — user must see the response text
        if (parsed.response) {
          yield { type: 'assistant', response: parsed.response, sessionId };
          this.sessionManager.appendEvent(sessionId, {
            type: 'assistant',
            response: parsed.response,
            timestamp: new Date().toISOString(),
          });
        }
        yield { type: 'action_start', tool: parsed.tool, params: parsed.params, sessionId };
        const actionResult = await this._handleAction(parsed, sessionId, options);
        yield { type: 'action_end', tool: parsed.tool, result: actionResult, sessionId };
        yield actionResult;
        break;
      }

      case 'PLAN': {
        // v5.2: Emit response FIRST (if any) before executing plan
        if (parsed.response) {
          yield { type: 'assistant', response: parsed.response, sessionId };
          this.sessionManager.appendEvent(sessionId, {
            type: 'assistant',
            response: parsed.response,
            timestamp: new Date().toISOString(),
          });
        }
        yield { type: 'plan_start', steps: parsed.steps, sessionId };
        for await (const ev of this._handlePlanStream(parsed, sessionId, originalInput, options)) {
          yield ev;
        }
        break;
      }

      case 'DONE':
        yield this._handleDone(parsed, sessionId);
        break;

      case 'LOAD_SKILL':
        yield this._handleLoadSkill(parsed, sessionId);
        break;

      case 'UPDATE_MEMORY':
        yield this._handleUpdateMemory(parsed, sessionId);
        break;

      case 'META': {
        yield { type: 'meta_start', metaAction: parsed.meta_action, sessionId };
        const metaResult = await this._handleMeta(parsed, sessionId);
        yield { type: 'meta_end', result: metaResult, sessionId };
        yield metaResult;
        break;
      }

      case 'SUGGEST': {
        const suggestResult = await this._handleSuggest(parsed, sessionId, options);
        yield { type: 'suggest', suggestion: parsed.suggestion, result: suggestResult, sessionId };
        yield suggestResult;
        break;
      }

      default:
        yield this._handleChat({ response: `Modo desconhecido: ${mode}. Resposta: ${JSON.stringify(parsed)}` }, sessionId);
    }
  }

  /**
   * Non-generator version of _processModeStream.
   * Returns { events: [], output: string, tool: string } for auto-continue loop.
   */
  async _processModeResult(parsed, sessionId, originalInput, options) {
    const mode = parsed.mode || 'CHAT';
    const events = [];
    let output = '';
    let tool = '';

    switch (mode) {
      case 'CHAT': {
        const chatResult = this._handleChat(parsed, sessionId);
        events.push(chatResult);
        output = parsed.response || '';
        break;
      }

      case 'ACTION': {
        tool = parsed.tool || '';
        // v5.2: Emit response FIRST (if any) before executing action
        if (parsed.response) {
          const chatResult = this._handleChat({ response: parsed.response }, sessionId);
          events.push(chatResult);
          output = parsed.response;
        }
        events.push({ type: 'action_start', tool: parsed.tool, params: parsed.params, sessionId });
        const actionResult = await this._handleAction(parsed, sessionId, options);
        events.push({ type: 'action_end', tool: parsed.tool, result: actionResult, sessionId });
        // Append action output to response output
        const actionOutput = actionResult.result?.stdout || actionResult.result?.output || actionResult.result?.text || JSON.stringify(actionResult.result);
        output = output ? `${output}\n\n${actionOutput}` : actionOutput;
        break;
      }

      case 'PLAN': {
        const steps = parsed.steps || [];
        // v5.2: Emit response FIRST (if any) before executing plan
        if (parsed.response) {
          const chatResult = this._handleChat({ response: parsed.response }, sessionId);
          events.push(chatResult);
          output = parsed.response;
        }
        events.push({ type: 'plan_start', steps, sessionId });
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          events.push({
            type: 'plan_step',
            stepIndex: i,
            total: steps.length,
            tool: step.tool,
            params: step.params,
            sessionId,
          });
          const stepResult = await this._handleAction(
            { tool: step.tool, params: step.params, reasoning: step.reasoning },
            sessionId,
            options
          );
          if (!stepResult.success) {
            events.push({ type: 'plan_error', stepIndex: i, error: stepResult.error, sessionId });
            output = `Falha no passo ${i + 1}: ${stepResult.error}`;
            break;
          }
          await new Promise(r => setTimeout(r, 500));
        }
        events.push({ type: 'plan_complete', sessionId });
        break;
      }

      case 'DONE': {
        const doneResult = this._handleDone(parsed, sessionId);
        events.push(doneResult);
        output = parsed.response || '';
        break;
      }

      case 'LOAD_SKILL':
        events.push(this._handleLoadSkill(parsed, sessionId));
        break;

      case 'UPDATE_MEMORY':
        events.push(this._handleUpdateMemory(parsed, sessionId));
        break;

      case 'META': {
        events.push({ type: 'meta_start', metaAction: parsed.meta_action, sessionId });
        const metaResult = await this._handleMeta(parsed, sessionId);
        events.push({ type: 'meta_end', result: metaResult, sessionId });
        break;
      }

      case 'SUGGEST': {
        const suggestResult = await this._handleSuggest(parsed, sessionId, options);
        events.push({ type: 'suggest', suggestion: parsed.suggestion, result: suggestResult, sessionId });
        break;
      }

      default:
        events.push(this._handleChat({ response: `Modo desconhecido: ${mode}. Resposta: ${JSON.stringify(parsed)}` }, sessionId));
    }

    return { events, output, tool };
  }

  /** Stream-aware plan handler */
  async *_handlePlanStream(parsed, sessionId, originalInput, options) {
    const steps = parsed.steps || [];
    const results = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      yield {
        type: 'plan_step',
        stepIndex: i,
        total: steps.length,
        tool: step.tool,
        params: step.params,
        sessionId,
      };

      const stepResult = await this._handleAction(
        { tool: step.tool, params: step.params, reasoning: step.reasoning },
        sessionId,
        options
      );

      results.push({ step, result: stepResult });

      if (!stepResult.success) {
        yield { type: 'plan_error', stepIndex: i, error: stepResult.error, sessionId };
        yield { success: false, mode: 'PLAN', error: `Falha no passo ${i + 1}`, results, sessionId };
        return;
      }

      await new Promise(r => setTimeout(r, 500));
    }

    yield { type: 'plan_complete', sessionId };
    yield { success: true, mode: 'PLAN', results, sessionId };
  }

  /** Build context prompt with history, desktop, skills, memories */
  async _buildContext(sessionId, userInput, options = {}) {
    const session = this.sessionManager.loadSession(sessionId);
    const recentEvents = this.sessionManager.readRecentEvents(sessionId, 30);

    // Build conversation history
    const historyLines = [];
    for (const ev of recentEvents) {
      if (ev.type === 'user') {
        historyLines.push(`user: ${ev.content}`);
      } else if (ev.type === 'assistant') {
        historyLines.push(`assistant: ${ev.response || ev.content || '[tool use]'}`);
      } else if (ev.type === 'tool_call') {
        // FIX: Truncate tool params in history to prevent context bloat
        const paramsStr = JSON.stringify(ev.params || ev.action?.params || {});
        const truncatedParams = paramsStr.length > 500 ? paramsStr.slice(0, 500) + '…' : paramsStr;
        historyLines.push(`tool: ${ev.tool || ev.action?.type}(${truncatedParams})`);
      } else if (ev.type === 'tool_result') {
        // v5.2: Aumentado de 200 para 3000 chars — Kimi PRECISA ver o resultado completo
        const resultOutput = (ev.output || ev.stdout || ev.result?.stdout || ev.result?.output || '').slice(0, 3000);
        historyLines.push(`result: ${ev.success ? '✅' : '❌'} ${resultOutput}`);
      }
    }

    // Desktop state (optional)
    let desktopState = '';
    if (options.includeDesktop !== false) {
      try {
        const state = await this.engine.getDesktopState();
        desktopState = `Resolução: ${state.screenSize?.width}x${state.screenSize?.height}\nJanela ativa: ${state.activeWindow?.name || 'N/A'}\nMouse: (${state.mousePosition?.x}, ${state.mousePosition?.y})`;
      } catch {
        desktopState = '(desktop state unavailable)';
      }
    }

    // Determine if this is the FIRST message in a new thread
    // If the session has no prior assistant events, we need to send the full system prompt
    const hasPriorConversation = recentEvents.some(ev => ev.type === 'assistant' || ev.type === 'tool_call');
    const isFirstMessage = options.isFirstMessage !== undefined ? options.isFirstMessage : !hasPriorConversation;

    if (isFirstMessage) {
      // ── FIRST MESSAGE: full system prompt + context ──
      // Load skills index
      const skills = loadSkillIndex();
      const skillIndex = skills.map(s => `- ${s.name}: ${s.description} (triggers: ${s.triggers?.join(', ') || 'none'})`).join('\n');

      // Load persona
      const personaContent = loadPersona(session?.persona || 'default') || '';

      // Load memories
      const memories = loadMemories();
      const memoryContext = memories.map(m => `[${m.file}]\n${m.content}`).join('\n\n');

      // Load AGENTS.md from current working directory (kimi-cli style)
      const agentsMd = loadAgentsMd(process.cwd());

      // Build registries for auto-selection
      const personaReg = loadPersonaRegistry();
      const personaRegistry = personaReg.map(p => `- ${p.name}: ${p.description}`).join('\n');
      const skillReg = loadSkillRegistry();
      const skillRegistry = skillReg.map(s => `- ${s.name}: ${s.description}`).join('\n');

      // Load master prompt
      const masterPrompt = loadMasterPrompt();

      // Build system prompt
      const systemPrompt = buildSystemPrompt({ skillIndex, personaContent, memoryContext, personaRegistry, skillRegistry, agentsMd, masterPrompt });

      // Workspace context (if set)
      const workspaceContext = workspaceManager.getFormattedManifest('luna-cli');
      const activeFilesContext = workspaceManager.getActiveFilesContext('luna-cli');

      // Build full prompt
      const prompt = `${systemPrompt}\n\n--- CONTEXTO DO DESKTOP ---\n${desktopState}${workspaceContext ? '\n\n--- WORKSPACE ---\n' + workspaceContext : ''}${activeFilesContext ? '\n\n' + activeFilesContext : ''}\n\n--- HISTÓRICO ---\n${historyLines.join('\n')}\n\n--- MENSAGEM ATUAL ---\nuser: ${userInput}\n\nResponda usando APENAS code blocks JSON. NUNCA tags [[response]] ou [[action]]:`;

      // Debug log
      if (process.env.LUNA_DEBUG) {
        console.error(`[LunaDebug] FIRST_MESSAGE promptSize=${Buffer.byteLength(prompt, 'utf8')} bytes, systemPromptSize=${Buffer.byteLength(systemPrompt, 'utf8')} bytes, agentsMd=${agentsMd ? 'YES' : 'NO'}`);
      }

      return { prompt, systemPrompt, historyLines, desktopState, isFirstMessage: true };
    } else {
      // ── SUBSEQUENT MESSAGES: minimal reminder only ──
      // The Kimi Web thread already has the full system prompt in its history.
      // We only need a short reminder + the current user input or tool result.
      // Include a condensed tool registry so Kimi remembers available actions.
      // v5.3: MICRO-REMINDER — system prompt completo foi enviado na 1ª msg.
      // Nas subsequentes, enviamos APENAS o essencial para manter contexto.
      const microReminder = `[LUNA — CONTINUAÇÃO]
Você é Luna (agente de Abner, CEO NEXO DIGITAL). Formato: code blocks JSON apenas.
Response: \`\`\`json{"response":"..."}\`\`\`  Tool: \`\`\`json{"tool":"...","params":{}}\`\`\`
NUNCA diga "não posso". EXECUTE. NUNCA peça confirmação. Se falhar, tente alternativa.`;

      // Workspace context (if set) — include in follow-ups too
      const workspaceCtx = workspaceManager.getFormattedManifest('luna-cli');
      const activeFilesCtx = workspaceManager.getActiveFilesContext('luna-cli');
      const workspaceSnippet = workspaceCtx ? `\nWORKSPACE: ${workspaceCtx.split('\n')[0]}${workspaceCtx.split('\n')[1] ? ' ' + workspaceCtx.split('\n')[1] : ''}` : '';

      // v5.2: SEMPRE incluir histórico — Kimi precisa de contexto para entender que o resultado
      // é da ação DELA. Sem histórico, ela vê uma mensagem aleatória sem saber de onde veio.
      const isToolResult = options.isToolResult === true;
      const historySnippet = historyLines.slice(-10).join('\n'); // Aumentado de -6 para -10
      const toolResultHeader = isToolResult
        ? `\n🔄 ESTE É O RESULTADO DA SUA AÇÃO ANTERIOR. Use-o para continuar o raciocínio.`
        : '';
      let prompt;
      if (isToolResult) {
        // Tool result: mini-reminder + histórico completo + resultado destacado
        prompt = `${microReminder}${workspaceSnippet}\n\n--- HISTÓRICO DA CONVERSA ---\n${historySnippet}${activeFilesCtx ? '\n\n' + activeFilesCtx : ''}${toolResultHeader}\n\n--- RESULTADO DA FERRAMENTA ---\n${userInput}\n\nResponda usando APENAS code blocks JSON. NUNCA tags [[response]] ou [[action]]:`;
      } else {
        prompt = `${microReminder}${workspaceSnippet}\n\n--- HISTÓRICO RECENTE ---\n${historySnippet}${activeFilesCtx ? '\n\n' + activeFilesCtx : ''}\n\n--- MENSAGEM ATUAL ---\nuser: ${userInput}\n\nResponda usando APENAS code blocks JSON. NUNCA tags [[response]] ou [[action]]:`;
      }

      // Debug log
      if (process.env.LUNA_DEBUG) {
        console.error(`[LunaDebug] FOLLOW_UP promptSize=${Buffer.byteLength(prompt, 'utf8')} bytes, toolResult=${isToolResult}, historyLines=${historyLines.length}`);
      }

      return { prompt, systemPrompt: microReminder, historyLines, desktopState, isFirstMessage: false };
    }
  }

  /** Process parsed mode */
  async _processMode(parsed, sessionId, originalInput, options) {
    const mode = parsed.mode || 'CHAT';

    switch (mode) {
      case 'CHAT':
        return this._handleChat(parsed, sessionId);

      case 'ACTION':
        return this._handleAction(parsed, sessionId, options);

      case 'PLAN':
        return this._handlePlan(parsed, sessionId, originalInput, options);

      case 'DONE':
        return this._handleDone(parsed, sessionId);

      case 'LOAD_SKILL':
        return this._handleLoadSkill(parsed, sessionId);

      case 'UPDATE_MEMORY':
        return this._handleUpdateMemory(parsed, sessionId);

      case 'META':
        return this._handleMeta(parsed, sessionId);

      case 'SUGGEST':
        return this._handleSuggest(parsed, sessionId, options);

      default:
        // Unknown mode — treat as chat
        return this._handleChat({ response: `Modo desconhecido: ${mode}. Resposta: ${JSON.stringify(parsed)}` }, sessionId);
    }
  }

  /**
   * Generate a friendly Portuguese feedback message after tool execution.
   */
  _makeFriendlyFeedback(tool, params, result) {
    const p = params || {};
    if (!result.success) {
      const fallbacks = [
        `Opa, deu errado ao usar ${tool}. Quer que eu tente de outra forma?`,
        `Não consegui executar ${tool}. Pode me dar mais detalhes?`,
        `Falha no ${tool}. Vou tentar um approach diferente se precisar.`,
      ];
      return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }

    switch (tool) {
      case 'writeFile':
        return `✅ Pronto, Abner! Criei o arquivo em \`${p.path || p.filePath}\`. Precisa de mais alguma coisa?`;
      case 'readFile':
        return `📖 Li o arquivo. Dá uma olhada no conteúdo acima. Quer que eu edite algo?`;
      case 'replaceInFile':
        return `✏️ Feito! Substitui \`${p.old || p.oldStr}\` por \`${p.new || p.newStr}\` no arquivo.`;
      case 'appendFile':
        return `📝 Adicionei o texto no final do arquivo \`${p.path || p.filePath}\`.`;
      case 'deleteFile':
        return `🗑️ Arquivo \`${p.path || p.filePath}\` deletado com sucesso.`;
      case 'moveFile':
        return `📦 Movido de \`${p.source || p.from}\` para \`${p.destination || p.to}\`.`;
      case 'copyFile':
        return `📋 Copiado de \`${p.source || p.from}\` para \`${p.destination || p.to}\`.`;
      case 'createDirectory':
        return `📁 Diretório \`${p.path || p.dirPath}\` criado.`;
      case 'removeDirectory':
        return `🗑️ Diretório \`${p.path || p.dirPath}\` removido.`;
      case 'executeShell': {
        const out = result.stdout || result.output || '';
        if (out.length > 0 && out.length < 200) {
          return `🖥️ Comando executado. Resultado:\n\`\`\`\n${out}\n\`\`\``;
        }
        return `🖥️ Comando executado com sucesso.`;
      }
      case 'executeScript': {
        const scriptOut = result.stdout || '';
        const scriptErr = result.stderr || '';
        const exitCode = result.exitCode || 0;
        const lang = result.language || 'script';
        const status = exitCode === 0 ? '✅' : '❌';
        let msg = `${status} Script ${lang} executado (exit ${exitCode})`;
        if (scriptOut) msg += `\n\n📤 stdout:\n\`\`\`\n${scriptOut.slice(0, 3000)}\n\`\`\``;
        if (scriptErr) msg += `\n\n⚠️ stderr:\n\`\`\`\n${scriptErr.slice(0, 1000)}\n\`\`\``;
        return msg;
      }
      case 'searchFiles':
      case 'grep': {
        const matches = result.matches || [];
        return `🔍 Encontrei ${matches.length} resultado(s).`;
      }
      case 'gitStatus':
        return `🌿 Status do git verificado.`;
      case 'gitCommit':
        return `💾 Commit feito: \`${p.message || ''}\``;
      case 'gitDiff':
        return `🌿 Diff gerado. Dá uma olhada no resultado acima.`;
      case 'gitLog':
        return `📜 Histórico de commits recuperado.`;
      case 'applyPatch':
        return `🩹 Patch aplicado com sucesso.`;
      case 'downloadFile':
        return `⬇️ Download concluído em \`${p.destination || p.path}\`.`;
      case 'fetchURL':
        return `🌐 Página carregada. Veja o conteúdo acima.`;
      case 'runTests': {
        const out = result.stdout || '';
        const passed = out.includes('PASS') || out.includes('passing');
        return passed ? `🧪 Testes passaram!` : `🧪 Testes executados. Veja o resultado.`;
      }
      case 'checkSyntax':
        return `✅ Sintaxe OK.`;
      case 'clipboardWrite':
        return `📋 Copiado para o clipboard.`;
      case 'clipboardRead': {
        const content = result.content || '';
        return `📋 Clipboard: \`${content.slice(0, 100)}${content.length > 100 ? '...' : ''}\``;
      }
      case 'screenshot':
        return `📸 Screenshot tirado e salvo.`;
      case 'think':
        return `🧠 Reflexão registrada.`;
      case 'dashboardCreateTask':
      case 'dashboardListTasks':
      case 'dashboardCreateLead':
      case 'dashboardCreateIdea':
      case 'dashboardListIdeas':
      case 'dashboardListLeads':
      case 'dashboardGetFinanceSummary':
      case 'dashboardListVotingSessions':
      case 'dashboardGetVotingSession':
      case 'dashboardCreateVotingSession':
      case 'dashboardVoteInSession':
      case 'dashboardDeleteVotingSession': {
        const out = result.stdout || '';
        return out.length < 300 ? out : out.slice(0, 300) + '...';
      }
      default:
        return `✅ ${tool} executado com sucesso.`;
    }
  }

  /** CHAT mode — simple response */
  _handleChat(parsed, sessionId) {
    const response = parsed.response || parsed.content || 'Sem resposta';

    this.sessionManager.appendEvent(sessionId, {
      type: 'assistant',
      mode: 'CHAT',
      response,
      timestamp: new Date().toISOString(),
    });

    this.emit('response', { type: 'chat', content: response, sessionId });
    return { success: true, mode: 'CHAT', response, sessionId };
  }

  /** ACTION mode — execute a tool */
  async _handleAction(parsed, sessionId, options) {
    const tool = parsed.tool || parsed.action?.type;
    const params = parsed.params || parsed.action?.params || {};
    const reasoning = parsed.reasoning || '';
    let result;

    // ── Plan Mode Tool Filter ──
    // When in plan mode, only read-only tools are allowed
    if (options?.planMode === true) {
      const READ_ONLY_TOOLS = [
        'readFile', 'glob', 'grep', 'searchFiles', 'viewDirectory', 'listFiles',
        'getFileInfo', 'searchWeb', 'fetchURL', 'gitStatus', 'gitDiff', 'gitLog',
        'dashboardListTasks', 'dashboardListLeads', 'dashboardListPayments',
        'dashboardListExpenses', 'dashboardGetCashBox', 'dashboardListCashHistory',
        'dashboardListQuotes', 'dashboardListProjects', 'dashboardListClients',
        'dashboardListIdeas', 'dashboardGetFinanceSummary', 'dashboardListVotingSessions',
        'dashboardGetSystemStatus', 'dashboardGetSystemLogs', 'dashboardListNotifications',
        'dashboardListUsers', 'dashboardListGitHubRepos', 'dashboardListVercelProjects',
        'dashboardListBugReports', 'dashboardListEmails', 'dashboardListLinks',
        'think', 'getCurrentDirectory', 'clipboardRead', 'readMediaFile',
        'ipython', 'python', 'code', 'executePython',
      ];
      const DASHBOARD_READ_ONLY_PATTERN = /^dashboard(List|Get)/;
      const isReadOnly = READ_ONLY_TOOLS.includes(tool) || DASHBOARD_READ_ONLY_PATTERN.test(tool);

      if (!isReadOnly) {
        const blockedResult = {
          success: false,
          error: `Modo Detetive: A ferramenta "${tool}" é proibida durante a investigação. Apenas ferramentas de leitura são permitidas.`,
          friendlyMessage: `🔒 ${tool} bloqueado em Plan Mode. Use apenas readFile, grep, glob, searchWeb, etc.`,
          planModeBlocked: true,
        };
        this.sessionManager.appendEvent(sessionId, {
          type: 'tool_call',
          tool,
          params,
          reasoning,
          timestamp: new Date().toISOString(),
        });
        this.sessionManager.appendEvent(sessionId, {
          type: 'tool_result',
          tool,
          success: false,
          output: blockedResult.error,
          timestamp: new Date().toISOString(),
        });
        return blockedResult;
      }
    }

    // Store tool call
    this.sessionManager.appendEvent(sessionId, {
      type: 'tool_call',
      tool,
      params,
      reasoning,
      timestamp: new Date().toISOString(),
    });

    // Detect if it's a file tool or desktop tool
    const FILE_TOOLS = Object.keys(lunaTools);
    const DESKTOP_TOOLS = ['shell', 'click', 'doubleClick', 'rightClick', 'type', 'keypress', 'hotkey', 'scroll', 'screenshot', 'ocr', 'open_app', 'wait'];
    const isFileTool = FILE_TOOLS.includes(tool);
    const isDesktopTool = DESKTOP_TOOLS.includes(tool);

    // Emit progress
    const FILE_EMOJIS = {
      readFile: '📖', writeFile: '✍️', appendFile: '📝', replaceInFile: '✏️', deleteFile: '🗑️',
      moveFile: '📦', copyFile: '📋', getFileInfo: '📄',
      listFiles: '📂', viewDirectory: '🗂️', createDirectory: '📁', removeDirectory: '🗑️',
      searchFiles: '🔍', grep: '🔎', glob: '🎯', searchWeb: '🌐', fetchURL: '🌐',
      executeShell: '🖥️', runTests: '🧪', checkSyntax: '✅', installPackages: '📦',
      gitStatus: '🌿', gitDiff: '🌿', gitLog: '📜', gitCommit: '💾',
      applyPatch: '🩹', downloadFile: '⬇️',
      clipboardRead: '📋', clipboardWrite: '📋',
      readMediaFile: '🖼️', getCurrentDirectory: '📍',
      think: '🧠',
    };
    const DESKTOP_EMOJIS = {
      shell: '🖥️', click: '🖱️', doubleClick: '🖱️🖱️', rightClick: '🖱️▶️',
      type: '⌨️', keypress: '🔑', hotkey: '🔑', scroll: '📜',
      screenshot: '📸', ocr: '🔍', open_app: '🚀', wait: '⏱️',
    };
    const emoji = FILE_EMOJIS[tool] || DESKTOP_EMOJIS[tool] || '⚡';

    this.emit('progress', {
      type: 'action',
      tool,
      params,
      message: `${emoji} ${tool}: ${JSON.stringify(params).slice(0, 200)}`,
      sessionId,
      category: isFileTool ? 'file' : isDesktopTool ? 'desktop' : 'unknown',
    });

    // ── Path Traversal Protection ──
    // Ensure file paths stay within workspace (if workspace is set)
    const ws = workspaceManager.getWorkspace('luna-cli');
    if (ws && params.path) {
      const resolved = path.resolve(params.path);
      const wsResolved = path.resolve(ws.path);
      if (!resolved.startsWith(wsResolved) && !params.path.startsWith('/tmp')) {
        result = { success: false, error: `Path traversal bloqueado: "${params.path}" está fora do workspace "${ws.path}".` };
      }
    }

    // ── Destructive operation check for shell commands ──
    if (!result && tool === 'executeShell' && params.command) {
      const destructive = checkDestructivePattern(params.command);
      if (destructive) {
        const confirmed = await this._confirmDestructive(destructive.message, params.command);
        if (!confirmed) {
          result = { success: false, error: `Operação destrutiva cancelada pelo usuário (${destructive.message})` };
        }
      }
    }

    // ── Truncation guard for shell commands ──
    // If a shell command looks like it was cut mid-heredoc or mid-string,
    // return an error so Kimi Web knows to retry with a different approach.
    if (!result && tool === 'executeShell' && params.command) {
      const cmd = params.command;
      const truncErrors = [];
      // Check for unclosed heredoc: cat << 'EOF' ... (no closing EOF line)
      const heredocOpen = cmd.match(/<<\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*$/m);
      if (heredocOpen) {
        const delimiter = heredocOpen[1];
        const closeRe = new RegExp(`^${delimiter}\\s*$`, 'm');
        if (!closeRe.test(cmd)) {
          truncErrors.push(`Heredoc não fechado (esperado ${delimiter} no final)`);
        }
      }
      // Check for unclosed single/double quotes
      let inSingle = false, inDouble = false, escape = false;
      for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
      }
      if (inSingle) truncErrors.push('String com aspas simples não fechada');
      if (inDouble) truncErrors.push('String com aspas duplas não fechada');
      // Check for unclosed backticks
      const backticks = (cmd.match(/`/g) || []).length;
      if (backticks % 2 !== 0) truncErrors.push('Backtick não fechado');
      // Check for unclosed $() or ()
      let parenDepth = 0;
      for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];
        if (ch === '(') parenDepth++;
        else if (ch === ')') parenDepth--;
      }
      if (parenDepth !== 0) truncErrors.push('Parênteses desbalanceados');

      if (truncErrors.length > 0) {
        result = {
          success: false,
          error: `Comando shell parece truncado. NÃO EXECUTADO. Problemas: ${truncErrors.join(', ')}. Por favor, reenvie usando writeFile ou node -e em vez de heredoc longos.`,
        };
      }
    }

    // ── Execute ──
    if (!result) {
      try {
        const guard = this._ensureToolGuard();
        if (isFileTool && lunaTools[tool]) {
          const p = params || {};
          // Build tool executor lambda
          const toolFn = () => {
            switch (tool) {
              case 'readFile': return lunaTools.readFile(p.path || p.file, { offset: p.offset || p.line_offset, limit: p.limit || p.n_lines });
              case 'writeFile': return lunaTools.writeFile(p.path || p.filePath, p.content);
              case 'appendFile': return lunaTools.appendFile(p.path || p.filePath, p.content);
              case 'replaceInFile': return lunaTools.replaceInFile(p.path || p.filePath, p.old || p.oldStr, p.new || p.newStr, { replaceAll: p.replaceAll, edit: p.edit });
              case 'deleteFile': return lunaTools.deleteFile(p.path || p.filePath);
              case 'moveFile': return lunaTools.moveFile(p.source || p.from, p.destination || p.to);
              case 'copyFile': return lunaTools.copyFile(p.source || p.from, p.destination || p.to);
              case 'getFileInfo': return lunaTools.getFileInfo(p.path || p.filePath);
              case 'listFiles': return lunaTools.listFiles(p.pattern || '*', { cwd: p.cwd, limit: p.limit, dot: p.dot });
              case 'viewDirectory': return lunaTools.viewDirectory(p.path || p.dirPath, { depth: p.depth });
              case 'createDirectory': return lunaTools.createDirectory(p.path || p.dirPath);
              case 'removeDirectory': return lunaTools.removeDirectory(p.path || p.dirPath);
              case 'searchFiles': return lunaTools.searchFiles(p.pattern, { cwd: p.cwd, path: p.path, context: p.context, '-C': p['-C'], limit: p.limit });
              case 'grep': return lunaTools.grep(p.pattern, { cwd: p.cwd, path: p.path, glob: p.glob, include: p.include, context: p.context, '-C': p['-C'], limit: p.limit, output_mode: p.output_mode });
              case 'glob': return lunaTools.glob(p.pattern, { cwd: p.cwd, dot: p.dot, ignore: p.ignore, limit: p.limit });
              case 'searchWeb': return lunaTools.searchWeb(p.query || p.q, { limit: p.limit });
              case 'fetchURL': return lunaTools.fetchURL(p.url, { limit: p.limit, timeout: p.timeout });
              case 'executeShell': return lunaTools.executeShell(p.command, { cwd: p.cwd, timeout: p.timeout });
              case 'executeScript': return lunaTools.executeScript(p.code || p.script, { language: p.language || p.lang, cwd: p.cwd, timeout: p.timeout });
              case 'runTests': return lunaTools.runTests({ cwd: p.cwd, timeout: p.timeout, command: p.command });
              case 'checkSyntax': return lunaTools.checkSyntax(p.path || p.filePath);
              case 'installPackages': return lunaTools.installPackages(p.packages || p.package, { cwd: p.cwd, timeout: p.timeout });
              case 'gitStatus': return lunaTools.gitStatus({ cwd: p.cwd });
              case 'gitDiff': return lunaTools.gitDiff({ cwd: p.cwd, staged: p.staged });
              case 'gitLog': return lunaTools.gitLog({ cwd: p.cwd, n: p.n, limit: p.limit });
              case 'gitCommit': return lunaTools.gitCommit(p.message, { cwd: p.cwd });
              case 'applyPatch': return lunaTools.applyPatch(p.patch || p.patchContent, { cwd: p.cwd });
              case 'downloadFile': return lunaTools.downloadFile(p.url, p.destination || p.path, { timeout: p.timeout });
              case 'clipboardRead': return lunaTools.clipboardRead();
              case 'clipboardWrite': return lunaTools.clipboardWrite(p.text || p.content);
              case 'readMediaFile': return lunaTools.readMediaFile(p.path || p.filePath);
              case 'getCurrentDirectory': return lunaTools.getCurrentDirectory();
              case 'openDebugTerminal': return lunaTools.openDebugTerminal(p);
              case 'think': return lunaTools.think(p.thought || p.reasoning || p.text);
              case 'dashboardCreateTask': return lunaTools.dashboardCreateTask(p);
              case 'dashboardListTasks': return lunaTools.dashboardListTasks(p);
              case 'dashboardUpdateTask': return lunaTools.dashboardUpdateTask(p);
              case 'dashboardDeleteTask': return lunaTools.dashboardDeleteTask(p);
              case 'dashboardCompleteTask': return lunaTools.dashboardCompleteTask(p);
              case 'dashboardAddComment': return lunaTools.dashboardAddComment(p);
              case 'dashboardCreateLead': return lunaTools.dashboardCreateLead(p);
              case 'dashboardListLeads': return lunaTools.dashboardListLeads(p);
              case 'dashboardUpdateLead': return lunaTools.dashboardUpdateLead(p);
              case 'dashboardConvertLead': return lunaTools.dashboardConvertLead(p);
              case 'dashboardDeleteLead': return lunaTools.dashboardDeleteLead(p);
              case 'dashboardCreatePayment': return lunaTools.dashboardCreatePayment(p);
              case 'dashboardListPayments': return lunaTools.dashboardListPayments(p);
              case 'dashboardUpdatePayment': return lunaTools.dashboardUpdatePayment(p);
              case 'dashboardDeletePayment': return lunaTools.dashboardDeletePayment(p);
              case 'dashboardReceiveSplit': return lunaTools.dashboardReceiveSplit(p);
              case 'dashboardCreateExpense': return lunaTools.dashboardCreateExpense(p);
              case 'dashboardListExpenses': return lunaTools.dashboardListExpenses(p);
              case 'dashboardUpdateExpense': return lunaTools.dashboardUpdateExpense(p);
              case 'dashboardDeleteExpense': return lunaTools.dashboardDeleteExpense(p);
              case 'dashboardPayExpense': return lunaTools.dashboardPayExpense(p);
              case 'dashboardCreateExpenseTemplate': return lunaTools.dashboardCreateExpenseTemplate(p);
              case 'dashboardQuickExpense': return lunaTools.dashboardQuickExpense(p);
              case 'dashboardGetCashBox': return lunaTools.dashboardGetCashBox(p);
              case 'dashboardAddCashEntry': return lunaTools.dashboardAddCashEntry(p);
              case 'dashboardListCashHistory': return lunaTools.dashboardListCashHistory(p);
              case 'dashboardReconcileCashBox': return lunaTools.dashboardReconcileCashBox(p);
              case 'dashboardAdjustCashBox': return lunaTools.dashboardAdjustCashBox(p);
              case 'dashboardGetCashBoxProjection': return lunaTools.dashboardGetCashBoxProjection(p);
              case 'dashboardCreateCashPayment': return lunaTools.dashboardCreateCashPayment(p);
              case 'dashboardCreateQuote': return lunaTools.dashboardCreateQuote(p);
              case 'dashboardListQuotes': return lunaTools.dashboardListQuotes(p);
              case 'dashboardUpdateQuote': return lunaTools.dashboardUpdateQuote(p);
              case 'dashboardDeleteQuote': return lunaTools.dashboardDeleteQuote(p);
              case 'dashboardListProjects': return lunaTools.dashboardListProjects(p);
              case 'dashboardListClients': return lunaTools.dashboardListClients(p);
              case 'dashboardCreateIdea': return lunaTools.dashboardCreateIdea(p);
              case 'dashboardListIdeas': return lunaTools.dashboardListIdeas(p);
              case 'dashboardAddLink': return lunaTools.dashboardAddLink(p);
              case 'dashboardListLinks': return lunaTools.dashboardListLinks(p);
              case 'dashboardDeleteLink': return lunaTools.dashboardDeleteLink(p);
              case 'dashboardEnrichLink': return lunaTools.dashboardEnrichLink(p);
              case 'dashboardSyncLinks': return lunaTools.dashboardSyncLinks(p);
              case 'dashboardGetLinksStats': return lunaTools.dashboardGetLinksStats(p);
              case 'dashboardSendEmail': return lunaTools.dashboardSendEmail(p);
              case 'dashboardListEmails': return lunaTools.dashboardListEmails(p);
              case 'dashboardSyncEmails': return lunaTools.dashboardSyncEmails(p);
              case 'dashboardSendWhatsApp': return lunaTools.dashboardSendWhatsApp(p);
              case 'dashboardGetWhatsAppHistory': return lunaTools.dashboardGetWhatsAppHistory(p);
              case 'dashboardScanWhatsApp': return lunaTools.dashboardScanWhatsApp(p);
              case 'dashboardGetWhatsAppStatus': return lunaTools.dashboardGetWhatsAppStatus(p);
              case 'dashboardGetWhatsAppClassifications': return lunaTools.dashboardGetWhatsAppClassifications(p);
              case 'dashboardGetSystemStatus': return lunaTools.dashboardGetSystemStatus(p);
              case 'dashboardGetSystemLogs': return lunaTools.dashboardGetSystemLogs(p);
              case 'dashboardControlService': return lunaTools.dashboardControlService(p);
              case 'dashboardListNotifications': return lunaTools.dashboardListNotifications(p);
              case 'dashboardMarkNotificationRead': return lunaTools.dashboardMarkNotificationRead(p);
              case 'dashboardMarkAllNotificationsRead': return lunaTools.dashboardMarkAllNotificationsRead(p);
              case 'dashboardListUsers': return lunaTools.dashboardListUsers(p);
              case 'dashboardListMembers': return lunaTools.dashboardListMembers(p);
              case 'dashboardListBugReports': return lunaTools.dashboardListBugReports(p);
              case 'dashboardDeleteBugReport': return lunaTools.dashboardDeleteBugReport(p);
              case 'dashboardListGitHubRepos': return lunaTools.dashboardListGitHubRepos(p);
              case 'dashboardListVercelProjects': return lunaTools.dashboardListVercelProjects(p);
              case 'dashboardListOpsAlerts': return lunaTools.dashboardListOpsAlerts(p);
              case 'dashboardCreateOpsAlert': return lunaTools.dashboardCreateOpsAlert(p);
              case 'dashboardDeleteOpsAlert': return lunaTools.dashboardDeleteOpsAlert(p);
              case 'dashboardListTransactions': return lunaTools.dashboardListTransactions(p);
              case 'dashboardGetNexoState': return lunaTools.dashboardGetNexoState(p);
              case 'dashboardGetConfig': return lunaTools.dashboardGetConfig(p);
              case 'dashboardGetFinanceSummary': return lunaTools.dashboardGetFinanceSummary(p);
              case 'dashboardListVotingSessions': return lunaTools.dashboardListVotingSessions(p);
              case 'dashboardGetVotingSession': return lunaTools.dashboardGetVotingSession(p);
              case 'dashboardCreateVotingSession': return lunaTools.dashboardCreateVotingSession(p);
              case 'dashboardVoteInSession': return lunaTools.dashboardVoteInSession(p);
              case 'dashboardDeleteVotingSession': return lunaTools.dashboardDeleteVotingSession(p);
              case 'dashboardCommandRouter': return this._execDashboardCommandRouter(p);
              default: return { success: false, error: `Ferramenta desconhecida: ${tool}` };
            }
          };
          if (guard) {
            result = await guard.execute(tool, p, toolFn);
          } else {
            result = toolFn();
          }

          // ── IMMEDIATE FILE VALIDATION (fast feedback loop) ──
          // Detecta erros de sintaxe/truncamento IMEDIATAMENTE após writeFile
          // para que a Kimi Web corrija na próxima iteração
          const FILE_WRITE_TOOLS = ['writeFile', 'appendFile', 'replaceInFile'];
          if (FILE_WRITE_TOOLS.includes(tool) && result?.success) {
            const writtenPath = p.path || p.filePath;
            if (writtenPath && fs.existsSync(writtenPath)) {
              const ext = path.extname(writtenPath);
              const content = fs.readFileSync(writtenPath, 'utf8');
              const validationErrors = [];

              // 1. Truncation check
              const trunc = checkFileTruncated(content, ext);
              if (trunc.truncated) validationErrors.push(...trunc.errors);

              // 2. JSX balance check
              if (ext === '.jsx' || ext === '.tsx') {
                const jsx = checkJsxBalanced(content);
                if (!jsx.balanced) validationErrors.push(...jsx.errors);
              }

              if (validationErrors.length > 0) {
                const errorText = `⚠️ VALIDAÇÃO IMEDIATA DO ARQUIVO (${path.basename(writtenPath)}):\n${validationErrors.map(e => `  - ${e}`).join('\n')}\n\nO arquivo foi escrito mas contém erros. Por favor, corrija e reescreva o arquivo.`;
                result.validationErrors = validationErrors;
                result.message = (result.message || '') + '\n\n' + errorText;
                // Não marcamos como falha (success continua true) para não quebrar o fluxo,
                // mas a Kimi Web vê os erros na mensagem e pode corrigir.
              }
            }
          }

          // ── Auto project health validation after file creation ──
          if (tool === 'writeFile' || tool === 'create_script' || tool === 'edit_file') {
            const filePath = p.path || p.filePath;
            if (filePath) {
              const projectDir = this._findProjectRoot(path.dirname(path.resolve(filePath)));
              if (projectDir) {
                const validation = await this.projectValidator.validate(projectDir);
                if (!validation.ok && validation.fixes.length > 0) {
                  // Append fixes to result message
                  const fixesText = validation.fixes.join('\n');
                  if (result && result.message) {
                    result.message += `\n\n🔧 Auto-fixes aplicados:\n${fixesText}`;
                  }
                }
                // Sempre emite o progress (inclui screenshot e errorText se houver)
                this.emit('progress', {
                  type: 'project_health',
                  fixes: validation.fixes,
                  screenshot: validation.screenshot,
                  errorText: validation.errorText,
                  projectDir,
                  sessionId,
                });
                // Se houver screenshot, inclui no resultado
                if (validation.screenshot && result) {
                  result.screenshot = validation.screenshot;
                }
                // Se houver erro no screenshot, inclui no resultado para Kimi analisar
                if (validation.errorText && result) {
                  result.errorText = validation.errorText;
                  result.message = (result.message || '') + `\n\n🚨 ERRO NA PÁGINA:\n${validation.errorText.slice(0, 1500)}`;
                }
              }
            }
          }
        } else if (isDesktopTool) {
          const action = { type: tool, params };
          result = await this.engine.executeSingle(action);
        } else if (tool === 'ipython') {
          // v3.3: Kimi nativa ipython → extrair código e executar localmente via executeShell
          const code = params.code || params.command || '';
          if (!code) {
            result = { success: false, error: 'ipython: nenhum código fornecido' };
          } else {
            // Security: AST-light sandbox validation
            const pyCheck = validatePythonCode(code);
            if (!pyCheck.ok) {
              result = { success: false, error: `ipython: ${pyCheck.reason}. Operação bloqueada por segurança.` };
            } else {
              const heredocDelim = `PYEOF_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              const shellCmd = `python3 <<'${heredocDelim}'\n${code}\n${heredocDelim}`;
              // Check for destructive shell patterns even inside Python heredoc
              const destructive = checkDestructivePattern(shellCmd);
              if (destructive) {
                const confirmed = await this._confirmDestructive(destructive.message, shellCmd);
                if (!confirmed) {
                  result = { success: false, error: `ipython: operação destrutiva cancelada pelo usuário (${destructive.message})` };
                }
              }
              if (!result) {
                const shellFn = () => lunaTools.executeShell(shellCmd);
                if (guard) {
                  result = await guard.execute('executeShell', { command: shellCmd }, shellFn);
                } else {
                  result = shellFn();
                }
              }
            }
          }
        } else if (tool === 'browser') {
          // v3.3: Kimi nativa browser → mapear para fetchURL (simplificado) ou executeShell com curl
          const url = params.url || (typeof params === 'string' ? params : '');
          if (!url) {
            result = { success: false, error: 'browser: nenhuma URL fornecida' };
          } else {
            const fetchFn = () => lunaTools.fetchURL(url);
            if (guard) {
              result = await guard.execute('browser', { url }, fetchFn);
            } else {
              result = await fetchFn();
            }
          }
        } else if (tool === 'computer') {
          // v3.3: Kimi nativa computer → mapear para desktop engine
          const action = params.action || 'screenshot';
          const desktopActions = ['click', 'type', 'keypress', 'hotkey', 'screenshot', 'scroll', 'wait', 'open_app'];
          if (desktopActions.includes(action)) {
            const desktopParams = { ...params };
            delete desktopParams.action;
            const desktopFn = () => this.engine.executeSingle({ type: action, params: desktopParams });
            if (guard) {
              result = await guard.execute('computer', { action, ...desktopParams }, desktopFn);
            } else {
              result = await desktopFn();
            }
          } else {
            result = { success: false, error: `computer: ação '${action}' não suportada. Use: ${desktopActions.join(', ')}` };
          }
        } else if (tool === 'dashboardCommandRouter') {
          const p = params || {};
          const routerFn = () => this._execDashboardCommandRouter(p);
          if (guard) {
            result = await guard.execute(tool, p, routerFn);
          } else {
            result = await routerFn();
          }
        } else {
          result = { success: false, error: `Ferramenta desconhecida: ${tool}. Use uma das ferramentas disponíveis.` };
        }
      } catch (err) {
        result = { success: false, error: err.message };
      }
    }

    // Auto-commit git hook for file-modifying tools
    const MODIFYING_TOOLS = ['writeFile', 'appendFile', 'replaceInFile', 'deleteFile', 'moveFile'];
    if (result.success && MODIFYING_TOOLS.includes(tool)) {
      try {
        const git = await this._ensureGit();
        if (git) {
          const filePath = params.path || params.filePath || params.source || params.from;
          if (filePath) {
            const commitResult = await git.commit(filePath, `luna: ${tool} ${path.basename(filePath)}`);
            if (commitResult.success && commitResult.hash) {
              result.gitCommit = commitResult.hash;
            }
          }
        }
      } catch (gitErr) {
        // Git errors shouldn't fail the tool call
        result.gitWarning = gitErr.message;
      }
    }

    // Format output for storage (with secret scrubbing)
    // FIX: Empty output (result.output === '') is falsy and was skipped.
    // Use explicit checks so empty strings are preserved and reported back to the LLM.
    const rawOutput = (result.content !== undefined ? result.content : result.stdout !== undefined ? result.stdout : result.output !== undefined ? result.output : JSON.stringify(result)).slice(0, 2000);
    const outputText = this._scrubSecrets(rawOutput);
    if (result.error) result.error = this._scrubSecrets(result.error);
    if (result.stdout) result.stdout = this._scrubSecrets(result.stdout);
    if (result.content) result.content = this._scrubSecrets(result.content);

    // Generate friendly feedback message
    const friendlyMessage = this._makeFriendlyFeedback(tool, params, result);
    if (friendlyMessage) {
      result.friendlyMessage = friendlyMessage;
    }

    // Store result
    this.sessionManager.appendEvent(sessionId, {
      type: 'tool_result',
      tool,
      success: result.success,
      output: outputText,
      error: result.error || null,
      timestamp: new Date().toISOString(),
    });

    // Emit result
    this.emit('progress', {
      type: result.success ? 'success' : 'error',
      tool,
      result,
      message: result.success
        ? `${emoji} ✅ ${tool} executado`
        : `${emoji} ❌ ${tool} falhou: ${result.error}`,
      sessionId,
    });

    // If action succeeded and needs follow-up, continue loop
    if (result.success && !parsed.done) {
      return {
        success: true,
        mode: 'ACTION',
        tool,
        result,
        needsContinue: true,
        sessionId,
      };
    }

    return { success: result.success, mode: 'ACTION', tool, result, sessionId };
  }

  /** PLAN mode — execute multi-step plan */
  async _handlePlan(parsed, sessionId, originalInput, options) {
    const steps = parsed.steps || [];
    const reasoning = parsed.reasoning || '';

    this.emit('progress', {
      type: 'plan',
      message: `📋 Plano: ${steps.length} passos`,
      steps: steps.map(s => ({ id: s.id, tool: s.tool, reasoning: s.reasoning, done: false })),
      sessionId,
    });

    const results = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // Check overall timeout
      // (simplified — would need startTime tracking)

      // Execute step as ACTION
      const stepResult = await this._handleAction(
        { tool: step.tool, params: step.params, reasoning: step.reasoning },
        sessionId,
        options
      );

      results.push({ step, result: stepResult });

      // Update plan progress
      this.emit('progress', {
        type: 'plan_step',
        stepIndex: i,
        total: steps.length,
        done: stepResult.success,
        sessionId,
      });

      if (!stepResult.success) {
        this.emit('progress', {
          type: 'plan_error',
          message: `❌ Plano falhou no passo ${i + 1}`,
          sessionId,
        });
        return {
          success: false,
          mode: 'PLAN',
          error: `Falha no passo ${i + 1}`,
          results,
          sessionId,
        };
      }

      // Small delay between steps
      await new Promise(r => setTimeout(r, 500));
    }

    this.emit('progress', {
      type: 'plan_complete',
      message: '✅ Plano concluído!',
      sessionId,
    });

    return { success: true, mode: 'PLAN', results, sessionId };
  }

  /** DONE mode — task complete */
  _handleDone(parsed, sessionId) {
    const message = parsed.response || parsed.message || 'Tarefa concluída!';

    this.sessionManager.appendEvent(sessionId, {
      type: 'assistant',
      mode: 'DONE',
      response: message,
      timestamp: new Date().toISOString(),
    });

    this.emit('response', { type: 'done', content: message, sessionId });
    return { success: true, mode: 'DONE', response: message, sessionId };
  }

  /** LOAD_SKILL mode */
  _handleLoadSkill(parsed, sessionId) {
    const skillName = parsed.skill;
    const skillPath = path.join(SKILLS_DIR, skillName, 'SKILL.md');

    let skillContent = '';
    if (fs.existsSync(skillPath)) {
      skillContent = fs.readFileSync(skillPath, 'utf8');
    }

    this.sessionManager.appendEvent(sessionId, {
      type: 'assistant',
      mode: 'LOAD_SKILL',
      skill: skillName,
      timestamp: new Date().toISOString(),
    });

    this.emit('progress', {
      type: 'skill_loaded',
      message: `📚 Skill carregada: ${skillName}`,
      skill: skillName,
      content: skillContent,
      sessionId,
    });

    return {
      success: true,
      mode: 'LOAD_SKILL',
      skill: skillName,
      content: skillContent,
      sessionId,
    };
  }

  /** UPDATE_MEMORY mode */
  _handleUpdateMemory(parsed, sessionId) {
    const fileName = parsed.file || 'user-profile.md';
    const content = parsed.content || '';
    const memoryPath = path.join(MEMORIES_DIR, fileName);

    fs.mkdirSync(MEMORIES_DIR, { recursive: true });
    fs.writeFileSync(memoryPath, content);

    this.sessionManager.appendEvent(sessionId, {
      type: 'assistant',
      mode: 'UPDATE_MEMORY',
      file: fileName,
      timestamp: new Date().toISOString(),
    });

    this.emit('progress', {
      type: 'memory_updated',
      message: `💾 Memória atualizada: ${fileName}`,
      file: fileName,
      sessionId,
    });

    return { success: true, mode: 'UPDATE_MEMORY', file: fileName, sessionId };
  }

  /** META mode — self-improvement */
  async _handleMeta(parsed, sessionId) {
    const metaAction = parsed.meta_action || parsed.metaAction;
    const params = parsed.params || {};
    const reasoning = parsed.reasoning || '';

    this.emit('progress', {
      type: 'meta',
      message: `🔮 META: ${metaAction} — ${reasoning}`,
      metaAction,
      sessionId,
    });

    const result = await this.metaExecutor.execute(metaAction, params);

    this.sessionManager.appendEvent(sessionId, {
      type: 'assistant',
      mode: 'META',
      metaAction,
      success: result.success,
      timestamp: new Date().toISOString(),
    });

    this.emit('progress', {
      type: result.success ? 'meta_success' : 'meta_error',
      message: result.success
        ? `🔮 ✅ META ${metaAction}: ${result.message}`
        : `🔮 ❌ META ${metaAction} falhou: ${result.error}`,
      result,
      sessionId,
    });

    return {
      success: result.success,
      mode: 'META',
      metaAction,
      result,
      sessionId,
    };
  }

  /** SUGGEST mode — auto-select persona/skill based on context */
  async _handleSuggest(parsed, sessionId, options = {}) {
    const suggestion = parsed.suggestion || parsed;
    const type = suggestion.type || suggestion.suggestion?.type;
    const target = suggestion.target || suggestion.suggestion?.target;
    const reason = suggestion.reason || suggestion.suggestion?.reason || '';
    const confidence = suggestion.confidence || suggestion.suggestion?.confidence || 0.5;

    this.emit('progress', {
      type: 'suggest',
      suggestionType: type,
      target,
      reason,
      confidence,
      autoApproved: this.autoSwitchEnabled && confidence >= 0.85,
      sessionId,
    });

    // Store suggestion in session events
    this.sessionManager.appendEvent(sessionId, {
      type: 'suggestion',
      suggestionType: type,
      target,
      reason,
      confidence,
      timestamp: new Date().toISOString(),
    });

    // If auto-switch enabled and high confidence, apply immediately
    if (this.autoSwitchEnabled && confidence >= 0.85) {
      if (type === 'persona') {
        const personaPath = path.join(PERSONAS_DIR, `${target}.md`);
        if (fs.existsSync(personaPath)) {
          // Update session state
          const statePath = path.join(LUNA_DIR, 'sessions', sessionId, 'state.json');
          try {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            state.persona = target;
            fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
          } catch {}
          this.emit('progress', {
            type: 'persona_switched',
            message: `🎭 Auto-switch: persona "${target}" ativada (${Math.round(confidence * 100)}% confiança)`,
            reason,
            target,
            sessionId,
          });
        }
      } else if (type === 'skill') {
        this.emit('progress', {
          type: 'skill_suggested',
          message: `📚 Auto-load: skill "${target}" sugerida (${Math.round(confidence * 100)}% confiança)`,
          reason,
          target,
          sessionId,
        });
        // Return LOAD_SKILL mode so caller can handle it
        return {
          success: true,
          mode: 'SUGGEST',
          applied: true,
          type,
          target,
          reason,
          confidence,
          sessionId,
        };
      }
    }

    // If not auto-applied, return suggestion for user confirmation
    return {
      success: true,
      mode: 'SUGGEST',
      applied: false,
      needsConfirmation: true,
      type,
      target,
      reason,
      confidence,
      sessionId,
    };
  }

  /** Apply a suggestion manually (called by adapter after user confirms) */
  async applySuggestion(sessionId, type, target) {
    if (type === 'persona') {
      const personaPath = path.join(PERSONAS_DIR, `${target}.md`);
      if (!fs.existsSync(personaPath)) {
        return { success: false, error: `Persona "${target}" não encontrada` };
      }
      const statePath = path.join(LUNA_DIR, 'sessions', sessionId, 'state.json');
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        state.persona = target;
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      } catch {}
      this.emit('progress', {
        type: 'persona_switched',
        message: `🎭 Persona "${target}" ativada`,
        target,
        sessionId,
      });
      return { success: true, type: 'persona', target };
    }
    if (type === 'skill') {
      return this._handleLoadSkill({ skill: target }, sessionId);
    }
    return { success: false, error: 'Tipo de sugestão desconhecido' };
  }

  /** Continue an action loop (for multi-step tasks) */
  async continueLoop(sessionId, options = {}) {
    // Re-build context and send to Kimi for next step
    const recentEvents = this.sessionManager.readRecentEvents(sessionId, 10);
    const lastEvent = recentEvents[recentEvents.length - 1];

    if (!lastEvent || lastEvent.type !== 'tool_result') {
      return { success: false, error: 'No tool result to continue from', sessionId };
    }

    // Build a prompt asking Kimi what to do next
    const context = await this._buildContext(sessionId, '[continue after tool execution]', options);
    const prompt = context.prompt + '\n\nO último comando foi executado. Qual o próximo passo?';

    let kimiResponse;
    try {
      const result = await this.kimiBridge.sendMessage(
        options.userId || 'luna-default',
        prompt,
        { mode: options.mode || this.defaultMode }
      );
      kimiResponse = result.response;
    } catch (err) {
      return { success: false, error: err.message, sessionId };
    }

    const parsed = parseTagResponse(kimiResponse) || parseKimiResponse(kimiResponse);
    if (!parsed) {
      return { success: false, error: 'Failed to parse continuation', raw: kimiResponse, sessionId };
    }

    return this._processMode(parsed, sessionId, '[continue]', options);
  }

  /** Run a full ReAct-style task (for complex PC interactions) */
  async runTask(taskDescription, options = {}) {
    const sessionId = options.sessionId || this.sessionManager.getOrCreateCurrentSession({
      title: `Tarefa: ${taskDescription.slice(0, 50)}`,
    }).id;

    this.emit('progress', {
      type: 'task_start',
      message: `📝 Tarefa: ${taskDescription}`,
      sessionId,
    });

    const startTime = Date.now();
    const maxIterations = options.maxIterations || this.maxIterations;

    for (let i = 0; i < maxIterations; i++) {
      if (false) { // [DONO ABSOLUTO] Timeout desativado
        return { success: false, error: 'Timeout', sessionId };
      }

      // Process one step
      const result = await this.processMessage(taskDescription, {
        ...options,
        sessionId,
        includeDesktop: true,
      });

      // [DONO ABSOLUTO] Nunca parar em DONE ou CHAT — continuar até o contexto acabar
      if (result.mode === 'DONE') {
        taskDescription = '[CHECK] A tarefa parece concluída. Verifique se há mais alguma ação pendente. Se houver, execute. Se não, confirme novamente que está tudo pronto.';
        await new Promise(r => setTimeout(r, 800));
        continue;
      }

      if (result.mode === 'ACTION' && result.needsContinue) {
        // Continue the loop
        taskDescription = '[continue]'; // Signal to continue
        await new Promise(r => setTimeout(r, 800));
        continue;
      }

      if (result.mode === 'CHAT') {
        // [DONO ABSOLUTO] Chat não significa fim — continuar verificando
        taskDescription = '[CHECK] Você respondeu em modo chat. Verifique se há mais ações pendentes para a tarefa atual. Se houver, execute-as agora.';
        await new Promise(r => setTimeout(r, 800));
        continue;
      }

      if (!result.success) {
        return { success: false, error: result.error, sessionId };
      }

      await new Promise(r => setTimeout(r, 500));
    }

    // [DONO ABSOLUTO] Sem limite de iterações
      // return { success: false, error: `Máximo de iterações (${maxIterations}) atingido`, sessionId };
  }

  // ── v3.3: Destructive operation confirmation gate ──
  async _confirmDestructive(message, command) {
    if (this.autoConfirmDestructive) {
      console.log(`[LunaSoul] Auto-confirmando operação destrutiva: ${message} | ${command.slice(0, 200)}`);
      return true;
    }
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(
        `\n⚠️  OPERAÇÃO DESTRUTIVA DETECTADA: ${message}\n   Comando: ${command.slice(0, 200)}\n   Confirmar execução? [s/N]: `,
        (answer) => {
          rl.close();
          resolve(answer.trim().toLowerCase() === 's' || answer.trim().toLowerCase() === 'sim');
        }
      );
    });
  }
}

module.exports = {
  LunaSoul,
  parseKimiResponse,
  parseTagResponse,
  isIncompleteResponse,
  buildSystemPrompt,
  loadSkillIndex,
  loadPersona,
  loadMemories,
  MetaExecutor,
  // v4.0 new modules
  ResponseStreamParser,
  safeJsonParse,
  isBalancedBraces,
  MetaExecutorSecure,
  PathValidator,
};
