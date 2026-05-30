<script>
  import { currentMode, MODE_COLORS } from '../stores.js';
  import { onMount } from 'svelte';

  export let sessions = [];
  export let onNewSession = () => {};
  export let onSelectSession = (id) => {};

  $: theme = MODE_COLORS[$currentMode] || MODE_COLORS.thinking;
  $: recentSessions = [...sessions].sort((a, b) =>
    new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)
  ).slice(0, 6);

  let mounted = false;
  onMount(() => { mounted = true; });
</script>

<div class="welcome-screen" style="--accent: {theme.primary}; --glow: {theme.glow}">
  <div class="welcome-content" class:mounted>
    <!-- Logo -->
    <div class="welcome-logo">
      <span class="logo-moon">🌙</span>
      <h1 class="welcome-title">Luna</h1>
      <p class="welcome-subtitle">Seu assistente autônomo inteligente</p>
    </div>

    <!-- Main CTA -->
    <button class="new-chat-btn" on:click={onNewSession}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      <span>Nova Conversa</span>
      <kbd class="shortcut">Ctrl K</kbd>
    </button>

    <!-- Recent Sessions -->
    {#if recentSessions.length > 0}
      <div class="recent-section">
        <h3 class="recent-title">💬 Conversas recentes</h3>
        <div class="recent-list">
          {#each recentSessions as session (session.id)}
            <button
              class="recent-item"
              on:click={() => onSelectSession(session.id)}
            >
              <span class="recent-dot" style="background: {session.mode && MODE_COLORS[session.mode] ? MODE_COLORS[session.mode].primary : theme.primary}"></span>
              <span class="recent-name">{session.title || 'Sem título'}</span>
              <span class="recent-time">{new Date(session.updatedAt).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Tips -->
    <div class="tips-section">
      <div class="tip-card">
        <span class="tip-icon">⚡</span>
        <div class="tip-text">
          <strong>Modo Instant</strong>
          <span>Respostas rápidas sem raciocínio</span>
        </div>
      </div>
      <div class="tip-card">
        <span class="tip-icon">🧠</span>
        <div class="tip-text">
          <strong>Modo Thinking</strong>
          <span>Raciocínio passo a passo</span>
        </div>
      </div>
      <div class="tip-card">
        <span class="tip-icon">🤖</span>
        <div class="tip-text">
          <strong>Modo Agent</strong>
          <span>Executa ações no seu PC</span>
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .welcome-screen {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    overflow-y: auto;
    background: transparent;
    position: relative;
  }

  .welcome-content {
    max-width: 560px;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 28px;
    opacity: 0;
    transform: translateY(16px);
    transition: opacity 0.6s ease, transform 0.6s ease;
  }
  .welcome-content.mounted {
    opacity: 1;
    transform: translateY(0);
  }

  .welcome-logo {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .logo-moon {
    font-size: 56px;
    line-height: 1;
    filter: drop-shadow(0 0 24px var(--glow));
    animation: float 3s ease-in-out infinite;
  }
  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-8px); }
  }
  .welcome-title {
    font-size: 42px;
    font-weight: 800;
    color: var(--luna-text);
    letter-spacing: -1px;
    margin: 0;
    background: linear-gradient(135deg, var(--luna-text) 0%, var(--accent) 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .welcome-subtitle {
    font-size: 15px;
    color: var(--luna-text-secondary);
    margin: 0;
    font-weight: 400;
  }

  .new-chat-btn {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 28px;
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 14px;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    box-shadow: 0 4px 24px var(--glow);
    width: 100%;
    max-width: 320px;
    justify-content: center;
    position: relative;
  }
  .new-chat-btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 32px var(--glow);
    filter: brightness(1.1);
  }
  .new-chat-btn:active {
    transform: translateY(0);
  }
  .shortcut {
    position: absolute;
    right: 14px;
    font-size: 11px;
    font-weight: 500;
    opacity: 0.7;
    font-family: 'JetBrains Mono', monospace;
    background: rgba(255,255,255,0.15);
    padding: 2px 6px;
    border-radius: 4px;
  }

  .recent-section {
    width: 100%;
  }
  .recent-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--luna-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0 0 12px 0;
    padding-left: 4px;
  }
  .recent-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .recent-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: rgba(18, 18, 31, 0.55);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px;
    color: var(--luna-text);
    font-size: 14px;
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: left;
    width: 100%;
  }
  .recent-item:hover {
    background: rgba(255,255,255,0.04);
    border-color: var(--accent);
    transform: translateX(4px);
  }
  .recent-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .recent-name {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
  }
  .recent-time {
    font-size: 11px;
    color: var(--luna-text-secondary);
    font-family: 'JetBrains Mono', monospace;
    flex-shrink: 0;
  }

  .tips-section {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 10px;
    width: 100%;
  }
  .tip-card {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 14px;
    background: rgba(18, 18, 31, 0.55);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px;
    transition: all 0.15s ease;
  }
  .tip-card:hover {
    border-color: var(--accent);
    background: rgba(255,255,255,0.03);
  }
  .tip-icon {
    font-size: 20px;
    line-height: 1;
    flex-shrink: 0;
  }
  .tip-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tip-text strong {
    font-size: 13px;
    color: var(--luna-text);
    font-weight: 600;
  }
  .tip-text span {
    font-size: 12px;
    color: var(--luna-text-secondary);
  }

  @media (max-width: 640px) {
    .welcome-title { font-size: 32px; }
    .tips-section { grid-template-columns: 1fr; }
    .new-chat-btn { max-width: 100%; }
    .shortcut { display: none; }
  }
</style>
