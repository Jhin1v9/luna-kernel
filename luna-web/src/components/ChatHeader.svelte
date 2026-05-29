<script>
  import { createEventDispatcher } from 'svelte';

  export let title = 'Nova Conversa';
  export let mode = 'thinking';
  export let isStreaming = false;

  const dispatch = createEventDispatcher();

  let editing = false;
  let editValue = title;
  let showMenu = false;
  let showModeDropdown = false;

  function startEdit() {
    editing = true;
    editValue = title;
  }

  function commitEdit() {
    if (editValue.trim()) {
      title = editValue.trim();
    }
    editing = false;
  }

  function cancelEdit() {
    editing = false;
    editValue = title;
  }

  function handleEditKey(e) {
    if (e.key === 'Enter') commitEdit();
    else if (e.key === 'Escape') cancelEdit();
  }

  function selectMode(newMode) {
    dispatch('modeChange', newMode);
    showModeDropdown = false;
  }

  function handleClickOutside() {
    showMenu = false;
    showModeDropdown = false;
  }
</script>

<svelte:window on:click={handleClickOutside} />

<header class="chat-header">
  <div class="header-left">
    <!-- Mode Dropdown -->
    <div class="mode-dropdown-container">
      <button
        class="mode-btn"
        on:click|stopPropagation={() => showModeDropdown = !showModeDropdown}
        disabled={isStreaming}
      >
        <span class="mode-icon">{mode === 'thinking' ? '⭐' : '⚡'}</span>
        <span class="mode-text">{mode === 'thinking' ? 'thinking' : 'instant'}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {#if showModeDropdown}
        <div class="mode-dropdown">
          <button class="mode-option" class:active={mode === 'thinking'} on:click={() => selectMode('thinking')}>
            ⭐ thinking
          </button>
          <button class="mode-option" class:active={mode === 'instant'} on:click={() => selectMode('instant')}>
            ⚡ instant
          </button>
        </div>
      {/if}
    </div>

    <!-- Title -->
    <div class="title-area">
      {#if editing}
        <input
          class="title-input"
          bind:value={editValue}
          on:blur={commitEdit}
          on:keydown={handleEditKey}
          autofocus
        />
      {:else}
        <h1 class="title" on:click={startEdit} title="Clique para editar">
          {title}
        </h1>
      {/if}
    </div>
  </div>

  <div class="header-right">
    <!-- Menu -->
    <div class="menu-container">
      <button
        class="icon-btn"
        on:click|stopPropagation={() => showMenu = !showMenu}
        aria-label="Menu"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="5" r="1" fill="currentColor" stroke="none"/>
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>
          <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none"/>
        </svg>
      </button>
      {#if showMenu}
        <div class="header-menu">
          <button class="menu-item" on:click={() => { dispatch('clear'); showMenu = false; }}>
            🗑️ Limpar chat
          </button>
          <button class="menu-item" on:click={() => { dispatch('export'); showMenu = false; }}>
            📥 Exportar
          </button>
        </div>
      {/if}
    </div>
  </div>
</header>

<style>
  .chat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 56px;
    min-height: 56px;
    padding: 0 16px;
    background: var(--luna-surface);
    border-bottom: 1px solid var(--luna-border);
    flex-shrink: 0;
    z-index: 10;
  }
  .header-left {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
    min-width: 0;
  }
  .mode-dropdown-container {
    position: relative;
    flex-shrink: 0;
  }
  .mode-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: var(--luna-elevated);
    border: 1px solid var(--luna-border);
    border-radius: 8px;
    color: var(--luna-text);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .mode-btn:hover:not(:disabled) {
    border-color: rgba(255,255,255,0.12);
  }
  .mode-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .mode-icon { font-size: 14px; }
  .mode-text { font-weight: 500; }
  .mode-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    background: var(--luna-elevated);
    border: 1px solid var(--luna-border);
    border-radius: 8px;
    padding: 4px;
    z-index: 100;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    min-width: 140px;
  }
  .mode-option {
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
  .mode-option:hover, .mode-option.active {
    background: rgba(255,255,255,0.06);
  }
  .title-area {
    flex: 1;
    min-width: 0;
  }
  .title {
    font-size: 15px;
    font-weight: 500;
    color: var(--luna-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
    margin: 0;
    padding: 4px 8px;
    border-radius: 6px;
    transition: background 0.15s;
    line-height: 1.4;
  }
  .title:hover {
    background: rgba(255,255,255,0.04);
  }
  .title-input {
    font-size: 15px;
    font-weight: 500;
    color: var(--luna-text);
    background: var(--luna-bg);
    border: 1px solid var(--luna-primary);
    border-radius: 6px;
    padding: 4px 8px;
    outline: none;
    width: 100%;
    max-width: 300px;
  }
  .header-right {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  .menu-container {
    position: relative;
  }
  .icon-btn {
    background: none;
    border: none;
    color: var(--luna-text-secondary);
    cursor: pointer;
    padding: 8px;
    border-radius: 8px;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
  }
  .icon-btn:hover {
    background: rgba(255,255,255,0.06);
    color: var(--luna-text);
  }
  .header-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    background: var(--luna-elevated);
    border: 1px solid var(--luna-border);
    border-radius: 8px;
    padding: 4px;
    z-index: 100;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    min-width: 160px;
  }
  .menu-item {
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
  .menu-item:hover {
    background: rgba(255,255,255,0.06);
  }
</style>
