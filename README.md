<div align="center">

# 🌙 LUNA — Kernel Autônomo

**Agente de IA autônomo com roda infinita de providers, 200+ ferramentas e memória de longo prazo.**
*A Luna não é um chatbot. É uma operadora: lê, escreve, executa, pesquisa, lembra e age — por chat web, WhatsApp ou voz.*

[![Node](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-11%2B-F69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![PM2](https://img.shields.io/badge/PM2-process%20manager-2B037A?logo=pm2&logoColor=white)](https://pm2.keymetrics.io)
[![License](https://img.shields.io/badge/license-NEXO%20DIGITAL-8B5CF6)]()

`v14.x` · NEXO DIGITAL S.L.

</div>

---

## ✨ O que é a Luna

A Luna é a CTO virtual da Nexo Digital: um kernel de agente que roda **no seu próprio PC ou VPS** e dá a qualquer modelo de linguagem **braços reais** — sistema de arquivos, shell, Git, navegador, WhatsApp, e-mail e a API completa do painel Nexo. Ela roda sobre uma **roda de providers**: se um modelo esgota quota, dá 429 ou cai, ela **gira sozinha para o próximo** sem perder o contexto da conversa.

Recursos centrais:

- 🧠 **Roda de providers** — fila FIFO de APIs OpenAI-compatíveis (Gemini, GitHub Models, OpenRouter, NVIDIA, Pollinations, Kimi…). Falhou um → gira pro próximo, com reidratação do contexto.
- 🛠️ **200+ ferramentas nativas** — arquivos, shell, Git, busca web, navegador, WhatsApp, e-mail, financeiro, projetos, workspace dos clientes. A Luna executa de verdade, não só descreve.
- 🧬 **Brain** — memória de longo prazo da empresa (quem é quem, decisões, erros, aprendizados). A Luna pesquisa antes de responder e grava outcomes depois.
- 💬 **Multi-canal** — chat web (Luna Web), WhatsApp, Telegram e chamada de voz com operador.
- 📟 **Painel de controle** — configuração de providers, visor do modelo ativo, histórico e gerenciamento visual.
- 🔄 **Auto-update** — `lunaSelfUpdate` puxa a versão nova do GitHub sozinha.

---

## 🏗️ Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                        VOCÊ                                 │
│   Chat Web :3458  ·  WhatsApp  ·  Telegram  ·  Chamada      │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│              apps/dashboard — Servidor Luna (:3458)         │
│   REST + SSE · sessões persistidas (Postgres/JSON) ·        │
│   painel de providers · rota /api/chat/*                    │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│            packages/kernel — A SOUL (@luna/kernel)          │
│  luna-soul.cjs · tool-catalog (200+ tools) · brain-loader   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  BRIDGES (quem responde pelo modelo)                  │  │
│  │  RodaApiBridge ──► fila de APIs OpenAI-compatíveis    │  │
│  │    (failover automático 429/5xx/quota, health 🟢🟠🔴) │  │
│  │  KimiBridge ─────► Kimi Web via CDP/Playwright        │  │
│  │    (fallback sem nenhuma API key)                     │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│  EXTERNOS · Postgres · Brain (:4321) · WhatsApp · GitHub    │
└─────────────────────────────────────────────────────────────┘
```

**Como funciona um turno:** sua mensagem chega → a Soul monta o system prompt + histórico + TOOL INDEX → manda pro provider ativo da roda → o modelo responde com texto e/ou chamadas de tool → a Soul executa cada tool e devolve o resultado no formato `[TOOL RESULT] {status, tool, result}` → o modelo continua até decidir que terminou (sem limite de interações por mensagem) → a resposta final é entregue no canal.

---

## 🚀 Instalação

### Linux / macOS — one-liner (recomendado)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Jhin1v9/luna-kernel/main/install.sh)
```

O instalador é idempotente e roda em qualquer diretório. Ele:

1. **Verifica dependências** — Node 22+, pnpm (corepack), PM2, Chrome/Chromium — e pergunta antes de instalar o que faltar.
2. **Clona o repo** para `~/.luna-kernel` (ou `LUNA_DIR` se já definido).
3. **Roda o wizard** (`install.cjs`) que pergunta: portas (default 3458/3456), pasta base NEXO DIGITAL, `DATABASE_URL` (opcional — sem ele tudo funciona em modo JSON), URL do Brain e token do Brain.
4. **Gera `config/providers.json`** com 5 presets gratuitos da roda (Gemini, GitHub Models GPT-4o, OpenRouter, NVIDIA Nemotron, Pollinations).
5. **Gera os `.env`** (apps/dashboard e packages/kernel) com `JWT_SECRET`, `INTERNAL_API_TOKEN`, `LUNA_RODA_CONFIG`, `BRAIN_INTERNAL_URL` e as variáveis de API key comentadas.
6. **Instala dependências e builda** (`corepack pnpm install && pnpm build`).
7. **Sobe tudo no PM2** e cria os atalhos `luna` e `dashboard` em `~/.local/bin`.
8. **Abre o assistente de login Kimi** (fallback CDP para quando nenhuma API key estiver configurada).

Depois, para sempre:

```bash
luna      # liga/reinicia tudo e abre a Luna Web + Vite
dashboard # liga/reinicia e abre o painel Nexo
```

### Windows

```powershell
# Em PowerShell como Administrador, dentro da pasta onde quer a Luna:
powershell -ExecutionPolicy Bypass -File scripts/setup-windows.ps1 -ProjectDir "$env:USERPROFILE\.luna-kernel"
```

O script Windows configura o diretório do projeto, a porta e (opcionalmente) adiciona o Chrome ao PATH. O resto do fluxo (wizard, providers, PM2) é o mesmo `install.cjs`.

### Instalação manual (controle total)

```bash
git clone https://github.com/Jhin1v9/luna-kernel.git ~/.luna-kernel
cd ~/.luna-kernel
corepack pnpm install
corepack pnpm build
cp .env.example apps/dashboard/.env   # ou rode: node install.cjs
pm2 start pm2-ecosystem.config.js && pm2 save
```

> **Instalar "em qualquer lugar":** nada é hardcoded. Todos os caminhos vêm de `LUNA_DIR`, `LUNA_HOME`, `LUNA_KERNEL_DIR` e `NEXO_DIR` (o PM2 já define os três últimos apontando pro monorepo). A tabela de sessões do chat se auto-migra no boot (`CREATE TABLE IF NOT EXISTS`), então uma instalação do zero funciona sem rodar migração nenhuma.

---

## ⚙️ Configurando a roda de providers

A roda é definida em `config/providers.json` (caminho gravado em `LUNA_RODA_CONFIG` pelo instalador):

```json
{
  "providers": [
    { "id": "gemini", "label": "Gemini Flash (Google)", "model": "gemini-2.5-flash",
      "transport": "openai", "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai/",
      "apiKeyEnv": "GEMINI_API_KEY", "priority": 10, "enabled": true, "role": "ambos" }
  ]
}
```

**Regras da roda:**

| Campo | Significado |
|---|---|
| `priority` | Ordem da fila — menor número = primeiro a ser usado |
| `enabled` | Só entra na roda se `true` **e** `transport: "openai"` com `baseUrl` + `model` |
| `apiKeyEnv` | Nome da variável de ambiente que guarda a key. Sem key no `.env`, o provider fica como `semKey` — a roda só usa providers sem key se **nenhum** com key estiver disponível |
| `role` | `chat`, `code` ou `ambos` — classificação interna de uso |

**Presets que já vêm no install** (basta descomentar a key no `.env` e ligar `enabled`):

| # | Provider | Modelo | Key necessária | Prioridade |
|---|---|---|---|---|
| 1 | Gemini (Google) | gemini-2.5-flash | `GEMINI_API_KEY` — grátis em aistudio.google.com | 10 |
| 2 | GitHub Models | openai/gpt-4o | `GITHUB_TOKEN` — grátis com conta GitHub | 20 |
| 3 | OpenRouter | google/gemini-2.5-flash | `OPENROUTER_API_KEY` — créditos grátis no cadastro | 30 |
| 4 | NVIDIA | nemotron-70b-instruct | `NVIDIA_API_KEY` — grátis em build.nvidia.com | 40 |
| 5 | Pollinations | openai | **nenhuma** — gratuito e anônimo | 90 |

Quando um provider falha (429, quota, 5xx, timeout), a `RodaApiBridge` gira pro próximo **mantendo o contexto** — a próxima API recebe o histórico com uma nota de continuação. O visor no topo da Luna Web mostra o provider ativo (🟢 saudável · 🟠 rate-limited · 🔴 morto).

> **Sem nenhuma key?** O preset Pollinations funciona sem key, e o **KimiBridge CDP** é o fallback final: um assistente no navegador te guia no login Kimi Web e a Luna usa sua sessão. Nunca fica sem cérebro.

A própria Luna administra a roda por chat/WhatsApp:

```
dashboardListProviders {}                                     ← vê a fila e o status das keys
dashboardConfigProvider {"action":"add-preset","presetId":"nvidia-nemotron"}
dashboardSetProviderKey {"env":"GEMINI_API_KEY","value":"AIza..."}
dashboardConfigProvider {"action":"remove","id":"openrouter"}
```

---

## 🔑 Variáveis de ambiente

Geradas pelo instalador em `apps/dashboard/.env` e `packages/kernel/.env`:

| Variável | Obrigatória | Descrição |
|---|---|---|
| `LUNA_PORT` | sim | Porta do servidor Luna Web (default `3458`) |
| `DASHBOARD_PORT` | sim | Porta do painel Nexo legado (default `3456`) |
| `JWT_SECRET` | sim | Segredo de sessão (gerado no install) |
| `INTERNAL_API_TOKEN` | sim | Token para APIs internas (gerado no install) |
| `LUNA_RODA_CONFIG` | sim | Caminho do `providers.json` da roda |
| `DATABASE_URL` | não | Postgres das sessões/histórico. Ausente → modo JSON automático |
| `BRAIN_INTERNAL_URL` | não | URL do Brain (default `http://127.0.0.1:4321`) |
| `BRAIN_API_TOKEN` | não | Token de autenticação do Brain |
| `NEXO_BASE_PATH` | não | Pasta base dos projetos Nexo no disco |
| `GEMINI_API_KEY` | não | Key do preset Gemini |
| `OPENROUTER_API_KEY` | não | Key do preset OpenRouter |
| `NVIDIA_API_KEY` | não | Key do preset NVIDIA |
| `GITHUB_TOKEN` | não | Key do preset GitHub Models |
| `TELEGRAM_BOT_TOKEN` | não | Liga o adapter Telegram |
| `KIMI_BASE_URL` / `KIMI_MODEL` / `KIMI_API_KEY` | não | Fallback legado por env (via manual) |
| `SMTP_*` / `GMAIL_*` | não | Envio e sincronização de e-mail |

---

## ▶️ Rodando

### Produção (PM2)

```bash
pm2 start pm2-ecosystem.config.js && pm2 save
pm2 logs luna-server          # acompanha a Luna
```

| Processo | O que é | Porta |
|---|---|---|
| `luna-server` | Servidor Luna (chat + API + painel de providers) | 3458 |
| `nexo-dashboard` | API/dashboard legado Nexo | 3456 |
| `luna-vite` | Dev server do frontend (opcional) | 5173 |
| `luna-health-watchdog` | Vigia de saúde da stack | — |

### Desenvolvimento

```bash
corepack pnpm dev:dashboard   # backend :3458
corepack pnpm dev:kernel      # Vite dev :5173
corepack pnpm test            # suíte de testes
```

---

## 🛠️ Ferramentas da Luna (tool catalog)

A Luna carrega um índice completo de ferramentas em **toda conversa** (cabeçalho `# CATEGORIA` por bloco, uma linha por tool) e se autodocumenta: `listTools {"busca":"arquivo"}` lista com filtro e `toolInfo {"name":"readFile"}` devolve parâmetros + exemplo. As 200+ tools abaixo são as do `tool-catalog.cjs` deste repo — a lista real é sempre a que `listTools` responder.


### ARQUIVOS

| Tool | O que faz |
|---|---|
| `readFile` | Lê o conteúdo de um arquivo de texto. |
| `writeFile` | Cria ou sobrescreve um arquivo. |
| `appendFile` | Adiciona texto no final do arquivo. |
| `replaceInFile` | Substitui uma ocorrência exata no arquivo. |
| `deleteFile` | Deleta um arquivo. |
| `moveFile` | Move/renomeia um arquivo. |
| `copyFile` | Copia um arquivo. |
| `getFileInfo` | Tamanho, datas e tipo de um arquivo. |

### DIRETÓRIOS

| Tool | O que faz |
|---|---|
| `listFiles` | Lista arquivos por padrão glob. |
| `viewDirectory` | Lista o conteúdo de um diretório. |
| `createDirectory` | Cria diretório (recursivo). |
| `removeDirectory` | Remove diretório e conteúdo. |

### BUSCA

| Tool | O que faz |
|---|---|
| `searchFiles` | Busca arquivos pelo nome. |
| `grep` | Busca texto DENTRO dos arquivos. |
| `glob` | Expande padrão glob e retorna caminhos. |

### WEB

| Tool | O que faz |
|---|---|
| `searchWeb` | Pesquisa na internet (aliases web_search/webSearch). |
| `fetchURL` | Busca o conteúdo de uma página. |
| `downloadFile` | Baixa um arquivo da web para o disco. |
| `browser` | Automação de navegador (modo CDP/Playwright). |

### SHELL

| Tool | O que faz |
|---|---|
| `executeShell` | Executa comando no PC (shell real, sem confirmação). |
| `executeScript` | Executa script completo (bash/node/python). |
| `runTests` | Roda a suíte de testes do projeto. |
| `checkSyntax` | Valida sintaxe de um arquivo de código. |
| `installPackages` | Instala dependências (npm/pip/etc). |

### GIT

| Tool | O que faz |
|---|---|
| `gitStatus` | Status do repositório. |
| `gitDiff` | Diff das alterações. |
| `gitLog` | Histórico de commits. |
| `gitCommit` | Commit das alterações. |
| `applyPatch` | Aplica um patch unificado a arquivos. |

### BRAIN

| Tool | O que faz |
|---|---|
| `brainSearch` | Pesquisa notas/aprendizados no brain da empresa (quem é quem, números, decisões, erros). Use SEMPRE que precisar de contexto que você não tem. |
| `brainRead` | Lê uma nota completa do brain pelo id (id vem do brainSearch). |
| `brainSaveOutcome` | Grava aprendizado/outcome no brain (memória de longo prazo da Luna). |

### SISTEMA

| Tool | O que faz |
|---|---|
| `think` | Registra raciocínio passo a passo (não executa nada). |
| `getCurrentDirectory` | Diretório de trabalho atual. |
| `clipboardRead` | Lê o conteúdo da área de transferência. |
| `clipboardWrite` | Escreve na área de transferência. |
| `readMediaFile` | Inspeciona imagem/vídeo (tipo, tamanho). |
| `lunaSelfUpdate` | Atualiza a Luna do GitHub (dryRun p/ simular). |
| `setVisibleMode` | Liga/desliga modo visual da Luna. |
| `getVisibleMode` | Retorna o modo visual atual. |
| `openDebugTerminal` | Abre terminal de debug de um processo Luna. |
| `validateProject` | Valida a estrutura de um projeto (lint + checks). |

### TAREFAS

| Tool | O que faz |
|---|---|
| `dashboardListTasks` | Lista tarefas do dashboard com filtros opcionais. |
| `dashboardCreateTask` | Cria uma nova tarefa no dashboard. |
| `dashboardUpdateTask` | Atualiza os dados de uma tarefa existente. |
| `dashboardCompleteTask` | Marca uma tarefa como concluída. |
| `dashboardDeleteTask` | Remove uma tarefa do dashboard. |
| `dashboardAddComment` | Adiciona um comentário a uma tarefa. |

### LEADS

| Tool | O que faz |
|---|---|
| `dashboardListLeads` | Lista leads cadastrados com filtros opcionais. |
| `dashboardCreateLead` | Cria um novo lead no dashboard. |
| `dashboardUpdateLead` | Atualiza os dados de um lead existente. |
| `dashboardConvertLead` | Converte um lead em cliente. |
| `dashboardDeleteLead` | Remove um lead do dashboard. |

### FINANCEIRO

| Tool | O que faz |
|---|---|
| `dashboardGetFinanceSummary` | Retorna o resumo financeiro esperado, recebido, pendente e em atraso. |
| `dashboardListPayments` | Lista pagamentos/receitas cadastradas. |
| `dashboardCreatePayment` | Registra um novo pagamento ou receita. |
| `dashboardReceiveSplit` | Marca uma parte de pagamento dividido como recebida. |

### DESPESAS

| Tool | O que faz |
|---|---|
| `dashboardListExpenses` | Lista despesas com filtros de status e categoria. |
| `dashboardCreateExpense` | Registra uma nova despesa. |
| `dashboardUpdateExpense` | Atualiza os dados de uma despesa existente. |
| `dashboardDeleteExpense` | Remove uma despesa do dashboard. |
| `dashboardPayExpense` | Marca uma despesa como paga. |

### CAIXA

| Tool | O que faz |
|---|---|
| `dashboardGetCashBox` | Retorna o saldo atual do caixa. |
| `dashboardListCashHistory` | Lista o histórico de movimentações do caixa. |
| `dashboardAddCashEntry` | Adiciona uma entrada ou saída de caixa. |
| `dashboardReconcileCashBox` | Reconcilia o caixa com um saldo real informado. |
| `dashboardAdjustCashBox` | Ajusta o saldo do caixa manualmente. |
| `dashboardGetCashBoxProjection` | Retorna a projeção financeira do caixa. |
| `dashboardCreateCashPayment` | Registra um pagamento direto no caixa. |

### PROJETOS

| Tool | O que faz |
|---|---|
| `dashboardListProjects` | Lista os projetos cadastrados no dashboard. |
| `dashboardListClients` | Lista os clientes cadastrados no dashboard. |

### ROADMAPS

| Tool | O que faz |
|---|---|
| `dashboardListRoadmaps` | Lista roadmaps com filtros opcionais. |
| `dashboardGetRoadmap` | Retorna os detalhes de um roadmap específico. |
| `dashboardCreateRoadmap` | Cria um novo roadmap de projeto. |
| `dashboardAdvanceRoadmapPhase` | Avança para a próxima fase de um roadmap. |
| `dashboardListProjectTypes` | Lista os tipos de projeto disponíveis. |

### IDEIAS

| Tool | O que faz |
|---|---|
| `dashboardListIdeas` | Lista ideias com filtros opcionais. |
| `dashboardCreateIdea` | Cria uma nova ideia no dashboard. |

### VOTAÇÕES

| Tool | O que faz |
|---|---|
| `dashboardListVotingSessions` | Lista sessões de votação. |
| `dashboardGetVotingSession` | Retorna os detalhes de uma sessão de votação. |
| `dashboardCreateVotingSession` | Cria uma nova sessão de votação. |
| `dashboardVoteInSession` | Registra um voto em uma sessão de votação. |
| `dashboardDeleteVotingSession` | Remove uma sessão de votação. |

### HISTÓRICO

| Tool | O que faz |
|---|---|
| `dashboardListRecentChanges` | Lista as alterações recentes no dashboard (criações, atualizações, exclusões). |
| `dashboardListTrash` | Mostra a lixeira do dashboard com itens excluídos que podem ser restaurados. |
| `dashboardUndoLastChange` | Desfaz a última alteração feita pelo usuário no dashboard. |
| `dashboardRestoreItem` | Restaura um item específico a partir do ID do histórico (audit log). |

### LINKS

| Tool | O que faz |
|---|---|
| `dashboardListLinks` | Lista links salvos no dashboard. |
| `dashboardAddLink` | Adiciona um novo link ao dashboard. |

### COTAÇÕES

| Tool | O que faz |
|---|---|
| `dashboardListQuotes` | Lista orçamentos/cotações cadastradas. |
| `dashboardCreateQuote` | Cria uma nova cotação/orçamento. |
| `dashboardUpdateQuote` | Atualiza uma cotação existente. |
| `dashboardDeleteQuote` | Remove uma cotação do dashboard. |

### WHATSAPP

| Tool | O que faz |
|---|---|
| `dashboardSendWhatsApp` | Envia mensagem WhatsApp pelo pipeline oficial. |
| `dashboardGetWhatsAppHistory` | Histórico de mensagens de um chat. |
| `dashboardScanWhatsApp` | Escaneia chats novos/pendentes. |
| `dashboardGetWhatsAppStatus` | Status da conexão WhatsApp. |
| `dashboardGetWhatsAppClassifications` | Classificações automáticas recentes. |

### EMAIL

| Tool | O que faz |
|---|---|
| `dashboardSendEmail` | Envia email. |
| `dashboardListEmails` | Lista emails sincronizados. |
| `dashboardSyncEmails` | Força sincronização da caixa de email. |

### DASHBOARD — SISTEMA

| Tool | O que faz |
|---|---|
| `dashboardGetSystemStatus` | Status geral do dashboard. |
| `dashboardGetSystemLogs` | Logs recentes do sistema. |
| `dashboardControlService` | Inicia/para/reinicia um serviço. |
| `dashboardListNotifications` | Lista notificações. |
| `dashboardMarkNotificationRead` | Marca notificação como lida. |
| `dashboardMarkAllNotificationsRead` | Marca todas como lidas. |

### DASHBOARD — PESSOAS

| Tool | O que faz |
|---|---|
| `dashboardListUsers` | Lista usuários do dashboard. |
| `dashboardListMembers` | Lista membros da equipe. |

### DASHBOARD — BUGS & OPS

| Tool | O que faz |
|---|---|
| `dashboardListBugReports` | Lista bug reports. |
| `dashboardDeleteBugReport` | Remove um bug report. |
| `dashboardListOpsAlerts` | Lista alertas operacionais. |
| `dashboardCreateOpsAlert` | Cria alerta operacional. |
| `dashboardDeleteOpsAlert` | Remove alerta operacional. |

### DASHBOARD — TAREFAS & SOLICITAÇÕES

| Tool | O que faz |
|---|---|
| `dashboardCreateTask` | Cria tarefa/solicitação no dashboard. |
| `dashboardListTasks` | Lista tarefas (filtros opcionais). |
| `dashboardUpdateTask` | Atualiza tarefa. |
| `dashboardCompleteTask` | Marca tarefa como concluída. |
| `dashboardDeleteTask` | Remove uma tarefa. |
| `dashboardCreateLead` | Registra um lead. |

### DASHBOARD — GITHUB/VERCEL

| Tool | O que faz |
|---|---|
| `dashboardListGitHubRepos` | Lista repositórios GitHub. |
| `dashboardListVercelProjects` | Lista projetos Vercel. |

### DASHBOARD — AVANÇADO

| Tool | O que faz |
|---|---|
| `dashboardUpdatePayment` | Atualiza um pagamento. |
| `dashboardDeletePayment` | Remove um pagamento. |
| `dashboardUpdateExpense` | Atualiza uma despesa. |
| `dashboardDeleteExpense` | Remove uma despesa. |
| `dashboardCreateExpenseTemplate` | Cria template de despesa recorrente. |
| `dashboardQuickExpense` | Registra despesa rápida. |
| `dashboardDeleteQuote` | Remove uma cotação. |
| `dashboardDeleteLink` | Remove um link salvo. |
| `dashboardEnrichLink` | Enriquece metadados de um link. |
| `dashboardSyncLinks` | Sincroniza links salvos. |
| `dashboardGetLinksStats` | Estatísticas de links. |
| `dashboardGetVotingSession` | Detalhes de uma votação. |
| `dashboardVoteInSession` | Vota em uma sessão. |
| `dashboardDeleteVotingSession` | Remove uma votação. |
| `dashboardListTransactions` | Lista transações financeiras. |
| `dashboardGetNexoState` | Estado geral do Nexo. |
| `dashboardGetConfig` | Configuração do dashboard. |
| `dashboardJoinTimeline` | Entra em uma timeline colaborativa. |
| `dashboardAdvanceTimelineStep` | Avança o step da timeline. |
| `dashboardCreateReviewVote` | Cria votação de revisão de fase. |

### WORKSPACE NEXO — SOLICITAÇÕES

| Tool | O que faz |
|---|---|
| `workspaceListRequests` | Lista solicitações dos clientes (filtros: status, organizationId, projectId, search). |
| `workspaceGetRequest` | Detalhe completo de uma solicitação. |
| `workspaceCreateRequest` | Cria solicitação para qualquer cliente. |
| `workspaceUpdateRequest` | Muda status/urgência de uma solicitação. |
| `workspaceAddComment` | Comenta numa solicitação (visível pro cliente). |
| `workspaceListProjects` | Lista projetos do workspace (clientes e ids). |
| `workspaceListOrganizations` | Lista organizações (clientes) com ids. |
| `workspaceListClients` | Lista usuários-cliente cadastrados. |

### WHATSAPP — DIRETÓRIO & ENVIO

| Tool | O que faz |
|---|---|
| `whatsappListContacts` | Lista contatos do WhatsApp (diretório real; filtro search). |
| `whatsappListGroups` | Lista grupos do WhatsApp com nº de membros (filtro search). |
| `whatsappGroupMembers` | Lista os membros de um grupo. |
| `whatsappSendMessage` | Envia msg pra NOME, jid ou número — grupo incluído. FLUXO: listar → escolher → enviar. |
| `whatsappAllowContact` | PROTOCOLO NOVO CONTATO: add nome/número na allowlist + diretório (decree owner). |

### PAINEL — PROVIDERS & RODA

| Tool | O que faz |
|---|---|
| `dashboardConfigProvider` | API unificada: list \| set-key \| add-preset \| add-custom \| remove. |
| `dashboardListProviders` | Lista providers da roda com status de key. |
| `dashboardSetProviderKey` | Salva uma API key no .env via painel (env + value). |
| `dashboardAddProvider` | Adiciona provider (presetId ou custom {...}). |
| `dashboardRemoveProvider` | Remove um provider da roda. |

### CHAMADA — OPERADOR

| Tool | O que faz |
|---|---|
| `callRespond` | Fala um texto NA CHAMADA ativa (vai pro operador/ChatGPT e a voz fala). Sua voz durante a ligação. |


### Meta-tools — a Luna se autodocumenta

| Tool | O que faz |
|---|---|
| `listTools` | Lista as tools (todas, ou filtradas por `busca`/`categoria`). Use sempre que precisar saber o que pode executar — ela é citada em todo erro e sucesso. |
| `toolInfo` | Docs completas de UMA tool: parâmetros + exemplo pronto. `toolInfo {"name":"whatsappSendMessage"}` |

> **Dica de engenharia:** o system prompt da Luna instrui o modelo a chamar `listTools` sempre que incerto, e o resultado de cada tool volta no envelope `[TOOL RESULT] {status, tool, result}` — compacto, sem poluir o contexto com logs.

---

## 🩺 Troubleshooting

| Sintoma | Causa provável | Resolução |
|---|---|---|
| `relation luna_chat_sessions does not exist` | Banco antigo, migração nunca rodou | **Já resolvido no v14.3** — a tabela se cria no boot. Se persistir, rode o SQL de `packages/kernel/001_luna_chat_sessions.sql` manualmente |
| A Luna não responde nada | Nenhum provider com key e Kimi CDP sem login | `pm2 logs luna-server` — veja qual bridge ativou. Abra o wizard Kimi ou configure uma key no `.env` |
| Só gira entre providers e nunca responde | Todas as keys inválidas | Confira `LUNA_RODA_CONFIG` no `.env` e as envs de key. Teste a key com curl direto no `baseUrl` |
| Porta 3458 ocupada | Outro processo (outra instância da Luna) | `pm2 delete all` ou mude `LUNA_PORT` no `.env` |
| WhatsApp não envia | Sessão caiu ou contact_id nulo | `dashboardGetWhatsAppStatus {}` → reescaneie; a resposta resolve destino por `metadata.chat_id` automaticamente |
| `pm2: command not found` | PATH sem o PM2 (comum em SSH não-interativo) | `export PATH="$HOME/node24/bin:$PATH"` antes dos comandos pm2 |
| Brain não responde | Brain (:4321) fora ou URL errada | Confira `BRAIN_INTERNAL_URL`; sem Brain a Luna funciona, só sem memória de longo prazo |

---

## 📁 Estrutura do repositório

```
.
├── install.sh                  # instalador Linux (one-liner)
├── install.cjs                 # wizard: envs, providers.json, PM2, atalhos
├── scripts/setup-windows.ps1   # instalador Windows
├── pm2-ecosystem.config.js     # processos de produção
├── packages/
│   └── kernel/                 # @luna/kernel — a SOUL
│       ├── luna-soul.cjs           # loop principal do agente
│       ├── tool-catalog.cjs        # catálogo das 161 tools (fonte deste README)
│       ├── bridge-factory.cjs      # roda de providers + KimiBridge CDP
│       ├── brain-loader.cjs        # memória de longo prazo
│       ├── whatsapp-tools.cjs      # diretório + envio WhatsApp
│       └── luna-web/               # frontend Svelte (Luna Web)
└── apps/
    └── dashboard/              # @luna/dashboard — servidor :3458
        ├── luna-server.js
        ├── luna-chat-routes.js     # rotas do chat + providers
        ├── db.js                   # Postgres com auto-migração + fallback JSON
        └── services/               # gemini, e-mail, whatsapp…
```

---

## 📚 Documentação interna

- Guia humano (liga/desliga/atalhos): [`docs/guia-humano.md`](docs/guia-humano.md)
- README do kernel: [`packages/kernel/README.md`](packages/kernel/README.md)

---

<div align="center">
<sub>🌙 Luna Kernel — a operadora não dorme. · NEXO DIGITAL S.L.</sub>
</div>
