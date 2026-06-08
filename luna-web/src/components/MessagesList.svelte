<script>
  import { onMount, tick } from 'svelte';
  import { isStreaming } from '../stores.js';
  import { scrollManager } from '../utils.js';
  import UserMessage from './UserMessage.svelte';
  import AssistantMessage from './AssistantMessage.svelte';
  import ThinkingBubble from './ThinkingBubble.svelte';
  import ToolCard from './ToolCard.svelte';
  import PlanCard from './PlanCard.svelte';
  import TypingIndicator from './TypingIndicator.svelte';

  export let messages = [];
  export let showTyping = false;
  export let currentMode = 'instant';
  export let hasMore = false;
  export let loadingMore = false;
  export let onLoadMore = () => {};
  export let onApprovePlan = () => {};
  export let onRejectPlan = () => {};
  export let onRevisePlan = () => {};

  let listEl;
  let userScrolledUp = false;
  let showNewMessagesBadge = false;

  // v10.3: lightweight virtualization
  let viewportHeight = 0;
  let scrollTop = 0;
  const ESTIMATED_HEIGHT = 80;
  const BUFFER = 5;

  $: totalHeight = messages.length * ESTIMATED_HEIGHT;
  $: startIdx = Math.max(0, Math.floor(scrollTop / ESTIMATED_HEIGHT) - BUFFER);
  $: endIdx = Math.min(messages.length, Math.ceil((scrollTop + viewportHeight) / ESTIMATED_HEIGHT) + BUFFER);
  $: visibleMessages = messages.slice(startIdx, endIdx);

  // Auto-scroll to bottom on new messages unless user scrolled up
  $: if (messages.length > 0) {
    tick().then(() => {
      if (!userScrolledUp) {
        scrollToBottom('smooth');
      } else {
        showNewMessagesBadge = true;
      }
    });
  }

  function handleScroll() {
    if (!listEl) return;
    scrollTop = listEl.scrollTop;
    const nearBottom = scrollManager.isNearBottom(listEl, 100);
    userScrolledUp = !nearBottom;
    if (nearBottom) showNewMessagesBadge = false;
  }

  function scrollToBottom(behavior = 'smooth') {
    if (listEl) {
      listEl.scrollTop = listEl.scrollHeight;
    }
    userScrolledUp = false;
    showNewMessagesBadge = false;
  }

  onMount(() => {
    scrollToBottom('auto');
  });
</script>

<div
  class="messages-list"
  bind:this={listEl}
  bind:clientHeight={viewportHeight}
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
    <div class="virtual-spacer" style="height: {totalHeight}px;">
      <div class="virtual-content" style="transform: translateY({startIdx * ESTIMATED_HEIGHT}px);">
        {#if hasMore && startIdx === 0}
          <div class="load-more-row">
            <button
              class="load-more-btn"
              on:click={onLoadMore}
              disabled={loadingMore}
            >
              {#if loadingMore}
                <span class="spinner" /> Carregando...
              {:else}
                ↑ Carregar mensagens anteriores
              {/if}
            </button>
          </div>
        {/if}
        {#each visibleMessages as message (message.id)}
          <div class="message-wrapper" class:system-msg={message.type === 'system' || message.type === 'error' || message.type === 'login_required'} style="min-height: {ESTIMATED_HEIGHT}px;">
            {#if message.type === 'user'}
              <UserMessage content={message.content} timestamp={message.timestamp} files={message.files} />
            {:else if message.type === 'assistant'}
              <AssistantMessage content={message.content} timestamp={message.timestamp} isStreaming={$isStreaming} />
            {:else if message.type === 'thinking'}
              <ThinkingBubble text={message.content} />
            {:else if message.type === 'tool'}
              <ToolCard
                tool={message.tool}
                params={message.params}
                result={message.result}
                duration={message.duration}
                status={message.status || 'running'}
                liveOutput={message.liveOutput || ''}
              />
            {:else if message.type === 'plan'}
              <PlanCard
                plan={message.content}
                status={message.status || 'awaiting_approval'}
                on:approve={onApprovePlan}
                on:reject={onRejectPlan}
                on:revise={(e) => onRevisePlan(e.detail)}
              />
            {:else if message.type === 'system' || message.type === 'error'}
              <div class="system-banner" class:error={message.type === 'error'}>
                {message.content}
              </div>
            {:else if message.type === 'login_required'}
              <div class="system-banner login-required">
                🔒 {message.content}
                <button class="retry-btn" on:click={() => location.reload()}>Recarregar página</button>
              </div>
            {/if}
          </div>
        {/each}
        <!-- v10.1-fix: Typing indicator for ALL modes when Luna is processing -->
        {#if showTyping && !messages.some(m => m.type === 'thinking')}
          <div class="message-wrapper" style="min-height: {ESTIMATED_HEIGHT}px;">
            <TypingIndicator text="Luna está respondendo" />
          </div>
        {/if}
      </div>
    </div>
  {/if}

  {#if showNewMessagesBadge}
    <button class="new-messages-badge" on:click={() => scrollToBottom('smooth')}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
      Novas mensagens
    </button>
  {/if}

  <!-- Bottom spacer to prevent last message being hidden behind input -->
  <div class="messages-bottom-spacer" aria-hidden="true"></div>
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
  .virtual-spacer {
    position: relative;
    width: 100%;
    max-width: 900px;
    margin: 0 auto;
  }
  .virtual-content {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: 100%;
  }
  .messages-bottom-spacer {
    height: 12px;
    flex-shrink: 0;
  }
  @media (max-width: 640px) {
    .messages-list {
      padding: 10px;
    }
    .virtual-content {
      gap: 12px;
    }
  }
  .message-wrapper {
    animation: fadeInUp 300ms cubic-bezier(0.4, 0, 0.2, 1);
    box-sizing: border-box;
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
    background: rgba(18, 18, 31, 0.6);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid var(--luna-border);
    border-radius: 10px;
    color: var(--luna-text);
    font-size: 14px;
    cursor: pointer;
    text-align: left;
    transition: all 0.2s;
  }
  .suggestion:hover {
    background: rgba(26, 26, 46, 0.75);
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
  .system-banner.login-required {
    background: rgba(245, 158, 11, 0.1);
    border-color: rgba(245, 158, 11, 0.2);
    color: #fbbf24;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .retry-btn {
    background: rgba(245, 158, 11, 0.2);
    border: 1px solid rgba(245, 158, 11, 0.3);
    color: #fbbf24;
    padding: 4px 12px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .retry-btn:hover {
    background: rgba(245, 158, 11, 0.3);
  }
  .load-more-row { display: flex; justify-content: center; padding: 12px 0; }
  .load-more-btn {
    background: var(--luna-surface); color: var(--luna-text);
    border: 1px solid var(--luna-border); border-radius: 999px;
    padding: 8px 16px; font-size: 13px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 8px;
    transition: all 0.15s;
  }
  .load-more-btn:hover:not(:disabled) { background: rgba(255,255,255,0.05); }
  .load-more-btn:disabled { opacity: 0.7; cursor: not-allowed; }
  .spinner {
    width: 14px; height: 14px; border: 2px solid var(--luna-border);
    border-top-color: var(--luna-text); border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .new-messages-badge {
    position: absolute;
    bottom: 80px;
    right: 24px;
    padding: 8px 16px;
    background: rgba(233, 69, 96, 0.9);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    color: white;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 20px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    box-shadow: 0 4px 24px rgba(233, 69, 96, 0.3), 0 0 0 1px rgba(255,255,255,0.05);
    animation: fadeIn 200ms ease;
    z-index: 10;
    transition: all 0.2s ease;
  }
  .new-messages-badge:hover {
    transform: translateY(-2px);
    background: rgba(233, 69, 96, 1);
    box-shadow: 0 6px 28px rgba(233, 69, 96, 0.4), 0 0 0 1px rgba(255,255,255,0.08);
  }
</style>
