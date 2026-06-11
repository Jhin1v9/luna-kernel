# 🎙️ LUNA VOICE MODE — PLANO ARQUITETURAL SUPER DETALHADO
## Arquiteto Sênior: Modo Voz Real-Time para Luna Agent
### Data: 2026-06-07 | Versão: 1.0 | Status: PLANEJAMENTO (Aguardando aprovação Abner)

---

## 📋 RESUMO EXECUTIVO

Implementar um **modo voz real-time** no Luna Agent que transforme a interface atual em uma experiência de "chamada de voz" contínua. Quando ativado (clique no microfone), o teclado desaparece, o background expande para 100vh/100vw, as estrelas formam uma onda visual que responde à voz do usuário, meteoros continuam, e Luna responde por voz em streaming — como uma chamada telefônica com IA.

---

## 🏆 REFERÊNCIAS DE SUCESSO DO MERCADO

### 1. **ChatGPT Voice Mode (OpenAI)**
- **Arquitetura**: WebRTC + OpenAI Realtime API (WebSocket)
- **Tecnologia**: `gpt-4o-realtime-preview` — modelo nativamente multimodal (áudio-in, áudio-out, texto)
- **Latência**: ~300ms end-to-end (fala → processamento → resposta falada)
- **Streaming**: Audio chunks via WebSocket (PCM 16-bit, 24kHz)
- **VAD**: Silero VAD (Voice Activity Detection) no cliente para detectar fim de fala
- **Interrupções**: Usuário pode interromper a resposta da IA a qualquer momento

### 2. **ElevenLabs Conversational AI**
- **Arquitetura**: WebSocket streaming com ElevenLabs Turbo v2.5
- **Latência**: ~250ms (menor do mercado para TTS)
- **Vozes**: 3000+ vozes, clonagem de voz, controle emocional (prosody)
- **Agent**: LLM integrado (OpenAI, Anthropic, ou custom) + ElevenLabs TTS streaming
- **Turn-taking**: WebRTC-based com VAD inteligente

### 3. **Google Gemini Live API**
- **Arquitetura**: WebSocket bidirecional nativo
- **Multimodal**: Áudio + vídeo + tela em tempo real
- **VAD**: Integrado no pipeline do modelo
- **Streaming**: Resposta em chunks de áudio nativos (sem TTS separado)

### 4. **Hume AI — EVI (Empathic Voice Interface)**
- **Diferencial**: Análise emocional da voz do usuário (prosody, tom, velocidade)
- **Arquitetura**: WebSocket + análise de embeddings emocionais
- **Resposta**: TTS com ajuste emocional baseado no estado do usuário

### 5. **Play.ai / Bland.ai (Voice Agents for Business)**
- **Uso**: Atendimento telefônico automatizado
- **Arquitetura**: Twilio/WebRTC + LLM + TTS streaming
- **Latência**: ~500ms (aceitável para telefonia)

---

## 🎯 DECISÃO ARQUITETURAL — STACK RECOMENDADO

Após análise das referências, recomendo **Arquitetura Híbrida OpenAI + ElevenLabs**:

| Componente | Tecnologia | Justificativa |
|---|---|---|
| **STT (Speech-to-Text)** | Whisper API (OpenAI) ou Web Speech API (browser) | Whisper = melhor precisão multilíngue; Web Speech = gratuito, offline, latência zero |
| **LLM / Orquestração** | OpenAI GPT-4o / Claude 3.5 Sonnet | GPT-4o tem Realtime API nativa; Claude tem melhor raciocínio |
| **TTS (Text-to-Speech)** | ElevenLabs Turbo v2.5 | Melhor latência do mercado (~250ms), voz natural, streaming |
| **Protocolo Streaming** | WebSocket | Bidirecional, baixa latência, suportado por todos os navegadores |
| **VAD (Voice Activity)** | Silero VAD (cliente) ou WebRTC VAD | Detecta fim de fala, evita cortes |
| **Áudio Cliente** | Web Audio API + MediaRecorder | Captura microfone, reprodução streaming, visualização |

**ALTERNATIVA SIMPLES (MVP)**: Web Speech API (STT built-in do Chrome) + GPT-4o (texto) + ElevenLabs TTS. Menos latência, sem custo de STT.

---

## 🏗️ ARQUITETURA DE SISTEMA — DIAGRAMA

```
┌─────────────────────────────────────────────────────────────────────┐
│                         BROWSER (Cliente)                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐  │
│  │  Microfone  │  │   Web Audio │  │   Canvas/WebGL Background    │  │
│  │  Capture    │──│   API       │──│   (Estrelas + Onda Voz)      │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────────┘  │
│         │                │                        │                   │
│         ▼                ▼                        ▼                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐  │
│  │  VAD        │  │  Audio      │  │   Voice Mode UI             │  │
│  │  (Silero)   │  │  Visualizer │  │   (100vh/100vw, no keyboard)│  │
│  └─────────────┘  └─────────────┘  └─────────────────────────────┘  │
│         │                │                        │                   │
│         └────────────────┼────────────────────────┘                   │
│                          │                                          │
│                    ┌─────┴─────┐                                    │
│                    │ WebSocket │◄───────────────────────────────────┤
│                    │  Client   │                                    │
│                    └─────┬─────┘                                    │
└──────────────────────────┼──────────────────────────────────────────┘
                           │ WebSocket (wss://)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      SERVIDOR / EDGE FUNCTION                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐  │
│  │  WebSocket  │  │  OpenAI     │  │   ElevenLabs                │  │
│  │  Server     │──│  Realtime   │  │   Conversational            │  │
│  │  (Node.js)  │  │  API (opt)  │  │   API (opt)                 │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────────┘  │
│         │                │                        │                   │
│         └────────────────┼────────────────────────┘                   │
│                          │                                          │
│                    ┌─────┴─────┐                                    │
│                    │  Orquestrador │  Decide: STT → LLM → TTS     │
│                    │  (Luna Core)  │                                │
│                    └─────────────┘                                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 📐 ESPECIFICAÇÃO TÉCNICA DETALHADA

### 1. INTERFACE — TRANSFORMAÇÃO VISUAL (Voice Mode Ativado)

**Estado Normal → Voice Mode:**
```
ANTES (Chat Mode):
┌─────────────────────────────┐
│ [Header]                    │
│                             │
│  [Messages Area]            │
│                             │
│  [Input Box + Send]         │
│  [Micro Button]             │
└─────────────────────────────┘

DEPOIS (Voice Mode):
┌─────────────────────────────┐
│  ★  ☄️  ★  ☄️  ★  ☄️  ★   │  ← Meteoros passando
│                             │
│    ╭─────────────────╮      │
│    │  ◉  ◉  ◉  ◉  ◉  │      │  ← Estrelas formando onda
│    │    ◉  ◉  ◉  ◉    │      │     (visualização de áudio)
│    │  ◉  ◉  ◉  ◉  ◉  │      │
│    ╰─────────────────╯      │
│                             │
│        [ 🎙️ ]               │  ← Botão grande, pulsando
│      "Fale com Luna"        │
│                             │
│  [X] Sair do Voice Mode     │
└─────────────────────────────┘
100vh / 100vw — sem scroll, sem teclado
```

**Requisitos CSS:**
- `position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 9999`
- Background: gradiente espacial existente (preservado)
- Estrelas: canvas 2D ou WebGL, posições aleatórias, conectadas por onda quando há áudio
- Meteoros: animação CSS/Canvas independente, não afetada pela onda
- Onda de voz: FFT (Fast Fourier Transform) do áudio capturado, mapeado para amplitude das estrelas

### 2. ANIMAÇÃO — ONDA DE VOZ COM ESTRELAS

**Algoritmo de Visualização:**
```javascript
// Pseudocódigo
const audioContext = new AudioContext();
const analyser = audioContext.createAnalyser();
analyser.fftSize = 256; // 128 bins de frequência
const dataArray = new Uint8Array(analyser.frequencyBinCount);

function renderVoiceWave() {
  analyser.getByteFrequencyData(dataArray);
  
  // Mapear 128 bins para ~50 estrelas na tela
  const starCount = 50;
  const step = Math.floor(dataArray.length / starCount);
  
  stars.forEach((star, i) => {
    const amplitude = dataArray[i * step] / 255; // 0.0 - 1.0
    star.radius = baseRadius + (amplitude * maxRadiusDelta);
    star.opacity = 0.3 + (amplitude * 0.7);
    star.glow = amplitude * 20; // glow radius
  });
  
  // Conectar estrelas vizinhas com linhas quando amplitude > threshold
  // Criar efeito de "onda" que se move da esquerda para direita
}
```

**Estados da Onda:**
- **Silêncio**: Estrelas piscam suavemente (opacidade 0.3-0.5), raio mínimo
- **Fala do usuário**: Estrelas pulsam com FFT, conectadas por linhas luminosas, cor azul/ciano
- **Fala da Luna (TTS)**: Estrelas pulsam com áudio do TTS, cor roxa/dourada, meteoros aceleram levemente
- **Pensando/Processando**: Estrelas rodam em espiral, cor amarela/laranja, velocidade média

### 3. PIPELINE DE ÁUDIO — REAL-TIME STREAMING

**Fluxo Completo (Latência Alvo: < 500ms):**

```
[1] CAPTURA (0ms)
    Microfone → MediaRecorder (opus/webm, 16kHz)
    → Web Audio API → AnalyserNode (visualização em tempo real)
    
[2] VAD — Voice Activity Detection (50ms)
    Silero VAD (wasm) ou WebRTC VAD
    Detecta: fala iniciada / fala terminada / silêncio prolongado
    → Trigger: enviar chunk de áudio para servidor
    
[3] STT — Speech-to-Text (200-300ms)
    Opção A: OpenAI Whisper API (streaming, chunked)
    Opção B: Web Speech API (browser, gratuito, offline)
    Opção C: Deepgram Nova-2 (streaming, ~100ms)
    → Texto transcrito enviado para LLM
    
[4] LLM — Processamento (200-800ms)
    GPT-4o / Claude 3.5 Sonnet
    Streaming de texto (SSE ou WebSocket)
    → Texto parcial enviado para TTS em chunks
    
[5] TTS — Text-to-Speech (100-250ms per chunk)
    ElevenLabs Turbo v2.5 (streaming)
    Formato: PCM 16-bit, 24kHz, mono
    → Chunks de áudio enviados para cliente via WebSocket
    
[6] REPRODUÇÃO (0ms buffering)
    Web Audio API → AudioBufferSourceNode
    Buffering circular: 200ms pre-buffer para evitar gaps
    → Fala ouvida pelo usuário
```

**Total Latência Estimada:**
- MVP (Web Speech + GPT + ElevenLabs): ~400-600ms
- Premium (OpenAI Realtime API): ~250-350ms
- Ultra (Gemini Live): ~200-300ms

### 4. PROTOCOLO WEBSOCKET — MENSAGENS

```typescript
// Cliente → Servidor
interface VoiceMessage {
  type: 'audio_chunk' | 'text' | 'interrupt' | 'ping';
  payload: {
    audio?: ArrayBuffer;        // PCM 16-bit ou Opus
    text?: string;              // Texto transcrito (fallback)
    timestamp: number;          // ms desde epoch
    sessionId: string;          // UUID da sessão
  };
}

// Servidor → Cliente
interface ServerMessage {
  type: 'audio_chunk' | 'text_delta' | 'status' | 'error' | 'turn_end';
  payload: {
    audio?: ArrayBuffer;        // PCM 16-bit TTS
    text?: string;              // Texto parcial (para debug/visual)
    status?: 'listening' | 'thinking' | 'speaking' | 'idle';
    error?: string;
  };
}
```

### 5. ESTADOS DA CONVERSAÇÃO (State Machine)

```
IDLE ──► LISTENING ──► PROCESSING ──► SPEAKING ──► IDLE
           ▲                                      │
           └────────── INTERRUPT ─────────────────┘
           
 Estados:
 • IDLE: Aguardando ativação (botão micro ou wake word "Ei Luna")
 • LISTENING: Capturando áudio, VAD ativo, onda azul pulsando
 • PROCESSING: STT → LLM → TTS pipeline, onda amarela em espiral
 • SPEAKING: Reproduzindo TTS, onda roxa/dourada, usuário pode interromper
 • INTERRUPT: Usuário falou durante SPEAKING, cancela TTS atual, volta a LISTENING
```

---

## 📁 ESTRUTURA DE ARQUIVOS PROPOSTA

```
/home/jhin/luna/voice-mode/
├── 📄 PLAN.md                    # Este documento
├── 📁 src/
│   ├── 📁 components/
│   │   ├── VoiceMode.tsx         # Componente principal (100vh/100vw)
│   │   ├── StarField.tsx         # Canvas de estrelas + meteoros
│   │   ├── VoiceWave.tsx         # Visualização FFT das estrelas
│   │   ├── MicButton.tsx         # Botão grande, pulsante, com anel
│   │   └── StatusIndicator.tsx   # "Ouvindo...", "Pensando...", "Falando..."
│   ├── 📁 hooks/
│   │   ├── useAudioCapture.ts    # MediaRecorder + Web Audio API
│   │   ├── useVoiceActivity.ts   # VAD (Silero ou WebRTC)
│   │   ├── useWebSocket.ts       # Conexão WebSocket com servidor
│   │   ├── useTTS.ts             # ElevenLabs streaming TTS
│   │   └── useSTT.ts             # Web Speech API ou Whisper
│   ├── 📁 utils/
│   │   ├── audioProcessor.ts     FFT, normalização, buffer circular
│   │   ├── starWaveRenderer.ts   # Algoritmo de onda com estrelas
│   │   └── websocketProtocol.ts  # Tipagens e parsers de mensagens
│   ├── 📁 services/
│   │   ├── openaiRealtime.ts     # OpenAI Realtime API (opcional)
│   │   ├── elevenlabsTTS.ts      # ElevenLabs streaming
│   │   └── lunaOrchestrator.ts   # Orquestração: STT → LLM → TTS
│   └── 📁 types/
│       └── voice.ts              # Interfaces TypeScript
├── 📁 server/
│   ├── websocketServer.ts        # Node.js + ws (WebSocket server)
│   ├── audioPipeline.ts          # Orquestração no servidor
│   └── config.ts                 # API keys, timeouts, rate limits
├── 📁 assets/
│   └── silero_vad.onnx           # Modelo VAD (se usar Silero)
└── 📁 backup/                    # Backup automático antes de modificações
```

---

## 🔧 IMPLEMENTAÇÃO — FASES

### FASE 1: PROTÓTIPO VISUAL (Sem voz real ainda)
**Duração estimada**: 2-3 dias
**Objetivo**: Interface Voice Mode com estrelas-onda, botão micro, transições

- [ ] Criar componente `VoiceMode.tsx` com 100vh/100vw
- [ ] Migrar StarField existente para dentro do VoiceMode
- [ ] Implementar FFT visualizer conectado às estrelas (com áudio de teste/sine wave)
- [ ] Botão micro pulsante com anel animado
- [ ] Estados visuais: IDLE, LISTENING, PROCESSING, SPEAKING (com cores diferentes)
- [ ] Transição suave: Chat Mode → Voice Mode (fade, scale)
- [ ] Meteoros independentes, não afetados pela onda

### FASE 2: ÁUDIO CAPTURA + REPRODUÇÃO LOCAL
**Duração estimada**: 2-3 dias
**Objetivo**: Capturar microfone, reproduzir áudio, VAD básico

- [ ] Implementar `useAudioCapture` (MediaRecorder + Web Audio API)
- [ ] Implementar reprodução de áudio via AudioBufferSourceNode
- [ ] Integrar VAD (Web Speech API primeiro — built-in do Chrome)
- [ ] Testar loop: falar → ouvir própria voz com delay mínimo
- [ ] Visualização real da voz do usuário nas estrelas

### FASE 3: STT + LLM (Texto)
**Duração estimada**: 2-3 dias
**Objetivo**: Falar → Texto → Resposta texto

- [ ] Integrar Web Speech API (STT) — gratuito, offline
- [ ] Ou OpenAI Whisper API (streaming) — melhor precisão
- [ ] Enviar texto transcrito para GPT-4o/Claude
- [ ] Receber resposta em streaming (SSE)
- [ ] Mostrar resposta em texto na tela (modo debug/overlay)

### FASE 4: TTS + VOZ DA LUNA
**Duração estimada**: 3-4 dias
**Objetivo**: Resposta texto → Voz sintetizada → Streaming

- [ ] Configurar ElevenLabs API (Turbo v2.5)
- [ ] Escolher/clonar voz para Luna (feminina, calma, profissional)
- [ ] Implementar streaming TTS: chunks de texto → chunks de áudio
- [ ] Reproduzir áudio em tempo real (buffering circular 200ms)
- [ ] Sincronizar visualização das estrelas com áudio do TTS

### FASE 5: WEBSOCKET + PIPELINE COMPLETO
**Duração estimada**: 3-4 dias
**Objetivo**: Tudo conectado em pipeline real-time

- [ ] Criar WebSocket server (Node.js + ws ou Socket.io)
- [ ] Protocolo de mensagens (audio_chunk, text_delta, status)
- [ ] Orquestração no servidor: STT → LLM → TTS em pipeline
- [ ] Interrupções: usuário pode falar durante resposta da Luna
- [ ] Latência otimizada: paralelização, prefetch, caching

### FASE 6: POLIMENTO + PRODUÇÃO
**Duração estimada**: 2-3 dias
**Objetivo**: Estabilidade, edge cases, deploy

- [ ] Wake word detection ("Ei Luna", "Ok Luna") — opcional
- [ ] Fallback: se voz falhar, voltar para texto automaticamente
- [ ] Indicadores de rede/latência
- [ ] Testes em diferentes dispositivos (mobile, desktop)
- [ ] Otimização de bateria (mobile)
- [ ] Deploy do WebSocket server (Vercel Edge, Railway, ou VPS)

---

## 💰 CUSTOS ESTIMADOS (Mensais)

| Serviço | Uso Estimado | Custo |
|---|---|---|
| **OpenAI GPT-4o** | 100K tokens/mês | ~$3-5 |
| **OpenAI Whisper** | 10h de áudio/mês | ~$6 |
| **ElevenLabs TTS** | 10h de áudio/mês | ~$5 (Turbo) |
| **WebSocket Server** | Railway/Vercel | ~$5-10 |
| **Web Speech API** | STT gratuito | $0 |
| **TOTAL** | | **~$15-25/mês** |

**Custo MVP (Web Speech + GPT-4o-mini + ElevenLabs)**: ~$10/mês

---

## ⚠️ RISCOS E MITIGAÇÕES

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Latência > 1s | Média | Alto | Usar Web Speech API (STT local), ElevenLabs Turbo, otimizar pipeline |
| WebSocket instável | Média | Alto | Reconexão automática, fallback para HTTP polling, heartbeat |
| STT precisão ruim (PT-BR) | Baixa | Médio | Whisper treinado em PT, ou Web Speech API (Chrome excelente em PT) |
| TTS robótico | Baixa | Médio | ElevenLabs voz clonada, ajuste de stability/clarity |
| Mobile não suporta Web Audio | Baixa | Alto | Feature detection, fallback para modo texto |
| Custo elevado | Baixa | Médio | Rate limiting, caching, GPT-4o-mini para MVP |

---

## 🎨 DESIGN TOKENS — VOICE MODE

```css
/* Cores por estado */
--voice-idle: #1a1a2e;           /* Azul escuro espacial */
--voice-listening: #00d4ff;      /* Ciano brilhante */
--voice-thinking: #ffd700;       /* Dourado */
--voice-speaking: #9d4edd;       /* Roxo mágico */
--voice-interrupt: #ff6b6b;      /* Vermelho alerta */

/* Animações */
--wave-speed: 0.05s;             /* Atualização FFT */
--star-glow-duration: 2s;        /* Pulsação das estrelas */
--meteor-speed: 3s;              /* Velocidade dos meteoros */
--transition-duration: 0.5s;     /* Chat → Voice Mode */

/* Tipografia */
--status-font: 'Inter', sans-serif;
--status-size: 1.5rem;
--status-weight: 300;            /* Light */
```

---

## ✅ CHECKLIST DE APROVAÇÃO (Abner)

- [ ] Aprovar arquitetura híbrida (OpenAI + ElevenLabs)
- [ ] Aprovar fases de implementação (6 fases, ~14-20 dias)
- [ ] Aprovar custo estimado ($15-25/mês)
- [ ] Definir prioridade: MVP rápido vs. qualidade premium
- [ ] Escolher voz da Luna (ElevenLabs — posso mostrar opções)
- [ ] Aprovar modificação nos arquivos existentes de `/home/jhin/luna/`
- [ ] Backup confirmado antes de qualquer modificação

---

## 📝 NOTAS TÉCNICAS ADICIONAIS

### Web Speech API (PT-BR)
- Chrome: Excelente suporte, reconhecimento contínuo, gratuito
- Firefox: Suporte parcial (precisa de flag)
- Safari: Não suporta (fallback para Whisper API)

### ElevenLabs — Vozes Recomendadas para Luna
- "Bella" (feminina, calma, profissional)
- "Rachel" (feminina, amigável)
- "Antoni" (masculino, profissional) — se preferir voz masculina
- Ou clonar voz de referência (ex: assistente virtual brasileira)

### OpenAI Realtime API (Futuro)
- Quando disponível em PT-BR com qualidade, pode substituir STT+LLM+TTS separados
- Reduz latência em ~40% (modelo nativamente multimodal)
- Por enquanto, usar pipeline separado para maior controle

---

**Documento criado por: Luna (Arquiteta Sênior)**
**Para: Abner Gabriel, CEO NEXO DIGITAL**
**Status: AGUARDANDO APROVAÇÃO PARA INÍCIO DA FASE 1**
