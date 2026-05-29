<script>
  export let text = '';
  export let isExpanded = false;

  $: displayText = text || '';
  $: lines = displayText.split('\n').filter(l => l.trim());
</script>

<div class="thinking-bubble" class:expanded={isExpanded}>
  <button class="thinking-header" on:click={() => isExpanded = !isExpanded}>
    <span class="thinking-icon">🧠</span>
    <span class="thinking-title">Pensando</span>
    <span class="thinking-dots">
      <span class="dot"></span>
      <span class="dot"></span>
      <span class="dot"></span>
    </span>
    <svg class="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class:rotated={isExpanded}>
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  </button>

  {#if isExpanded}
    <div class="thinking-content" transition:slideExpand>
      {#if lines.length > 0}
        {#each lines as line}
          <div class="thinking-line">{line}</div>
        {/each}
      {:else}
        <div class="thinking-placeholder">Analisando...</div>
      {/if}
    </div>
  {/if}
</div>

<script context="module">
  function slideExpand(node, params) {
    return {
      duration: 200,
      css: t => `max-height: ${t * 1000}px; opacity: ${t}; overflow: hidden;`
    };
  }
</script>

<style>
  .thinking-bubble {
    background: var(--luna-surface);
    border: 1px dashed rgba(255,255,255,0.1);
    border-radius: 12px;
    max-width: 85%;
    animation: fadeIn 300ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  .thinking-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: none;
    border: none;
    color: var(--luna-text-secondary);
    font-size: 13px;
    cursor: pointer;
    width: 100%;
    text-align: left;
    border-radius: 12px;
    transition: color 0.15s;
    font-family: 'JetBrains Mono', monospace;
  }
  .thinking-header:hover {
    color: var(--luna-text);
  }
  .thinking-icon {
    font-size: 15px;
    animation: pulse 2s infinite;
  }
  .thinking-title {
    font-weight: 500;
  }
  .thinking-dots {
    display: flex;
    gap: 3px;
    margin-left: 4px;
  }
  .dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--luna-text-secondary);
    animation: bounceDots 1.4s infinite ease-in-out both;
  }
  .dot:nth-child(1) { animation-delay: -0.32s; }
  .dot:nth-child(2) { animation-delay: -0.16s; }
  .chevron {
    margin-left: auto;
    transition: transform 0.2s;
    opacity: 0.5;
  }
  .chevron.rotated {
    transform: rotate(180deg);
  }
  .thinking-content {
    padding: 0 14px 12px;
    font-size: 13px;
    font-family: 'JetBrains Mono', monospace;
    color: var(--luna-text-secondary);
    line-height: 1.7;
  }
  .thinking-line {
    padding: 2px 0;
    word-break: break-word;
  }
  .thinking-placeholder {
    opacity: 0.5;
    font-style: italic;
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }
  @keyframes bounceDots {
    0%, 80%, 100% { transform: scale(0); opacity: 0.3; }
    40% { transform: scale(1); opacity: 1; }
  }
</style>
