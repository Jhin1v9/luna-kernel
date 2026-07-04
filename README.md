# 🌙 Luna Monorepo

Repositório unificado que contém o **Luna Kernel** (agente autônomo, bridge Kimi, Telegram) e o **Luna Dashboard** (backend web, APIs REST/SSE, interface).

Antes, o projeto era dividido entre `luna-kernel` e `NexoDashboard`. Agora tudo vive aqui, usando **pnpm workspaces**.

---

## 📁 Layout

```
.
├── package.json                  # root do monorepo + workspaces
├── pnpm-workspace.yaml
├── pm2-ecosystem.config.js       # processos de produção (PM2)
├── packages/
│   └── kernel/                   # @luna/kernel
│       ├── luna-soul.cjs         # cérebro da Luna
│       ├── kimi-bridge.cjs       # Playwright/CDP para Kimi Web
│       ├── telegram-luna-adapter.cjs
│       ├── luna-web/             # workspace luna-web (Vite + Svelte)
│       └── ...
└── apps/
    └── dashboard/                # @luna/dashboard
        ├── luna-server.js        # servidor web principal (porta 3458)
        ├── server.js             # API/dashboard legado (porta 3456)
        └── ...
```

---

## ⚙️ Pré-requisitos

- Node.js **v22+**
- pnpm **v11.9+** (gerenciado pelo corepack)
- Git
- Google Chrome/Chromium
- PM2 (para produção)

---

## 🚀 Instalação

```bash
cd /home/jhin/.luna-kernel
corepack pnpm install
```

Isso instala todas as dependências do root e de cada workspace, criando os links simbólicos internos (`@luna/kernel`, `@luna/dashboard`).

---

## 🔨 Build

Para compilar a interface web (`packages/kernel/luna-web/dist`):

```bash
cd /home/jhin/.luna-kernel
corepack pnpm build
```

Equivalente a:

```bash
corepack pnpm --filter luna-web build
```

---

## ▶️ Como rodar

### Desenvolvimento

```bash
# Interface web (Vite dev server na porta 5173)
corepack pnpm dev:kernel

# Backend Luna (porta 3458)
corepack pnpm dev:dashboard
```

### Produção (PM2)

```bash
cd /home/jhin/.luna-kernel
pm2 start pm2-ecosystem.config.js
pm2 save
```

Processos gerenciados:

| Nome | Descrição | Porta padrão |
|---|---|---|
| `luna-server` | Servidor web Luna (chat + API) | 3458 |
| `nexo-dashboard` | API/dashboard legado | 3456 |
| `telegram-bot` | Bot do Telegram | — |
| `luna-vite` | Vite dev server do frontend | 5173 |
| `luna-health-watchdog` | Monitor de saúde | — |

---

## 🧪 Testes rápidos

```bash
# Sessões
curl -s http://localhost:3458/api/chat/sessions | head -c 200

# Compactação manual (SSE)
curl -s -N -H 'Accept: text/event-stream' \
  -H 'Content-Type: application/json' \
  -X POST http://localhost:3458/api/luna/compact \
  -d '{"sessionId":"test-session","userId":"luna-default"}' | head -20
```

---

## 🔑 Variáveis de ambiente

Crie/edit `apps/dashboard/.env` (e/ou `packages/kernel/.env`):

```env
# Obrigatórias
TELEGRAM_BOT_TOKEN=...
INTERNAL_API_TOKEN=...
JWT_SECRET=...

# Opcionais
LUNA_PORT=3458
DASHBOARD_PORT=3456
LUNA_HOME=/home/jhin/.luna-kernel
LUNA_KERNEL_DIR=/home/jhin/.luna-kernel/packages/kernel
NEXO_DIR=/home/jhin/.luna-kernel/apps/dashboard
```

> O PM2 já define `LUNA_KERNEL_DIR`, `LUNA_DIR` e `NEXO_DIR` apontando para o monorepo. Defina `LUNA_HOME` para controlar onde dados persistentes (sessions, cookies, personas) ficam.

---

## 📚 Documentação

- **Guia humano (liga/desliga/atalhos):** [`docs/HUMAN-GUIDE.md`](docs/HUMAN-GUIDE.md)
- Manual de compactação: [`packages/kernel/docs/LUNA-MANUAL-COMPACTACAO-MANUAL.md`](packages/kernel/docs/LUNA-MANUAL-COMPACTACAO-MANUAL.md)
- README do kernel: [`packages/kernel/README.md`](packages/kernel/README.md)

---

## 🛠️ Comandos úteis

```bash
# Logs
corepack pnpm --filter @luna/dashboard logs   # ou: pm2 logs luna-server

# Parar/limpar PM2
pm2 stop all
pm2 delete all

# Reinstalar dependências do zero
rm -rf node_modules apps/dashboard/node_modules packages/kernel/node_modules packages/kernel/luna-web/node_modules
corepack pnpm install
```

---

## 📝 Notas

- O repositório legado `NexoDashboard` foi incorporado em `apps/dashboard` e não deve mais receber alterações paralelas.
- O `dist/` do `luna-web` é versionado de propósito (produção usa o build estático).

---

<p align="center">
  <sub>🌙 Luna Monorepo — NEXO DIGITAL S.L.</sub>
</p>
