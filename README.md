# 🌙 Luna Kernel v4.0

Autonomous Agent Kernel for Abner Gabriel (CEO, NEXO DIGITAL S.L.)

> **Privado** — Uso exclusivo da NEXO DIGITAL S.L. e parceiros autorizados.

---

## 🚀 Quick Start (copie e cole)

```bash
# 1. Instalar
bash <(curl -fsSL https://raw.githubusercontent.com/Jhin1v9/luna-kernel/main/install.sh)

# 2. Configurar
cd ~/.luna-kernel
cp .env.example .env
nano .env   # cole seus tokens

# 3. Iniciar
node telegram-luna-adapter.cjs

# Ou com PM2 (background, recomendado):
pm2 start telegram-luna-adapter.cjs --name luna-kernel
pm2 save
```

---

## 🤖 Bot do Telegram

**[@lunanexobot](https://t.me/lunanexobot)**

Adicione ao seu grupo ou converse diretamente. Todos no grupo usam a **mesma conta** — a Luna executa no PC do Abner.

---

## 📋 .env Pronto (copie e preencha)

```bash
# === OBRIGATÓRIOS ===

# Pegue em @BotFather (https://t.me/BotFather)
# /newbot → escolha nome → copie o token
TELEGRAM_BOT_TOKEN=SEU_TOKEN_AQUI

# Token da API interna do NEXO Dashboard
# Usado para criar/listar tarefas, leads, finanças
INTERNAL_API_TOKEN=SEU_TOKEN_AQUI

# === OPCIONAIS (deixe os defaults se não souber) ===

KIMI_TIMEOUT=120000
KIMI_MAX_PAGES=5
KIMI_IDLE_TIMEOUT=600000
KIMI_COOLDOWN_MS=5000
KIMI_MAX_TYPE_LENGTH=500
KIMI_LOG_MAX_MB=10
LUNA_COMPACT_THRESHOLD=24
LUNA_COMPACT_TOKEN_THRESHOLD=120000

# Chrome path (auto-detectado se vazio)
# LUNA_CHROME_PATH=/usr/bin/google-chrome
```

---

## 📖 Tutorial Completo

### 1. Requisitos

- **Node.js v20+** — [nodejs.org](https://nodejs.org/)
- **Chrome/Chromium** — `sudo apt-get install google-chrome-stable`
- **Git** — já vem na maioria das distros Linux

### 2. Instalação

O `install.sh` faz tudo automaticamente:
- Verifica Node.js
- Clona o repo para `~/.luna-kernel`
- Instala dependências (`npm install`)
- Detecta Chrome
- Cria template `.env`

### 3. Configuração

**Opção A — Painel Web (recomendado):**
```bash
cd ~/.luna-kernel
# Abra o config.html no navegador:
firefox config.html   # ou chrome, chromium, etc.
```

O painel web permite:
- Preencher todos os tokens visualmente
- Editar o **System Prompt** (com aviso de risco + botão reset)
- Exportar `.env` pronto para usar
- Importar `.env` de arquivo
- Testar conexão com o Telegram
- Ver tutorial embutido

**Opção B — Editar direto:**
```bash
nano ~/.luna-kernel/.env
```

### 4. Iniciar a Luna

**Modo direto (logs no terminal):**
```bash
cd ~/.luna-kernel
node telegram-luna-adapter.cjs
```

**Modo PM2 (background, recomendado para produção):**
```bash
cd ~/.luna-kernel
pm2 start telegram-luna-adapter.cjs --name luna-kernel
pm2 save
pm2 startup    # opcional: inicia automaticamente no boot
```

Para ver logs:
```bash
pm2 logs luna-kernel
```

Para reiniciar:
```bash
pm2 restart luna-kernel
```

### 5. Usar no Telegram

Adicione o bot `@lunanexobot` ao seu grupo.

**Comandos:**

| Comando | Descrição |
|---------|-----------|
| `/kimi` | Liga/desliga modo persistente |
| `/kimi on` | Liga — Luna responde TODAS as mensagens |
| `/kimi off` | Desliga — Luna ignora mensagens normais |
| `/status` | Mostra status da Luna |

**Como funciona em grupo:**
- Com `/kimi on`, qualquer mensagem no grupo é processada pela Luna
- A Luna executa no PC do Abner (Linux real)
- Contexto é mantido por chat — ela lembra o que vocês falaram antes
- Use `"Luna, ..."` no início para garantir atenção

### 6. O que a Luna faz?

| Tarefa | Exemplo de comando |
|--------|-------------------|
| Criar projeto | `"Luna, cria um app React de lista de tarefas com Tailwind"` |
| Gerenciar arquivos | `"Leia o arquivo ~/Documentos/relatorio.txt"` |
| Navegar na web | `"Pesquisa melhores práticas de SEO 2025"` |
| Dashboard | `"Cria tarefa: Reunião Santander, prioridade alta"` |
| Auto-correção | `"O projeto em ~/meu-app não tá rodando, conserta"` |
| Scripts | `"Roda um script bash que faz backup da pasta Documentos"` |

### 7. Chrome / Kimi Web

A Luna usa o Chrome na porta 9222 (CDP) para conversar com o Kimi Web.

**Iniciar Chrome com CDP:**
```bash
google-chrome --remote-debugging-port=9222 \
  --user-data-dir=~/chrome-luna \
  --no-first-run
```

Ou use o script que a Luna já tem:
```bash
node -e "require('./kimi-bridge.cjs').launchChrome()"
```

---

## 🎨 Painel de Configurações

Abra `config.html` no navegador para uma interface visual completa:

```bash
cd ~/.luna-kernel
firefox config.html
```

**Tabs:**
- **⚙️ Setup** — todos os campos de configuração com explicações
- **🧠 System Prompt** — editor do prompt master com:
  - Contador de caracteres/linhas
  - **⚠️ Aviso de risco** ao editar
  - Botão **Reset** — restaura o prompt original funcional
- **📖 Tutorial** — guia completo embutido
- **🔍 Status** — testa conexão com Telegram, Node.js, Chrome

---

## 🔧 Problemas Comuns

| Erro | Solução |
|------|---------|
| `Timeout 30000ms exceeded` | Kimi Web demorou. A Luna tenta de novo automaticamente. Verifique se Chrome está na porta 9222. |
| `ERR_ABORTED` | Página caiu. A Luna limpa e recria. Normalmente resolve sozinho. |
| `npm not found` | Reinstale Node.js v20+. Verifique `node -v`. |
| `Bot não responde` | Verifique `TELEGRAM_BOT_TOKEN`. O bot pode estar bloqueado pelo Telegram. |
| `Chrome not found` | Instale: `sudo apt-get install google-chrome-stable` |
| `Permission denied` | Verifique permissões da pasta `~/.luna-kernel` |

---

## 🏗️ Arquitetura

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Telegram   │────▶│  Luna Soul  │────▶│ Kimi Bridge │
│   Adapter   │     │  (Core)     │     │ (Playwright)│
└─────────────┘     └──────┬──────┘     └─────────────┘
                           │
                    ┌──────┴──────┐
                    │  Luna Tools  │
                    │ read/write   │
                    │ executeShell │
                    │ searchWeb    │
                    └─────────────┘
```

---

## 📁 Arquivos

| File | Description |
|------|-------------|
| `luna-soul.cjs` | Core orchestrator engine |
| `luna-tools.cjs` | Tool definitions (file ops, shell, git) |
| `kimi-bridge.cjs` | Playwright CDP bridge to Kimi Web |
| `telegram-luna-adapter.cjs` | Telegram bot adapter |
| `response-stream-parser.cjs` | Incremental stream parser |
| `meta-executor-secure.cjs` | Secure file executor with path validation |
| `session-manager.cjs` | Session persistence |
| `computer-use-engine.cjs` | Desktop automation |
| `luna-tool-guard.cjs` | Security validations |
| `luna-workspace.cjs` | Workspace management |
| `luna-git.cjs` | Git operations |
| `config.html` | 🎨 Painel de configurações visual |

---

## 📝 Variáveis de Ambiente

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ Yes | — | Token from @BotFather |
| `INTERNAL_API_TOKEN` | ✅ Yes | — | NEXO Dashboard API token |
| `KIMI_TIMEOUT` | No | 120000 | Kimi Web timeout (ms) |
| `KIMI_MAX_PAGES` | No | 5 | Max Chrome pages |
| `KIMI_IDLE_TIMEOUT` | No | 600000 | Idle timeout (ms) |
| `KIMI_COOLDOWN_MS` | No | 5000 | Message cooldown (ms) |
| `KIMI_MAX_TYPE_LENGTH` | No | 500 | Max text length to type |
| `KIMI_LOG_MAX_MB` | No | 10 | Max log file size (MB) |
| `LUNA_COMPACT_THRESHOLD` | No | 24 | Context compaction threshold |
| `LUNA_COMPACT_TOKEN_THRESHOLD` | No | 120000 | Token threshold |
| `LUNA_CHROME_PATH` | No | auto | Chrome binary path |
| `LUNA_DEBUG` | No | false | Debug mode |

---

## 📜 Licença

Private — NEXO DIGITAL S.L.  
**Não distribuir sem autorização.**

---

*Feito com 🌙 pela NEXO DIGITAL S.L. — Barcelona*
