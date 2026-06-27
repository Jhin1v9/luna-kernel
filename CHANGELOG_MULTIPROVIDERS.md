# Changelog — Multi-Provider Support

## 2026-06-26

### FASE 1 — Bridge config-driven
- Adicionado `provider-loader.cjs` para carregar configs de `provider-configs/*.json`.
- Refatorado `kimi-bridge.cjs` para ser provider-aware:
  - `_resolveProvider`, `_providerDomain`, `_modeUrl` e helpers de config.
  - `_getOrCreateUserPage` usa provider da sessão, store ou parâmetro.
  - `_verifySession`, `_injectMasterLocalStorage`, `ensureLogin`, `recoverSession`, `newChat`, `setMode`, `sendMessage`, `sendImage`, `sendFile`, `sendMessageStream`, `anonymousConsult` e `_sendFileViaWebBridge` agora usam URLs/seletores/cookies do provider ativo.
  - Modos `agent`/`swarm` continuam Kimi-only; para outros providers apenas o modo base é armazenado.

### FASE 2 — Frontend provider selector
- `stores.js`: novo store `currentProvider` persistido no `localStorage`.
- `api.js`: `fetchProviders()`, `setSessionProvider()` e `sendMessage()` agora envia `provider`.
- `ChatHeader.svelte`: dropdown de provider integrado ao header (ícone 🌐).
- `ChatArea.svelte`: usa `$currentProvider` e repassa para `sendMessage` e `ChatHeader`.

### FASE 3 — Backend sessão + provider
- Restaurado/criado `config-server.cjs` a partir do backup, com suporte multi-provider:
  - `GET /api/providers` lista providers disponíveis.
  - `POST /api/chat/session` suporta `action: 'setProvider'`.
  - `POST /api/chat` aceita `provider` no body e persiste por sessão.
  - `GET /api/chat/sessions` inclui `provider` na resposta.
- `luna-soul.cjs` repassa `options.provider` para todas as chamadas do bridge (`sendMessage`, `sendMessageStream`, incluindo plan mode e continuation).

### FASE 4 — Extensão Chrome + servidor /ext
- `luna-extension/manifest.json`: adicionados padrões `chat.deepseek.com` e `deepseek.com` em `host_permissions`, `content_scripts` e `web_accessible_resources`.
- `luna-extension/background.js`: `KIMI_URL_PATTERNS` renomeado para `PROVIDER_URL_PATTERNS` e inclui DeepSeek.
- `config-server.cjs`: adicionados endpoints `/ext/register`, `/ext/event` e `/ext/poll` para comunicação com a extensão.

### FASE 5 — Testes
- Build do frontend (`luna-web`) executado com sucesso.
- `node --check` aprovado em todos os arquivos alterados.
- Servidor `config-server.cjs` iniciado em porta alternativa (3459) e endpoint `GET /api/providers` retornou Kimi e DeepSeek corretamente.
- Teste Kimi baseline: servidor conectou ao Chrome, injetou cookies/localStorage e iniciou `sendMessageStream` com provider `kimi`.
- Teste DeepSeek: servidor criou nova página com provider `deepseek` e navegou para `chat.deepseek.com`; login manual é necessário para resposta completa.

### Notas
- Para adicionar novos providers, basta criar `provider-configs/<nome>.json` seguindo o formato existente.
- Cookies e localStorage por provider são lidos de `cookies/<provider>-master-cookies.json` e `cookies/<provider>-master-localstorage.json`.
