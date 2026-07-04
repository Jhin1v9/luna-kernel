# Decisões de Arquitetura — Modo Detetive (Plan Mode)

## 1. Loop multi-turno real no backend
- **Decisão:** `processPlanModeStream` agora executa até 8 turnos. A Kimi envia uma ferramenta de leitura, o backend executa no PC local, retorna o resultado real e reenvia para a próxima inferência.
- **Motivo:** O usuário queria investigação visível, com mínimo de 5 ferramentas, e o card do plano só no final.
- **Arquivos:** `.luna-kernel/luna-soul.cjs` (`processPlanModeStream`, `_buildPlanModePrompt`, `_buildPlanFollowUpPrompt`, `_extractPlanMarkdown`, `_sanitizePlanResponse`).

## 2. Prompt do Modo Detetive isolado do system prompt normal
- **Decisão:** O system prompt do modo plan é injetado como `[SYSTEM OVERRIDE — MÁXIMA PRIORIDADE]` e exige saída JSON-only com code blocks, igual ao prompt normal.
- **Motivo:** Evitar texto livre e garantir que a Kimi use a mesma sintaxe de ferramentas JSON.
- **Detalhe:** `ipython` e `python` foram removidos da lista proibida e mantidos na lista de ferramentas de leitura permitidas.

## 3. Ferramentas de leitura apenas
- **Decisão:** Em plan mode, write/execute são bloqueados. Permitidos: `readFile`, `glob`, `grep`, `searchFiles`, `viewDirectory`, `listFiles`, `getFileInfo`, `searchWeb`, `fetchURL`, git read-only, dashboards read-only, `ipython`, `python`, `think`.
- **Motivo:** O Modo Detetive é investigação antes de execução; não deve modificar nada.

## 4. Sanitização do texto da Kimi
- **Decisão:** `_sanitizePlanResponse` remove blocos JSON de ferramentas e seções `Think ...` que vazam para o texto de resposta.
- **Motivo:** Evitar que a Kimi reenvie seus próprios comandos de ferramenta como conteúdo do plano.

## 5. Histórico truncado no follow-up
- **Decisão:** `_formatToolResultForPlan` limita cada resultado a 2000 caracteres e o follow-up mantém apenas os 6 eventos mais recentes.
- **Motivo:** O prompt estourava (24k+ chars) e deixava a Kimi lenta/sem resposta.

## 6. Forçar plano final após investigação suficiente
- **Decisão:** Quando `totalToolCalls >= 5` ou faltam 2 turnos, o follow-up passa a ser uma ordem direta para produzir o JSON final `{"response": "# Plano: ..."}`.
- **Motivo:** Garantir que a investigação termine e o card apareça.

## 7. Card único e estado no frontend
- **Decisão:** `plan_display` adiciona a mensagem do plano; `plan_awaiting_approval` apenas atualiza `planModeState`. Isso evita cards duplicados.
- **Arquivos:** `.luna-kernel/luna-web/src/components/ChatArea.svelte`.

## 8. Aceitar sessão via URL mesmo fora da lista local
- **Decisão:** `App.svelte` agora seta `currentSessionId` diretamente quando há `?session=...`, independentemente de `fetchSessions` retornar a sessão.
- **Motivo:** Permitir links diretos e testes com sessões criadas via API.

## 9. Dependência `glob` adicionada
- **Decisão:** `npm install glob --save` em `.luna-kernel`.
- **Motivo:** A ferramenta `glob` falhava com "Cannot find module 'glob'".
