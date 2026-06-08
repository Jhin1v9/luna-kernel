# 🌙 Luna Web — Documentação Completa

> Assistente de IA integrada ao Kimi Web, com execução de ferramentas em tempo real.

---

## 📖 Índice

1. [O que é a Luna Web](#o-que-é-a-luna-web)
2. [Como Usar](#como-usar)
3. [Modos de Operação](#modos-de-operação)
4. [Comandos (Slash Commands)](#comandos-slash-commands)
5. [Recursos](#recursos)
6. [Arquitetura](#arquitetura)
7. [Como Rodar Localmente](#como-rodar-localmente)
8. [Solução de Problemas](#solução-de-problemas)
9. [Dashboards Integrados](#dashboards-integrados)

---

## O que é a Luna Web

A **Luna Web** é uma interface de chat avançada que conecta você à **Kimi** (modelo de IA da Moonshot) com superpoderes:

- 💬 **Chat em streaming** — respostas em tempo real, como no ChatGPT
- 🛠️ **Execução de ferramentas** — a Luna pode ler arquivos, executar comandos, criar tarefas e leads diretamente no seu sistema
- 🧠 **Modo Thinking** — veja o raciocínio da Luna antes da resposta
- ⚡ **Modo Instant** — respostas rápidas sem mostrar o pensamento
- 📋 **Plan Mode** — a Luna investiga, planeja e pede sua aprovação antes de agir
- 📊 **Dashboards** — gestão de Tarefas, Leads e Finanças integrada

---

## Como Usar

### Enviar uma mensagem

1. Digite sua mensagem no campo na parte inferior
2. Pressione **Enter** ou clique no botão de enviar
3. A Luna processa e responde em streaming

### Anexar arquivos

- Arraste e solte arquivos no campo de texto
- Ou clique no ícone de anexo (se disponível)
- A Luna pode ler código, documentos, imagens e mais

### Modos de Operação

Clique no seletor de modo no topo do chat para alternar:

| Modo | Descrição | Quando usar |
|------|-----------|-------------|
| **Instant** | Resposta rápida, sem mostrar raciocínio | Perguntas simples, respostas diretas |
| **Thinking** | Mostra o raciocínio passo a passo | Problemas complexos, debugging |
| **Agent** | Executa ferramentas automaticamente | Tarefas que precisam de código, arquivo, busca |
| **Swarm** | Múltiplos agentes trabalhando juntos | Projetos grandes, multi-etapa |

### Copiar respostas

- Passe o mouse sobre qualquer bolha de mensagem (sua ou da Luna)
- Clique no ícone 📋 no canto superior direito
- O texto é copiado para a área de trabalho

### Buscar conversas

- No sidebar esquerdo, use o campo **"Buscar conversas..."**
- Digite parte do título da conversa
- Pressione **Esc** para limpar a busca

---

## Comandos (Slash Commands)

Digite `/` no campo de mensagem para ver todos os comandos:

| Comando | Descrição |
|---------|-----------|
| `/newchat` | Inicia uma nova conversa |
| `/clear` | Limpa o chat atual |
| `/plan <tarefa>` | Ativa o Modo Detetive para investigar e planejar |
| `/mode <instant/thinking/agent/swarm>` | Muda o modo de operação |
| `/restart` | Reinicia o servidor Luna |
| `/status` | Mostra status do sistema |
| `/stop` | Para o agente Luna |
| `/logs` | Mostra logs recentes |
| `/help` | Mostra esta lista de comandos |

---

## Recursos

### 🔧 Tool Cards

Quando a Luna executa uma ferramenta (ex: `readFile`, `executeShell`, `createTask`), um card aparece no chat mostrando:
- Nome da ferramenta e ícone
- Parâmetros usados
- Status: em execução → sucesso / erro
- Tempo de execução
- Resultado colapsável

### 🧠 Thinking Bubble

No modo **Thinking**, uma bolha animada aparece enquanto a Luna pensa:
- Mostra o raciocínio em tempo real
- Desaparece automaticamente quando a resposta começa

### ⚡ Typing Indicator

No modo **Instant**, pontos animados indicam que a Luna está processando — sem mostrar o pensamento.

### 📋 Plan Mode (Modo Detetive)

1. Você pede algo complexo (ex: "Crie um app React")
2. A Luna investiga, lê arquivos, analisa o projeto
3. Ela gera um **plano detalhado**
4. Você **aprova**, **rejeita** ou **revisa** o plano
5. Só então ela executa

### 🔔 Notificações Telegram

Se configurado, a Luna pode enviar notificações para o Telegram quando:
- Uma tarefa longa é concluída
- Um plano precisa de aprovação
- Erros críticos acontecem

---

## Arquitetura

```
┌─────────────┐      HTTP/SSE      ┌──────────────┐
│  Luna Web   │ ◄────────────────► │ luna-server  │
│  (Svelte)   │                    │  (Node.js)   │
└─────────────┘                    └──────┬───────┘
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    │                     │                     │
              ┌─────▼─────┐      ┌────────▼────────┐   ┌──────▼──────┐
              │luna-soul  │      │  kimi-bridge    │   │ luna-tools  │
              │(orquestra)│      │ (Playwright/    │   │ (execução   │
              │           │      │  Chrome)        │   │  de tools)  │
              └─────┬─────┘      └────────┬────────┘   └──────┬──────┘
                    │                     │                   │
                    │              ┌──────▼──────┐            │
                    │              │  Kimi Web   │            │
                    │              │  (kimi.com) │            │
                    │              └─────────────┘            │
                    │                                         │
                    └─────────────────────────────────────────┘
                                          │
                                   ┌──────▼──────┐
                                   │   NEXO      │
                                   │  Dashboard  │
                                   └─────────────┘
```

**Fluxo de uma mensagem:**
1. Você digita no Luna Web
2. Frontend envia para `POST /api/chat`
3. Backend inicia `processMessageStream()` no `luna-soul.cjs`
4. `luna-soul` envia para a Kimi via `kimi-bridge.cjs`
5. Kimi responde em streaming
6. Eventos (thinking, resposta, tool calls) fluem via SSE
7. Frontend renderiza em tempo real

---

## Como Rodar Localmente

### Pré-requisitos

- Node.js 18+
- Chrome instalado (para o bridge)
- PM2 instalado globalmente: `npm install -g pm2`

### Instalação

```bash
# Clone ou navegue até o projeto
cd /home/jhin/.luna-kernel

# Instalar dependências do frontend
cd luna-web && npm install

# Build do frontend
cd luna-web && npm run build

# Iniciar o servidor
pm2 start luna-server.cjs --name luna-server
# ou reiniciar se já estiver rodando:
pm2 restart luna-server
```

### Acesso

Abra o navegador em: `http://localhost:3458`

### Login na Kimi

1. Abra o Chrome manualmente
2. Acesse `https://kimi.com`
3. Faça login com sua conta
4. A Luna Web detectará automaticamente

---

## Solução de Problemas

### 🔴 "Chrome não conectado"

- Verifique se o Chrome está aberto
- Verifique se o Chrome foi iniciado com `--remote-debugging-port=9222`
- Reinicie o luna-server: `pm2 restart luna-server`

### 🔴 "Você precisa logar primeiro no Kimi Web"

- Abra o Chrome e acesse `https://kimi.com`
- Faça login manualmente
- Recarregue a página do Luna Web

### 🔴 Chat parou de responder

- Verifique se não atingiu o limite de contexto (a Luna compacta automaticamente)
- Tente `/newchat` para uma nova conversa
- Verifique os logs: `pm2 logs luna-server`

### 🔴 Ferramenta ficou "rodando" para sempre

- O Tool Card tem timeout de 60 segundos
- Se travar, cancele e tente novamente
- Verifique se o comando não está esperando input interativo

### 🔴 Resposta veio com JSON cru

- O frontend tem proteção (response buffer) para esconder JSON durante streaming
- Se ainda aparecer, a tool provavelmente já está sendo executada — aguarde o Tool Card

### 🔴 Notificações do Telegram triplicadas

- Verifique se há múltiplas instâncias do `telegram-adapter` rodando: `pm2 status`
- Se houver, pare as duplicatas: `pm2 delete <id>`

---

## Dashboards Integrados

### 📋 Gestão de Tarefas

Acesse via painel lateral ou peça à Luna: *"Crie uma tarefa para revisar o código"*

- Criar, listar, completar e excluir tarefas
- Prioridades: Alta, Média, Baixa
- Tipos: Uma vez, Diária, Semanal, Mensal
- Filtros por status e busca por texto

### 👤 Gestão de Leads

Peça à Luna: *"Crie um lead chamado João Silva"*

- Criar leads com nome, email, telefone, valor estimado
- Acompanhar status do pipeline
- Atribuir responsáveis

### 💰 Financeiro

Acesse o dashboard financeiro para:
- Resumo de receitas e despesas
- Projeções e gráficos
- Controle de fluxo de caixa

---

## 📝 Contribuindo

Este é um projeto pessoal em desenvolvimento ativo. Para sugestões:

1. Teste as funcionalidades
2. Reporte bugs com passos para reproduzir
3. Sugira melhorias de UX

**Backup da versão estável:** `backup-luna-web-20260604-193703/`

---

*Última atualização: 2026-06-04 | Versão: 8.4*
