# Bugs conhecidos / resolvidos — Modo Detetive

## Resolvidos

### 1. Plano vazio no card / card duplicado
- **Sintoma:** O evento `plan_display` chegava com conteúdo, mas o card renderizava "(plano vazio)" e aparecia duplicado.
- **Causa:** `plan_display` e `plan_awaiting_approval` compartilhavam o mesmo case e ambos adicionavam uma mensagem do tipo `plan`.
- **Fix:** Separar os cases em `ChatArea.svelte`: `plan_display` insere o card; `plan_awaiting_approval` só atualiza o `planModeState`.

### 2. Extração aceitava qualquer texto como plano
- **Sintoma:** `_extractPlanMarkdown` retornava o texto cru (inclusive JSON de ferramentas) como plano.
- **Causa:** Heurística muito permissiva (`clean.length > 40 && /[#*\-\d]/.test(clean)`).
- **Fix:** Exigir JSON `{"response": "..."}` ou markdown começando com `# ` / `## ` / `# Plano`.

### 3. Tool JSON e "Think" vazando para o histórico
- **Sintoma:** A resposta acumulada continha `{"tool": ...}` e seções `Think ...`, poluindo o follow-up.
- **Fix:** `_sanitizePlanResponse` remove esses trechos antes de extrair o plano e antes de adicionar ao histórico.

### 4. `glob` não encontrado
- **Sintoma:** Ferramenta `glob` retornava `Cannot find module 'glob'`.
- **Fix:** `npm install glob --save` em `.luna-kernel` e atualização do `package.json`.

### 5. Prompt muito longo e lento
- **Sintoma:** Follow-up chegava a 24k+ caracteres; a Kimi demorava minutos ou travava.
- **Fix:** Truncar cada resultado de ferramenta para 2000 caracteres e manter só os 6 eventos mais recentes no histórico.

### 6. `App.svelte` descartava sessão via URL
- **Sintoma:** Navegar para `/?session=<id>` redirecionava para `/` se a sessão não estivesse na lista retornada por `fetchSessions`.
- **Fix:** Sempre setar `currentSessionId` a partir da URL, movendo a lógica para fora do bloco condicional de `fetchSessions`.

## Ainda observáveis / melhorias futuras

### A. Persistência do plano entre restarts do servidor
- **Observação:** O endpoint `/api/plan/approve` consulta `planModeSessions` em memória. Se o backend reiniciar, o plano ainda existe em `~/.luna-kernel/plans/<sessionId>.md`, mas a aprovação retorna 404.
- **Sugestão:** Carregar o plano do arquivo quando `planModeSessions` não tiver a entrada.

### B. HMR / certificado no Playwright
- **Observação:** Durante os testes automatizados, o Vite dev server reiniciou e o navegador do Playwright passou a rejeitar o certificado self-signed (`ERR_CERT_AUTHORITY_INVALID`).
- **Impacto:** Não impede o funcionamento real; apenas dificulta testes E2E via Playwright sem flag de ignorar certificado.

### C. Velocidade da investigação
- **Observação:** Mesmo com truncamento, cada turno pode levar 20-60s devido ao tempo de resposta da Kimi.
- **Sugestão:** Considerar cache de resultados de ferramentas e/ou reduzir o mínimo de ferramentas para 3 quando o usuário pedir algo trivial.
