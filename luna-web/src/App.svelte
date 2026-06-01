<script>
  import { onMount } from 'svelte';
  import { sessions, currentSessionId, isStreaming, messages, lunaConfig, connectionStatus, currentMode, user, MODE_COLORS, planModeState, PLAN_MODE_COLORS, mascotState } from './stores.js';

  // Update CSS theme variables when mode changes
  $: {
    const root = document.documentElement;
    if ($planModeState.active) {
      root.style.setProperty('--luna-accent', PLAN_MODE_COLORS.primary);
      root.style.setProperty('--luna-accent-glow', PLAN_MODE_COLORS.glow);
      root.style.setProperty('--luna-accent-border', PLAN_MODE_COLORS.border);
      document.body.classList.add('plan-mode-active');
    } else {
      const theme = MODE_COLORS[$currentMode] || MODE_COLORS.thinking;
      root.style.setProperty('--luna-accent', theme.primary);
      root.style.setProperty('--luna-accent-glow', theme.glow);
      root.style.setProperty('--luna-accent-border', theme.border);
      document.body.classList.remove('plan-mode-active');
    }
  }
  import { fetchSessions, fetchConfig, sessionAction, SSEManager, fetchMe } from './api.js';
  import Sidebar from './components/Sidebar.svelte';
  import ChatArea from './components/ChatArea.svelte';
  import LoginPage from './components/LoginPage.svelte';
  import ConfigDrawer from './components/ConfigDrawer.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import ParticleBackground from './components/ParticleBackground.svelte';
  import WelcomeScreen from './components/WelcomeScreen.svelte';


  let configOpen = false;
  let mobileSidebarOpen = false;
  let authChecked = false;

  // Quando não há sessão ativa, Luna vai dormir 💤
  $: if (!$currentSessionId) mascotState.set('sleep');

  async function handleNewSession() {
    const res = await sessionAction('create', null, 'Nova Sessão');
    if (res.ok && res.session) {
      const newSession = { ...res.session, updatedAt: new Date().toISOString() };
      sessions.update(s => [newSession, ...s]);
      currentSessionId.set(res.session.id);
    }
  }

  async function handleRename(id, title) {
    await sessionAction('rename', id, title);
    sessions.update(s => s.map(sess => sess.id === id ? { ...sess, title } : sess));
  }

  async function handleDelete(id) {
    await sessionAction('delete', id);
    sessions.update(s => s.filter(sess => sess.id !== id));
    currentSessionId.update(current => current === id ? null : current);
  }

  async function handleSaveConfig(cfg) {
    // v5.0-fix: send env and systemPrompt separately as backend expects
    const env = {};
    const systemPrompt = cfg.SYSTEM_PROMPT;
    for (const [key, value] of Object.entries(cfg)) {
      if (key === 'SYSTEM_PROMPT') continue;
      if (value !== undefined && value !== '') env[key] = value;
    }
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env, systemPrompt })
    });
    lunaConfig.set(cfg);
  }

  async function handleRestartLuna() {
    try {
      const res = await fetch('/api/system/restart', { method: 'POST' });
      const data = await res.json();
      alert(data.message || 'Reiniciando...');
    } catch (e) {
      alert('Erro ao reiniciar: ' + e.message);
    }
  }

  onMount(async () => {
    // Auto-login: validate existing token
    try {
      const me = await fetchMe();
      if (me) {
        user.set(me);
      }
    } catch (e) {
      console.error('Auth check error:', e);
    }
    authChecked = true;

    try {
      const res = await fetchSessions();
      if (res.ok && res.sessions) {
        sessions.set(res.sessions);
        // v5.1-fix: Do NOT auto-select first session — respect stored currentSessionId
        // If stored session no longer exists, clear it so WelcomeScreen shows
        const storedId = $currentSessionId;
        if (storedId && !res.sessions.find(s => s.id === storedId)) {
          currentSessionId.set(null);
        }
      }
      const cfg = await fetchConfig();
      if (cfg) lunaConfig.set(cfg);
    } catch (e) {
      console.error('Init error:', e);
    }
  });
</script>

<svelte:window on:keydown={(e) => {
  if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    handleNewSession();
  }
}}/>

{#if $user}
  <ParticleBackground />
  <div class="app-layout">
    <div class="app-body">
      <Sidebar
        sessions={$sessions}
        currentId={$currentSessionId}
        onSelect={(id) => {
          const sess = $sessions.find(s => s.id === id);
          if (sess?.mode) currentMode.set(sess.mode);
          currentSessionId.set(id);
        }}
        onNew={handleNewSession}
        onRename={handleRename}
        onDelete={handleDelete}
        onOpenConfig={() => configOpen = true}
        bind:mobileOpen={mobileSidebarOpen}
      />

      <main class="main-content">
        {#if $currentSessionId}
          <ChatArea
            sessionId={$currentSessionId}
          />
        {:else}
          <WelcomeScreen
            sessions={$sessions}
            onNewSession={handleNewSession}
            onSelectSession={(id) => {
              const sess = $sessions.find(s => s.id === id);
              if (sess?.mode) currentMode.set(sess.mode);
              currentSessionId.set(id);
            }}
          />
        {/if}
      </main>

      <ConfigDrawer
        open={configOpen}
        config={$lunaConfig}
        onSave={handleSaveConfig}
        onClose={() => configOpen = false}
        onRestart={handleRestartLuna}
      />
    </div>

    <StatusBar
      status={$connectionStatus}
      onOpenConfig={() => configOpen = true}
    />

    <!-- 🏠 CASA DA LUNA — Footer Stage -->

  </div>
{:else if authChecked}
  <LoginPage />
{:else}
  <!-- Auth checking loader -->
  <div class="auth-loader">
    <div class="auth-loader-icon">🌙</div>
    <div class="auth-loader-text">Conectando...</div>
  </div>
{/if}

<style>
  .app-layout {
    display: flex;
    flex-direction: column;
    height: 100vh;
    height: 100dvh;
    background: transparent;
    overflow: hidden;
  }
  .app-body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .main-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
  }
  @media (max-width: 768px) {
    .main-content {
      padding-top: 52px; /* espaço pro hamburger button */
    }
  }
  .auth-loader {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    height: 100dvh;
    background: var(--luna-bg);
    color: var(--luna-text);
    gap: 16px;
  }
  .auth-loader-icon {
    font-size: 48px;
    animation: pulse 2s ease-in-out infinite;
  }
  .auth-loader-text {
    font-size: 14px;
    color: var(--luna-text-secondary);
    font-family: 'JetBrains Mono', monospace;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.6; transform: scale(1); }
    50% { opacity: 1; transform: scale(1.1); }
  }
  @media (max-width: 768px) {
    .app-body {
      flex-direction: column;
    }
  }
</style>
