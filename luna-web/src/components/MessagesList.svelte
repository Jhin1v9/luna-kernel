<script>
  import { onMount, tick } from 'svelte';
  import { scrollManager } from '../utils.js';
  import UserMessage from './UserMessage.svelte';
  import AssistantMessage from './AssistantMessage.svelte';
  import ThinkingBubble from './ThinkingBubble.svelte';
  import ToolCard from './ToolCard.svelte';

  export let messages = [];

  let listEl;
  let userScrolledUp = false;
  let showNewMessagesBadge = false;

  $: if (messages.length > 0) {
    tick().then(() => {
      if (!userScrolledUp) {
        scrollManager.scrollToBottom(listEl, 'smooth');
      } else {
        showNewMessagesBadge = true;
      }
    });
  }

  function handleScroll() {
    if (!listEl) return;
    const nearBottom = scrollManager.isNearBottom(listEl, 100);
    userScrolledUp = !nearBottom;
    if (nearBottom) showNewMessagesBadge = false;
  }

  function scrollToBottom() {
    scrollManager.scrollToBottom(listEl, 'smooth');
    userScrolledUp = false;
    showNewMessagesBadge = false;
  }

  onMount(() => {
    scrollManager.scrollToBottom(listEl, 'auto');
  });
</script>

<div
  class="messages-list"
  bind:this={listEl}
  on:scroll={handleScroll}
  aria-live="polite"
  aria-label="Mensagens do chat"
>
  {#if messages.length === 0}
    <div class="welcome">
      <div class="welcome-icon">🌙</div>
      <h2 class="welcome-title">Bem-vindo a Luna Web</h2>
      <p class="welcome-subtitle">Como posso ajudar voce hoje?</p>
      <div class="welcome-suggestions">
        <button class="suggestion" on:click>
          💻 Crie um app React com Tailwind
        </button>
        <button class="suggestion" on:click>
          🔍 Pesquise as ultimas noticias de IA
        </button>
        <button class="suggestion" on:click>
          🐍 Execute um script Python
        </button>
      </div>
    </div>
  {:else}
    <div class="messages-container">
      {#each messages as message (message.id)}
        <div class="message-wrapper" class:system-msg={message.type === 'system' || message.type === 'error'}>
          {#if message.type === 'user'}
            <UserMessage content={message.content} timestamp={message.timestamp} files={message.files} />
          {:else if message.type === 'assistant'}
            <AssistantMessage content={message.content} timestamp={message.timestamp} />
          {:else if message.type === 'thinking'}
            <ThinkingBubble text={message.content} />
          {:else if message.type === 'tool'}
            <ToolCard
              tool={message.tool}
              params={message.params}
              result={message.result}
              duration={message.duration}
            />
          {:else if message.type === 'system' || message.type === 'error'}
            <div class="system-banner" class:error={message.type === 'error'}>
              {message.content}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if showNewMessagesBadge}
    <button class="new-messages-badge" on:click={scrollToBottom}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
      Novas mensagens
    </button>
  {/if}
</div>

<style>
  .messages-list {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 16px;
    position: relative;
    scroll-behavior: smooth;
  }
  .messages-container {
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-width: 900px;
    margin: 0 auto;
    width: 100%;
  }
  .message-wrapper {
    animation: fadeInUp 300ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  .message-wrapper.system-msg {
    animation: fadeIn 200ms ease;
  }
  @keyframes fadeInUp {
    from { opacity: 0; transform: translateY(20px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 50vh;
    text-align: center;
    animation: fadeInUp 500ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  .welcome-icon {
    font-size: 48px;
    margin-bottom: 16px;
  }
  .welcome-title {
    font-size: 24px;
    font-weight: 600;
    color: var(--luna-text);
    margin-bottom: 8px;
  }
  .welcome-subtitle {
    font-size: 15px;
    color: var(--luna-text-secondary);
    margin-bottom: 24px;
  }
  .welcome-suggestions {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    max-width: 400px;
  }
  .suggestion {
    padding: 12px 16px;
    background: var(--luna-surface);
    border: 1px solid var(--luna-border);
    border-radius: 10px;
    color: var(--luna-text);
    font-size: 14px;
    cursor: pointer;
    text-align: left;
    transition: all 0.2s;
  }
  .suggestion:hover {
    background: var(--luna-elevated);
    border-color: rgba(255,255,255,0.1);
    transform: translateY(-1px);
  }
  .system-banner {
    padding: 10px 16px;
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.2);
    border-radius: 8px;
    color: var(--luna-text-secondary);
    font-size: 13px;
    text-align: center;
  }
  .system-banner.error {
    background: rgba(239, 68, 68, 0.1);
    border-color: rgba(239, 68, 68, 0.2);
    color: #fca5a5;
  }
  .new-messages-badge {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    padding: 8px 16px;
    background: var(--luna-primary);
    color: white;
    border: none;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    box-shadow: 0 4px 16px rgba(233, 69, 96, 0.4);
    animation: fadeIn 200ms ease;
    z-index: 10;
    transition: transform 0.15s;
  }
  .new-messages-badge:hover {
    transform: translateX(-50%) translateY(-2px);
  }
</style>
