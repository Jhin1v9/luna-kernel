# 🌌 Luna Universe + Voice Mode — Análise Completa

> **Data:** 2026-06-10  
> **Status:** 📋 Documentado — aguardando implementação  
> **Arquivos analisados:**
> - `file:///home/jhin/luna/luna-universe.html` (478 linhas)
> - `file:///home/jhin/luna/nexo-cosmos-preview.html` (773 linhas)
> - `~/.luna-kernel/luna-web/src/lib/voiceService.js` (253 linhas)

---

## 🎯 Visão Geral

A ideia evoluiu de "simples voice mode" para um **ecossistema visual completo** onde:
- A Luna "mora" em um universo 3D
- Cada projeto é uma galáxia/constelação
- Cada módulo do projeto é um planeta orbitando
- O usuário navega pelo universo e interage por voz

---

## 📁 Arquivos Existentes

### 1. `luna-universe.html` — Tela de Entrada do Voice Mode

**Local:** `file:///home/jhin/luna/luna-universe.html`

**O que é:** Tela fullscreen minimalista e misteriosa que serve como "portal" para falar com a Luna.

**Features visuais:**
- 🌌 **Nebulosa custom GLSL shader** — esfera gigante com noise fbm, cores roxas/azuis
- ⭐ **Shader de estrelas custom** — 25.000 estrelas com twinkle, fade por distância, core brilhante
- 🔗 **Constelações** — 6 projetos como agrupamentos de estrelas conectadas por linhas:
  - NEXO CORE (ciano)
  - SINUCA (laranja)
  - VERIFACTU (roxo)
  - HYPERFRAMES (amarelo)
  - LUNA KERNEL (verde)
  - DASHBOARD (rosa)
- 🎙️ **Botão de microfone gigante** (100px) no centro inferior
  - Estados visuais:
    - `idle` → branco translúcido, anel rotativo sutil
    - `listening` → azul ciano, pulse animation, glow
    - `processing` → dourado, spin animation
    - `speaking` → roxo, pulse animation
- 📝 **Status text** dinâmico abaixo do mic
- ✕ **Botão SAIR** no topo direito

**⚠️ Limitação:** A parte de voz é **MOCK/SIMULADA**. O `toggleVoice()` só troca classes CSS e textos com `setTimeout`. Não tem Speech Recognition real nem TTS.

**Código chave:**
```javascript
function toggleVoice() {
  if (voiceState !== "idle") return;
  voiceState = "listening";
  micBtn.classList.add("listening");
  statusText.textContent = "Ouvindo...";
  setTimeout(() => {
    voiceState = "processing";
    // ... mais setTimeouts
  }, 3000);
}
```

---

### 2. `nexo-cosmos-preview.html` — Navegação pelo Universo

**Local:** `file:///home/jhin/luna/nexo-cosmos-preview.html`

**O que é:** Visualização 3D completa do "NEXO COSMOS" — todas as galáxias, planetas, tasks.

**Features visuais:**
- 🌌 **5 Galáxias 3D** com braços espirais (800 estrelas por braço, 3 braços por galáxia)
  - DASHBOARD (ciano) — pos [0,0,0], raio 800
  - SINUCA (laranja) — pos [3000,800,-1500], raio 500
  - VERIFACTU (roxo) — pos [-2500,-600,2000], raio 450
  - HYPERFRAMES (amarelo) — pos [2000,1200,2500], raio 400
  - LUNA KERNEL (verde) — pos [-2000,400,-2500], raio 550
- 🪐 **Planetas/Módulos** orbitando cada galáxia
  - Dashboard: CAIXA, LEADS, TAREFAS, PROJETOS, IDEIAS, LINKS
  - Sinuca: JOGADORES, PARTIDAS, LOJA
  - Verifactu: FATURAS, CLIENTES, IMPOSTOS
  - Hyperframes: VÍDEOS, SCRIPTS, RENDERS
  - Luna Kernel: AGENTES, MEMÓRIA, PIPELINE
- 🌑 **Tasks** como pequenas esferas orbitando cada planeta
- 🔗 **Conexões** visuais entre galáxias (linhas cinzas translúcidas)
- ✨ **30.000 estrelas** de fundo com cores variadas
- 🖱️ **Interações:**
  - Scroll → zoom in/out (500 a 8000 unidades)
  - Drag → orbitar câmera
  - Click galáxia → voo suave até ela + info card (nome, módulos, itens, status, barra)
  - Click planeta → voo suave + side panel com tasks
- 📋 **Side Panel** (desliza da direita)
  - Título do módulo + galáxia
  - Lista de tasks com dot colorido por status
  - Botão "+ Nova Tarefa/Lead/Transação/Item"
- 🔔 **Toast notifications** no canto superior direito
- ⚡ **Painel de Ações Simuladas**
  - Criar Tarefa, Adicionar Lead, Entrada Caixa, Deletar Item, Explorar Galáxia
- 🧭 **Legenda inferior** com cores dos projetos

**⚠️ Limitação:** Dados são **HARDCODED/MOCK** no objeto `cosmicData`. Não conecta com API real.

---

### 3. `voiceService.js` — STT Real (já existe no luna-web!)

**Local:** `~/.luna-kernel/luna-web/src/lib/voiceService.js`

**O que é:** Serviço completo de Speech-to-Text já implementado no frontend.

**Features:**
- 🎤 Web Speech API (pt-BR)
- 🔁 Modo contínuo (`recognition.continuous = true`)
- ⏱️ Detecção de silêncio (2 segundos → auto-submit)
- 📊 Visualização de áudio em tempo real (64 bins de frequência)
- 🔄 Auto-restart em modo conversação
- 📢 Callbacks: `onTranscript`, `onAudioData`, `onStateChange`, `onError`, `onSilence`

**Estados:** `idle` → `listening` → `processing` → `idle`

---

## 🔌 O que falta para integrar na Luna

### Arquitetura proposta:

```
┌─────────────────────────────────────────────────────────────────────┐
│  LUNA UNIVERSE — Tela de Entrada (luna-universe.html)              │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  🌌 Nebulosa + Constelações (projetos)                     │   │
│  │                                                             │   │
│  │        🔗  🔗                                               │   │
│  │      NEXO CORE ─── SINUCA                                   │   │
│  │         │                                                   │   │
│  │    VERIFACTU ─── LUNA KERNEL                                │   │
│  │                                                             │   │
│  │              🎙️                                             │   │
│  │         [Toque para falar]                                  │   │
│  │                                                             │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  Click no mic → STT (voiceService.js) → Texto → Envia pro chat    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  NEXO COSMOS — Navegação (nexo-cosmos-preview.html)                │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  🌌 Galáxia Dashboard                                       │   │
│  │     🪐 CAIXA    🪐 LEADS    🪐 TAREFAS                      │   │
│  │     🪐 PROJETOS 🪐 IDEIAS   🪐 LINKS                        │   │
│  │                                                             │   │
│  │  Click planeta → Side Panel com tasks reais da API          │   │
│  │  Click ação   → Chama dashboardApi (criar tarefa, etc)     │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Tarefas de implementação:

| # | Tarefa | Complexidade |
|---|---|---|
| 1 | **Conectar `luna-universe.html` mic ao `voiceService.js`** real | Média |
| 2 | **Adicionar TTS** (`speechSynthesis`) para Luna falar respostas | Média |
| 3 | **Integrar com backend Luna** — enviar transcript via WebSocket/SSE | Alta |
| 4 | **Substituir dados mock** do cosmos por dados reais da API | Alta |
| 5 | **Criar rota/overlay** no luna-web para abrir o universo (ex: `/universe`) | Baixa |
| 6 | **Adicionar botão "Universo"** no header do chat | Baixa |

---

## 💡 Insights do usuário

- O usuário quer que a Luna "more" no universo — não é só um dashboard, é um **mundo visual**
- Cada projeto tem sua galáxia com planetas = módulos do sidebar
- Navegação é exploratória: zoom, orbitar, click para voar
- Voice mode é o **portal de entrada** — tela fullscreen com botão de mic gigante
- A transição entre "falar com Luna" e "navegar projetos" deve ser fluida

---

*Análise gerada por Luna CTO após exploração visual completa dos HTMLs*
