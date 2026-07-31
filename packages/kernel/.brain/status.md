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

## VPS session recovery (2026-07-31)

- Un rsync manual con `--delete` sobrescribió `chrome-profile/`, `cookies/kimi-master*.json` y `apps/dashboard/data/luna-chat-sessions.json` del VPS, perdiendo la sesión activa de Kimi y el historial de chats.
- **Sesión de Kimi restaurada** vía login manual del usuario en el VNC (ventana de Chrome estaba minimizada en `Xvfb :1`; se activó con xdotool). Tras el login, `_syncMasterCookiesFromContext` re-escribió `kimi-master-cookies.json` con `kimi-auth` (16 cookies Kimi, savedAt 09:02).
- **Historial de chats** (28 sesiones) reconstruido desde `~/.luna/sessions/web-*/context.jsonl` por `/tmp/rebuild-sessions.py`.
- **Prevención**: `.gitignore` ya excluye `chrome-profile/`, `cookies/` y `apps/dashboard/data/` — el rsync manual debe usar `--exclude` explícito (`rsync -av --exclude chrome-profile/ --exclude cookies/ --exclude apps/dashboard/data/`).
- VNC para login manual: x11vnc `:5901` + websockify `:18445`, noVNC en `https://vps.nexo-digital.app:8445/vnc.html`.

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

- `GET /api/credits/client/:id/profile` — organización + créditos + suscripción + proyectos + contratos + tickets + team users + transacciones recientes (público)
- `GET /api/credits/admin/client/:id/profile` — perfil completo admin, incluye historial completo de créditos y consumo interno del team (staff)
- `POST /api/credits/admin/client/:id/team-usage` — log de consumo interno del team (no descuenta balance del cliente)

### UI integrada (workspace-cliente, Next.js)

- `app/api/credits/profile/route.ts` — proxy al dashboard backend (`/api/credits/client/:orgId/profile`) usando `lib/dashboard-proxy.ts` (Bearer con DASHBOARD_API_KEY)
- `app/[locale]/(dashboard)/perfil/page.tsx` — ahora consume el perfil unificado: nuevas secciones de suscripción (plan, vigencia, auto-renovación, próxima asignación), contratos (con badge de estado) y tickets (con créditos estimados)
- i18n actualizado en pt/en/es con claves: subscription, plan, noSubscription, periodEnd, autoRenew, contracts, tickets, estimatedCredits, creditPlan, nextAssignment
- Backend auth del dashboard usa `nexo-digital-2026` (PM2 env), no el token del .env

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

## Kimi login false-positive fix (2026-07-31, in local main)

- Problema: adjuntar archivos en Luna fallaba con `KIMI_LOGIN_REQUIRED` aunque la sesión estuviera activa.
- Causa: Kimi mantiene nodos de login "fantasma" montados en el DOM (`.login-modal`, inputs ocultos, texto "Google") aunque el chat shell sea visible; `_verifySession`, `sendFile` (checkAndRecoverLogin) y el WebBridge loginCheck usaban `querySelector` genérico sin filtrar visibilidad.
- Fix aplicado en `kimi-bridge.cjs` (commit `307506e`):
  - helper `isVisible` (display/visibility/opacity/getBoundingClientRect) + `firstVisible`.
  - `evalLoggedIn` en `_verifySession`: `loggedIn = hasAppContent && !(hasLoginForm && hasPassword)`, espera SPA 6×500ms antes de declarar logout.
  - `checkAndRecoverLogin` (sendFile): solo declara modal real con password/modal visible.
  - WebBridge `loginCheck`: `hasModal && !hasChat` (el chat shell anula el modal).
  - Verificación pre-navegación en `openChatPage` (isLoggedIn/stillLoggedOut) también es visibility-aware para evitar reloads innecesarios.
- Sincronizado local (commit `307506e`) y aplicado en VPS (pm2 restart `luna-server`, arranque limpio).

## Workspace-nexo: sistema de créditos — role selector + sincronización Prisma (2026-07-31)

Implementado en el VPS (`/root/nexo-workspace-src`, branch `master`, pendiente de commit):

### Creación de org en un solo paso

- **`POST /api/admin/organizations`** crea en cadena: Organization → Project → Contract (plantilla con datos reales del plan, vigencia 12 meses) → WorkspaceUser admin (opcional, bcrypt) → suscripción + créditos iniciales en el dashboard backend (:13500) → **sincronización a Prisma** (`CreditTransaction` tipo `plan` + `WorkspaceUser.credits`).
- Planes: `basico/profesional/premium/enterprise`. `types/admin.ts` actualizado.
- El backend de créditos se invoca con `lib/dashboard-client.ts` (Bearer con DASHBOARD_API_KEY). Errores del dashboard no abortan — se reportan en `warnings`.
- `clientId` del sistema de créditos == `organizationId`.

### Role selector (nuevo 2026-07-31)

- **Ruta**: acepta `adminRole` (ADMIN/MANAGER/MEMBER/VIEWER, default ADMIN). Validación con fallback.
- **UI** (`organizacoes/page.tsx`): `<select>` con opciones ADMIN/MANAGER/MEMBER/VIEWER en el formulario de creación.
- **i18n**: `form.adminRole` en es ("Rol del administrador"), en ("Administrator role"), pt ("Papel do administrador").

### Sincronización Prisma (nuevo 2026-07-31)

- Al crear org con plan y usuario admin, se crea `CreditTransaction` (tipo `plan`, amount = `creditsPerMonth`, userId = adminUser, projectId) y se incrementa `WorkspaceUser.credits` vía `prisma.$transaction`.
- Esto resuelve el problema reportado donde el portal del cliente (`/api/credits/balance`) y `/creditos` admin mostraban saldo 0 porque solo existían los créditos del dashboard backend.
- Test E2E verificado: org premium con adminRole=MANAGER → balance dashboard 2400 + Prisma CreditTransaction plan 2400 + WorkspaceUser.credits 2400 + rol MANAGER.

### Reset de contraseña

- `POST /api/admin/clients/[id]/reset-password` (bcrypt + log `RESET`) + botón/modal en `clientes/[id]`.

### How-to del sistema de créditos

- `apps/dashboard/public/howto.html` — página HTML servida en `https://vps.nexo-digital.app:3500/howto.html`. Cubre planes, suscripciones, créditos, tickets, auto-assign, admin summary, team-usage, ejemplos cURL admin y cliente, flujo de trabajo completo.
- Desplegado en el VPS (`/root/nexo-projects-abner/luna-kernel/apps/dashboard/public/howto.html`).
- Enlace visible añadido en los sidebars de workspace-nexo (admin) y workspace-cliente (cliente) con ícono `HelpCircle`, abre en pestaña nueva.

### Build standalone — static files faltantes (2026-07-31)

- Problema: tras el rebuild, los dashboards de admin y cliente se veían rotos y el cliente mostraba `Loading chunk 3447 failed` en `_next/static/chunks/app/%5Blocale%5D/(dashboard)/layout-...js`.
- Causa: `next build` con `output: 'standalone'` no copió la carpeta `.next/static` al directorio `.next/standalone/apps/<app>/.next/`.
- Solución: copia manual de `.next/static` → `.next/standalone/apps/<app>/.next/static` y reinicio PM2.
- Prevención: añadido script `postbuild` en `package.json` de ambas apps (`workspace-nexo` y `workspace-cliente`) para copiar los estáticos automáticamente tras cada build.

### Dashboard Pro en :3500/:3501 — assets faltantes (2026-07-31)

- Problema: `https://vps.nexo-digital.app:3501/` se quedaba en blanco.
- Causa: `apps/dashboard/public/index.html` referenciaba `assets/index-CZ9uRbAg.js` y `assets/index-Bn4Oj2qG.css`, pero la carpeta `public/assets` no existía (estáticos del frontend NEXO Dashboard Pro no copiados).
- Solución: copiado `NexoDashboard/frontend/dist/*` a `apps/dashboard/public/` (preservando `howto.html`). Ambos puertos (`:3500` y `:3501`) ahora sirven el JS/CSS correctamente.

### Windows local setup (2026-07-31)

- Creado `scripts/setup-windows.ps1` para configurar Luna localmente en Windows:
  - Detecta/instala dependências (npm/pnpm)
  - Procura Chrome/Edge/Chromium e opcionalmente añade al PATH
  - Configura `DATABASE_URL=file:./luna.db` (SQLite) y `PUPPETEER_EXECUTABLE_PATH`
  - Crea `.env` faltante
  - Builda el frontend si no existe `dist`
  - Inicia `luna-server` y hace health check
- Uso: `powershell -ExecutionPolicy Bypass -File scripts/setup-windows.ps1 -ProjectDir "C:\caminho\luna-kernel"`

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
