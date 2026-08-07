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

### Correção Windows + stubs de guarda (2026-08-01)

- Regressão do commit `355570e` revertida: `lib/path-guard.cjs` e `luna-tool-guard.cjs` restaurados com funcionalidade completa (path traversal, retry, circuit breaker, idempotency, checksum, schema validation).
- `lib/path-guard.cjs` agora cross-platform: `realpathKernel` usa `path.resolve`/`path.sep`, permitindo validação de paths no Windows sem quebrar.
- `luna-tools.cjs`: correção das strings de caminho do Git Bash (escapes) + conversão MSYS para scripts bash no Windows.
- Testes `wave3-guard-tools.test.cjs`: 104/104 passando no Windows (após skip de testes Unix-only: modo de arquivo e symlink sem privilégios de admin).
- Detecção de Chrome no Windows: `bridge-libs/chrome-launcher.cjs` e `kimi-bridge.cjs` agora priorizam `PUPPETEER_EXECUTABLE_PATH` / `CHROME_EXECUTABLE_PATH` / `LUNA_CHROME_PATH`, incluem caminhos padrão do Chrome/Edge no Windows e usam `path.isAbsolute` + `where`/`which` conforme a plataforma. Isso permite o lazy-connect do Kimi Bridge iniciar o Chrome localmente no Windows sem depender dele já estar rodando com `--remote-debugging-port`.

### Kimi DOM fixes + resposta duplicada + thread de tool (2026-08-01)

- `kimi-bridge.cjs`: extração DOM (`_pollThinkingAndResponse` e `_extractResponse`) agora evita duplicar texto quando a Kimi renderiza um JSON `{"response": "..."}` tanto no code block quanto como prose adjacente. `rawResponsePreview` passou a mostrar a resposta uma única vez.
- `luna-soul.cjs`: continuações de tool não abrem mais um novo chat Kimi. `forceNewChat` só é verdadeiro na primeira iteração do auto-continue loop (`safety === 1`); reenviar o resultado de uma tool mantém a mesma thread.
- `kimi-dom-observer.js` / `_extractToolMirrorFromDOM`: previews de thinking (`Think`, `Thinking`, `Pensando`, `Analisando`) são descartados para não serem interpretados como `executeShell`.
- Healthcheck: `apps/dashboard/luna-server.js` é o entrypoint correto no Windows (resolve dependências do workspace pnpm); processos Node antigos são mortos antes do restart para evitar `EADDRINUSE`.
- Testes end-to-end validados via curl/SSE: mensagem `oi` devolve `thinking_start` → `thinking_delta` → `response_delta` → `assistant` → `done` sem duplicação; `execute o comando dir` executa `ls -la` e mantém a mesma thread.

### Admin mode + gate de confirmação para operações destrutivas (2026-08-01)

- `config/luna-config.js`: novo flag `adminMode` carregado de `path-guard.json` ou via `LUNA_ADMIN_MODE=true` no `.env`. Quando ativo, o path guard é desabilitado e a Luna pode ler/escrever em qualquer diretório.
- `luna-soul.cjs`: honra `adminMode` no loop de path guard; operações destrutivas ainda exigem confirmação via `isDestructive()`.
- `.env.example`: documenta `LUNA_ADMIN_MODE`.
- v11.8-fix: `LUNA_ADMIN_MODE=true` ativado em `packages/kernel/.env`; `luna-server` reiniciado com `--update-env`. Path guard desabilitado para leitura/escrita em qualquer diretório; deletes/comandos destrutivos ainda passam pelo gate de confirmação no frontend.
- Opção A do gate: somente deletes explícitos (`deleteFile`, `removeDirectory`, `dashboardDelete*`) e comandos/scripts claramente destrutivos (`rm -rf`, `git reset --hard`, `mkfs`, etc.) exigem confirmação; todo o restante executa sem interromper o usuário.
- `luna-soul.cjs`: `pendingConfirmations`, `isDestructive()`, `_requestConfirmation()`, `confirmAction()`. A partir da v11.8 a confirmação espera indefinidamente pelo usuário — não há mais timeout de 5 minutos.
- O evento `confirmation_required` flui pelo `EventBus` do turno (`_processModeResult`) e é persistido/drenado pelo SSE; `action_start` carrega `toolInstanceId` para que o frontend mapeie o card correto.
- `apps/dashboard/luna-chat-routes.js`: endpoint `POST /api/luna/confirm` resolve a confirmação pendente.
- `luna-web/src/api.js`: `confirmToolAction(sessionId, confirmationId, action)`.
- `ToolCard.svelte` renderiza botões Confirmar/Cancelar quando `status === 'awaiting_confirmation'`.
- Testes `wave3-guard-tools.test.cjs`: seção Fix J (J1–J6) cobre classificação e ciclo confirm/cancel.

### Frontend: thinking bubble persistente + comando `luna` unificado (2026-08-02)

- `luna-web/src/components/ChatArea.svelte`: thinking bubble não é mais removido em `response_detected` nem em `done`. O raciocínio da Kimi continua visível ao lado da resposta final. A partir da v11.8, `thinking_start` também não remove mais bubbles anteriores dentro do mesmo turno: cada raciocínio (inclusive entre tools consecutivas) persiste como um bubble próprio, igual a um card de tool. Bubbles só são limpos quando o usuário envia uma nova mensagem.
- `luna-web/src/components/ToolCard.svelte`:
  - **v11.8 fix:** `friendlyMessage` não é mais renderizado como erro; detecta se indica sucesso (verde) ou falha (vermelho) por regex de emoji/palavras.
  - **v11.8 fix:** output de tool com sucesso fica com fundo verde (`output-success`); output com falha fica com fundo vermelho (`output-error`).
  - **v11.8 fix:** code fences (`\`\`\``) são removidos do output e do `friendlyMessage` para não vazar no frontend.
- **v11.8 fix:** thinking agora usa a mesma tecnologia do response. O `kimi-bridge.cjs` diffa o texto completo do raciocínio da Kimi com um cursor per-source (`stream-text-cursor.cjs`) e emite `thinking_delta` limpo, em vez de `thinking_update` snapshot. Isso resolve o bug onde o primeiro thinking era "engolido" pelo Phase 0 e o bubble "Pensando" ficava vazio. Relatório em `.brain/reports/2026-08-02-thinking-cursor-source-of-truth.md`.
- Build do `luna-web` regenerado e `luna-server` reiniciado via PM2 ecosystem no Windows.
- Comando `luna` unificado e corrigido:
  - `C:\Users\Abner\bin\luna.bat` (cmd) e `C:\Users\Abner\bin\luna` (Git Bash) apontam para `C:\Users\Abner\Documents\luna-kernel`.
  - `luna.bat` usa `call pm2.cmd` para evitar que o batch morra ao chamar outro arquivo `.cmd`.
  - Sobe/reinicia apenas os processos essenciais locais: `luna-server`, `nexo-dashboard` e `luna-health-watchdog`.
  - Remove `luna-telegram-adapter` (falha sem `TELEGRAM_BOT_TOKEN`) e `luna-vite` (dev server, nao necessario) para evitar janelas de CMD abrindo/fechando em loop.
  - `luna.cmd` quebrado (apontava para `luna-kernel-main`) e `luna.ps1` (abria terminais separados) foram removidos.

### Compactação manual unificada com a automática (2026-08-02)

- `luna-soul.cjs`: novo método `_runCompactFlow` é a source of truth única para compactação (automática no `context_limit` e manual via botão/`/compactar`).
- `compactAndContinue(sessionId, userId)`: entrypoint da manual. Pega a última mensagem do usuário, compacta, cria novo chat na Kimi, liga a sessão da Luna ao novo chat e CONTINUA o fluxo reenviando a mensagem — exatamente como a automática.
- `_compactContext` agora garante conexão com o Kimi Bridge antes de criar nova thread e aguarda 2s após enviar o checkpoint para capturar a URL final correta.
- Endpoint `POST /api/luna/compact` em `apps/dashboard/luna-chat-routes.js` agora chama `compactAndContinue` e devolve o SSE contínuo (compactação + resposta da Kimi), em vez de parar em `done` imediatamente.

### Detecção multilíngue de context limit + SO/workspace em todo turno (2026-08-02)

- `luna-soul.cjs`: `_buildContext` injeta `{{systemContext}}` (SO, shell padrão e workspace ativo) nos templates `followUp` e `toolLoop`, não só no `firstMessage`, para que a Kimi saiba se está em Windows/Git Bash ou Linux e qual é o workspace da sessão em toda resposta.
- `config/luna-prompt-config.json`: templates `followUp` e `toolLoop` atualizados para renderizar `{{systemContext}}`.
- `kimi-bridge.cjs` (`_isContextLimitResponse`) e `bridge-libs/dom-scripts/poll-dom-structure.js` (`scanPageContextLimit`): regex de context limit agora detecta português (`conversa muito longa`, `contexto limite`, `nova sessão`, `conversaram bastante`, `iniciar um novo chat`), espanhol (`sesión muy larga`, `nueva sesión`) e variações, além do inglês e chinês.
- `tests/wave3-guard-tools.test.cjs`: 110/110 passando no Windows após as correções de path guard.
- v11.8-fix: banner português "Você e o Kimi conversaram bastante. Tente iniciar um novo chat." agora dispara a compactação automática; relatório em `.brain/reports/2026-08-02-context-limit-portuguese-detection.md`.
- `tests/wave10-autocompact.test.cjs`: 22/22 passando. v11.8-fix: regex de context limit refinada para evitar falsos positivos em textos que apenas mencionam "limite de contexto" sem ser um aviso real da Kimi (ex.: "Uma página completamente normal sem nenhum aviso de limite de contexto aqui"). A regex agora exige sinais fortes (`getting too long`, `reached...limit`, `conversaram bastante`, `atingiu o limite`, `iniciar um novo chat`, etc.) e está sincronizada byte-a-byte entre `kimi-bridge.cjs` e `bridge-libs/dom-scripts/poll-dom-structure.js`.

### CMDs fantasmas no Windows (2026-08-02)

- Causa raiz: o módulo `pm2-windows-startup` estava em `errored` e reiniciando sozinho, e o `luna-health-watchdog.js` monitorava `luna-vite:5173` e `nexo-dashboard:3456` — mas `luna-vite` não era iniciado pelo stack local e `nexo-dashboard` estava entrando em loop de restart. A cada ciclo de 30s o watchdog chamava `pm2 restart`, abrindo janelas de CMD.
- `pm2-windows-startup` removido (`pm2 uninstall pm2-windows-startup`).
- `packages/kernel/luna-health-watchdog.js`: monitora apenas `luna-server:3458` e `nexo-dashboard:3456`; removeu `luna-vite`; `execSync` agora usa `stdio: 'pipe'` e `windowsHide: true`.
- `C:\Users\Abner\bin\luna.bat` e `C:\Users\Abner\bin\luna`: definem `LUNA_PORT=3458` e `DASHBOARD_PORT=3456` antes de subir os serviços; `pm2 restart` usa `--update-env`.
- `pm2-ecosystem.config.js` (raiz do monorepo): removeu `luna-vite` e `luna-telegram-adapter` do stack local; `nexo-dashboard` recebe `PORT: 3456`/`DASHBOARD_PORT: 3456`; `luna-health-watchdog` recebe as portas corretas via env.
- Stack reiniciado limpo (`pm2 delete all`, matou processo zumbi na 3458, `pm2 start pm2-ecosystem.config.js`, `pm2 save`). Verificado: `luna-server` na 3458, `nexo-dashboard` na 3456.

## How to run (VPS)

`pm2 status` muestra:

- `luna-server` — Luna API + chat backend (:3458)
- `nexo-dashboard-backend` — Dashboard API (:13500)
- Workspace Cliente (Next.js) — puerto 13472, proxea `/api/dashboard/*` → localhost:3456
- Dashboard legacy process — PID 191762, puerto 3456 (proceso viejo, no en PM2)
- Caddy proxy inverso en puertos 3472 y 3601

### Extensão do Chrome: detecção robusta de thinking + fim do pensamento (2026-08-02)

- `packages/kernel/luna-extension/injected.js` v2.6.1:
  - Usa o `.toolcall-container.thinking-container` da Kimi como fonte única de verdade: texto **dentro** = raciocínio; texto **fora** = resposta/tool.
  - Ignora headers "Think/Thinking/Pensando/Analisando", botões "JSON Copy"/"Copy" e code blocks ao extrair o thinking.
  - Detecta o fim do pensamento quando: container perde `is-expanded`, aparece botão "JSON Copy" dentro dele, aparece code block JSON dentro dele, ou texto real começa a ser renderizado fora do container.
  - Emite `stream_state` (bufferável) com `thinking`/`response`/`isStreaming`; emite `thinking_start` imediato; emite `tool_call_detected` / `tool_response_detected` / `json_block_added` apenas para blocos **fora** do thinking.
  - v11.7-fix: adiciona um `MutationObserver` leve apenas no container de chat para detectar o thinking container no momento em que ele é renderizado.
  - v2.6.1-fix: emite `thinking_update` (bufferável) com o texto **completo** do raciocínio sempre que o thinking muda. A página da Kimi é a source of truth; o evento flui pelo bridge/soul/routes e o frontend **substitui** o conteúdo do bubble, sem depender de delta accumulation nem do cursor de diff — que engolia o primeiro thinking ao coincidir com o seed do Phase 0.
  - v2.5.2-fix: `extractResponse()` ignora nós que **contêm** o thinking container como descendente, evitando que o raciocínio colapsado ("Raciocínio concluído") vaze para o bubble de resposta. Headers em português (`Raciocínio`, `Concluído`, etc.) também são descartados na extração do thinking.
  - v11.8-fix: quando um novo thinking container aparece dentro do mesmo bubble do assistente (ex: antes de uma segunda ou terceira tool), o estado é resetado e emite um novo `thinking_start`, para que cada etapa do raciocínio persista como um bubble próprio.
  - Polling leve a cada 80ms + heartbeat de 600ms; sem MutationObserver pesado no `document.documentElement`.
- `packages/kernel/luna-extension/content.js` v11.8:
  - Aceita `luna_event_batch` do `injected.js`;
  - Enfileira eventos e flui para o background em batch de até 25 eventos ou 80ms, reduzindo drásticamente as chamadas `chrome.runtime.sendMessage`.
  - v11.7-fix: `findInput()` agora procura o input do Kimi dentro do composer (`[class*="chat-input"]`, `[class*="composer"]`, `.input-area`), priorizando `contenteditable` com placeholder e `textarea` com placeholder "Ask" / "Pergunte".
  - v11.7-fix: `injectToolResult()` é async e aguarda até 3s pelo input aparecer; preenche `contenteditable` via execCommand + fallback com Range/Selection; clica no botão de envio com seletores mais robustos.
  - v11.7-fix-ctx: `isExtensionContextValid()` + `stopForwarding()` protegem contra `Extension context invalidated`: cada `chrome.runtime.sendMessage` verifica `chrome.runtime.id` e está envolvido em `try/catch`; se o contexto morrer (reload, disable, SW morto), o content script para de encaminhar eventos silenciosamente e esvazia a fila.
  - v11.8-fix: `clickSendButton()` tenta primeiro enviar com `Enter` no input (mais confiável na UI atual da Kimi); clique no botão é fallback.
- `packages/kernel/luna-extension/background.js` v11.6:
  - Aceita `luna_event_batch` do content script;
  - Repassa cada evento individualmente para `/ext/event` preservando `tabId`/`tabUrl`.
- `apps/dashboard/luna-extension-handler.cjs`:
  - Adicionou `thinking_start` à lista de tipos bufferáveis para a bridge.
- `packages/kernel/kimi-bridge.cjs`:
  - Corrigiu detecção da extensão: exige `window.__lunaDomObserver && window.__lunaObserverVersion` (não mais `__lunaEventQueue`, que pertence ao fallback Playwright).
  - Quando a extensão está presente, desconecta o fallback `__lunaUltraLightObserver` e limpa `__lunaEventQueue` para evitar dois observadores competindo.
  - `_consumeExtensionEvents` agora traduz `thinking_start` para o evento interno da bridge.
- Build do `luna-web` regenerado (`npm run build` no workspace `luna-web`); `luna-server` reiniciado via PM2. A extensão no Chrome deve ser recarregada em `chrome://extensions` → ícone de atualização do Luna Extension. v11.8-fix: build + testes `wave10-autocompact` (22/22) e `wave3-guard-tools` (110/110) passando no Windows após refinamento da regex de context limit.

### Pipeline de eventos em tempo real + sem timeouts (v11.9, 2026-08-03)

Problema: o frontend mostrava apenas a mensagem anterior e o thinking não atualizava. Causas encontradas:

1. **Deduplicação por conteúdo no backend** (`apps/dashboard/lib/chat-event-dedup.cjs`) colapsava `thinking_start`, `thinking_update` e `response_delta` com o mesmo texto.
2. **`messageId` não fluía** do frontend para o backend e de volta, então o filtro anti-stale do frontend não protegia contra eventos atrasados.
3. **Timeouts** no `kimi-bridge.cjs` (`GENERATION_START_TIMEOUT_MS` 5min, `MESSAGE_SAFETY_TIMEOUT_MS` 60min) podiam matar a resposta da Kimi enquanto ela ainda processava.

Correções:

- `apps/dashboard/lib/chat-event-dedup.cjs`: dedup agora é por identidade do evento (`ev.id`), nunca por conteúdo.
- `apps/dashboard/luna-chat-routes.js`: persiste todos os eventos do stream; adiciona `messageId` em cada evento antes de persistir/encaminhar.
- `packages/kernel/kimi-bridge.cjs`: removeu `GENERATION_START_TIMEOUT_MS` e `MESSAGE_SAFETY_TIMEOUT_MS`. A Luna agora espera a Kimi responder indefinidamente (o usuário pode cancelar com nova mensagem/botão).
- `packages/kernel/luna-web/src/components/ChatArea.svelte`: `getEventHash` deduplica por `event.id` quando existe; fallback usa timestamp+seq único, evitando colisões por conteúdo igual.
- `apps/dashboard/tests/wave1-chat-routes.test.cjs`: atualizado para refletir dedup por id.
- Commit local `51fb62a` salva o checkpoint.

Validação:

- `node --test apps/dashboard/tests/wave1-chat-routes.test.cjs`: 7/7 passando.
- Build do `luna-web` sucesso.
- `luna` reiniciou `luna-server` na :3458.

Pendente de validação manual: recarregar a extensão no Chrome e enviar uma mensagem na Luna Web para confirmar que thinking, resposta e tools espelham a Kimi em tempo real.
