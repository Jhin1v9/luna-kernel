# 🌙 Plano Arquitetural — Sistema de Agentes da Luna

> **Status:** Rascunho para discussão  
> **Base:** Reutiliza 100% do `.brain` existente (`OPERACAO_AGENTES`, `SUBAGENT_REGISTRY`, `ORQUESTRADOR`, `RUNBOOKS`, `PERSONALIDADES`)

---

## 🎯 Visão em uma frase

A Luna vira **Orquestradora Principal**. Ela não executa código sozinha — ela **monta equipes de agentes especializados** (do `.brain`), delega missões via protocolo `MAMIS/1`, supervisiona execução paralela em background e consolida resultados em uma resposta única ao usuário.

---

## 🏗️ Arquitetura de 4 Camadas

```
┌─────────────────────────────────────────────────────────────┐
│  CAMADA 1 — INTERFACE (usuário)                             │
│  Telegram Bot  │  Luna Web (chat)  │  Dashboard             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  CAMADA 2 — ORQUESTRADOR PRINCIPAL (Luna)                   │
│  • Classifica intenção do usuário                           │
│  • Consulta ORQUESTRADOR.md + SUBAGENT_REGISTRY.json        │
│  • Monta "team recipe" (ex: Pesquisa Suprema)               │
│  • Emite contratos MAMIS/1 para cada agente                 │
│  • Supervisiona progresso em tempo real                     │
│  • Consolida resposta final                                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  CAMADA 3 — MOTOR DE AGENTES (Agent Runtime)                │
│  Fila de missões  │  Pool de workers  │  State Machine      │
│  • Recebe contratos MAMIS/1                                 │
│  • Spawn agentes em processos/threads isolados              │
│  • Executa em paralelo (max 3-12 conforme policy)           │
│  • Aplica RUNBOOKS (AUDIT, IMPLEMENTATION, RESEARCH)        │
│  • Envia "heartbeat" + resultados de volta à Luna           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  CAMADA 4 — EXECUTORES (ferramentas reais)                  │
│  ├─ Kimi Bridge (navegação web, execução browser)           │
│  ├─ File System (read/write/scan do codebase)               │
│  ├─ Shell Exec (comandos sandboxed)                         │
│  ├─ Git Ops (commit, diff, branch)                          │
│  ├─ Test Runner (npm test, playwright, etc)                 │
│  └─ LLM Workers (sub-chamadas ao Kimi/GenAI para análise)   │
└─────────────────────────────────────────────────────────────┘
```

---

## 🧠 O que aproveitar do `.brain` existente

| Ativo do `.brain` | Como reaproveitar na Luna |
|---|---|
| `SUBAGENT_REGISTRY.json` | Banco de dados de roles. O Orquestrador lê isso para saber quais agentes existem, o que cada um faz, quantos podem rodar em paralelo. |
| `ORQUESTRADOR.md` | Matriz de decisão já pronta. A Luna usa isso para decidir "esta tarefa é de UI → ativar UIUX_ENGINEER + REACT_SPECIALIST". |
| `OPERACAO_AGENTES.md` | Regras de governança. Quando criar subagentes, como parallelizar, contratos, observabilidade. |
| `SUBAGENT_PROMPTS.md` | Templates `MAMIS/1` prontos. O Orquestrador gera contratos usando esses templates. |
| 8 Personalidades | Cada uma vira um **prompt de sistema** para um worker LLM. Ex: quando o CODE_SCOUT precisa de análise profunda, a personalidade ARQUITETO entra como prompt de contexto. |
| 4 Runbooks | Cada runbook vira um **workflow automatizado**. O agente RECEBE um runbook e executa passo a passo. |
| `CODEX_KIMI_TASK_ALLOCATION` | Divisão de responsabilidades. Na Luna, isso vira "modos de operação": modo CODEX (conservador, hardening) vs modo KIMI (explorador, ideias). |
| Brain Learning System | O BLS vira **memória persistente dos agentes**. Cada missão gera um `LEARNING_DELTA` que alimenta o BLS. |

---

## ⚙️ Componentes Técnicos (o que construir)

### 1. `AgentRuntime` (novo módulo Node.js)

```javascript
// Local: ~/.luna-kernel/agents/runtime/AgentRuntime.cjs

class AgentRuntime {
  constructor() {
    this.registry = load('./SUBAGENT_REGISTRY.json');
    this.orchestrator = load('./ORQUESTRADOR.md');
    this.runbooks = load('./runbooks/');
    this.queue = new MissionQueue();        // fila de missões
    this.workers = new WorkerPool(6);       // max 6 paralelos (default)
    this.state = new StateMachine();        // rastreia cada missão
  }

  async delegate(mission) {
    // 1. Classifica intenção
    const context = this.orchestrator.classify(mission);
    
    // 2. Seleciona team recipe
    const team = this.orchestrator.selectTeam(context);
    
    // 3. Gera contratos MAMIS/1
    const contracts = team.map(agent => ({
      protocol: 'MAMIS/1',
      role: agent.role,
      goal: mission.subGoalFor(agent),
      scope: agent.scope,
      inputs: mission.inputs,
      output: agent.requiredOutput,
      done: agent.doneConditions,
      risk: agent.riskProfile,
    }));
    
    // 4. Enfileira e executa em paralelo
    const jobs = contracts.map(c => this.workers.spawn(c));
    
    // 5. Aguarda com timeout e heartbeat
    const results = await Promise.allSettled(jobs);
    
    // 6. Consolida
    return this.synthesize(results);
  }
}
```

### 2. `WorkerPool` — execução paralela

Cada worker pode ser:
- **Processo filho** (`child_process.fork`) — isolamento máximo, mas mais pesado
- **Worker Thread** (`worker_threads`) — mais leve, shared memory
- **Micro-serviço** — se um dia escalar para máquinas separadas

Regra do `.brain`: `never_parallelize_same_file_writes: true` → o WorkerPool precisa de um **FileLockManager** que bloqueia arquivos durante edição.

### 3. `MissionQueue` + `StateMachine`

Cada missão tem estados:
```
CREATED → QUEUED → RUNNING → HEARTBEAT → RESULT → SYNTHESIZING → DONE
                ↘ BLOCKED → RETRY (max 3)
```

A Luna Web (frontend) pode mostrar o status em tempo real: "⏳ 3 agentes trabalhando... CODE_SCOUT 80%... SURGEON esperando..."

### 4. Integração com o Kimi Bridge

Os agentes não substituem o Kimi — eles **o utilizam** como ferramenta:
- WEB_SCOUT usa Kimi para navegar e extrair informações da web
- CODE_SCOUT usa Kimi para ler e analisar código via browser
- SURGEON usa Kimi para editar código no IDE web (se necessário)

Isso significa: o Kimi Bridge continua sendo o executor de baixo nível. Os agentes são a camada de orquestração acima.

### 5. Integração com Telegram / Luna Web

Quando o usuário manda uma mensagem complexa:
```
Usuário: "Cria um sistema de notificações com push, email e SMS"

Luna (Orquestradora):
  → "Isso é arquitetura + UI + backend"
  → Monta team: ARQUITETO + UIUX + REACT + TESTING
  → Delega missões MAMIS/1 para cada um
  → Envia para o usuário: "🧠 Montando equipe de 4 especialistas..."

(30s depois)
  → Recebe resultados dos 4 agentes
  → Consolida em um plano único
  → Envia: "📋 Plano criado! 1. Estrutura... 2. Componentes... 3. Testes..."
  → Pergunta: "Quer que eu implemente?"
```

---

## 📋 Roadmap Incremental (não quebra nada)

### Fase 0 — Fundação (1 semana)
- [ ] Copiar o `.brain` inteiro para `~/.luna-kernel/.brain/` (já existe a pasta!)
- [ ] Criar o `AgentRuntime` como módulo separado (não toca no luna-server ainda)
- [ ] Implementar parser do `SUBAGENT_REGISTRY.json` e `ORQUESTRADOR.md`
- [ ] Criar o `MissionQueue` e `StateMachine` em memória
- [ ] Teste unitário: "dada uma tarefa X, retorna o team recipe correto"

### Fase 1 — Workers Simples (1 semana)
- [ ] Implementar `WorkerPool` com `child_process.fork`
- [ ] Criar o primeiro worker real: `CODE_SCOUT` (só lê arquivos, não escreve)
- [ ] Criar o segundo worker: `WEB_SCOUT` (usa Kimi Bridge para pesquisa)
- [ ] Integrar com Luna Web: mostrar "🧠 Pensando..." → "🔍 2 agentes pesquisando..."
- [ ] Síntese básica: concatenar resultados dos workers

### Fase 2 — Write + Verify (2 semanas)
- [ ] Implementar `SURGEON` worker (pode editar arquivos)
- [ ] Implementar `FileLockManager` (regra do `.brain`: nunca paralelizar writes no mesmo arquivo)
- [ ] Implementar `VERIFIER` worker (roda build/testes após edit)
- [ ] Implementar `REVIEWER` worker (análise de qualidade)
- [ ] Pipeline: SURGEON → VERIFIER → REVIEWER → SYNTHESIZER

### Fase 3 — Telegram + Background (1 semana)
- [ ] Adaptar o Telegram Bot para mostrar progresso dos agentes
- [ ] Permitir "/agentes on/off" (modo agente vs modo chat normal)
- [ ] Agentes trabalham em background: usuário pode mandar outra msg enquanto espera
- [ ] Notificação quando a equipe termina: "✅ Missão concluída! [ver resultado]"

### Fase 4 — Brain Learning System (contínuo)
- [ ] Cada missão gera `LEARNING_DELTA`
- [ ] Persistir no BLS (`~/.luna-kernel/.brain/learning/`)
- [ ] Personalidades evoluem com base nos deltas
- [ ] O Orquestrador melhora suas decisões com base no histórico

---

## 🔄 Fluxo Completo — Exemplo

**Tarefa do usuário:** "Refatora o dashboard para usar Zustand em vez de Context API"

```
CAMADA 2 — LUNA ORQUESTRADORA
  1. Classifica: "refatoração de estado global" → contexto: arquitetura + react
  2. Consulta ORQUESTRADOR.md:
     → Primária: ARQUITETO (estrutura)
     → Secundária: REACT_SPECIALIST (hooks, patterns)
     → Terciária: TYPESCRIPT_MASTER (tipos)
  3. Monta team recipe "Implementação Segura":
     → CODE_SCOUT: mapear todos os arquivos que usam Context
     → SURGEON: editar arquivos (um por um, com file lock)
     → VERIFIER: rodar build + testes após cada arquivo
     → REVIEWER: revisar mudanças finais

CAMADA 3 — AGENT RUNTIME
  4. Emite 4 contratos MAMIS/1
  5. Executa CODE_SCOUT em paralelo com setup inicial
  6. Quando CODE_SCOUT devolve lista de arquivos:
     → SURGEON começa (sequencial, file lock)
     → VERIFIER valida cada arquivo editado
  7. REVIEWER analisa o diff final
  8. SYNTHESIZER consolida tudo

CAMADA 4 — EXECUTORES
  CODE_SCOUT → lê FileSystem, usa LLM para analisar imports
  SURGEON    → edita arquivos via FileSystem + Git ops
  VERIFIER   → roda `npm run build` e `npm test`
  REVIEWER   → usa LLM para análise de qualidade

RETORNO AO USUÁRIO
  9. Luna recebe resultado consolidado
  10. Envia: "✅ Refatoração concluída! 12 arquivos alterados. 
              Build passou. Testes passaram. 
              [ver diff] [reverter]"
```

---

## ⚠️ Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| **Loop infinito** de agentes se delegando | `recursion_policy.max_depth = 2` (já no `.brain`) + hard limit no runtime |
| **Colisão** de dois agents editando mesmo arquivo | `FileLockManager` + regra `never_parallelize_same_file_writes` |
| **Custo** de múltiplas chamadas LLM | Workers usam LLM só quando necessário; leitura de código é local (fs) |
| **Complexidade** dificultar manutenção | Fase 0 começa como módulo separado; só integra quando estável |
| **Timeout** de agente travado | Heartbeat a cada 10s; kill + retry após 60s |
| **Luna fica lenta** com muitos workers | WorkerPool com `soft_max = 6`, `hard_max = 12`; fila o resto |

---

## 💡 Diferencial vs outras IAs

A maioria das IAs (ChatGPT, Claude, etc) é **single-agent**. Elas pensam sozinhas.

A Luna com esse sistema vira **multi-agent orquestrada**:
- Especialistas reais (ARQUITETO não opina em CSS; CSS_EXPERT não opina em arquitetura)
- Paralelismo inteligente (só quando há ganho real)
- Contratos formais (MAMIS/1) — não é "vai lá e faz"
- Verificação obrigatória (nada entrega sem VERIFIER + REVIEWER)
- Memória persistente (BLS faz a Luna ficar mais inteligente a cada missão)

---

## 🤔 Decisões pendentes (preciso da sua opinião)

1. **Workers: processos ou threads?** Processos = isolamento total, mais seguro. Threads = mais rápido, mais leve.
2. **Modo Agente é default ou opt-in?** Sempre que a Luna detectar tarefa complexa, ela automaticamente monta equipe? Ou só quando o usuário mandar "/agentes on"?
3. **Custo LLM:** Cada agente pode fazer sub-chamadas ao Kimi. Quer limitar por missão (ex: máximo 5 chamadas LLM por equipe)?
4. **Dashboard:** Quer ver os agentes trabalhando em tempo real no Dashboard? Tipo um "Mission Control" com status de cada worker?

---

> **Próximo passo:** Me diz o que acha. Se aprovado, começo pela Fase 0 (fundação). Nada mexe no que já funciona.
