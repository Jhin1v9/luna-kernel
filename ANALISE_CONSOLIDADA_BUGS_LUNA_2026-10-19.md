# 🔍 ANÁLISE CONSOLIDADA — BUGS DA LUNA (sessão ao vivo 2026-10-19)

> Investigação conduzida com evidência de código real.
> Todo fato aqui foi verificado lendo código no repositório `C:\Users\Abner\Documents\luna-kernel`
> ou com output real de comando executado na máquina do owner. Nada é adivinhação.

---

## 📌 TL;DR — Estado atual

| # | Bug | Status | Causa raiz |
|---|-----|--------|-----------|
| 1 | Tools vazando como texto no WhatsApp | ❌ Aberto | Pipeline WhatsApp separado (formato `{"type":"TOOL_CALL",...}` ≠ protocolo do soul) |
| 2 | toolLoop reenviando histórico gigante | ⚠️ Fix aplicado e **REVERTIDO** (`git checkout`) — código no estado original | `historyLines` sem cap + `statelessHeader` |
| 3 | Loopback de tools morre (resultado não volta pro provider) | ❌ Aberto — **DIAGNÓSTICO FECHADO** | 4 assassinos (K1–K4) |
| 4 | Circuit breaker limitando tools | ❌ Aberto — fix aprovado, não aplicado | `cbCount > 3` no luna-soul.cjs |

---

## 🐛 BUG 1 — Tools vazando no WhatsApp

**Commit suspeito:** `e3ba552` (v15.5 — modo GOAL)
**Arquivos do commit:**
- `apps/dashboard/luna-chat-routes.js` (+18 linhas)
- `apps/dashboard/luna-goal.js` (novo, +261 linhas)

### O que o modo GOAL faz
1. **CLASSIFICADOR** — decide se a msg é "responder" ou "agir"
2. **EXECUTOR** — roda a ação tool a tool
3. **LIVE BRAIN** — loop até `<goal_done/>` ou `GOAL_MAX_TURNS = 8`

### Evidência do vazamento (print do WhatsApp, 17:05)
```
{"type":"TOOL_CALL","tool":"listTools","args":{},"reason":"para obter a lista das ferramentas disponíveis no workspace conforme solicitado"}
```
Esse JSON foi **enviado como mensagem de texto** pro WhatsApp, em vez de executar silenciosamente.

### ⚠️ Fato importante descoberto
O formato `{"type":"TOOL_CALL","tool":...,"args":...}` **NÃO é o protocolo do luna-soul**
(que usa `mode: 'ACTION'`). É um protocolo separado do pipeline `luna-agent`/LunaBrain.
**Conclusão: o vazamento é num pipeline separado** — o handler inbound não está nos arquivos
do luna-kernel (dump seção 6b veio vazia). Precisa caçar no repo `luna-agent`.

### Hipóteses originais (modo GOAL vazando) — parcialmente descartadas
- `parseGoalCommand` regex: `/^\s*\/goal\s+([\s\S]+)$/i` — está correta, só ativa com `/goal` no início
- `session.mode = 'goal'` persiste — mecanismo real, mas o print do WhatsApp mostra protocolo diferente

### Fix proposto (quando o handler for localizado)
Interceptar mensagem que casar com JSON de tool-call → EXECUTAR, nunca encaminhar como texto.

---

## 🐛 BUG 2 — toolLoop reenviando histórico gigante (FIX REVERTIDO)

**Arquivo:** `packages/kernel/luna-soul.cjs`

### Evidência (logs reais, 2026-09-05)
```
[LUNA-PROMPT] kind=toolLoop bytes=592
[LUNA-PROMPT] kind=toolLoop bytes=1910
[LUNA-PROMPT] kind=toolLoop bytes=3545
[LUNA-PROMPT] kind=toolLoop bytes=13710   ← decolou
```

### Causa (código verificado)
1. `toolLoop` template inclui `{{history}}`
2. `history = historyLines.slice(isToolResult ? -12 : ...)` — últimos 12 eventos
3. Cada `tool_result` entra com **output INTEIRO sem cap** (diretriz v13.0)
4. `statelessHeader` gigante adicionado em cima (v14.1)

### Fixes que FORAM aplicados (17:15) e REVERTIDOS (git checkout)
1. Template novo: `[TOOL LOOP]\nSucesso: {{success}}\nResultado: {{toolResult}}...` + dica listTools
2. `interpolateTemplate` sem history/workspaceSnippet/systemContext
3. `statelessHeader` condicionado a `!isToolResult`

**⚠️ O revert aconteceu porque os fixes quebraram o modo CDP** (foram aplicados para todos
os modos; o owner esclareceu que no-history é só pro CDP/Playwright, API stateless fica como está).

### Decreto do owner (18:49)
1. **Circuit breaker: remove total**
2. **Sem cap no resultado** — o fix certo é não reenviar histórico (só a tool atual).
   Exemplo: 2 arquivos de 30KB → com histórico 30+60=90KB; só a tool atual 30+30=60KB.
3. **Auto-compact: aumentar o timeout** (página demora às vezes) em vez de teto de tentativas

### Fix correto (a implementar — diferencia CDP de stateless)
```js
// luna-soul.cjs ~4699
const history = (isToolResult && !isStatelessApi)
  ? ''
  : historyLines.slice(isStatelessApi ? -30 : -10).join('\n');
```

---

## 🐛 BUG 3 — LOOPBACK DE TOOLS: diagnóstico FECHADO (4 assassinos)

**Sintoma:** tool executa (painel esquerdo mostra resultado) mas o resultado **nunca volta
pro provider** — o owner vira "transporte manual" colando resultados no chat.

### 🗺️ Caminho de volta completo (provado no código)

```
MODEL decide tool → extensão detecta no DOM (injected.js)
→ content.js → Service Worker → POST /ext/event
→ luna-extension-handler.cjs → toolExecutor (wired na Soul)
→ SOUL executa → resultado retorna por 2 rotas:
  Rota A (soul): sendMessageStream([TOOL LOOP]) via CDP → digita na página
  Rota B (ext):  fila session.messages → GET /ext/poll → content.js injeta no textarea
```

Arquivos-chave (linhas verificadas):
- `luna-extension-handler.cjs:112` — endpoint `/ext/poll`
- `luna-extension-handler.cjs:240` — `type: 'tool_result'` na fila
- `luna-extension-handler.cjs:271-274` — `tabId: payload.tabId || session.tabId`
- `kimi-bridge.cjs:8542` — `async *sendMessageStream(userId, text, options, provider)`
- `kimi-bridge.cjs:8590` — `const PROCESSING_DRAIN_TIMEOUT_MS = 60_000`

### 💀 K1 — content.js: `stopForwarding()` = morte PERMANENTE
**Arquivo:** `packages/kernel/luna-extension/content.js` (v11.7)

Quando o contexto da extensão invalida (reload do SW, deploy, update):
```js
function stopForwarding() {
  isForwarding = false;   // ← PARA SEMPRE, até reload da página
  ...
}
```
E o `deploy.sh` faz exatamente isso: `chrome.runtime.reload()` via CDP.
Depois: modelo emite tool → injected.js detecta → postMessage →
**content.js descarta em silêncio** (`if (!isForwarding) return`).
**Sintoma do owner: "tem horas que nem executar executa"** ✅ bate

### 💀 K2 — Chrome clampa alarme MV3 pra 30s
**Arquivo:** `packages/kernel/luna-extension/background.js` (v11.6)

```js
chrome.alarms.create('luna-poll', { periodInMinutes: 0.1 }); // 6s? NÃO.
```
Chrome MV3 força mínimo de **30s** em alarmes. Rota B tem latência de até 30s/iteração.
E o `offscreen.js` (WebSocket, latência ~0) é **CÓDIGO MORTO** — background.js nunca chama
`chrome.offscreen.createDocument`. O manifest tem a permissão `offscreen`, mas não é usada.

### 💀 K3 — Lado soul: stream zumbi + drain de 60s + v2ResponseComplete swallow
**Arquivos:** `kimi-bridge.cjs`, `luna-soul.cjs`

1. `PROCESSING_DRAIN_TIMEOUT_MS = 60_000` (bridge:8590): stream zumbi trava o
   `processing flag`; a próxima msg espera até 60s pro force-clear (bridge:8595).
   **Sintoma do owner: "mando msg e ele revive" = esse timeout disparando** ✅ bate
2. `luna_response_complete` handler: cancela o stream imediatamente
   (`PROTOCOL COMPLETION: Cancel stream immediately`). Se `domActionPromises`
   pendentes → o early-return `if (v2ResponseComplete) → yield done; return` pode
   engolir o resultado antes do bloco `hasOutput`.
3. Circuit breaker `cbCount > 3` (soul ~3470) mata o turno.

### 💀 K4 — Guerra da porta 3458
**Evidência (dump de logs):**
- `nexo-dashboard-out.log`: "🔥 NEXO DASHBOARD PRO rodando em http://0.0.0.0:3458"
- `luna-kernel-error.log`: `Error: listen EADDRINUSE: address already in use :::3458`
- `luna-server-error-6.log`: "⚠️ 3 falhas consecutivas. Reiniciando serviços..."

**Owner confirmou (18:38):** o dono da 3458 é a **Luna Web**; o dashboard tem outra porta.
**Sintoma do owner: "funciona uma hora, falha no segundo seguinte"** ✅ bate — a porta
fica trocando de dono.

### Outros achados do dump (fora do escopo, registrados)
- `_poll` dispara a cada ~450ms com DOM serializado em nível INFO → afoga os logs
- `luna-agent` (whatsplay/worker/orchestrator/watchdog) em crash-loop `postgres unreachable`
  a cada ~1.6s — **separado do luna-kernel, não é causa do bug** (owner esclareceu)

---

## 📋 PLANO FINAL DE FIX (5 arquivos)

### 1. content.js (K1 — prioridade máxima)
- Trocar morte permanente por reconexão: retry a cada 5s quando contexto invalidar
- Fallback direto: manifest já tem `http://localhost:*/*` → se SW falhar 2x,
  content.js faz `fetch('http://localhost:3458/ext/event')` direto

### 2. background.js (K2)
- Criar offscreen document de verdade (`chrome.offscreen.createDocument`) → ativa o
  WebSocket do offscreen.js → retorno em ~0ms
- Logar drop de `routeToTab` sem tabId (hoje silencioso)

### 3. luna-soul.cjs + kimi-bridge.cjs (K3 — owner decidiu)
- a) **REMOVER circuit breaker** (`cbCount > 3`) — remove total
- b) toolLoop sem histórico acumulado (só CDP/Playwright; stateless fica como está)
- c) Guard no `v2ResponseComplete`: `domActionResults.length > 0` → feedback + continue, nunca done
- d) `PROCESSING_DRAIN_TIMEOUT_MS` 60s → 10s

### 4. luna-extension-handler.cjs
- Funciona (fila com delivered flag + auto-register no poll v11.8). **Não mexe.**

### 5. Fase 0 (K4)
- nexo-dashboard para a porta própria; **3458 é só do luna-server**

---

## ✅ Critérios de aceite

1. Nova sessão, pedido com 5+ tools diferentes sequenciais → todas executam e voltam sem paste manual
2. Mesma tool + mesmos params 2x → executa 1x (dedup intacto)
3. Reiniciar extensão via deploy.sh mid-sessão → loop sobrevive (reconexão)
4. Log sem `_poll` spam (demotado pra DEBUG)
5. Nenhum "Circuit breaker" nos logs

---

## 📜 Histórico da sessão (audit trail)

| Hora | Evento |
|------|--------|
| 15:57 | Sessão aberta; owner relata tools vazando no WhatsApp após v15.5 |
| 16:12 | Análise do commit e3ba552; hipóteses do modo GOAL |
| 16:15 | Bug 2 identificado: resultado de tool não volta pro provider |
| 16:30 | Decreto: prompt de tool result = só resultado atual + sucesso + dica listTools |
| 17:15 | Fixes 1-3 aplicados no luna-soul.cjs (13 insertions, 12 deletions) |
| 17:18 | Owner esclarece: no-history é pra CDP+Playwright; API stateless fica igual |
| 17:20 | Owner pede pausa: investigar o looping primeiro |
| 17:47 | Fix 3 quebrou tools → `git checkout` reverteu tudo (estado original) |
| 18:12 | Decreto: múltiplas tools sem limite; dedup apenas (mesma tool+params) |
| 18:25 | Análise: circuit breaker, checkAlreadySent, domActionResults zerado |
| 18:30 | Plano de 5 fases montado |
| 18:38 | Owner responde 3 perguntas: 3458=Luna Web; espera sem digitar; extensão primária |
| 18:49 | Decisões: 1) remove breaker total 2) sem cap, só não reenviar histórico 3) timeout maior no autocompact |
| 18:56 | Reprodução ao vivo: echo 123 executa no painel, não volta pro chat (print) |
| 19:00 | Dump de logs: restart do server 17:00:08Z, watchdog stalls de horas, guerra da 3458 |
| 19:25 | Owner envia source da extensão → K1/K2 confirmados no código |
| 19:39 | Diagnóstico fechado: 4 assassinos comprovados |

---

*Documento gerado na sessão de 2026-10-19 — todos os dados verificados em código/output real.*
