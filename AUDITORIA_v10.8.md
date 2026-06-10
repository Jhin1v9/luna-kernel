# 🔴 AUDITORIA FORENSE COMPLETA — Luna v10.8

**Data:** 2026-06-10  
**Escopo:** luna-soul.cjs, kimi-bridge.cjs, luna-chat-routes.js, ChatArea.svelte, luna-extension/injected.js

---

## RESUMO EXECUTIVO

Foram identificados **35+ bugs** distribuídos em 4 camadas. Destes, **8 são CRÍTICOS** (causam travamento, perda de eventos, ou execução dupla), **12 são ALTOS** (causam comportamento incorreto ou degradam UX), e o restante é MÉDIO/BAIXO.

| Camada | Críticos | Altos | Médios | Baixos |
|--------|---------|-------|--------|--------|
| luna-soul.cjs | 5 | 7 | 5 | 2 |
| kimi-bridge.cjs | 3 | 4 | 4 | 1 |
| luna-chat-routes.js | 1 | 2 | 1 | 0 |
| ChatArea.svelte | 0 | 2 | 2 | 1 |

---

## 🚨 CRÍTICO — luna-soul.cjs

### C1. `_handleAction` sem timeout no DOM mirror = deadlock eterno
- **Local:** Linhas 2163-2171
- **Problema:** Se `_handleAction` (ou a tool que ela chama) entrar em deadlock, `actionDone` nunca vira `true`. O `while (!actionDone)` roda para sempre.
- **Fix:** `Promise.race(actionPromise, sleep(MAX_ACTION_TIME))`

### C2. Hashes de deduplicação divergentes (DOM mirror vs parser)
- **Local:** Linhas 2136-2137, 2786-2788
- **Problema:** `JSON.stringify` é sensível à ordem das chaves. Se DOM mirror e parser extraírem o mesmo tool mas com chaves em ordem diferente, os hashes SHA256 divergem.
- **Fix:** Normalizar params (sortKeys recursivo, remover undefined) antes de hashear.

### C3. Phantom events (`yield` sem `type`)
- **Local:** Linhas 2711, 2748, 2755
- **Problema:** `yield actionResult;`, `yield metaResult;`, `yield suggestResult;` — objetos sem campo `type`. O backend filtra por `type`, então são invisíveis.
- **Fix:** Adicionar `type` ou remover o `yield`.

### C4. `result` não-objeto crasha em `.success`
- **Local:** Linha 3728
- **Problema:** `if (result.success && ...)` — se tool retornar `null`/`undefined`/`string`, `TypeError`.
- **Fix:** `if (result && typeof result === 'object' && result.success && ...)`

### C5. `hasOutput` trata string vazia como "sem output"
- **Local:** Linha 2384
- **Problema:** `const hasOutput = result.output || domActionResults.length > 0;` — se tool retornar `""`, `hasOutput` é `false`.
- **Fix:** `result.output != null && result.output !== ''`

### C6. `MAX_LOOPS = Number.MAX_SAFE_INTEGER` = OOM em loop adversarial
- **Local:** Linha 2020
- **Problema:** Sem limite de tempo real. Kimi pode ficar em loop ACTION→result→ACTION.
- **Fix:** Adicionar `MAX_WALL_TIME_MS = 10*60*1000` e `Date.now() - loopStart > MAX_WALL_TIME`.

### C7. Crash recovery: após 3 falhas do bridge, entra em loop de erro infinito
- **Local:** Linhas 2272-2329
- **Problema:** Se Chrome/bridge estiver permanentemente morto, o agente fica em loop eterno de rebuild+retry.
- **Fix:** Contador global de erros consecutivos. Após N, `return` fatal.

### C8. `_markActionExecuted` nunca limpa cache antigo
- **Local:** Linhas 1512-1517
- **Problema:** Map cresce indefinidamente. Memory leak lento.
- **Fix:** Deletar entradas com TTL expirado ao inserir novas.

---

## 🔴 ALTO — luna-soul.cjs

### A1. `_processModeStream` não suporta modo `SCRIPT`
- **Local:** Linha 2682
- **Problema:** `_processModeResult` tem case SCRIPT, mas `_processModeStream` não. Cai no `default`.

### A2. `processPlanModeStream` usa await síncrono em `action_detected`
- **Local:** Linhas 2554-2567
- **Problema:** Tool é `await`ada diretamente. Se demorar 30s, o generator não emite nada. Frontend parece congelado.

### A3. `for await (const event of stream)` não tem `default` case
- **Local:** Linhas 2044-2232
- **Problema:** Eventos desconhecidos são silenciosamente ignorados.

### A4. `_buildCompactSummary` ignora eventos de erro e sistema
- **Local:** Linhas 1708-1741
- **Problema:** Após compactação, Kimi perde histórico de erros. Pode repetir ações que já falharam.

### A5. `_autoCompact` trunca em 999 eventos sem aviso
- **Local:** Linha 1666
- **Problema:** Contexto crítico desaparece silenciosamente.

### A6. Path Traversal: `params.path` pode ser array
- **Local:** Linha 3392
- **Problema:** `path.resolve(params.path)` throwa `TypeError` se `params.path` for array.

### A7. Path Traversal só verifica `params.path`, ignora `source`/`destination`/`from`/`to`
- **Local:** Linha 3391
- **Problema:** `moveFile`, `copyFile` não são validados.

---

## 🚨 CRÍTICO — kimi-bridge.cjs

### C1. Perda de eventos DOM (Multi-User Race)
- **Local:** `_consumeExtensionEvents()` (linha 4120)
- **Problema:** Consome TODOS os buffers de TODAS as sessões. Em multi-user, o primeiro poller rouba os eventos de todos.
- **Fix:** Filtrar por `userId` — cada poller consome APENAS seu buffer.

### C2. Loop infinito no DOM Verification Mode
- **Local:** Linhas 6419-6488
- **Problema:** Se `_extractResponseDiff()` throwar consistentemente, `isComplete` NUNCA é setado. Loop `while (!isComplete)` continua para sempre.
- **Fix:** Contador de falhas consecutivas. Após N, forçar `isComplete = true`.

### C3. Poller nunca para — Memory Leak + CPU contínua
- **Local:** `_startDomPoller()` (linha 4232)
- **Problema:** Poller só para se página fechar ou `_stopDomPoller()` for chamado. Acumula CPU/memory indefinidamente.
- **Fix:** Parar após X minutos sem `session.processing = true`.

---

## 🔴 ALTO — kimi-bridge.cjs

### A1. Respostas perdidas quando DOM shrinka
- **Local:** Linhas 6269-6327
- **Problema:** Quando `r.length < lastResponse.length`, o conteúdo anterior que desapareceu NÃO é recuperado.
- **Fix:** Salvar conteúdo anterior e tentar reconciliar.

### A2. JSON Accumulator pode perder conteúdo
- **Local:** Linhas 6274-6306, 6502
- **Problema:** Se JSON nunca fica completo (stream interrompido), conteúdo acumulado é descartado.

### A3. Mudança de chat (nova thread) NÃO detectada
- **Local:** Geral
- **Problema:** Nunca há verificação de URL durante streaming. `preSendSnapshot` fica desatualizado.

### A4. `_pollThinkingAndResponse` bypassa `_enqueueDomEvent`
- **Local:** Linhas 4932-4956
- **Problema:** Tools detectadas são enfileiradas diretamente via `queue.events.push()` em vez de `_enqueueDomEvent()`. Não aplica filtros nem trim circular.

---

## 🔴 ALTO — luna-chat-routes.js

### A1. `action_end` deduplicado por `content` vazio
- **Local:** Linha ~541
- **Problema:** Todos os `action_end` para a mesma tool tinham mesmo `dedupKey` porque `content` é vazio.
- **Status:** ✅ CORRIGIDO na v10.8 — agora usa `event.id` no dedupKey.

### A2. Cliente desconecta durante streaming — loop continua consumindo generator
- **Local:** POST /api/chat
- **Problema:** Se cliente fecha SSE, o `for await` continua consumindo o generator até que ele termine. Não há mecanismo de cancelamento.

---

## 🔴 ALTO — ChatArea.svelte

### A1. `action_end` pode não encontrar `lastTool` correspondente
- **Local:** Linha 683
- **Problema:** Se `action_start` foi perdido/descartado, `action_end` não encontra tool card para atualizar.

### A2. `result.result.error` não é mostrado em ToolCard
- **Local:** ToolCard.svelte
- **Problema:** ToolCard só verifica `result.error`, não `result.result.error`.
- **Status:** ✅ CORRIGIDO na v10.8.

---

## 🟡 MÉDIO — Vários arquivos

- `nextToolEventId` counter overflow (luna-soul.cjs)
- SSE Lines cortadas no Network Interceptor (kimi-bridge.cjs)
- Fila de eventos nunca limpa por userId (kimi-bridge.cjs)
- Page crash durante streaming não é recuperado (kimi-bridge.cjs)
- `_checkCompletionCandidate` pode emitir duplicados (kimi-bridge.cjs)
- `STREAM_CANCELLED` ignora cancelamento se houver `domActionResults` (luna-soul.cjs)
- `processMessage` (legado) é caminho abandonado sem manutenção (luna-soul.cjs)

---

## CORREÇÕES APLICADAS NA v10.8

| # | Bug | Arquivo | Status |
|---|-----|---------|--------|
| 1 | Agente parava em erros genéricos do stream | luna-soul.cjs | ✅ CORRIGIDO |
| 2 | Agente parava em falha de compactação | luna-soul.cjs | ✅ CORRIGIDO |
| 3 | `action_end` deduplicado por `content` vazio | luna-chat-routes.js | ✅ CORRIGIDO |
| 4 | Tool events sem `id` no frontend dedup | ChatArea.svelte | ✅ CORRIGIDO |
| 5 | ToolCard não mostrava `result.result.error` | ToolCard.svelte | ✅ CORRIGIDO |
| 6 | `_markActionExecuted` só marcava em sucesso | luna-soul.cjs | ✅ CORRIGIDO |
| 7 | `actionResult` inconsistente no catch | luna-soul.cjs | ✅ CORRIGIDO |
| 8 | `_handlePlanStream` parava em step failure | luna-soul.cjs | ✅ CORRIGIDO |
| 9 | Phantom events em `_handlePlanStream` | luna-soul.cjs | ✅ CORRIGIDO |

---

## CORREÇÕES PENDENTES (PRIORIDADE)

### 🔴 CRÍTICO — Implementar AGORA
1. **DOM Verification infinite loop** (kimi-bridge.cjs) — pode travar o agente
2. **`_consumeExtensionEvents` multi-user race** (kimi-bridge.cjs) — perde eventos
3. **`_handleAction` timeout no DOM mirror** (luna-soul.cjs) — deadlock
4. **Hash normalização** (luna-soul.cjs) — execução dupla

### 🔴 ALTO — Implementar em seguida
5. **DOM shrink content loss** (kimi-bridge.cjs)
6. **Poller never stops** (kimi-bridge.cjs)
7. **`hasOutput` string vazia** (luna-soul.cjs)
8. **`result` não-objeto crash** (luna-soul.cjs)
9. **Wall time limit** (luna-soul.cjs)
10. **Crash recovery circuit breaker** (luna-soul.cjs)
