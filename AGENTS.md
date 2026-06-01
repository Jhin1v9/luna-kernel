# AGENTS.md — Luna Kernel v5.0

> ⚠️ **LEIA ANTES DE EDITAR QUALQUER ARQUIVO**

## Aviso Crítico: Arquitetura Real

A arquitetura do Luna Web foi migrada. **NÃO edite os arquivos errados.**

### O que MUDOU
| Antigo (DEFASADO) | Novo (ATUAL) |
|---|---|
| `~/.luna-kernel/config-server.cjs` | `NEXO_DASHBOARD_PRO/backend/luna-server.js` + `luna-chat-routes.js` |
| `NEXO_DASHBOARD_PRO/agents/luna-web/` | `~/.luna-kernel/luna-web/` |
| `NEXO_DASHBOARD_PRO/agents/luna-soul.cjs` | `~/.luna-kernel/luna-soul.cjs` |
| Systemd service (`luna-server.service`) | Script `NEXO_DASHBOARD_PRO/luna-nexo.sh` |

### Backend Luna Web (porta 3458)
- **`NEXO_DASHBOARD_PRO/backend/luna-server.js`** — Express server, serve static files, auth JWT
- **`NEXO_DASHBOARD_PRO/backend/luna-chat-routes.js`** — Router com `/api/chat/*`, `/api/plan/*`, `/api/system/*`, SSE streaming

### Frontend Luna Web (porta 5173 dev / 3458 produção)
- **Source:** `~/.luna-kernel/luna-web/src/`
- **Build:** `~/.luna-kernel/luna-web/dist/` (servido por luna-server.js)
- **Stack:** Svelte 4 + Tailwind + Vite

### Engine Luna
- **`~/.luna-kernel/luna-soul.cjs`** — Orquestrador, processa mensagens, Plan Mode, tools
- **`~/.luna-kernel/kimi-bridge.cjs`** — Playwright CDP bridge para Kimi Web
- **`~/.luna-kernel/session-manager.cjs`** — Gerenciamento de sessões
- **`~/.luna-kernel/luna-tools.cjs`** — Ferramentas executadas no PC local

### Controle de Serviços
```bash
bash /home/jhin/NEXO_DASHBOARD_PRO/luna-nexo.sh [start|stop|restart|status|logs]
```

### O que editar para cada mudança
| Mudança | Arquivo |
|---------|---------|
| Rotas API chat/plan/system | `NEXO_DASHBOARD_PRO/backend/luna-chat-routes.js` |
| Lógica de processamento, modos, limites | `~/.luna-kernel/luna-soul.cjs` |
| Bridge, timeouts, extração DOM | `~/.luna-kernel/kimi-bridge.cjs` |
| Componentes UI | `~/.luna-kernel/luna-web/src/components/*.svelte` |
| API client frontend | `~/.luna-kernel/luna-web/src/api.js` |
| Stores Svelte | `~/.luna-kernel/luna-web/src/stores.js` |
| Tema CSS | `~/.luna-kernel/luna-web/src/app.css` |

### Fluxo pós-edição
```bash
# 1. Edite o frontend
# 2. Build
cd ~/.luna-kernel/luna-web && npm run build
# 3. Reinicie os serviços
bash /home/jhin/NEXO_DASHBOARD_PRO/luna-nexo.sh restart
```

### Documentação completa
→ Veja `/home/jhin/NEXO_DASHBOARD_PRO/AGENTS.md` para documentação completa do projeto.
