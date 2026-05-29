# 🌙 Luna Kernel v5.0

Autonomous AI Agent with Web Interface + Telegram Bot + Kimi Bridge

> **Privado** — Uso exclusivo da NEXO DIGITAL S.L. e parceiros autorizados.
> Author: Abner Gabriel

---

## ✨ What's New in v5.0

- 🌐 **Luna Web Interface** — Beautiful Svelte 4 + Tailwind CSS chat UI
- ⚡ **Real-time SSE Streaming** — See Luna thinking and executing tools live
- 🎨 **Dark Mode** — Consistent #0f0f1a theme with #e94560 accents
- 🛠️ **Tool Cards** — Visual feedback for every tool execution
- 📱 **Mobile Responsive** — Works on phone, tablet, and desktop
- 🔄 **Auto-reconnect SSE** — Reliable streaming with exponential backoff

---

## 🚀 Quick Start

```bash
# 1. Install
bash <(curl -fsSL https://raw.githubusercontent.com/Jhin1v9/luna-kernel/main/install.sh)

# 2. Configure
cd ~/.luna-kernel
nano .env   # paste your tokens

# 3. Start Web Interface (recommended)
node config-server.cjs
# → Open: http://localhost:3458

# Or start Telegram Bot
node telegram-luna-adapter.cjs
```

---

## 🌐 Luna Web Interface

The web interface is built with **Svelte 4 + Vite + Tailwind CSS**.

### Features:
- 💬 Real-time chat with SSE streaming
- 🧠 Thinking bubbles — see Luna's thought process
- 🛠️ Tool cards — visual execution status
- 📁 Session management — create, rename, delete
- ⚙️ Config drawer — edit .env and system prompt
- 📱 Mobile responsive with bottom sheet sidebar

### Screenshots:
- Hero: Dark sidebar + chat area
- Streaming: Thinking bubbles + tool cards
- Results: Markdown responses with code highlighting

---

## 🤖 Bot do Telegram

- **Username:** @lunanexobot
- Send messages to interact with Luna
- Supports all modes: CHAT, ACTION, PLAN, META

---

## 📁 Architecture

```
Frontend (Browser) ──HTTP/SSE──► config-server.cjs (Node.js)
                                        │
                                        ▼
                              Luna Soul ──► Kimi Bridge ──► Kimi Web AI
                                        │
                                        ▼
                              Executa no PC real (filesystem, shell, browser)
```

### Core Files:
| File | Purpose |
|------|---------|
| `config-server.cjs` | HTTP server + REST API + SSE streaming + serves web UI |
| `luna-soul.cjs` | Main orchestrator — modes, compaction, tool routing |
| `kimi-bridge.cjs` | Playwright CDP bridge to Kimi Web AI |
| `luna-tools.cjs` | File tools (writeFile, readFile, executeShell, etc.) |
| `luna-code-validator.cjs` | Auto-validation for code quality |
| `luna-tool-guard.cjs` | Security sandbox for tool execution |
| `telegram-luna-adapter.cjs` | Telegram Bot API adapter |
| `luna-web/dist/` | Built Svelte frontend (static files) |

---

## ⚙️ Environment Variables

```env
# Required
TELEGRAM_BOT_TOKEN=your_token
INTERNAL_API_TOKEN=your_token
JWT_SECRET=your_secret_32_chars

# Optional
KIMI_TIMEOUT=120000
KIMI_MAX_PAGES=5
LUNA_CONFIG_PORT=3458
```

---

## 🛠️ Development

```bash
# Web frontend (if modifying UI)
cd luna-web
npm install
npm run dev     # dev server
npm run build   # production build
```

---

## 📜 License

Private — NEXO DIGITAL S.L. All rights reserved.
