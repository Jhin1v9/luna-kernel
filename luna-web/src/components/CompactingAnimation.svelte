<script>
  import { compactState } from '../stores.js';

  // Moon phase SVG paths — 8 phases
  const PHASES = [
    { name: '🌑 Nova', color: '#1a1a2e' },        // 0 — dark
    { name: '🌒 Crescente', color: '#4a4a6a' },   // 1
    { name: '🌓 Quarto', color: '#6a6a8a' },      // 2
    { name: '🌔 Gibosa', color: '#8a8aaa' },      // 3
    { name: '🌕 Cheia', color: '#e2e8f0' },       // 4 — full
    { name: '🌖 Gibosa', color: '#8a8aaa' },      // 5
    { name: '🌗 Quarto', color: '#6a6a8a' },      // 6
    { name: '🌘 Minguante', color: '#4a4a6a' },   // 7
  ];

  // Pulsing stars
  const STARS = [
    { x: 10, y: 15, r: 1.2, delay: 0 },
    { x: 85, y: 20, r: 0.8, delay: 0.3 },
    { x: 75, y: 75, r: 1.0, delay: 0.6 },
    { x: 20, y: 80, r: 0.6, delay: 0.9 },
    { x: 50, y: 8,  r: 0.7, delay: 1.2 },
    { x: 92, y: 55, r: 0.5, delay: 1.5 },
    { x: 8,  y: 50, r: 0.9, delay: 0.4 },
  ];
</script>

{#if $compactState.active}
  <div class="compacting-backdrop">
    <div class="compacting-card">
      <!-- Animated moon SVG -->
      <svg class="moon-svg" viewBox="0 0 100 100" width="80" height="80">
        <!-- Background circle (always visible glow) -->
        <circle cx="50" cy="50" r="38" fill="none" stroke="currentColor" stroke-width="0.5" opacity="0.15" />
        <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" stroke-width="0.3" opacity="0.08" />

        <!-- Stars -->
        {#each STARS as star, i}
          <circle cx={star.x} cy={star.y} r={star.r}
            fill="currentColor"
            class="star"
            style="animation-delay: {star.delay}s;"
          />
        {/each}

        <!-- Moon body -->
        <circle cx="50" cy="50" r="30" fill="#1a1a2e" stroke="currentColor" stroke-width="1.5" opacity="0.9" />

        <!-- Phase fill — animated clip-path or circle -->
        {#if $compactState.phase === 0}
          <!-- New moon — almost invisible -->
          <circle cx="50" cy="50" r="28" fill="currentColor" opacity="0.05" />
        {:else if $compactState.phase === 1}
          <!-- Waxing crescent -->
          <path d="M50,20 A30,30 0 0,1 50,80 A22,30 0 0,0 50,20" fill="currentColor" opacity="0.5" />
        {:else if $compactState.phase === 2}
          <!-- First quarter -->
          <path d="M50,20 A30,30 0 0,1 50,80 Z" fill="currentColor" opacity="0.6" />
        {:else if $compactState.phase === 3}
          <!-- Waxing gibbous -->
          <path d="M50,20 A30,30 0 0,1 50,80 A38,30 0 0,1 50,20" fill="currentColor" opacity="0.75" />
        {:else if $compactState.phase === 4}
          <!-- Full moon -->
          <circle cx="50" cy="50" r="28" fill="currentColor" opacity="0.9" />
        {:else if $compactState.phase === 5}
          <!-- Waning gibbous -->
          <path d="M50,20 A30,30 0 0,0 50,80 A38,30 0 0,0 50,20" fill="currentColor" opacity="0.75" />
        {:else if $compactState.phase === 6}
          <!-- Last quarter -->
          <path d="M50,20 A30,30 0 0,0 50,80 Z" fill="currentColor" opacity="0.6" />
        {:else if $compactState.phase === 7}
          <!-- Waning crescent -->
          <path d="M50,20 A30,30 0 0,0 50,80 A22,30 0 0,0 50,20" fill="currentColor" opacity="0.5" />
        {/if}

        <!-- Subtle crater details on full moon -->
        {#if $compactState.phase >= 3 && $compactState.phase <= 5}
          <circle cx="42" cy="42" r="3" fill="#1a1a2e" opacity="0.15" />
          <circle cx="58" cy="55" r="4" fill="#1a1a2e" opacity="0.12" />
          <circle cx="50" cy="65" r="2.5" fill="#1a1a2e" opacity="0.1" />
        {/if}
      </svg>

      <!-- Text -->
      <div class="compacting-text">
        <span class="compacting-title">Compactando contexto</span>
        <span class="compacting-phase">{PHASES[$compactState.phase]?.name || '🌑'}</span>
        <span class="compacting-message">{$compactState.message}</span>
      </div>

      <!-- Progress steps -->
      {#if $compactState.steps.length > 0}
        <div class="compacting-steps">
          {#each $compactState.steps.slice(-4) as step, i}
            <span class="step" class:done={i < $compactState.steps.slice(-4).length - 1 || $compactState.phase > i}>
              {step}
            </span>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .compacting-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(10, 10, 26, 0.85);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
    animation: fadeIn 0.3s ease;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .compacting-card {
    background: #12121f;
    border: 1px solid rgba(168, 85, 247, 0.2);
    border-radius: 16px;
    padding: 32px 40px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    box-shadow: 0 0 40px rgba(168, 85, 247, 0.15), 0 8px 32px rgba(0,0,0,0.4);
    animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    max-width: 420px;
    width: 90%;
  }

  @keyframes slideUp {
    from { transform: translateY(20px); opacity: 0; }
    to   { transform: translateY(0); opacity: 1; }
  }

  .moon-svg {
    color: #c9a227;
    animation: moonPulse 3s ease-in-out infinite;
    filter: drop-shadow(0 0 12px rgba(201, 162, 39, 0.3));
  }

  @keyframes moonPulse {
    0%, 100% { transform: scale(1); filter: drop-shadow(0 0 8px rgba(201, 162, 39, 0.2)); }
    50%      { transform: scale(1.05); filter: drop-shadow(0 0 20px rgba(201, 162, 39, 0.45)); }
  }

  .star {
    animation: twinkle 2s ease-in-out infinite;
    opacity: 0.4;
  }

  @keyframes twinkle {
    0%, 100% { opacity: 0.2; transform: scale(0.8); }
    50%      { opacity: 0.9; transform: scale(1.3); }
  }

  .compacting-text {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    text-align: center;
  }

  .compacting-title {
    font-size: 1.15rem;
    font-weight: 600;
    color: #e2e8f0;
    letter-spacing: 0.02em;
  }

  .compacting-phase {
    font-size: 0.85rem;
    color: #c9a227;
    font-weight: 500;
    opacity: 0.85;
  }

  .compacting-message {
    font-size: 0.8rem;
    color: #94a3b8;
    margin-top: 4px;
    max-width: 320px;
    line-height: 1.4;
  }

  .compacting-steps {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    margin-top: 8px;
  }

  .step {
    font-size: 0.75rem;
    color: #64748b;
    padding: 6px 12px;
    background: rgba(255,255,255,0.03);
    border-radius: 8px;
    border-left: 2px solid rgba(168, 85, 247, 0.3);
    transition: all 0.3s ease;
  }

  .step.done {
    color: #94a3b8;
    border-left-color: #22c55e;
    background: rgba(34, 197, 94, 0.05);
  }
</style>
