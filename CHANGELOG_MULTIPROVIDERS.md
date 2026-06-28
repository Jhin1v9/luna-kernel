# Changelog — Multi-Provider Support

## 2026-06-28

### FASE 7 — Malformed writeFile JSON recovery
- `luna-soul.cjs`: adicionada **Strategy 3c** em `parseKimiResponse()` para recuperar JSON tools `writeFile` malformados.
  - DeepSeek frequentemente emite `{"tool":"writeFile","params":{"path":"...","content":"<HTML com aspas não-escapadas>"}}`;
  - A nova estratégia detecta essa forma, extrai `path` via regex e `content` entre `"content":"` e o fechamento `"}}`;
  - Reverte escapes literais (`\n`, `\t`, `\r`, `\\`, `\"`) para produzir o arquivo original.
  - Isso dá à Luna uma **estrutura forte**: não depende mais do LLM escapar aspas internas de HTML/código.
- Teste end-to-end via Playwright: pedido "cria um jogo html simples e bonito" gerou arquivo `/home/jhin/.luna-workspace/jogo-teste-parser.html` (6320 bytes) corretamente, modo detectado como `ACTION` e não mais `CHAT`.

### FASE 8 — Parser JSON tolerante com `jsonrepair`
- Adicionada dependência `jsonrepair` ao `package.json`.
- `luna-soul.cjs`: substituída a Strategy 3c customizada por `tolerantJsonParse()`, que tenta `JSON.parse()` e, se falhar, usa `jsonrepair()` para corrigir aspas não escapadas, escapes faltantes, trailing commas e artifacts de markdown (`json\nCopy\nDownload\n{...}`).
- `response-stream-parser.cjs`: `safeJsonParse()` agora também usa `jsonrepair()` como fallback, centralizando a tolerância a JSON malformado.
- `kimi-bridge.cjs`: `tryParseToolJson()` em `_genericProviderExtraction()` agora usa `jsonrepair()` quando `JSON.parse()` falha, permitindo detectar tools `writeFile` com HTML cru mesmo no streaming.
- Testes locais: `jsonrepair` reparou com sucesso JSONs do DeepSeek com HTML não escapado e artifacts `Copy`/`Download`.

### FASE 6 — DeepSeek response cleanup
- `luna-soul.cjs`: `_stripJsonResponseWrapper()` reescrito com scanner de chaves por contagem, removendo wrappers `{"response":"..."}` / `{"message":"..."}` e convertendo objetos stray `{"status":"processed","id":"..."}` em mensagem amigável.
- `kimi-bridge.cjs`: extração genérica `_genericProviderExtraction()` usa contagem de chaves para desembrulhar JSON de forma segura; pre-captura de resposta anterior para providers não-Kimi evita completar prematuramente no texto antigo.
- `luna-web/src/components/ChatArea.svelte`: evento `done` substitui a bolha do assistente pelo `finalResponse` limpo quando o streaming vazou fragmentos de JSON wrapper.
- Build do frontend regerado e deployado no `luna-server`.
- Teste end-to-end via Playwright: mensagens DeepSeek renderizaram corretamente, sem JSON cru, duplicação ou truncamento.

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
