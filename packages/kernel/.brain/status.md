# Status

> Living document — current state only, no history. Read together with `decisions.md` and `bugs.md`.

## What Luna is

Luna is an autonomous "mirror" agent: reasoning happens inside the Kimi or DeepSeek web apps, driven through a real Chrome via CDP (:9222) by `kimi-bridge.cjs`. Luna (`luna-soul.cjs`) parses the model's JSON tool blocks and executes them on a real Linux PC — files, shell, git, dashboards — then feeds the results back for the next turn. The model never executes anything directly; Luna is the executor.

## Working

- **Web chat UI** on :3458 (`luna-server`, `apps/dashboard/luna-server.js`) with the Vite dev server on :5173.
- **Context compaction** — automatic on Kimi's context-limit notice (web + Telegram): the soul compacts via `_compactContext` and resends the original message in the new thread, one-shot per user message (Wave 10, supersedes the 2026-07-04 manual-only decision). Manual trigger remains: header button / `/compactar` → `POST /api/luna/compact` in `apps/dashboard/luna-chat-routes.js:2061` (mounted by `luna-server.js`); `packages/kernel/luna-api-server.cjs` is only a legacy stub that simulates it.
- **Telegram pipeline** — `_telegramPipeline` in `luna-soul.cjs`: intent classification → dashboard tool registry → telegram-assistant persona formatting. Runs as the `luna-telegram-adapter` pm2 process (owner's PC only).
- **Plan mode ("Detective Mode")** — multi-turn read-only investigation loop in the backend, ending in an Approve/Reject/Revise plan card.
- **Multi-provider** — Kimi + DeepSeek via `packages/kernel/provider-configs/*.json` (modes: instant/thinking; agent/swarm removed in Wave 7).
- **Dashboard audit log + trash** — commit c51561e: `/api/audit-log`, `/audit-log/trash`, `/audit-log/undo-last`, `/audit-log/restore/:id`, with undo/restore available from Telegram.
- **Living-memory automation** — `.githooks/post-commit` queues every commit and kicks `scripts/luna-brain-sync.sh` detached in the background (flock-serialized); the sync drains the queue via `kimi -p`, updates `.brain/` and auto-commits with the `[brain-sync]` marker, which the hook skips (anti-loop). (commits 71a5740, hardened 81d0158, auto-drain added 2026-07-13)

## Known broken / risky

See `bugs.md`. Currently empty by the owner's decision (2026-07-11): old audits are unreliable, so bugs will be registered manually after verification against the code.

## Current focus

Dashboard: **Sistema de créditos unificado** — integrado con modelos Prisma existentes (Organization, Project, Contract, WorkspaceUser, CreditTransaction).

### Credit system (local, working)

- Migración `016-credit-system.sql`: 5 tablas raw (credit_plans, client_credits, credit_transactions, client_subscriptions, service_tickets)
- `datastore-pg.js`: métodos CRUD + nuevas queries Prisma-compatibles (getPrismaOrganization, getPrismaProjectsByOrg, getPrismaContractsByOrg, getPrismaRequestsByOrg, getPrismaWorkspaceUsersByOrg, getPrismaTeamMembersByProject, getPrismaCreditTransactions)
- `routes/credits.js`: endpoints públicos (plans, balance, transactions, history, perfil cliente) + admin (summary, adjust, auto-assign, perfil completo con edición, team-usage logging)
- `routes/service-tickets.js`: CRUD, cotizar, aprobar con reserva automática
- `server.js`: integración con separación auth pública/admin
- Test end-to-end validado: suscripción → asignar → ticket → cotizar → aprobar → historial

### Perfil unificado

- `GET /api/credits/client/:id/profile` — organización + créditos + suscripción + proyectos + contratos + tickets + team users + transacciones recientes
- `GET /api/credits/admin/client/:id/profile` — perfil completo admin, incluye historial completo de créditos y consumo interno del team (staff)
- `POST /api/credits/admin/client/:id/team-usage` — log de consumo interno del team (no descuenta balance del cliente)

### Nexo persona

- `personas/nexo-assistant.json` + `personas/nexo.md` con prompt limpio
- `luna-soul.cjs:2387`: auto-detección de nexo.md → persona 'nexo'

### Kimi DOM fixes applied on VPS (not yet in local main)

- `_pollThinkingAndResponse`: fallback `.markdown-container .markdown`
- DomPoller: no se detiene en context limit
- `_openNewChat`: wait 5s for `/chat/` URL
- `_detectActualMode`: full DOM scan, 5 selectores + URL fallback
- `setMode`: text scan + page.evaluate + URL navigation + localStorage override
- `_stripThinkingPrefix`: remueve prefijo "Thinking" en modo instant

## How to run (VPS)

`pm2 status` muestra:

- `luna-server` — Luna API + chat backend (:3458)
- `nexo-dashboard-backend` — Dashboard API (:13500)
- Workspace Cliente (Next.js) — puerto 13472, proxea `/api/dashboard/*` → localhost:3456
- Dashboard legacy process — PID 191762, puerto 3456 (proceso viejo, no en PM2)
- Caddy proxy inverso en puertos 3472 y 3601

## Repos

- `luna-kernel` (VPS): `/root/nexo-projects-abner/luna-kernel/`, branch `main`, commit `bf59316`
- `nexo-workspace-src`: Prisma schema en `/root/nexo-workspace-src/packages/shared-domain/prisma/schema.prisma`
