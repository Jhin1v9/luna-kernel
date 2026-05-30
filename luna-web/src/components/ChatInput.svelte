<script>
  import { onMount, tick } from 'svelte';
  import { planModeState } from '../stores.js';
  import { Search, FileSearch, Shield, Eye } from 'lucide-svelte';

  export let onSend = () => {};
  export let onCancel = () => {};
  export let disabled = false;
  export let placeholder = $planModeState.active ? 'Descreva o caso para investigação...' : 'Mensagem Luna...';
  $: placeholder = $planModeState.active ? 'Descreva o caso para investigação...' : 'Mensagem Luna...';

  let text = '';
  let textareaEl;
  let files = [];
  let isDragging = false;
  let fileInputEl;

  // Slash commands
  const COMMANDS = [
    { cmd: '/plan', desc: 'Modo Detetive — planejar antes de executar', icon: 'search', lucide: Search },
    { cmd: '/tarefa', desc: 'Criar tarefa', icon: '📋' },
    { cmd: '/lead', desc: 'Criar lead', icon: '👤' },
    { cmd: '/caixa', desc: 'Consultar caixa', icon: '💰' },
    { cmd: '/modo', desc: 'Trocar modo (instant/thinking/agent/swarm)', icon: '⚡' },
    { cmd: '/limpar', desc: 'Limpar chat', icon: '🗑️' },
    { cmd: '/nova', desc: 'Nova sessão', icon: '✨' },
    { cmd: '/ajuda', desc: 'Mostrar ajuda', icon: '❓' },
  ];

  let showCommands = false;
  let filteredCommands = [];
  let selectedCommandIndex = 0;

  function updateCommands() {
    if (!text.startsWith('/')) {
      showCommands = false;
      return;
    }
    const query = text.toLowerCase();
    filteredCommands = COMMANDS.filter(c => c.cmd.toLowerCase().startsWith(query));
    showCommands = filteredCommands.length > 0;
    selectedCommandIndex = 0;
  }

  function selectCommand(cmd) {
    text = cmd + ' ';
    showCommands = false;
    tick().then(() => {
      autoResize();
      textareaEl?.focus();
    });
  }

  function handleCommandKeydown(e) {
    if (!showCommands) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedCommandIndex = (selectedCommandIndex + 1) % filteredCommands.length;
      return true;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedCommandIndex = (selectedCommandIndex - 1 + filteredCommands.length) % filteredCommands.length;
      return true;
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      if (filteredCommands[selectedCommandIndex]) {
        selectCommand(filteredCommands[selectedCommandIndex].cmd);
      }
      return true;
    } else if (e.key === 'Escape') {
      showCommands = false;
      return true;
    }
    return false;
  }

  function autoResize() {
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    const maxHeight = 22 * 6; // 6 lines
    const scrollHeight = textareaEl.scrollHeight;
    textareaEl.style.height = Math.min(scrollHeight, maxHeight) + 'px';
    textareaEl.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  function handleInput() {
    autoResize();
    updateCommands();
  }

  function handleKeydown(e) {
    // Shift+Tab toggle plan mode
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      togglePlanMode();
      return;
    }
    if (handleCommandKeydown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === 'Escape' && disabled) {
      handleCancel();
    }
  }

  function togglePlanMode() {
    planModeState.update(s => ({ ...s, active: !s.active }));
  }

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;

    // If /plan command, toggle plan mode and send
    if (trimmed.startsWith('/plan')) {
      const planMessage = trimmed.slice(5).trim();
      planModeState.update(s => ({ ...s, active: true }));
      onSend(planMessage || '/plan', files.length > 0 ? files : undefined);
      text = '';
      files = [];
      tick().then(() => {
        autoResize();
        textareaEl?.focus();
      });
      return;
    }

    onSend(trimmed, files.length > 0 ? files : undefined);
    text = '';
    files = [];
    tick().then(() => {
      autoResize();
      textareaEl?.focus();
    });
  }

  function handleCancel() {
    onCancel();
  }

  function handleFileSelect(e) {
    const selected = Array.from(e.target.files || []);
    files = [...files, ...selected];
    if (fileInputEl) fileInputEl.value = '';
  }

  function removeFile(index) {
    files = files.filter((_, i) => i !== index);
  }

  function handleDrop(e) {
    e.preventDefault();
    isDragging = false;
    const dropped = Array.from(e.dataTransfer?.files || []);
    if (dropped.length > 0) {
      files = [...files, ...dropped];
    }
  }

  function handleDragOver(e) {
    e.preventDefault();
    isDragging = true;
  }

  function handleDragLeave() {
    isDragging = false;
  }

  onMount(() => {
    autoResize();
    textareaEl?.focus();
  });

  $: if (text) autoResize();
</script>

<div
  class="chat-input-container"
  class:dragging={isDragging}
  on:drop={handleDrop}
  on:dragover={handleDragOver}
  on:dragleave={handleDragLeave}
>
  {#if isDragging}
    <div class="drag-overlay">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/>
        <line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
      Solte os arquivos aqui
    </div>
  {/if}

  {#if files.length > 0}
    <div class="file-chips">
      {#each files as file, i}
        <div class="file-chip">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M13.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9.5L13.5 2z"/>
            <polyline points="13 2 13 9 20 9"/>
          </svg>
          <span class="chip-name">{file.name}</span>
          <button class="chip-remove" on:click={() => removeFile(i)} aria-label="Remover arquivo">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      {/each}
    </div>
  {/if}

  {#if showCommands}
    <div class="slash-commands">
      {#each filteredCommands as command, i}
        <button
          class="slash-command"
          class:selected={i === selectedCommandIndex}
          on:click={() => selectCommand(command.cmd)}
          on:mouseenter={() => selectedCommandIndex = i}
        >
          <span class="cmd-icon">
            {#if command.lucide}
              <svelte:component this={command.lucide} size={14} />
            {:else}
              {command.icon}
            {/if}
          </span>
          <span class="cmd-name">{command.cmd}</span>
          <span class="cmd-desc">{command.desc}</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="input-row">
    <input
      type="file"
      multiple
      bind:this={fileInputEl}
      on:change={handleFileSelect}
      class="hidden-input"
      aria-hidden="true"
    />

    <button
      class="attach-btn"
      on:click={() => fileInputEl?.click()}
      title="Anexar arquivo"
      aria-label="Anexar arquivo"
      disabled={disabled}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
      </svg>
    </button>

    <textarea
      bind:this={textareaEl}
      bind:value={text}
      on:input={handleInput}
      on:keydown={handleKeydown}
      {placeholder}
      {disabled}
      rows="1"
      class="chat-textarea"
      aria-label="Mensagem"
    />

    {#if disabled}
      <button
        class="cancel-btn"
        on:click={handleCancel}
        title="Cancelar (Esc)"
        aria-label="Cancelar"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <line x1="9" y1="9" x2="15" y2="15"/>
          <line x1="15" y1="9" x2="9" y2="15"/>
        </svg>
      </button>
    {:else}
      <button
        class="send-btn"
        on:click={handleSend}
        disabled={!text.trim()}
        title="Enviar (Enter)"
        aria-label="Enviar"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"/>
          <polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
      </button>
    {/if}
  </div>
</div>

<style>
  .chat-input-container {
    background: var(--luna-surface);
    border-top: 1px solid var(--luna-border);
    padding: 12px 16px;
    flex-shrink: 0;
    position: relative;
  }
  .chat-input-container.dragging::after {
    content: '';
    position: absolute;
    inset: 0;
    border: 2px dashed var(--luna-accent);
    border-radius: 12px;
    margin: 4px;
    pointer-events: none;
    background: var(--luna-accent-border);
  }
  .drag-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: rgba(10, 10, 26, 0.95);
    color: var(--luna-accent);
    font-size: 16px;
    font-weight: 500;
    z-index: 10;
    border-radius: 12px;
    margin: 4px;
  }
  .file-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--luna-border);
  }
  .file-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: var(--luna-elevated);
    border: 1px solid var(--luna-border);
    border-radius: 8px;
    font-size: 12px;
    color: var(--luna-text);
  }
  .chip-name {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip-remove {
    background: none;
    border: none;
    color: var(--luna-text-secondary);
    cursor: pointer;
    padding: 2px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.15s;
  }
  .chip-remove:hover {
    color: var(--luna-accent);
  }
  .input-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }
  .hidden-input {
    position: absolute;
    width: 0;
    height: 0;
    opacity: 0;
    pointer-events: none;
  }
  .attach-btn {
    background: none;
    border: none;
    color: var(--luna-text-secondary);
    cursor: pointer;
    padding: 10px;
    border-radius: 10px;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    min-width: 44px;
    min-height: 44px;
  }
  .attach-btn:hover:not(:disabled) {
    color: var(--luna-text);
    background: rgba(255,255,255,0.04);
  }
  .attach-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .chat-textarea {
    flex: 1;
    background: var(--luna-bg);
    border: 1px solid var(--luna-border);
    border-radius: 12px;
    padding: 10px 14px;
    color: var(--luna-text);
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.5;
    resize: none;
    outline: none;
    min-height: 44px;
    max-height: 132px;
    transition: border-color 0.2s;
  }
  .chat-textarea:focus {
    border-color: var(--luna-accent);
    box-shadow: 0 0 0 3px var(--luna-accent-border);
  }
  .chat-textarea::placeholder {
    color: var(--luna-text-secondary);
    opacity: 0.6;
  }
  .chat-textarea:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .send-btn {
    background: var(--luna-accent);
    border: none;
    color: white;
    cursor: pointer;
    padding: 10px;
    border-radius: 10px;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    min-width: 44px;
    min-height: 44px;
    box-shadow: 0 0 12px var(--luna-accent-border);
  }
  .send-btn:hover:not(:disabled) {
    background: var(--luna-accent);
    filter: brightness(1.15);
    transform: translateY(-1px);
    box-shadow: 0 0 20px var(--luna-accent-glow);
  }
  .send-btn:active:not(:disabled) {
    transform: translateY(0);
  }
  .send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    transform: none;
  }
  .cancel-btn {
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: #fca5a5;
    cursor: pointer;
    padding: 10px;
    border-radius: 10px;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    min-width: 44px;
    min-height: 44px;
    animation: fadeIn 150ms ease;
  }
  .cancel-btn:hover {
    background: rgba(239, 68, 68, 0.25);
  }
  .slash-commands {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 16px;
    right: 16px;
    background: var(--luna-elevated);
    border: 1px solid var(--luna-border);
    border-radius: 10px;
    padding: 4px;
    z-index: 100;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 20px var(--luna-accent-border);
    max-height: 240px;
    overflow-y: auto;
    animation: fadeIn 150ms ease;
  }
  .slash-command {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    color: var(--luna-text);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    border-radius: 6px;
    transition: all 0.12s;
  }
  .slash-command:hover,
  .slash-command.selected {
    background: var(--luna-accent-border);
  }
  .slash-command.selected {
    color: var(--luna-accent);
  }
  .cmd-icon {
    font-size: 14px;
    flex-shrink: 0;
  }
  .cmd-name {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 600;
    font-size: 12px;
    flex-shrink: 0;
  }
  .cmd-desc {
    color: var(--luna-text-secondary);
    font-size: 12px;
    margin-left: auto;
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: scale(0.9); }
    to { opacity: 1; transform: scale(1); }
  }
  @media (max-width: 768px) {
    .chat-input-container {
      padding: 8px 12px;
    }
    .chat-textarea {
      max-height: 88px; /* 4 lines on mobile */
    }
  }
</style>
