# 🛠️ Plano: Revisor TS/JS — Luna CTO

> **Status:** 📋 Planejado  
> **Prioridade:** Alta  
> **Complexidade:** Média (3/5)  
> **Estimativa:** 2-3 dias de dev  
> **Responsável:** @luna-core-team

---

## 🎯 Visão Executiva

A Luna precisa de um **revisor de código integrado** que rode automaticamente após cada `writeFile`/`replaceInFile` em arquivos TypeScript/JavaScript. O revisor detecta erros de compilação (`tsc`), warnings de lint (`eslint`) e sugestões de melhoria — tudo em tempo real, visível no chat como um "console log inteligente".

Quando encontrado erro, o usuário vê um card estilo terminal com:
- 📍 Localização exata (arquivo, linha, coluna)
- 🚨 Código do erro (TS6133, ESLint rule, etc.)
- 💬 Mensagem descritiva
- 🔘 Botão "Pedir pra Kimi corrigir" → envia contexto + erro pra IA revisar

---

## 🏗️ Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│  LUNA SOUL (luna-soul.cjs)                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ writeFile    │  │ replaceInFile│  │ appendFile       │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────────┘  │
│         │                 │                 │               │
│         └─────────────────┼─────────────────┘               │
│                           ▼                                 │
│              ┌─────────────────────┐                        │
│              │  CodeReviewHook     │                        │
│              │  (novo módulo)      │                        │
│              └──────────┬──────────┘                        │
│                         │                                   │
│              ┌──────────┴──────────┐                        │
│              ▼                     ▼                        │
│      ┌──────────────┐    ┌────────────────┐                │
│      │  TypeScript  │    │   ESLint       │                │
│      │  Compiler    │    │   Linter       │                │
│      │  (tsc)       │    │   (eslint)     │                │
│      └──────┬───────┘    └───────┬────────┘                │
│             │                    │                          │
│             └────────┬───────────┘                          │
│                      ▼                                      │
│           ┌─────────────────────┐                           │
│           │  DiagnosticsParser  │                           │
│           │  (transforma em     │                           │
│           │   eventos SSE)      │                           │
│           └──────────┬──────────┘                           │
│                      │                                      │
│                      ▼                                      │
│           ┌─────────────────────┐                           │
│           │  EventBus.push({    │                           │
│           │    type: 'review',  │                           │
│           │    diagnostics: []  │                           │
│           │  })                 │                           │
│           └─────────────────────┘                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  LUNA WEB (frontend)                                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  ReviewConsoleCard                                  │   │
│  │  ┌───────────────────────────────────────────────┐  │   │
│  │  │ 🛠️ Revisor TS — src/App.tsx                   │  │   │
│  │  │ ───────────────────────────────────────────── │  │   │
│  │  │ Line 15, col 23 │ TS6133 │ 'Unlock' unused   │  │   │
│  │  │ Line 11, col 10 │ TS1484 │ type-only import  │  │   │
│  │  │                                                 │  │   │
│  │  │ [🔧 Pedir pra Kimi corrigir]  [🙈 Ignorar]    │  │   │
│  │  └───────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 📦 Componentes

### 1. `CodeReviewHook` (backend — luna-soul.cjs)

Hook que intercepta operações de escrita em arquivos TS/JS. Roda `tsc` e `eslint` em background (fire-and-forget, não bloqueia a resposta da Kimi).

**Interface:**
```typescript
interface CodeReviewHook {
  // Disparado após writeFile/replaceInFile/appendFile
  onFileWrite(filePath: string, content: string): Promise<ReviewResult>;
  
  // Configuração por projeto
  getProjectConfig(projectRoot: string): ReviewConfig;
}

interface ReviewResult {
  file: string;
  diagnostics: Diagnostic[];
  hasErrors: boolean;
  hasWarnings: boolean;
}

interface Diagnostic {
  line: number;
  column: number;
  code: string;        // "TS6133" ou "@typescript-eslint/no-unused-vars"
  message: string;
  severity: 'error' | 'warning' | 'suggestion';
  source: 'tsc' | 'eslint';
}
```

### 2. `DiagnosticsParser` (backend)

Parser que transforma output de `tsc` e `eslint` em estrutura JSON tipada.

**Input (tsc):**
```
src/App.tsx(15,23): error TS6133: 'Unlock' is declared but its value is never read.
```

**Output:**
```json
{
  "line": 15,
  "column": 23,
  "code": "TS6133",
  "message": "'Unlock' is declared but its value is never read",
  "severity": "error",
  "source": "tsc"
}
```

### 3. `ReviewConsoleCard` (frontend — Svelte)

Componente visual que renderiza os diagnostics como um "console log inteligente" no chat.

**Props:**
```typescript
interface ReviewConsoleProps {
  file: string;
  diagnostics: Diagnostic[];
  onFixRequest: () => void;  // "Pedir pra Kimi corrigir"
  onIgnore: () => void;      // "Ignorar"
}
```

**Features:**
- Syntax highlighting no trecho de código afetado
- Collapsible (minimizar/maximizar)
- Badge com contagem de erros/warnings
- Botão que envia prompt automático pra Kimi

### 4. `AutoFixPrompt` (backend)

Gerador de prompt que manda o contexto do erro + conteúdo do arquivo pra Kimi revisar.

**Template:**
```
[SYSTEM: REVISOR DE CÓDIGO]

O arquivo {filePath} tem os seguintes erros:

{diagnostics.map(d => `- Linha ${d.line}, col ${d.column} [${d.code}]: ${d.message}`).join('\n')}

Conteúdo atual do arquivo:
```typescript
{fileContent}
```

Corrija TODOS os erros acima. Use writeFile para salvar o arquivo corrigido.
NÃO explique, apenas execute as correções necessárias.
```

---

## 🔄 Fluxo de Dados

```
1. Usuário pede pra Luna criar/editar arquivo TS
        │
        ▼
2. Luna executa writeFile/replaceInFile
        │
        ├──► Arquivo salvo no disco
        │
        └──► CodeReviewHook dispara (background)
                │
                ├──► tsc --noEmit (se tsconfig.json existir)
                ├──► eslint --format json (se .eslintrc existir)
                │
                ▼
3. DiagnosticsParser transforma output em JSON
                │
                ▼
4. Se encontrou diagnostics:
                │
                ├──► addMessageToSession(type: 'review', ...)
                │
                ▼
5. SSE envia pro frontend
                │
                ▼
6. Frontend renderiza ReviewConsoleCard
                │
                ├──► Usuário vê erros no chat
                │
                └──► [Opcional] Clica "Pedir pra Kimi corrigir"
                        │
                        ▼
7. Frontend envia mensagem automática pra Luna
   com o prompt de correção
                        │
                        ▼
8. Luna recebe, analisa e executa writeFile corrigido
```

---

## 🔧 API / Endpoints

### Novo endpoint (opcional — pra checagem manual)

```
POST /api/review
Body: { filePath: string, content?: string }
Response: { ok: true, diagnostics: Diagnostic[], hasErrors: boolean }
```

Usado quando o usuário quer forçar revisão de um arquivo sem ter escrito nele.

---

## 🧪 Tarefas de Implementação

### Fase 1: Backend Core (Dia 1)
- [ ] Criar `CodeReviewHook` class em `luna-soul.cjs`
- [ ] Implementar `onFileWrite` hook nos handlers de `writeFile`, `replaceInFile`, `appendFile`
- [ ] Integrar `tsc --noEmit` runner (spawn child process)
- [ ] Integrar `eslint` runner (opcional na v1)
- [ ] Criar `DiagnosticsParser` (regex + JSON parse)
- [ ] Adicionar tipo `'review'` ao protocolo de mensagens
- [ ] Testar com projetos reais (NEXO Dashboard, hello-kitty-memory)

### Fase 2: Frontend (Dia 2)
- [ ] Criar componente `ReviewConsoleCard.svelte`
- [ ] Adicionar handler de evento `review` no SSE handler do ChatArea
- [ ] Implementar botão "Pedir pra Kimi corrigir"
- [ ] Implementar botão "Ignorar" (descarta o card)
- [ ] Adicionar syntax highlighting no trecho de código
- [ ] Testar visualmente no dark mode

### Fase 3: AutoFix + Polish (Dia 3)
- [ ] Criar `AutoFixPrompt` generator
- [ ] Integrar botão "Corrigir" com envio de mensagem pra Kimi
- [ ] Adicionar configuração por projeto (`.luna-review.json`)
- [ ] Cache de diagnostics (evita rodar tsc 2x no mesmo arquivo)
- [ ] Rate limiting (não rodar mais que 1 revisão a cada 5s)
- [ ] Documentação no AGENTS.md

---

## ⚙️ Configuração por Projeto

Arquivo opcional `.luna-review.json` na raiz do projeto:

```json
{
  "enabled": true,
  "tools": ["tsc", "eslint"],
  "eslintConfig": "./.eslintrc.cjs",
  "tsconfig": "./tsconfig.json",
  "severityFilter": ["error", "warning"],
  "autoFix": false,
  "ignorePatterns": ["node_modules", "dist", ".git"]
}
```

Se o arquivo não existir, usa defaults:
- `tsc` se encontrar `tsconfig.json`
- `eslint` se encontrar `.eslintrc.*`
- Severity mínima: `error`

---

## 🛡️ Segurança & Performance

| Risco | Mitigação |
|-------|-----------|
| tsc lento em projetos grandes | Timeout de 10s; roda em background; não bloqueia resposta da Kimi |
| eslint sem config | Skipa silenciosamente; loga warning no servidor |
| Falso positivo | Usuário clica "Ignorar"; card some do chat |
| Loop infinito (fix gera novo erro) | Rate limiting de 5s entre revisões do mesmo arquivo |
| Memory leak no cache | Cache LRU com max 100 entradas |
| Projeto sem node_modules | Skipa silenciosamente; mostra aviso no card |

---

## 📊 Métricas de Sucesso

- [ ] 90% dos erros de TS são detectados antes do usuário perceber
- [ ] Tempo médio de revisão < 3s (para projetos < 50 arquivos)
- [ ] Zero falsos positivos críticos (erros reportados que não existem)
- [ ] 80% dos usuários usam o botão "Pedir pra Kimi corrigir" pelo menos 1x

---

## 🚀 Próximos Passos

1. **Aprovar** este plano
2. **Criar branch** `feat/code-reviewer`
3. **Implementar Fase 1** (backend)
4. **Testar** com projeto real
5. **Implementar Fase 2** (frontend)
6. **Merge** pra main

---

*Plano gerado por Luna CTO v1.0*  
*Timestamp: 2026-06-10T21:15:00Z*
