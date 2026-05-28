# 🌙 Luna Kernel v4.0

Autonomous Agent Kernel for Abner Gabriel (CEO, NEXO DIGITAL S.L.)

## What is Luna?

Luna is a multi-channel autonomous agent that runs on your local machine. It can:
- Create and manage files/projects
- Execute shell commands and scripts
- Browse the web via Playwright
- Integrate with Telegram
- Connect to Kimi Web for AI reasoning
- Self-heal and auto-correct projects

## Architecture

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

## Quick Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Jhin1v9/luna-kernel/main/install.sh)
```

## Requirements

- Node.js v20+
- Chrome/Chromium (for Playwright CDP)
- Telegram Bot Token (optional)

## Files

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

## License

Private — NEXO DIGITAL S.L.
