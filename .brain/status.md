# Status — Refatoração do Modo Detetive

## Resumo
O Modo Detetive foi refatorado para um loop multi-turno real no backend. A Kimi investiga com ferramentas de leitura no PC local, vê os resultados de volta e só no final entrega o card do plano.

## O que está funcionando
- ✅ `/plan <mensagem>` ativa o modo e envia para `/api/plan`.
- ✅ `Shift+Tab` / `Shift+Alt` ativam manualmente.
- ✅ O backend executa ferramentas de leitura (`listFiles`, `viewDirectory`, `readFile`, `grep`, `searchFiles`, `getFileInfo`, `glob`, `ipython`, etc.).
- ✅ Os resultados das ferramentas são devolvidos à Kimi para o próximo turno.
- ✅ Após investigação suficiente (≥5 ferramentas), o backend força o plano final em JSON `{"response": "# Plano: ..."}`.
- ✅ O plano final é persistido em `~/.luna-kernel/plans/<sessionId>.md`.
- ✅ O frontend exibe cada ferramenta em execução e, ao final, renderiza o card com botões Aprovar/Rejeitar/Revisar.
- ✅ Aprovação/rejeição/revisão chamam `/api/plan/approve`, `/api/plan/reject`, `/api/plan/revise`.
- ✅ O gatilho automático `PLAN` não ativa mais o modo sozinho (v10.13-fix).

## Arquivos alterados
- `.luna-kernel/luna-soul.cjs`
  - `processPlanModeStream` (loop multi-turno)
  - `_buildPlanModePrompt`
  - `_buildPlanFollowUpPrompt`
  - `_extractPlanMarkdown`
  - `_sanitizePlanResponse`
  - `_formatToolResultForPlan`
- `.luna-kernel/luna-web/src/components/ChatArea.svelte`
  - Handler de `plan_display` / `plan_awaiting_approval` separado
  - Atualização do `planModeState` no `plan_awaiting_approval`
- `.luna-kernel/luna-web/src/App.svelte`
  - Aceitar `?session=<id>` mesmo fora da lista local
- `.luna-kernel/package.json`
  - Adicionada dependência `glob`

## Testes realizados
- Teste real via navegador/Playwright: a Kimi executou `listFiles`, `viewDirectory`, `readFile`, `grep`, `searchFiles`, `getFileInfo`, `glob` e gerou planos estruturados em português.
- O arquivo de plano `~/.luna-kernel/plans/web-mq9rncnf-cn27.md` foi gerado com conteúdo markdown completo.

## Restrições / próximos passos sugeridos
1. Persistir o plano em memória (`planModeSessions`) entre restarts do servidor para permitir aprovar após reinício.
2. Adicionar flag no Playwright para ignorar certificado self-signed nos testes E2E.
3. Avaliar reduzir o mínimo de ferramentas para tarefas triviais, mantendo 5 como padrão.
