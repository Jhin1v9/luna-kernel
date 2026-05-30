<script>
  import { onMount, onDestroy } from 'svelte';
  import { sessions, currentSessionId, isStreaming, messages, lunaConfig, connectionStatus, currentMode, user } from './stores.js';
  import { fetchSessions, fetchConfig, sessionAction, SSEManager, fetchMe } from './api.js';
  import Sidebar from './components/Sidebar.svelte';
  import ChatArea from './components/ChatArea.svelte';
  import LoginPage from './components/LoginPage.svelte';
  import ConfigDrawer from './components/ConfigDrawer.svelte';
  import StatusBar from './components/StatusBar.svelte';

  let configOpen = false;
  let mobileSidebarOpen = false;

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
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg)
    });
    lunaConfig.set(cfg);
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

    try {
      const res = await fetchSessions();
      if (res.ok && res.sessions) {
        sessions.set(res.sessions);
        if (res.sessions.length > 0 && !$currentSessionId) {
          currentSessionId.set(res.sessions[0].id);
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
  <div class="app-container">
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
      <ChatArea
        sessionId={$currentSessionId}
      />
    </main>

    <ConfigDrawer
      open={configOpen}
      config={$lunaConfig}
      onSave={handleSaveConfig}
      onClose={() => configOpen = false}
    />
  </div>

  <StatusBar
    status={$connectionStatus}
    onOpenConfig={() => configOpen = true}
  />
{:else}
  <LoginPage />
{/if}

<style>
  .app-container {
    display: flex;
    height: 100vh;
    height: 100dvh;
    background: var(--luna-bg);
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
    .app-container {
      flex-direction: column;
    }
  }
</style>
