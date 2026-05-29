<script>
  import { onMount, onDestroy } from 'svelte';
  import { sessions, currentSessionId, isStreaming, messages, lunaConfig, connectionStatus } from './stores.js';
  import { fetchSessions, fetchConfig, sessionAction, SSEManager } from './api.js';
  import Sidebar from './components/Sidebar.svelte';
  import ChatArea from './components/ChatArea.svelte';
  import ConfigDrawer from './components/ConfigDrawer.svelte';
  import StatusBar from './components/StatusBar.svelte';

  let configOpen = false;
  let mobileSidebarOpen = false;

  async function handleNewSession() {
    const id = 'web-' + Date.now();
    const res = await sessionAction('create', id, 'Nova Sessão');
    if (res.ok || res.session) {
      const newSession = res.session || { id, title: 'Nova Sessão', updatedAt: new Date().toISOString() };
      sessions.update(s => [newSession, ...s]);
      currentSessionId.set(id);
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

<div class="app-container">
  <Sidebar
    sessions={$sessions}
    currentId={$currentSessionId}
    onSelect={(id) => currentSessionId.set(id)}
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
