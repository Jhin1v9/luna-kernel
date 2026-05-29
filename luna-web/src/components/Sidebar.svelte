<script>
  import { onMount, onDestroy } from 'svelte';
  import { formatTime } from '../utils.js';

  export let sessions = [];
  export let currentId = null;
  export let onSelect = () => {};
  export let onNew = () => {};
  export let onRename = () => {};
  export let onDelete = () => {};
  export let onOpenConfig = () => {};
  export let mobileOpen = false;

  let editingId = null;
  let editTitle = '';
  let contextMenuId = null;
  let contextMenuPos = { x: 0, y: 0 };
  let sidebarEl;

  $: sortedSessions = [...sessions].sort((a, b) =>
    new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)
  );

  function startRename(session, e) {
    e.stopPropagation();
    editingId = session.id;
    editTitle = session.title || 'Sem titulo';
    contextMenuId = null;
  }

  function commitRename() {
    if (editingId && editTitle.trim()) {
      onRename(editingId, editTitle.trim());
    }
    editingId = null;
  }

  function cancelRename() {
    editingId = null;
  }

  function handleKeydown(e, session) {
    if (e.key === 'Enter') {
      commitRename();
    } else if (e.key === 'Escape') {
      cancelRename();
    }
  }

  function showContextMenu(e, session) {
    e.preventDefault();
    e.stopPropagation();
    contextMenuId = session.id;
    contextMenuPos = { x: e.clientX, y: e.clientY };
  }

  function handleDelete(id) {
    contextMenuId = null;
    if (confirm('Tem certeza que deseja excluir esta sessão?')) {
      onDelete(id);
    }
  }

  function handleClickOutside() {
    contextMenuId = null;
  }

  onMount(() => {
    const handleKey = (e) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onNew();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });
</script>

<svelte:window on:click={handleClickOutside} />

<!-- Mobile overlay -->
{#if mobileOpen}
  <div class="mobile-overlay" on:click={() => mobileOpen = false} />
{/if}

<aside class="sidebar" class:mobile-open={mobileOpen} bind:this={sidebarEl}>
  <!-- Logo -->
  <div class="logo-area">
    <div class="logo">
      <span class="logo-icon">🌙</span>
      <span class="logo-text">Luna Web</span>
      <span class="logo-version">v5.0</span>
    </div>
  </div>

  <!-- New Session Button -->
  <button class="new-session-btn" on:click={onNew} title="Nova Sessao (Ctrl+K)">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
    Nova Sessao
  </button>

  <!-- Sessions Label -->
  <div class="section-label">📋 Sessoes</div>

  <!-- Session List -->
  <div class="session-list">
    {#if sortedSessions.length === 0}
      <div class="empty-state">
        <div class="empty-icon">💬</div>
        <div class="empty-text">Nenhuma sessao ainda</div>
        <div class="empty-hint">Clique em "Nova Sessao" para comecar</div>
      </div>
    {:else}
      {#each sortedSessions as session (session.id)}
        <div
          class="session-item"
          class:active={session.id === currentId}
          on:click={() => { onSelect(session.id); mobileOpen = false; }}
          on:contextmenu={(e) => showContextMenu(e, session)}
          on:dblclick={(e) => startRename(session, e)}
        >
          <div class="session-indicator" style="background-color: {session.id === currentId ? 'var(--luna-primary)' : 'transparent'}"></div>
          <div class="session-content">
            {#if editingId === session.id}
              <input
                class="session-edit-input"
                bind:value={editTitle}
                on:blur={commitRename}
                on:keydown={(e) => handleKeydown(e, session)}
                autofocus
              />
            {:else}
              <div class="session-title" class:active={session.id === currentId}>
                {session.title || 'Sem titulo'}
              </div>
              <div class="session-time">{formatTime(session.updatedAt)}</div>
            {/if}
          </div>
          <button
            class="session-menu-btn"
            on:click={(e) => showContextMenu(e, session)}
            aria-label="Menu da sessao"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="2"/>
              <circle cx="12" cy="12" r="2"/>
              <circle cx="12" cy="19" r="2"/>
            </svg>
          </button>

          <!-- Context Menu -->
          {#if contextMenuId === session.id}
            <div class="context-menu" style="top: 8px; right: 8px;">
              <button class="context-item" on:click={(e) => startRename(session, e)}>
                ✏️ Renomear
              </button>
              <button class="context-item" on:click={() => handleDelete(session.id)}>
                🗑️ Excluir
              </button>
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>

  <!-- Footer -->
  <div class="sidebar-footer">
    <button class="footer-btn" on:click={onOpenConfig}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
      Configuracoes
    </button>
    <div class="footer-status">
      <span class="footer-dot"></span>
      <span>Conectado</span>
      <span class="footer-version">v5.0</span>
    </div>
  </div>
</aside>

<!-- Mobile Toggle -->
<button class="mobile-toggle" on:click={() => mobileOpen = !mobileOpen} aria-label="Menu">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <line x1="3" y1="6" x2="21" y2="6"/>
    <line x1="3" y1="12" x2="21" y2="12"/>
    <line x1="3" y1="18" x2="21" y2="18"/>
  </svg>
</button>

<style>
  .sidebar {
    width: 260px;
    min-width: 260px;
    background: var(--luna-surface);
    border-right: 1px solid var(--luna-border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
    z-index: 20;
  }
  .logo-area {
    padding: 16px;
    border-bottom: 1px solid var(--luna-border);
    flex-shrink: 0;
  }
  .logo {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .logo-icon { font-size: 20px; }
  .logo-text {
    font-size: 16px;
    font-weight: 700;
    color: var(--luna-text);
    letter-spacing: -0.3px;
  }
  .logo-version {
    font-size: 11px;
    font-weight: 500;
    color: var(--luna-text-secondary);
    background: var(--luna-elevated);
    padding: 2px 6px;
    border-radius: 4px;
    margin-left: auto;
    font-family: 'JetBrains Mono', monospace;
  }
  .new-session-btn {
    margin: 12px 16px;
    padding: 10px 16px;
    background: var(--luna-primary);
    color: white;
    border: none;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    transition: all 0.2s;
    flex-shrink: 0;
  }
  .new-session-btn:hover {
    background: var(--luna-primary-hover);
    transform: translateY(-1px);
  }
  .new-session-btn:active {
    transform: translateY(0);
  }
  .section-label {
    padding: 8px 16px 4px;
    font-size: 11px;
    font-weight: 600;
    color: var(--luna-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex-shrink: 0;
  }
  .session-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 8px;
  }
  .empty-state {
    padding: 32px 16px;
    text-align: center;
    color: var(--luna-text-secondary);
  }
  .empty-icon { font-size: 32px; margin-bottom: 8px; }
  .empty-text { font-size: 14px; font-weight: 500; margin-bottom: 4px; }
  .empty-hint { font-size: 12px; opacity: 0.7; }
  .session-item {
    display: flex;
    align-items: center;
    padding: 10px 12px;
    border-radius: 8px;
    cursor: pointer;
    position: relative;
    transition: background 0.15s;
    margin-bottom: 2px;
    min-height: 48px;
  }
  .session-item:hover {
    background: rgba(255,255,255,0.04);
  }
  .session-item.active {
    background: rgba(233,69,96,0.08);
  }
  .session-indicator {
    width: 3px;
    height: 20px;
    border-radius: 2px;
    margin-right: 10px;
    flex-shrink: 0;
    transition: background 0.2s;
  }
  .session-content {
    flex: 1;
    min-width: 0;
  }
  .session-title {
    font-size: 14px;
    color: var(--luna-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .session-title.active {
    font-weight: 500;
    color: var(--luna-primary);
  }
  .session-time {
    font-size: 11px;
    color: var(--luna-text-secondary);
    font-family: 'JetBrains Mono', monospace;
  }
  .session-edit-input {
    width: 100%;
    background: var(--luna-bg);
    border: 1px solid var(--luna-primary);
    border-radius: 6px;
    padding: 4px 8px;
    color: var(--luna-text);
    font-size: 14px;
    outline: none;
  }
  .session-menu-btn {
    background: none;
    border: none;
    color: var(--luna-text-secondary);
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    opacity: 0;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .session-item:hover .session-menu-btn {
    opacity: 1;
  }
  .session-menu-btn:hover {
    color: var(--luna-text);
    background: rgba(255,255,255,0.06);
  }
  .context-menu {
    position: absolute;
    right: 8px;
    top: 36px;
    background: var(--luna-elevated);
    border: 1px solid var(--luna-border);
    border-radius: 8px;
    padding: 4px;
    z-index: 100;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    min-width: 140px;
  }
  .context-item {
    display: block;
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    color: var(--luna-text);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    border-radius: 6px;
    transition: background 0.15s;
  }
  .context-item:hover {
    background: rgba(255,255,255,0.06);
  }
  .sidebar-footer {
    padding: 12px 16px;
    border-top: 1px solid var(--luna-border);
    flex-shrink: 0;
  }
  .footer-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    color: var(--luna-text-secondary);
    font-size: 13px;
    cursor: pointer;
    border-radius: 8px;
    transition: all 0.15s;
    margin-bottom: 8px;
  }
  .footer-btn:hover {
    background: rgba(255,255,255,0.04);
    color: var(--luna-text);
  }
  .footer-status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--luna-text-secondary);
    font-family: 'JetBrains Mono', monospace;
    padding: 0 12px;
  }
  .footer-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #22c55e;
  }
  .footer-version {
    margin-left: auto;
    opacity: 0.6;
  }
  .mobile-overlay {
    display: none;
  }
  .mobile-toggle {
    display: none;
  }

  @media (max-width: 768px) {
    .sidebar {
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      z-index: 40;
      transform: translateX(-100%);
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .sidebar.mobile-open {
      transform: translateX(0);
    }
    .mobile-overlay {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 35;
    }
    .mobile-toggle {
      display: flex;
      position: fixed;
      top: 12px;
      left: 12px;
      z-index: 30;
      background: var(--luna-surface);
      border: 1px solid var(--luna-border);
      color: var(--luna-text);
      padding: 8px;
      border-radius: 8px;
      cursor: pointer;
    }
  }
</style>
