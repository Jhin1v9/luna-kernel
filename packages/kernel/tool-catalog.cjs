'use strict';
/**
 * Tool Catalog v1.0 — catálogo COMPLETO de tools para o system prompt.
 *
 * Fonte de verdade dupla, renderizada em prompt:
 *   1. CORE_TOOLS (curadoria deste arquivo) — file/shell/git/web/system com
 *      descrição, params e EXEMPLO REAL por tool.
 *   2. DASHBOARD_TOOL_REGISTRY (dashboard-tool-registry.cjs) — tools do
 *      dashboard; params por tool vêm do registry, exemplos por categoria.
 *   3. EXTRA_DASHBOARD_TOOLS — tools dashboard exportadas em luna-tools.cjs
 *      que ainda não entraram no registry (whatsapp, email, sistema, etc).
 *
 * Por que existe: o master prompt documentava só 15 tools enquanto o
 * luna-tools.cjs exporta ~150 — o modelo simplesmente não sabia que o resto
 * existia. Este catálogo é interpolado no system prompt via {{TOOL_CATALOG}},
 * então a API SEMPRE enxerga todas as tools com exemplo de uso.
 */

const lunaTools = require('./luna-tools.cjs');
const { DASHBOARD_TOOL_REGISTRY } = require('./dashboard-tool-registry.cjs');

// ─────────────────────────────────────────────────────────────────────────
// CORE TOOLS — descrição + params + exemplo. `ex` é copiado LITERAL para o
// prompt dentro de [[action]] (o WORKSPACE é interpolado depois pelo soul).
// ─────────────────────────────────────────────────────────────────────────
const CORE_TOOLS = [
  // 📁 Arquivos
  { name: 'readFile', cat: '📁 Arquivos', desc: 'Lê o conteúdo de um arquivo de texto.', params: '{path}', ex: { path: '{{WORKSPACE}}/notas.txt' } },
  { name: 'writeFile', cat: '📁 Arquivos', desc: 'Cria ou sobrescreve um arquivo.', params: '{path, content}', ex: { path: '{{WORKSPACE}}/hello.js', content: "console.log('oi');" } },
  { name: 'appendFile', cat: '📁 Arquivos', desc: 'Adiciona texto no final do arquivo.', params: '{path, content}', ex: { path: '{{WORKSPACE}}/log.txt', content: 'nova linha' } },
  { name: 'replaceInFile', cat: '📁 Arquivos', desc: 'Substitui uma ocorrência exata no arquivo.', params: '{path, old, new}', ex: { path: '{{WORKSPACE}}/app.js', old: 'const port = 3000;', new: 'const port = 3100;' } },
  { name: 'deleteFile', cat: '📁 Arquivos', desc: 'Deleta um arquivo.', params: '{path}', ex: { path: '{{WORKSPACE}}/lixo.txt' } },
  { name: 'moveFile', cat: '📁 Arquivos', desc: 'Move/renomeia um arquivo.', params: '{from, to}', ex: { from: '{{WORKSPACE}}/rascunho.txt', to: '{{WORKSPACE}}/final.txt' } },
  { name: 'copyFile', cat: '📁 Arquivos', desc: 'Copia um arquivo.', params: '{from, to}', ex: { from: '{{WORKSPACE}}/a.txt', to: '{{WORKSPACE}}/copia-a.txt' } },
  { name: 'getFileInfo', cat: '📁 Arquivos', desc: 'Tamanho, datas e tipo de um arquivo.', params: '{path}', ex: { path: '{{WORKSPACE}}/dados.csv' } },

  // 📂 Diretórios
  { name: 'listFiles', cat: '📂 Diretórios', desc: 'Lista arquivos por padrão glob.', params: '{pattern}', ex: { pattern: '{{WORKSPACE}}/*.md' } },
  { name: 'viewDirectory', cat: '📂 Diretórios', desc: 'Lista o conteúdo de um diretório.', params: '{path}', ex: { path: '{{WORKSPACE}}' } },
  { name: 'createDirectory', cat: '📂 Diretórios', desc: 'Cria diretório (recursivo).', params: '{path}', ex: { path: '{{WORKSPACE}}/novo-projeto/src' } },
  { name: 'removeDirectory', cat: '📂 Diretórios', desc: 'Remove diretório e conteúdo.', params: '{path}', ex: { path: '{{WORKSPACE}}/temp' } },

  // 🔍 Busca
  { name: 'searchFiles', cat: '🔍 Busca', desc: 'Busca arquivos pelo nome.', params: '{pattern, path?}', ex: { pattern: 'relatorio', path: '{{WORKSPACE}}' } },
  { name: 'grep', cat: '🔍 Busca', desc: 'Busca texto DENTRO dos arquivos.', params: '{pattern, path?}', ex: { pattern: 'TODO', path: '{{WORKSPACE}}/src' } },
  { name: 'glob', cat: '🔍 Busca', desc: 'Expande padrão glob e retorna caminhos.', params: '{pattern}', ex: { pattern: '{{WORKSPACE}}/**/*.test.js' } },

  // 🌐 Web
  { name: 'searchWeb', cat: '🌐 Web', desc: 'Pesquisa na internet (aliases web_search/webSearch).', params: '{query}', ex: { query: 'preço do dólar hoje' } },
  { name: 'fetchURL', cat: '🌐 Web', desc: 'Busca o conteúdo de uma página.', params: '{url}', ex: { url: 'https://example.com/docs' } },
  { name: 'downloadFile', cat: '🌐 Web', desc: 'Baixa um arquivo da web para o disco.', params: '{url, path}', ex: { url: 'https://example.com/arquivo.zip', path: '{{WORKSPACE}}/arquivo.zip' } },

  // 🖥️ Shell
  { name: 'executeShell', cat: '🖥️ Shell', desc: 'Executa comando no PC (shell real, sem confirmação).', params: '{command}', ex: { command: 'cd {{WORKSPACE}} && ls -la' } },
  { name: 'executeScript', cat: '🖥️ Shell', desc: 'Executa script completo (bash/node/python).', params: '{code, language?}', ex: { code: "console.log('ok')", language: 'node' } },
  { name: 'runTests', cat: '🖥️ Shell', desc: 'Roda a suíte de testes do projeto.', params: '{path?}', ex: { path: '{{WORKSPACE}}' } },
  { name: 'checkSyntax', cat: '🖥️ Shell', desc: 'Valida sintaxe de um arquivo de código.', params: '{path}', ex: { path: '{{WORKSPACE}}/app.js' } },
  { name: 'installPackages', cat: '🖥️ Shell', desc: 'Instala dependências (npm/pip/etc).', params: '{packages, cwd?}', ex: { packages: 'lodash', cwd: '{{WORKSPACE}}' } },

  // 🌿 Git
  { name: 'gitStatus', cat: '🌿 Git', desc: 'Status do repositório.', params: '{path}', ex: { path: '{{WORKSPACE}}' } },
  { name: 'gitDiff', cat: '🌿 Git', desc: 'Diff das alterações.', params: '{path}', ex: { path: '{{WORKSPACE}}' } },
  { name: 'gitLog', cat: '🌿 Git', desc: 'Histórico de commits.', params: '{path, limit?}', ex: { path: '{{WORKSPACE}}', limit: 5 } },
  { name: 'gitCommit', cat: '🌿 Git', desc: 'Commit das alterações.', params: '{path, message}', ex: { path: '{{WORKSPACE}}', message: 'feat: ajusta configuração' } },
  { name: 'applyPatch', cat: '🌿 Git', desc: 'Aplica um patch unificado a arquivos.', params: '{patch}', ex: { patch: '--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-old\n+new' } },

  // 🧠 Brain — memória institucional do NEXO (notas, aprendizados, runbooks)
  { name: 'brainSearch', cat: '🧠 Brain', desc: 'Pesquisa notas/aprendizados no brain da empresa (quem é quem, números, decisões, erros). Use SEMPRE que precisar de contexto que você não tem.', params: '{query}', ex: { query: 'quem é Abner whatsapp' } },
  { name: 'brainRead', cat: '🧠 Brain', desc: 'Lê uma nota completa do brain pelo id (id vem do brainSearch).', params: '{id}', ex: { id: 'learning/outcomes/positive/2026-10-13-exemplo.md' } },
  { name: 'brainSaveOutcome', cat: '🧠 Brain', desc: 'Grava aprendizado/outcome no brain (memória de longo prazo da Luna).', params: '{type, title, body, tags?}', ex: { type: 'positive', title: 'Fix validado no whatsplay', body: 'o que funcionou e por quê', tags: ['luna', 'whatsplay'] } },

  // 🧠 Raciocínio & sistema
  { name: 'think', cat: '🧠 Sistema', desc: 'Registra raciocínio passo a passo (não executa nada).', params: '{thought}', ex: { thought: 'Plano: 1) ler config 2) editar 3) testar' } },
  { name: 'getCurrentDirectory', cat: '🧠 Sistema', desc: 'Diretório de trabalho atual.', params: '{}', ex: {} },  { name: 'clipboardRead', cat: '🧠 Sistema', desc: 'Lê o conteúdo da área de transferência.', params: '{}', ex: {} },
  { name: 'clipboardWrite', cat: '🧠 Sistema', desc: 'Escreve na área de transferência.', params: '{text}', ex: { text: 'texto copiado' } },
  { name: 'readMediaFile', cat: '🧠 Sistema', desc: 'Inspeciona imagem/vídeo (tipo, tamanho).', params: '{path}', ex: { path: '{{WORKSPACE}}/foto.png' } },
  { name: 'lunaSelfUpdate', cat: '🧠 Sistema', desc: 'Atualiza a Luna do GitHub (dryRun p/ simular).', params: '{dryRun?}', ex: { dryRun: true } },
  { name: 'setVisibleMode', cat: '🧠 Sistema', desc: 'Liga/desliga modo visual da Luna.', params: '{}', ex: {} },
  { name: 'getVisibleMode', cat: '🧠 Sistema', desc: 'Retorna o modo visual atual.', params: '{}', ex: {} },
  { name: 'openDebugTerminal', cat: '🧠 Sistema', desc: 'Abre terminal de debug de um processo Luna.', params: '{process?, lines?}', ex: { process: 'luna-server', lines: 50 } },
  { name: 'validateProject', cat: '🧠 Sistema', desc: 'Valida a estrutura de um projeto (lint + checks).', params: '{path}', ex: { path: '{{WORKSPACE}}' } },
  { name: 'browser', cat: '🌐 Web', desc: 'Automação de navegador (modo CDP/Playwright).', params: '{action, ...}', ex: { action: 'screenshot' } },
];

// Dashboard tools exportadas em luna-tools.cjs mas ainda FORA do registry
// (o registry é a fonte das outras; estas entram como categoria extra).
const EXTRA_DASHBOARD_TOOLS = {
  '💬 WhatsApp': [
    { name: 'dashboardSendWhatsApp', desc: 'Envia mensagem WhatsApp pelo pipeline oficial.', params: ['chatId (ou phone)', 'message (ou text)'] },
    { name: 'dashboardGetWhatsAppHistory', desc: 'Histórico de mensagens de um chat.', params: ['chatId', 'limit'] },
    { name: 'dashboardScanWhatsApp', desc: 'Escaneia chats novos/pendentes.', params: [] },
    { name: 'dashboardGetWhatsAppStatus', desc: 'Status da conexão WhatsApp.', params: [] },
    { name: 'dashboardGetWhatsAppClassifications', desc: 'Classificações automáticas recentes.', params: ['limit'] },
  ],
  '📧 Email': [
    { name: 'dashboardSendEmail', desc: 'Envia email.', params: ['to', 'subject', 'body'] },
    { name: 'dashboardListEmails', desc: 'Lista emails sincronizados.', params: ['limit', 'folder'] },
    { name: 'dashboardSyncEmails', desc: 'Força sincronização da caixa de email.', params: [] },
  ],
  '⚙️ Dashboard — Sistema': [
    { name: 'dashboardGetSystemStatus', desc: 'Status geral do dashboard.', params: [] },
    { name: 'dashboardGetSystemLogs', desc: 'Logs recentes do sistema.', params: ['lines', 'service'] },
    { name: 'dashboardControlService', desc: 'Inicia/para/reinicia um serviço.', params: ['service', 'action'] },
    { name: 'dashboardListNotifications', desc: 'Lista notificações.', params: ['unreadOnly'] },
    { name: 'dashboardMarkNotificationRead', desc: 'Marca notificação como lida.', params: ['id'] },
    { name: 'dashboardMarkAllNotificationsRead', desc: 'Marca todas como lidas.', params: [] },
  ],
  '👥 Dashboard — Pessoas': [
    { name: 'dashboardListUsers', desc: 'Lista usuários do dashboard.', params: [] },
    { name: 'dashboardListMembers', desc: 'Lista membros da equipe.', params: [] },
  ],
  '🐞 Dashboard — Bugs & Ops': [
    { name: 'dashboardListBugReports', desc: 'Lista bug reports.', params: ['status', 'limit'] },
    { name: 'dashboardDeleteBugReport', desc: 'Remove um bug report.', params: ['id'] },
    { name: 'dashboardListOpsAlerts', desc: 'Lista alertas operacionais.', params: ['status'] },
    { name: 'dashboardCreateOpsAlert', desc: 'Cria alerta operacional.', params: ['title', 'severity', 'message'] },
    { name: 'dashboardDeleteOpsAlert', desc: 'Remove alerta operacional.', params: ['id'] },
  ],
  // 2026-10-13: tasks/solicitações já existiam em luna-tools.cjs mas AUSENTES
  // aqui — modelos não sabiam que existiam (matrix: "não tenho tool de tarefas").
  '📋 Dashboard — Tarefas & Solicitações': [
    { name: 'dashboardCreateTask', desc: 'Cria tarefa/solicitação no dashboard.', params: ['title', 'description', 'priority?'] },
    { name: 'dashboardListTasks', desc: 'Lista tarefas (filtros opcionais).', params: ['status?', 'limit?'] },
    { name: 'dashboardUpdateTask', desc: 'Atualiza tarefa.', params: ['id', 'status?', 'title?', 'priority?'] },
    { name: 'dashboardCompleteTask', desc: 'Marca tarefa como concluída.', params: ['id'] },
    { name: 'dashboardDeleteTask', desc: 'Remove uma tarefa.', params: ['id'] },
    { name: 'dashboardCreateLead', desc: 'Registra um lead.', params: ['name', 'phone?', 'email?', 'source?'] },
  ],
  '🚀 Dashboard — GitHub/Vercel': [
    { name: 'dashboardListGitHubRepos', desc: 'Lista repositórios GitHub.', params: [] },
    { name: 'dashboardListVercelProjects', desc: 'Lista projetos Vercel.', params: [] },
  ],
  '🔁 Dashboard — Avançado': [
    { name: 'dashboardUpdatePayment', desc: 'Atualiza um pagamento.', params: ['id', 'status', 'amount'] },
    { name: 'dashboardDeletePayment', desc: 'Remove um pagamento.', params: ['id'] },
    { name: 'dashboardUpdateExpense', desc: 'Atualiza uma despesa.', params: ['id', 'status', 'amount'] },
    { name: 'dashboardDeleteExpense', desc: 'Remove uma despesa.', params: ['id'] },
    { name: 'dashboardCreateExpenseTemplate', desc: 'Cria template de despesa recorrente.', params: ['description', 'amount', 'category'] },
    { name: 'dashboardQuickExpense', desc: 'Registra despesa rápida.', params: ['description', 'amount'] },
    { name: 'dashboardDeleteQuote', desc: 'Remove uma cotação.', params: ['id'] },
    { name: 'dashboardDeleteLink', desc: 'Remove um link salvo.', params: ['id'] },
    { name: 'dashboardEnrichLink', desc: 'Enriquece metadados de um link.', params: ['id'] },
    { name: 'dashboardSyncLinks', desc: 'Sincroniza links salvos.', params: [] },
    { name: 'dashboardGetLinksStats', desc: 'Estatísticas de links.', params: [] },
    { name: 'dashboardGetVotingSession', desc: 'Detalhes de uma votação.', params: ['id'] },
    { name: 'dashboardVoteInSession', desc: 'Vota em uma sessão.', params: ['id', 'vote', 'comment'] },
    { name: 'dashboardDeleteVotingSession', desc: 'Remove uma votação.', params: ['id'] },
    { name: 'dashboardListTransactions', desc: 'Lista transações financeiras.', params: ['limit'] },
    { name: 'dashboardGetNexoState', desc: 'Estado geral do Nexo.', params: [] },
    { name: 'dashboardGetConfig', desc: 'Configuração do dashboard.', params: [] },
    { name: 'dashboardJoinTimeline', desc: 'Entra em uma timeline colaborativa.', params: ['timelineId'] },
    { name: 'dashboardAdvanceTimelineStep', desc: 'Avança o step da timeline.', params: ['timelineId'] },
    { name: 'dashboardCreateReviewVote', desc: 'Cria votação de revisão de fase.', params: ['phaseTitle', 'quorumRequired'] },
  ],
  // 🗂️ 2026-10-14: Workspace Nexo (portal admin /nexo) — solicitações REAIS dos clientes
  '🗂️ Workspace Nexo — Solicitações': [
    { name: 'workspaceListRequests', desc: 'Lista solicitações dos clientes (filtros: status, organizationId, projectId, search).', params: ['status?', 'organizationId?', 'projectId?', 'search?', 'limit?'] },
    { name: 'workspaceGetRequest', desc: 'Detalhe completo de uma solicitação.', params: ['id'] },
    { name: 'workspaceCreateRequest', desc: 'Cria solicitação para qualquer cliente.', params: ['organizationId', 'projectId', 'content', 'status?', 'urgencyHint?'] },
    { name: 'workspaceUpdateRequest', desc: 'Muda status/urgência de uma solicitação.', params: ['id', 'status?', 'urgencyHint?'] },
    { name: 'workspaceAddComment', desc: 'Comenta numa solicitação (visível pro cliente).', params: ['id', 'content'] },
    { name: 'workspaceListProjects', desc: 'Lista projetos do workspace (clientes e ids).', params: [] },
    { name: 'workspaceListOrganizations', desc: 'Lista organizações (clientes) com ids.', params: [] },
    { name: 'workspaceListClients', desc: 'Lista usuários-cliente cadastrados.', params: [] },
  ],
  // 🟢 2026-10-14: WhatsApp de verdade — a Luna VÊ o diretório e envia por NOME
  // (grupo incluído). Protocolo de onboarding: whatsappAllowContact.
  '🟢 WhatsApp — Diretório & Envio': [
    { name: 'whatsappListContacts', desc: 'Lista contatos do WhatsApp (diretório real; filtro search).', params: ['search?'] },
    { name: 'whatsappListGroups', desc: 'Lista grupos do WhatsApp com nº de membros (filtro search).', params: ['search?'] },
    { name: 'whatsappGroupMembers', desc: 'Lista os membros de um grupo.', params: ['group'] },
    { name: 'whatsappSendMessage', desc: 'Envia msg pra NOME, jid ou número — grupo incluído. FLUXO: listar → escolher → enviar.', params: ['to', 'message'] },
    { name: 'whatsappAllowContact', desc: 'PROTOCOLO NOVO CONTATO: add nome/número na allowlist + diretório (decree owner).', params: ['name', 'phone?', 'note?'] },
  ],
  // ⚙️ 2026-10-14: a Luna CONFIGURA A RODA DE PROVIDERS do painel via tool —
  // o owner manda a key e ela põe direto.
  '⚙️ Painel — Providers & Roda': [
    { name: 'dashboardConfigProvider', desc: 'API unificada: list | set-key | add-preset | add-custom | remove.', params: ['action', '...'] },
    { name: 'dashboardListProviders', desc: 'Lista providers da roda com status de key.', params: ['busca?'] },
    { name: 'dashboardSetProviderKey', desc: 'Salva uma API key no .env via painel (env + value).', params: ['env', 'value'] },
    { name: 'dashboardAddProvider', desc: 'Adiciona provider (presetId ou custom {...}).', params: ['presetId? | provider?'] },
    { name: 'dashboardRemoveProvider', desc: 'Remove um provider da roda.', params: ['id'] },
  ],
  // 📞 2026-10-14: chamada ao vivo — a Luna responde o OPERADOR via tool
  // (arquitetura owner: sessão Luna Web como conductor da chamada).
  '📞 Chamada — Operador': [
    { name: 'callRespond', desc: 'Fala um texto NA CHAMADA ativa (vai pro operador/ChatGPT e a voz fala). Sua voz durante a ligação.', params: ['texto'] },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// Renderização
// ─────────────────────────────────────────────────────────────────────────
function fmtExample(toolName, params) {
  return `{"tool": "${toolName}", "params": ${JSON.stringify(params)}}`;
}

function renderCore() {
  const lines = [];
  const byCat = new Map();
  for (const t of CORE_TOOLS) {
    if (!byCat.has(t.cat)) byCat.set(t.cat, []);
    byCat.get(t.cat).push(t);
  }
  for (const [cat, tools] of byCat) {
    lines.push('', cat);
    for (const t of tools) {
      lines.push(`- ${t.name} — ${t.desc} params: ${t.params}`);
      lines.push(`  ex: ${fmtExample(t.name, t.ex)}`);
    }
  }
  return lines.join('\n');
}

function renderDashboardCategory(catKey) {
  const cat = DASHBOARD_TOOL_REGISTRY[catKey];
  const lines = [``, `${cat.emoji} Dashboard — ${cat.label}: ${cat.description}`];
  for (const t of cat.tools) {
    const params = t.params && t.params.length ? ` params: ${t.params.join(', ')}` : ' sem params';
    lines.push(`- ${t.name} — ${t.description}.${params}`);
  }
  // um exemplo por categoria (formato é idêntico para todas)
  const first = cat.tools[0];
  if (first) {
    const sample = {};
    for (const p of first.params || []) {
      sample[p] = p.match(/id$/i) ? 'ID_DO_REGISTRO' : p.match(/amount|value|total/i) ? 100 : 'valor';
    }
    lines.push(`  ex: ${fmtExample(first.name, sample)}`);
  }
  return lines.join('\n');
}

function renderExtraDashboard() {
  const lines = [];
  for (const [cat, tools] of Object.entries(EXTRA_DASHBOARD_TOOLS)) {
    lines.push('', cat);
    for (const t of tools) {
      const params = t.params && t.params.length ? ` params: ${t.params.join(', ')}` : ' sem params';
      lines.push(`- ${t.name} — ${t.desc}${params}`);
    }
    const first = tools[0];
    const sample = {};
    for (const p of first.params || []) sample[p] = p.match(/id$/i) ? 'ID' : 'valor';
    lines.push(`  ex: ${fmtExample(first.name, sample)}`);
  }
  return lines.join('\n');
}

/**
 * Constrói o catálogo completo em markdown (PT-BR, compacto).
 * Cada tool existente em luna-tools.cjs aparece com nome exato, descrição,
 * params e exemplo. Tools desconhecidas são omitidas com aviso no log.
 */
function buildToolCatalog() {
  const header = [
    '[TOOL CATALOG — FERRAMENTAS DISPONÍVEIS]',
    'Use EXATAMENTE estes nomes em {"tool": "..."}. Todos os nomes foram verificados contra o runtime.',
    'Uma tool por mensagem, dentro de [[action]]...[[/action]] (ou code block ```json).',
  ].join('\n');

  const out = [header, renderCore()];
  for (const catKey of Object.keys(DASHBOARD_TOOL_REGISTRY)) {
    out.push(renderDashboardCategory(catKey));
  }
  out.push(renderExtraDashboard());

  // Rede de segurança: avisa no log se a curadoria divergiu do runtime
  try {
    const runtime = new Set(Object.keys(lunaTools));
    const documented = new Set(CORE_TOOLS.map((t) => t.name));
    for (const catKey of Object.keys(DASHBOARD_TOOL_REGISTRY)) {
      for (const t of DASHBOARD_TOOL_REGISTRY[catKey].tools) documented.add(t.name);
    }
    for (const tools of Object.values(EXTRA_DASHBOARD_TOOLS)) {
      for (const t of tools) documented.add(t.name);
    }
    const missing = [...runtime].filter((n) => !documented.has(n) && !['web_search', 'webSearch'].includes(n));
    if (missing.length) {
      console.log(`[TOOL-CATALOG] aviso: tools no runtime sem documentação no catálogo: ${missing.join(', ')}`);
    }
  } catch { /* verificação best-effort */ }

  return out.join('\n') + '\n[/TOOL CATALOG]';
}

module.exports = { buildToolCatalog };

// ─────────────────────────────────────────────────────────────────────────
// v7.2 — ÍNDICE COMPACTO + META-TOOLS (progressão em camadas)
//
// Arquitetura pra não poluir o system prompt nem a API:
//   system prompt carrega SÓ o índice (nome + descrição de 1 linha/tool)
//   listTools({busca?, categoria?}) → o mesmo índice, filtrável, sob demanda
//   toolInfo({name}) → docs completas da tool: params + exemplo
// Assim o modelo "descobre os braços" que tem e puxa detalhe só quando
// precisa — em vez de enfiar ~17KB de catálogo em TODA chamada de API.
// ─────────────────────────────────────────────────────────────────────────

function collectAllTools() {
  const all = [];
  for (const t of CORE_TOOLS) {
    all.push({ name: t.name, cat: t.cat, desc: t.desc, params: t.params, ex: t.ex });
  }
  for (const catKey of Object.keys(DASHBOARD_TOOL_REGISTRY)) {
    const cat = DASHBOARD_TOOL_REGISTRY[catKey];
    for (const t of cat.tools) {
      all.push({ name: t.name, cat: `${cat.emoji} ${cat.label}`, desc: t.description, params: (t.params || []).join(', '), ex: null });
    }
  }
  for (const [cat, tools] of Object.entries(EXTRA_DASHBOARD_TOOLS)) {
    for (const t of tools) {
      all.push({ name: t.name, cat, desc: t.desc, params: (t.params || []).join(', '), ex: null });
    }
  }
  return all;
}

const ALL_TOOLS = collectAllTools();

/** Índice compacto: uma linha por tool, agrupado por categoria. */
function buildToolIndex() {
  const header = [
    '[TOOL INDEX — o que você pode executar]',
    'Uma linha por tool. Para docs completas (params + exemplo) de qualquer uma:',
    '  [[action]] {"tool": "toolInfo", "params": {"name": "NOME_DA_TOOL"}} [[/action]]',
    'Para listar de novo (com filtro opcional):',
    '  listTools {} · listTools {"busca": "arquivo"} · listTools {"categoria": "WhatsApp"}',
  ].join('\n');
  const byCat = new Map();
  for (const t of ALL_TOOLS) {
    if (!byCat.has(t.cat)) byCat.set(t.cat, []);
    byCat.get(t.cat).push(t);
  }
  const lines = [header];
  for (const [cat, tools] of byCat) {
    lines.push('', cat);
    for (const t of tools) {
      lines.push(`- ${t.name} — ${t.desc}`);
    }
  }
  return lines.join('\n') + '\n[/TOOL INDEX]';
}

function _fmtIndexList(tools) {
  return tools.map((t) => `- ${t.name} (${t.cat}) — ${t.desc}`).join('\n');
}

/** Meta-tool: lista as tools (filtrável). Mesmo formato de retorno das tools. */
function listTools(params = {}) {
  const busca = String(params.busca || '').toLowerCase();
  const categoria = String(params.categoria || '').toLowerCase();
  let out = ALL_TOOLS;
  if (categoria) out = out.filter((t) => t.cat.toLowerCase().includes(categoria));
  if (busca) out = out.filter((t) => (t.name + ' ' + t.desc).toLowerCase().includes(busca));
  if (out.length === 0) {
    return { success: false, error: `nenhuma tool encontrada${busca ? ` pra busca "${params.busca}"` : ''}${categoria ? ` na categoria "${params.categoria}"` : ''}` };
  }
  const header = out.length === ALL_TOOLS.length
    ? `${out.length} tools disponíveis (índice completo — use toolInfo {"name": "..."} pra docs de qualquer uma):`
    : `${out.length} tool(s) encontrada(s):`;
  return { success: true, stdout: `${header}\n${_fmtIndexList(out)}` };
}

/** Meta-tool: docs completas de UMA tool (params + exemplo). */
function toolInfo(params = {}) {
  const name = String(params.name || '').trim();
  if (!name) {
    return { success: false, error: 'informe o nome: toolInfo {"name": "readFile"}' };
  }
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) {
    const perto = ALL_TOOLS.filter((x) => x.name.toLowerCase().includes(name.toLowerCase())).slice(0, 5);
    return {
      success: false,
      error: `tool não encontrada: ${name}`,
      suggestion: perto.length ? `você quis dizer: ${perto.map((x) => x.name).join(', ')}?` : `use listTools {"busca": "${name}"} pra procurar`,
    };
  }
  const linhas = [
    `${t.name}`,
    `  categoria: ${t.cat}`,
    `  descrição: ${t.desc}`,
    `  params: ${t.params || '{}'}`,
  ];
  if (t.ex) linhas.push(`  exemplo: ${fmtExample(t.name, t.ex)}`);
  else {
    const sample = {};
    for (const p of String(t.params || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      sample[p] = p.match(/id$/i) ? 'ID_DO_REGISTRO' : p.match(/amount|value|total/i) ? 100 : 'valor';
    }
    linhas.push(`  exemplo: ${fmtExample(t.name, sample)}`);
  }
  return { success: true, stdout: linhas.join('\n') };
}

module.exports = { buildToolCatalog, buildToolIndex, listTools, toolInfo };
