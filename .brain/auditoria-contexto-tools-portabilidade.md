# Auditoria Técnica — Luna Kernel v10.32

> Data: 2026-07-03
> Escopo: mecanismo de compactação de contexto, execução de tools, fluxo Playwright, portabilidade, install.sh e comando `luna`.
> Status: **análise concluída — nenhum arquivo modificado**

---

## 1. Resumo executivo

Foram identificados **bugs ativos no mecanismo de compactação de contexto**, **brechas de concorrência na execução de tools**, **dezenas de caminhos/URLs/portas hardcoded** que impedem a Luna de funcionar em outro sistema, e **falhas críticas de portabilidade e segurança** no `install.sh` e no comando `luna`.

Os problemas mais graves são:

1. **Compactação automática ainda ativa** apesar do design spec dizer o contrário (`_autoCompact` é chamado automaticamente em 3 lugares).
2. **Rota manual `/api/luna/compact` chama método inexistente** (`_autoCompact` foi renomeado no spec para `_compactContext`, mas o código ainda usa o antigo).
3. **`KIMI_MODE_URLS` não existe no escopo global** — modo `agent`/`swarm` gera `ReferenceError`.
4. **`_saveChatUrl` só aceita URLs com `/chat/`** — provedores como DeepSeek (`/c/...`) nunca persistem thread.
5. **Senha sudo hardcoded** no launcher `~/.local/bin/luna`.
6. **Paths absolutos `/home/jhin/...`** em `pm2-ecosystem.config.js` e outros arquivos.
7. **Execução duplicada de tools** por deduplicação baseada em cache pós-execução.
8. **Lock `processing` não atômico** permite streams concorrentes no mesmo `userId`.
9. **Injeção de comandos shell** em `executeShellVisible` e outras tools.
10. **`install.sh` não instala o comando `luna` nem inicia os servidores** necessários.

---

## 2. Bugs no mecanismo de compactação de contexto

### 2.1 Compactação automática ainda não foi removida

Apesar do design spec `docs/superpowers/specs/2026-06-20-luna-manual-context-compaction-design.md` afirmar que a compactação deve ser 100% manual, o código atual ainda compacta automaticamente em **3 lugares**:

| Local | Comportamento |
|-------|---------------|
| `luna-soul.cjs:2416-2422` | `_shouldCompact(sessionId)` chamado antes de enviar mensagem; se true, chama `_autoCompact`. |
| `luna-soul.cjs:2551-2567` | Evento `context_limit` do Kimi dispara `_autoCompact` e continua o loop. |
| `luna-soul.cjs:2693-2711` | Regex fallback detecta frases de "contexto longo" e dispara `_autoCompact`. |

**Impacto:** o usuário perde controle manual. Compactações inesperadas podem ocorrer no meio de uma resposta, quebrando o fluxo.

**Correção:**
- Remover as 3 chamadas automáticas.
- No `context_limit`, emitir mensagem pedindo para o usuário clicar em **Compactar**.
- Implementar método único `_compactContext` e atualizar todos os call sites.

### 2.2 Rota manual chama método inexistente

`NEXO_DASHBOARD_PRO/backend/luna-chat-routes.js:1934`:

```js
const stream = luna._autoCompact(sessionId, uid);
```

O design spec propõe renomear para `_compactContext`, mas isso **não foi implementado**. Se o botão **Compactar** for clicado, pode ocorrer `TypeError: luna._autoCompact is not a function`.

**Correção:**
```js
const stream = luna._compactContext(sessionId, uid);
```

### 2.3 Helpers `_clearChatUrl` e `_captureCurrentChatUrl` não existem

O design spec exige esses helpers em `kimi-bridge.cjs`, mas eles **não foram implementados**. O `_autoCompact` atual faz uma captura manual de URL dentro do próprio método (`luna-soul.cjs:1871-1882`), o que é frágil.

**Impacto:** se `newChat` redirecionar para `/chat/<id>` depois do checkpoint, a URL capturada pode ser a antiga. A próxima mensagem do usuário pode ir para a thread exausta.

### 2.4 `sendMessage` usado para enviar checkpoint (bloqueia 60s)

`luna-soul.cjs:1850`:

```js
sendResult = await Promise.race([
  this.kimiBridge.sendMessage(userId, summary, { mode: 'thinking' }),
  new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout ao enviar checkpoint (60s)')), 60000))
]);
```

`sendMessage` espera a resposta completa do Kimi. Se o Kimi estiver lento, o timeout de 60s dispara e a compactação falha.

**Correção:** implementar `sendMessageNoWait` (já especificado no design doc) que confirma apenas o envio, sem esperar resposta.

### 2.5 `finally` de `_autoCompact` quebra invariante do stream pai

`luna-soul.cjs:1916-1925`:

```js
if (bridgeSession && wasProcessing && checkpointSent) {
  bridgeSession.processing = wasProcessing;
} else if (bridgeSession && wasProcessing) {
  bridgeSession.processing = false;
}
```

Se o checkpoint falhar, `processing` é forçado para `false`. Isso evita deadlock, mas permite que outra requisição entre no meio da recuperação, causando corrida.

### 2.6 URL mismatch frágil após compactação

`kimi-bridge.cjs:3550`:

```js
if (!isAgentOrSwarm && session.chatUrl && !currentUrl.includes(session.chatUrl.split('?')[0].split('/').pop())) {
```

Se `session.chatUrl` for a landing page `https://www.kimi.com/?...`, `.split('/').pop()` retorna string vazia, e `currentUrl.includes('')` é sempre `true`. O bridge **nunca corrige** se estiver na página errada.

### 2.7 `_saveChatUrl` só aceita `/chat/`

`kimi-bridge.cjs:917-918`:

```js
const isValid = url && url.includes('/chat/');
if (!isValid) { ...return; }
```

DeepSeek usa `/c/...`, outros provedores podem usar `/t/...` ou `/conversation/...`. Esses URLs nunca são persistidos.

### 2.8 Checkpoint prompt fraco

`_buildCompactSummary` (`luna-soul.cjs:2057-`) não inclui o bloco de identidade e autoridade de tools proposto no design spec. Após compactação, o Kimi frequentemente responde "não tenho acesso ao PC".

---

## 3. Brechas nas execuções das tools

### 3.1 Execução duplicada por deduplicação pós-execução

`luna-soul.cjs:2508-2517` — `_getRecentActionResult` só retorna cache **depois** que `_executeActionAsync` terminou e chamou `_markActionExecuted`. Se o Kimi reenviar a mesma tool enquanto a primeira ainda executa, uma segunda execução paralela é iniciada.

**Impacto real:** `writeFile`, `executeShell`, `deleteFile` e operações de dashboard podem rodar duas vezes.

### 3.2 Lock `processing` não atômico

`kimi-bridge.cjs:3498-3504`:

```js
if (session.processing) {
  while (session.processing) {
    await new Promise(r => setTimeout(r, 500));
  }
}
```

Duas chamadas simultâneas podem ler `processing === false` ao mesmo tempo e ambas entrar no stream, causando corrida na página do Playwright.

### 3.3 Cache de falhas inconsistente

- `_processModeResult` (`luna-soul.cjs:3439-3442`) só marca cache se `actionResult?.success` for true.
- `_executeActionAsync` (`luna-soul.cjs:4067-4078`) sempre marca cache, inclusive com erro.

Resultado: uma ação que falha pelo caminho pós-parse pode ser reexecutada; uma ação DOM mirror falha fica bloqueada por 60s.

### 3.4 Loop efetivamente ilimitado

`luna-soul.cjs:2386`:

```js
const MAX_LOOPS = Number.MAX_SAFE_INTEGER; // ILIMITADO — o usuário pediu zero limites
```

`MAX_AUTO_CONTINUES = 3` limita auto-continuações, mas não limita o loop principal. Se o Kimi entrar em padrão `ACTION` repetido, o loop consome memória/CPU indefinidamente.

### 3.5 Resultados nulos/parciais em cancelamento

`luna-soul.cjs:2586-2627` — no handler de `STREAM_CANCELLED`, o código monta mensagem de retorno sem esperar `domActionPromises`. Se as tools ainda estiverem rodando, o resultado parcial ou nulo é enviado ao Kimi.

### 3.6 Hash de deduplicação colide e ignora ordem de chaves

`luna-soul.cjs:2495-2496`:

```js
const toolKey = `${event.action?.tool || event.action?.type || 'unknown'}:${JSON.stringify(event.action?.params || event.action || {})}`;
const toolHash = require('crypto').createHash('sha256').update(toolKey).digest('hex').slice(0, 16);
```

- Truncamento para 64 bits permite colisões.
- `JSON.stringify` não ordena chaves; a mesma ação pode gerar hashes diferentes.
- Campos flat (`tool`, `type`) incluídos no hash de formas diferentes entre bridge e soul.

### 3.7 `_executeActionAsync` sem timeout, retry ou semáforo

`luna-soul.cjs:4043-4083` — uma tool lenta bloqueia indefinidamente. Sem limite de concorrência, várias ações em background saturam recursos.

### 3.8 Path traversal bypassável

`luna-soul.cjs:4182-4189` — a verificação de path traversal só olha `params.path`. Tools como `writeFile`/`moveFile`/`copyFile` aceitam variantes (`filePath`, `source`, `from`, `destination`, `to`). Se o campo ativo for outro, a proteção é bypassada.

---

## 4. Fluxo Playwright e rotas hardcoded

### 4.1 `KIMI_MODE_URLS` não definido

`kimi-bridge.cjs:2547` e `3525` usam `KIMI_MODE_URLS[mode]`, mas a constante **não existe**. Isso gera `ReferenceError` ao tentar usar modo `agent`/`swarm`.

A função correta parece ser `getModeUrls()` (definida em `kimi-bridge.cjs:63`).

### 4.2 Conexão não verifica `browser.isConnected()`

`kimi-bridge.cjs:931-934`:

```js
if (this.browser) {
  this._log('Already connected');
  return this;
}
```

Se o Chrome morrer e o objeto Playwright ainda existir, o bridge acha que está conectado e falha na próxima operação.

### 4.3 CDP ports e URLs hardcoded

- `kimi-bridge.cjs:59` — `CDP_PORTS` fallback `[9222, 9223, 9224, 9225]`.
- `kimi-bridge.cjs:88` — `makeCdpUrl(port)` sempre `http://127.0.0.1:${port}`; não permite Chrome remoto.
- `kimi-bridge.cjs:90` — `getPortFromUrl()` retorna `9222` em qualquer erro de parse.

### 4.4 Chrome profile e executáveis hardcoded

- `kimi-bridge.cjs:3762-3763` — `_ensureChromeProfile()` assume `~/.config/google-chrome`; não funciona no macOS/Windows.
- `kimi-bridge.cjs:3924-3930` — lista fixa de executáveis Chrome; sem variável de ambiente para override.
- `kimi-bridge.cjs:3968` — `DISPLAY: process.env.DISPLAY || ':0'`; em headless/Wayland pode falhar.

### 4.5 `newChat` com `timeout: 0`

`kimi-bridge.cjs:2663`:

```js
await page.goto(newChatUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
```

Se a página travar, a operação nunca retorna.

### 4.6 `recoverSession` com comparação frágil

`kimi-bridge.cjs:1196`:

```js
currentUrl.includes(chatUrl.split('?')[0].split('/').pop())
```

IDs curtos podem dar falso-positivo e recuperar a thread errada.

### 4.7 `sendMessage`/`sendMessageStream` salvam URL antes do redirecionamento

`kimi-bridge.cjs:3540-3543` e `6640-6645` — com `options.newChat`, o bridge faz `goto` para landing page e salva `session.chatUrl = page.url()` imediatamente. Se o provider ainda não redirecionou para `/chat/<id>`, o `chatUrl` salvo é a landing page.

### 4.8 Vazamento de memória no cache de ações

`luna-soul.cjs:1617-1644` — `_executedActionCache` é um `Map` de `Map` que cresce monotonicamente. Mesmo entradas expiradas (TTL 60s) nunca são removidas.

---

## 5. Problemas no install.sh e comando `luna`

### 5.1 `install.sh` não instala o comando `luna`

`install.sh` clona/atualiza `~/.luna-kernel` e roda `npm install`, mas **nunca copia** `~/.local/bin/luna`, cria symlink ou adiciona `~/.local/bin` ao `PATH`.

### 5.2 `install.sh` não inicia servidores

O script só imprime comandos manuais. Não levanta backend, frontend, Chrome CDP nem PostgreSQL.

### 5.3 `install.sh` assume existência de `~/NEXO_DASHBOARD_PRO`

O repositório clonado é `luna-kernel`, mas o fluxo recomendado depende de outro diretório (`NEXO_DASHBOARD_PRO`) que pode não existir na máquina de destino.

### 5.4 Senha sudo hardcoded no launcher

`~/.local/bin/luna:70`:

```bash
SUDO_PWD="anateamo"
echo "$SUDO_PWD" | sudo -S systemctl start postgresql 2>/dev/null
```

**Grave falha de segurança:** senha em texto puro no script.

### 5.5 Paths e portas hardcoded no launcher

- `~/.local/bin/luna:11` — `BACKEND_DIR="$HOME/NEXO_DASHBOARD_PRO/backend"`.
- `~/.local/bin/luna:13,43,52` — portas `9222`, `3458`, `3456` fixas.
- `~/.local/bin/luna:91` — chama apenas `google-chrome`; não tenta `chromium-browser` ou `chromium`.
- `~/.local/bin/luna:36-39,112-118` — usa `pm2` sem verificar se está instalado.
- `~/.local/bin/luna:43-58` — mata processos por porta sem confirmar que pertencem à Luna.

### 5.6 Launcher não inicia toda a stack

`~/.local/bin/luna` só inicia PostgreSQL, Chrome CDP e `luna-server`. **Não inicia:**
- `luna-vite` (frontend na porta 5173)
- `nexo-dashboard` (backend dashboard, porta 3456)
- `telegram-bot`
- `luna-health-watchdog`
- Caddy/reverse proxy

### 5.7 `pm2-ecosystem.config.js` com paths absolutos

```js
cwd: '/home/jhin/NEXO_DASHBOARD_PRO',
script: '/usr/bin/npm',
cwd: '/home/jhin/.luna-kernel/luna-web',
```

Quebra em qualquer outro usuário/sistema.

### 5.8 Watchdogs problemáticos

- `luna-watchdog.sh:5` — `HEALTH_URL="https://luna-app.duckdns.org:5173/"` declarada mas nunca usada.
- `luna-watchdog.sh:7` — `PM2_BIN="${HOME}/.npm-global/bin/pm2"` hardcoded.
- `luna-watchdog.sh:47` — `/usr/bin/caddy` hardcoded; no sistema real o binário está em `~/.local/bin/caddy`.
- `luna-health-watchdog.js:44` — `res.statusCode >= 100 && res.statusCode < 600` conta qualquer resposta como "alive", inclusive HTTP 500.
- `luna-health-watchdog.js:21-26` — portas/serviços hardcoded; não monitora PostgreSQL nem Chrome CDP.

---

## 6. Tools instáveis — bugs e abordagens

### 6.1 `readFile`

**Bugs (`luna-tools.cjs:138-168`):**
- Carrega arquivo inteiro em memória (`fs.readFileSync`); arquivos grandes causam OOM.
- Encoding hardcoded UTF-8; binários viram lixo.
- `limit` pode ser `Infinity`, removendo proteção.
- Não detecta diretório/symlink.

**Abordagens:**
- Verificar `stat.size` antes; rejeitar ou usar stream se > 1MB.
- Detectar binário via null bytes / mime / extensão.
- Suportar `encoding` explícito (`utf8`, `base64`, `hex`, `latin1`).
- Limitar `limit` a máximo absoluto (ex: 10.000 linhas).
- Usar `fs.createReadStream` com chunked reading.

### 6.2 `executeShell` / `executeShellVisible`

**Bugs (`luna-tools.cjs:892-983`, `763-848`):**
- `opts.timeout = 0` é ignorado (`|| 60`).
- stdout/stderr sem limite de buffer; comandos verbosos estouram memória.
- SIGKILL após timeout não é classificado corretamente.
- `executeShellVisible` interpola `command` e `cwd` em script bash → injeção grave.
- Modo visible não tem timeout; processos travados ficam órfãos.
- Depende de `gnome-terminal`.
- `safeExec` (`luna-tools.cjs:113-132`) ignora stderr.

**Abordagens:**
- Respeitar `opts.timeout === 0` como sem timeout.
- Limitar stdout/stderr (ring buffer ou maxBuffer absoluto).
- Corrigir classificação de SIGKILL.
- Escapar `cwd`, `command`, `tmpFile` antes de interpolar no script (`shell-quote`).
- Adicionar timeout no processo do terminal.
- Usar marcador de fim UUID ao invés de `[LUNA_EXIT_CODE=...]`.
- Capturar stderr em `safeExec`.

### 6.3 `writeFile` / `replaceInFile`

**Bugs (`luna-tools.cjs:170-196`, `230-284`):**
- Escrita não atômica; processo morto no meio deixa arquivo truncado.
- Base64 sem validação.
- Sobrescrita silenciosa.
- `replaceInFile` cria arquivo vazio se não existir.
- Read-modify-write não atômico → race condition.

**Abordagens:**
- Escrita atômica: escrever para `.arquivo.tmp` e `fs.renameSync`.
- Opção `backup` e `overwrite=false` por padrão.
- Validar base64 com regex.
- Usar lock de arquivo (`fs.flockSync` ou `proper-lockfile`).
- Não criar arquivo vazio automaticamente no `replaceInFile`.

### 6.4 `searchFiles` / `grep`

**Bugs (`luna-tools.cjs:546-603`):**
- Comando montado em string; regex pode causar DoS por backtracking.
- stderr ignorado.
- Timeout padrão zero → buscas podem rodar indefinidamente.
- `maxBuffer` de 1MB pode estourar.
- Filtros inconsistentes entre `rg` e fallback `grep`.
- Contagem de matches errada (conta linhas, não ocorrências).
- Pattern começando com `-` pode ser interpretado como flag.

**Abordagens:**
- Usar `spawn('rg', [...])` com args array.
- Separar flags do pattern com `--`.
- Timeout padrão (30s) e limites (`--max-count`, `--max-filesize`).
- Capturar stderr para diagnóstico.
- Oferecer modo literal (`-F` / `--fixed-strings`).

### 6.5 Segurança geral

**Path traversal:**
- `resolvePath` (`luna-tools.cjs:99-103`) não restringe caminho além de `path.resolve`. Permite ler/escrever fora do projeto (`~/.ssh`, `/etc`, etc.).

**Injeção de comandos:**
- `executeShell` passa `command` cru para `bash -c`.
- `executeShellVisible` interpola `command` e `cwd`.
- `installPackages` faz `packages.join(' ')` e executa via shell.
- `applyPatch` usa redirecionamento shell.

**SSRF / downloads:**
- `downloadFile`/`fetchURL` não validam URLs. Podem acessar `localhost`, redes internas e metadata cloud (`169.254.169.254`).

**Leitura de `.env`:**
- `luna-tools.cjs:32-43` lê `.env` do backend e injeta em `process.env`, podendo contaminar `PATH`, `HOME`, etc.

**Abordagens:**
- Implementar sandbox de path (`allowedRoots`).
- Usar `spawn` com args array quando possível; evitar `bash -c`.
- Validar/esquematizar URLs; bloquear esquemas não http/https, IPs privados e metadata endpoints.
- Não carregar `.env` arbitrário em `process.env`; usar objeto isolado.
- Audit logging para `writeFile`, `deleteFile`, `executeShell`, `downloadFile`.

---

## 7. Prioridade de correção recomendada

### 🔴 Crítico (impede funcionamento ou segurança)

1. Remover compactação automática e implementar `_compactContext` corretamente.
2. Corrigir rota `/api/luna/compact` para chamar `_compactContext`.
3. Implementar `_clearChatUrl` e `_captureCurrentChatUrl` em `kimi-bridge.cjs`.
4. Corrigir `KIMI_MODE_URLS` → usar `getModeUrls()`.
5. Remover senha sudo hardcoded de `~/.local/bin/luna`.
6. Corrigir injeção de comandos em `executeShellVisible`.

### 🟡 Alto (quebra em outros sistemas ou causa corrida)

7. Remover paths absolutos `/home/jhin/...` de `pm2-ecosystem.config.js`.
8. Tornar `_saveChatUrl` agnóstico a provedor (não exigir `/chat/`).
9. Corrigir lock `processing` para ser atômico (ou usar mutex/fila).
10. Adicionar timeout real em `_executeActionAsync`.
11. Fazer `install.sh` instalar o comando `luna` e validar dependências.
12. Corrigir verificação de URL mismatch na landing page.

### 🟢 Médio (robustez e qualidade)

13. Limitar tamanho de leitura em `readFile`.
14. Escrita atômica em `writeFile`/`replaceInFile`.
15. Validar/escapar patterns em `searchFiles`/`grep`.
16. Implementar sandbox de path.
17. Limpar cache expirado em `_executedActionCache`.
18. Verificar `browser.isConnected()` em `connect()`.

---

## 8. Notas sobre o fluxo desejado

O usuário deseja que o fluxo seja:

> "mensagem pedindo algo → lê meu PC → executa tools (quantas forem necessárias, sem limites, permitindo multitools) → quando o contexto acabar, cria novo chat, envia contexto resumido, troca a session id pro novo chat url"

Para que isso funcione sem bugs, os seguintes pontos são essenciais:

- **Sem compactação automática:** o usuário deve ser avisado e ter controle manual (botão "Compactar").
- **Checkpoint não bloqueante:** enviar resumo para nova thread sem esperar resposta do Kimi.
- **URL da nova thread garantida:** capturar e persistir a URL correta **depois** do redirecionamento.
- **Sem execução duplicada:** deduplicação deve acontecer **antes** da execução, não depois.
- **Sem deadlock:** locks devem ser liberados corretamente em todos os caminhos (sucesso/erro/cancelamento).
- **Portabilidade:** nenhum path/porta/senha hardcoded; tudo via config ou variáveis de ambiente.
- **Tools robustas:** timeout, retry, chunked reading, stderr capture, path sandbox.

---

*Fim da auditoria.*
