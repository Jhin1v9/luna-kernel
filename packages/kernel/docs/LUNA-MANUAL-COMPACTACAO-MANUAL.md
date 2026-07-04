# Manual Técnico — Compactação Manual de Contexto no Luna

## 1. Visão Geral

A compactação manual permite ao usuário forçar a criação de um **checkpoint inteligente** quando o contexto da conversa fica grande. Ao clicar no botão de compactação (ícone de caixa/arquivo) no header do chat, o Luna:

1. Resume o histórico local da sessão.
2. Cria uma **nova thread no Kimi Web**.
3. Envia o resumo como primeira mensagem da nova thread.
4. Limpa o contexto local e armazena o checkpoint.
5. Passa a usar a nova thread para as próximas mensagens.

> **Fluxo real sempre pelo frontend Luna.** O usuário interage com a Luna Web, que chama o backend `luna-server`, que por sua vez controla o Chrome isolado via `kimi-bridge`. Nunca envie mensagens diretamente para a UI do Kimi — isso quebra o estado de login e session do Luna.

---

## 2. Componentes e Arquivos

| Componente | Arquivo | Responsabilidade |
|---|---|---|
| Frontend (botão) | `luna-web/src/components/ChatHeader.svelte` | Renderiza o botão, chama `compactSession()`, dispara `compactEvent`. |
| API client | `luna-web/src/api.js` | Função `compactSession()` faz POST SSE para `/api/luna/compact`. |
| Handler de eventos | `luna-web/src/components/ChatArea.svelte` | Escuta `on:compactEvent`, atualiza UI (`compact_start`, `compact_progress`, `compact_end`, `compact_error`). |
| Rota backend | `apps/dashboard/luna-chat-routes.js` | Rota `POST /api/luna/compact`, configura SSE e chama `luna._compactContext()`. |
| Lógica de compactação | `packages/kernel/luna-soul.cjs` | Método `async *_compactContext(sessionId, userId)`. Faz o resumo, `newChat()` e `sendMessageNoWait()`. |
| Bridge do Kimi | `packages/kernel/kimi-bridge.cjs` | `newChat()`, `sendMessageNoWait()`, `_openNewChat()`, `_fillContentEditable()`, `_pressEnterOnInput()`. |
| Config do provider | `packages/kernel/provider-configs/kimi.json` | `modeUrls`, `selectors` (input, sendButton, loginIndicator, appContent). |

---

## 3. Fluxo de Dados (end-to-end)

```
[Usuário clica no botão 🗃️ no header]
        ↓
[ChatHeader.svelte] onCompact()
        ↓
[api.js] compactSession(sessionId, userId, callback)
        ↓ POST /api/luna/compact (SSE)
[luna-chat-routes.js] router.post('/api/luna/compact')
        ↓
[luna-soul.cjs] _compactContext(sessionId, userId)
   ├─ readContext / readRecentEvents
   ├─ _buildCompactSummary(events)
   ├─ kimiBridge.newChat(userId, null, { requireChatUrl: false })
   ├─ kimiBridge.sendMessageNoWait(userId, summary, { mode: 'thinking' })
   ├─ _captureCurrentChatUrl(userId)
   ├─ sessionManager.clearContext(sessionId)
   └─ yield compact_end
        ↓ SSE data: {...}
[api.js] callback(event)
        ↓
[ChatArea.svelte] handleEvent(ev.detail)
        ↓
[UI] Animação de fases da lua + mensagem de sucesso/erro
```

---

## 4. Bugs Corrigidos nesta Sessão

### 4.1 `NEW_CHAT_FAILED` por trailing slash na URL de landing

**Sintoma:** A compactação falhava logo na criação da nova thread:
```
❌ Falha ao criar nova thread: NEW_CHAT_FAILED: Não foi possível criar
uma nova thread válida em kimi (URL: https://www.kimi.com/?chat_enter_method=new_chat)
```

**Causa raiz:** Em `kimi-bridge.cjs` `newChat()`, a verificação de landing page comparava:
```js
newUrl === newChatUrl || newUrl.split('?')[0] === newChatUrl.split('?')[0]
```
O Kimi Web normaliza a URL adicionando trailing slash:
```
newUrl      = "https://www.kimi.com/?chat_enter_method=new_chat"
newChatUrl  = "https://www.kimi.com"
newUrl.split('?')[0]     = "https://www.kimi.com/"
newChatUrl.split('?')[0] = "https://www.kimi.com"
```
Como `"https://www.kimi.com/" !== "https://www.kimi.com"`, o sistema rejeitava a landing page válida.

**Correção:** Adicionadas funções utilitárias `normalizeBaseUrl()` e `isSameLandingPage()` que comparam `origin + pathname` com trailing slash removido, ignorando query e hash.

```js
function normalizeBaseUrl(url) {
  try {
    const u = new URL(url);
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch (e) {
    return url;
  }
}
```

E em `newChat()`:
```js
const isNewChatLanding = isSameLandingPage(newUrl, newChatUrl);
```

**Arquivos alterados:**
- `packages/kernel/kimi-bridge.cjs`

---

### 4.2 Preenchimento do input Lexical no `sendMessageNoWait`

**Sintoma:** Após criar a nova thread, o envio do checkpoint falhava:
```
❌ Checkpoint não enviado: Delivery confirmation timed out.
```

**Causa raiz:** `sendMessageNoWait()` usava `inputLocator.fill()` diretamente. No editor Lexical/contenteditable do Kimi, `fill()` pode inserir texto no DOM sem atualizar o estado interno do editor, fazendo com que o Enter não dispare o envio.

**Correção:** Substituído o preenchimento por `_fillContentEditable()`, que já é usado em `sendMessage()` e é conhecido por funcionar com o Lexical:
```js
await this._fillContentEditable(inputLocator, text);
```

**Arquivos alterados:**
- `packages/kernel/kimi-bridge.cjs`

---

### 4.3 Login perdido e idioma chinês na landing page

**Observação importante:** A landing page `https://www.kimi.com/?chat_enter_method=new_chat` pode perder a sessão de login do Kimi (modal de login aparece ao tentar enviar). A landing page `?chat_enter_method=shortcut` (aberta pelo atalho Ctrl+K) preserva o login, mas abria em chinês (`zh-CN`), quebrando o parsing do Luna.

**Ação tomada:** Atualizado `provider-configs/kimi.json` para usar o path `/en` com `chat_enter_method=shortcut`:

```json
"modeUrls": {
  "instant": "https://www.kimi.com/en?chat_enter_method=shortcut",
  "thinking": "https://www.kimi.com/en?chat_enter_method=shortcut",
  ...
}
```

Isso força a nova thread a abrir em inglês.

**Atenção:** `Ctrl+Shift+R` (hard refresh) na aba do Kimi pode descartar a sessão de login. Evite hard refresh na aba controlada pelo Luna.

**Arquivos alterados:**
- `packages/kernel/provider-configs/kimi.json`

---

### 4.4 Prompt de compactação fraco — Kimi negava tools

**Sintoma:** Após a compactação, a Kimi respondia:
```
As ferramentas que mencionaste (readFile, writeFile, ...) não estão disponíveis para mim.
Não tenho acesso ao sistema de arquivos do teu PC.
```

**Causa raiz:** O checkpoint dizia "Você é Luna" e "Você CONTROLA o computador". A Kimi K2.6 rejeitava essa identidade porque sabe que não é o agente Luna.

**Correção:** O prompt agora explica a arquitetura **Luna Mirror**:
- "Você é Kimi K2.6" — identidade correta.
- "O usuário está te usando através de um agente autônomo chamado LUNA."
- "Quando precisar executar uma ação no PC, responda com um bloco JSON da tool. A LUNA vai LER esse JSON na tela, executar a tool no Linux real e devolver o resultado."
- "Você NÃO precisa ter acesso direto ao PC — a LUNA é seu braço executor."

Exemplo incluído no checkpoint:
```json
{"tool": "readFile", "params": {"path": "/caminho/do/arquivo.txt"}}
```

**Arquivos alterados:**
- `packages/kernel/luna-soul.cjs` (`_buildCompactSummary`)

---

## 5. Como Testar o Fluxo Completo

### 5.1 Teste via frontend Luna (uso humano)

1. Abrir `http://localhost:3458`.
2. Fazer login com as credenciais do NEXO.
3. Selecionar uma sessão de chat existente.
4. No header, clicar no ícone de caixa/arquivo (tooltip "Compactar contexto").
5. Observar a animação de fases da lua.
6. Após a mensagem "✅ Contexto compactado", enviar uma nova mensagem no chat.
7. Verificar no Chrome isolado do Luna que a mensagem foi para a **nova thread** do Kimi.

### 5.2 Teste via API (para automação/debug)

```bash
curl -s -N -H 'Accept: text/event-stream' \
  -H 'Content-Type: application/json' \
  -X POST http://localhost:3458/api/luna/compact \
  -d '{"sessionId":"SEU_SESSION_ID","userId":"luna-default"}'
```

Resposta esperada (SSE):
```
data: {"type":"compact_start",...}
data: {"type":"compact_progress",...}
data: {"type":"compact_progress",...}
data: {"type":"compact_end","chatUrl":"https://www.kimi.com/chat/...",...}
data: {"type":"done","chatUrl":"https://www.kimi.com/chat/..."}
```

---

## 6. Checklist de Debug

Se a compactação falhar, verifique nesta ordem:

1. **O backend está rodando?**
   ```bash
   pm2 status luna-server
   curl -s http://localhost:3458/api/chat/sessions | head -c 200
   ```

2. **A sessão existe?**
   ```bash
   curl -s http://localhost:3458/api/chat/sessions | python3 -m json.tool
   ```

3. **O endpoint retorna SSE?**
   - Deve retornar `Content-Type: text/event-stream`.
   - Se retornar JSON de erro, leia a mensagem.

4. **O Chrome isolado está logado no Kimi?**
   - Verificar `http://localhost:9222` (CDP) ou abrir o Chrome do Luna.
   - Se aparecer modal de login na landing page, o login foi perdido.

5. **Qual URL a nova thread abriu?**
   - Verificar logs: `pm2 logs luna-server --lines 100`.
   - Procurar por `New chat created`, `URL after click`, `chatUrl`.

6. **O input do Kimi está sendo preenchido?**
   - Verificar logs de `sendMessageNoWait`.
   - Se `Delivery confirmation timed out`, o texto não saiu do input.

7. **Há overlay/mask bloqueando cliques?**
   - Sidebar recolhida, modal de login ou tour podem interceptar eventos.

---

## 7. Cuidados Críticos

- **Nunca feche o Chrome principal do usuário.** O Luna usa seu próprio perfil em `~/.luna-kernel/chrome-profile`.
- **Nunca envie mensagens diretamente na UI do Kimi.** Sempre use o frontend Luna ou a API `/api/luna/compact`.
- **Navegar para landing pages pode deslogar.** Prefira criar novas threads a partir de threads existentes logadas, ou use `chat_enter_method=shortcut`.
- **Testes diretos no Chrome devem ser apenas diagnósticos.** Eles podem alterar o estado da página e afetar o Luna.

---

## 8. Teste de Regressão

Após qualquer alteração em `kimi-bridge.cjs` ou `provider-configs/kimi.json`, rode:

```bash
cd /home/jhin/.luna-kernel
node tests/url-landing.test.cjs
```

Este teste valida a normalização de URLs de landing page.

---

## 9. Recomeçar do Zero (emergência)

Se o estado do Chrome ficar inconsistente:

1. Reiniciar o backend:
   ```bash
   pm2 restart luna-server
   ```
2. Verificar se o Chrome isolado ainda está logado.
3. Se necessário, limpar cookies inválidos e refazer login manualmente no Chrome isolado.

---

*Última atualização: 2026-07-04*
