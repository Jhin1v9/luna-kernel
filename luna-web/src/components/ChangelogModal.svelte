<script>
  import { onMount, onDestroy } from 'svelte';
  import { changelogModalOpen, changelogData } from '../stores.js';
  import MoonPhase from './MoonPhase.svelte';

  let currentPhase = 0;
  let phaseInterval;

  onMount(() => {
    phaseInterval = setInterval(() => {
      currentPhase = (currentPhase + 1) % 8;
    }, 1200);
  });

  onDestroy(() => {
    clearInterval(phaseInterval);
  });

  function closeModal() {
    changelogModalOpen.set(false);
    const data = $changelogData;
    if (data?.version) {
      localStorage.setItem('luna_changelog_seen', data.version);
    }
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') closeModal();
  }

  // v10.17-fix: Sanitize HTML to prevent XSS from CHANGELOG.json
  function sanitizeHtml(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const allowed = { strong: true, em: true, code: true, br: true };
    return raw
      .replace(/<([a-zA-Z0-9]+)[^>]*>/g, (match, tag) => allowed[tag.toLowerCase()] ? match : '')
      .replace(/<\/([a-zA-Z0-9]+)>/g, (match, tag) => allowed[tag.toLowerCase()] ? match : '');
  }

  $: updates = $changelogData?.updates || [];
  $: version = $changelogData?.version || '';
  $: date = $changelogData?.date || '';
</script>

{#if $changelogModalOpen}
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="changelog-backdrop" on:click={closeModal} on:keydown={handleKeydown}>
    <div class="changelog-card" on:click|stopPropagation>
      <!-- Close button -->
      <button class="close-btn" on:click={closeModal} aria-label="Fechar">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>

      <!-- Header with animated moon -->
      <div class="changelog-header">
        <div class="moon-container">
          <MoonPhase
            phase={currentPhase}
            size={90}
            color="#f0c040"
            glowIntensity={0.55}
            animated={true}
            extraStars={true}
          />
        </div>

        <div class="header-text">
          <div class="version-badge">v{version}</div>
          <h2 class="changelog-title">Novidades da Luna</h2>
          <p class="changelog-date">{date}</p>
        </div>
      </div>

      <!-- Updates list -->
      <div class="updates-container">
        {#each updates as category}
          <div class="update-category">
            <div class="category-header">
              <span class="category-icon">{category.icon}</span>
              <span class="category-name">{category.title}</span>
            </div>
            <ul class="category-items">
              {#each category.items as item}
                <li class="update-item">
                  <span class="item-bullet">✦</span>
                  <span class="item-text">{@html sanitizeHtml(item)}</span>
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      </div>

      <!-- Footer -->
      <div class="changelog-footer">
        <button class="continue-btn" on:click={closeModal}>
          Continuar ✨
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .changelog-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(5, 5, 15, 0.92);
    backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    animation: fadeIn 0.4s ease;
    padding: 16px;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .changelog-card {
    background: linear-gradient(180deg, #12121f 0%, #0d0d1a 100%);
    border: 1px solid rgba(168, 85, 247, 0.25);
    border-radius: 20px;
    padding: 0;
    display: flex;
    flex-direction: column;
    box-shadow:
      0 0 60px rgba(168, 85, 247, 0.12),
      0 0 120px rgba(99, 102, 241, 0.06),
      0 20px 60px rgba(0, 0, 0, 0.5);
    animation: slideUpScale 0.5s cubic-bezier(0.16, 1, 0.3, 1);
    max-width: 520px;
    width: 100%;
    max-height: 85vh;
    position: relative;
    overflow: hidden;
  }

  @keyframes slideUpScale {
    from { transform: translateY(30px) scale(0.95); opacity: 0; }
    to   { transform: translateY(0) scale(1); opacity: 1; }
  }

  /* Close button */
  .close-btn {
    position: absolute;
    top: 16px;
    right: 16px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #94a3b8;
    cursor: pointer;
    transition: all 0.2s ease;
    z-index: 10;
  }

  .close-btn:hover {
    background: rgba(255, 255, 255, 0.12);
    color: #e2e8f0;
    transform: rotate(90deg);
  }

  /* Header */
  .changelog-header {
    padding: 32px 32px 20px;
    text-align: center;
    border-bottom: 1px solid rgba(168, 85, 247, 0.1);
    position: relative;
  }

  .moon-container {
    display: flex;
    justify-content: center;
    margin-bottom: 20px;
    padding: 8px;
  }

  .moon-container :global(.moon-phase-svg) {
    filter: drop-shadow(0 0 24px rgba(240, 192, 64, 0.5)) drop-shadow(0 0 60px rgba(168, 85, 247, 0.15));
  }

  .version-badge {
    display: inline-block;
    background: rgba(168, 85, 247, 0.15);
    border: 1px solid rgba(168, 85, 247, 0.3);
    color: #c084fc;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    padding: 4px 14px;
    border-radius: 20px;
    margin-bottom: 10px;
    text-transform: uppercase;
  }

  .changelog-title {
    font-size: 1.6rem;
    font-weight: 700;
    color: #f1f5f9;
    margin: 0 0 4px;
    letter-spacing: -0.01em;
    background: linear-gradient(135deg, #f1f5f9 0%, #c084fc 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .changelog-date {
    font-size: 0.85rem;
    color: #64748b;
    margin: 0;
  }

  /* Updates scrollable area */
  .updates-container {
    padding: 20px 32px;
    overflow-y: auto;
    flex: 1;
    scrollbar-width: thin;
    scrollbar-color: rgba(168, 85, 247, 0.2) transparent;
  }

  .updates-container::-webkit-scrollbar {
    width: 4px;
  }

  .updates-container::-webkit-scrollbar-thumb {
    background: rgba(168, 85, 247, 0.25);
    border-radius: 4px;
  }

  .update-category {
    margin-bottom: 20px;
  }

  .category-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  }

  .category-icon {
    font-size: 1.1rem;
  }

  .category-name {
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #94a3b8;
  }

  .category-items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .update-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 10px;
    border-left: 2px solid rgba(168, 85, 247, 0.2);
    transition: background 0.2s ease;
  }

  .update-item:hover {
    background: rgba(255, 255, 255, 0.05);
    border-left-color: rgba(168, 85, 247, 0.5);
  }

  .item-bullet {
    color: #c084fc;
    font-size: 0.7rem;
    margin-top: 3px;
    flex-shrink: 0;
  }

  .item-text {
    font-size: 0.9rem;
    color: #cbd5e1;
    line-height: 1.5;
  }

  .item-text :global(strong) {
    color: #e2e8f0;
    font-weight: 600;
  }

  .item-text :global(code) {
    background: rgba(168, 85, 247, 0.1);
    color: #c084fc;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 0.8rem;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
  }

  /* Footer */
  .changelog-footer {
    padding: 16px 32px 24px;
    border-top: 1px solid rgba(168, 85, 247, 0.1);
    display: flex;
    justify-content: center;
  }

  .continue-btn {
    background: linear-gradient(135deg, #7c3aed 0%, #6366f1 100%);
    border: none;
    color: #fff;
    font-size: 0.95rem;
    font-weight: 600;
    padding: 12px 36px;
    border-radius: 12px;
    cursor: pointer;
    transition: all 0.3s ease;
    box-shadow: 0 4px 20px rgba(124, 58, 237, 0.3);
    letter-spacing: 0.02em;
  }

  .continue-btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 30px rgba(124, 58, 237, 0.45);
  }

  .continue-btn:active {
    transform: translateY(0);
  }

  /* Responsive */
  @media (max-width: 480px) {
    .changelog-card {
      max-height: 90vh;
    }

    .changelog-header {
      padding: 24px 20px 16px;
    }

    .changelog-title {
      font-size: 1.3rem;
    }

    .updates-container {
      padding: 16px 20px;
    }

    .changelog-footer {
      padding: 12px 20px 20px;
    }

    .continue-btn {
      width: 100%;
    }
  }
</style>
