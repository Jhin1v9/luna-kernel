<script>
  // Props
  export let phase = 0;
  export let size = 80;
  export let color = '#c9a227';
  export let showCraters = true;
  export let glowIntensity = 0.3;
  export let animated = true;
  export let extraStars = false;

  // Twinkling stars positions
  const BASE_STARS = [
    { x: 10, y: 15, r: 1.2, delay: 0 },
    { x: 85, y: 20, r: 0.8, delay: 0.3 },
    { x: 75, y: 75, r: 1.0, delay: 0.6 },
    { x: 20, y: 80, r: 0.6, delay: 0.9 },
    { x: 50, y: 8,  r: 0.7, delay: 1.2 },
    { x: 92, y: 55, r: 0.5, delay: 1.5 },
    { x: 8,  y: 50, r: 0.9, delay: 0.4 },
  ];

  const EXTRA_STARS = [
    { x: 35, y: 12, r: 0.5, delay: 0.7 },
    { x: 65, y: 85, r: 0.8, delay: 1.1 },
    { x: 15, y: 65, r: 0.4, delay: 1.8 },
    { x: 88, y: 35, r: 0.6, delay: 0.2 },
    { x: 45, y: 90, r: 0.5, delay: 1.4 },
  ];

  $: stars = extraStars ? [...BASE_STARS, ...EXTRA_STARS] : BASE_STARS;
  $: phaseNum = ((phase % 8) + 8) % 8;
</script>

<svg
  class="moon-phase-svg"
  class:animated
  viewBox="0 0 100 100"
  width={size}
  height={size}
  style="color: {color}; --glow-intensity: {glowIntensity};"
>
  <!-- Outer glow rings -->
  <circle cx="50" cy="50" r="44" fill="none" stroke="currentColor" stroke-width="0.3" opacity="0.1" />
  <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" stroke-width="0.5" opacity="0.15" />

  <!-- Stars -->
  {#each stars as star}
    <circle
      cx={star.x}
      cy={star.y}
      r={star.r}
      fill="currentColor"
      class="moon-star"
      style="animation-delay: {star.delay}s;"
    />
  {/each}

  <!-- Moon body -->
  <circle cx="50" cy="50" r="30" fill="#1a1a2e" stroke="currentColor" stroke-width="1.5" opacity="0.9" />

  <!-- Phase fill -->
  {#if phaseNum === 0}
    <circle cx="50" cy="50" r="28" fill="currentColor" opacity="0.05" />
  {:else if phaseNum === 1}
    <path d="M50,20 A30,30 0 0,1 50,80 A22,30 0 0,0 50,20" fill="currentColor" opacity="0.5" />
  {:else if phaseNum === 2}
    <path d="M50,20 A30,30 0 0,1 50,80 Z" fill="currentColor" opacity="0.6" />
  {:else if phaseNum === 3}
    <path d="M50,20 A30,30 0 0,1 50,80 A38,30 0 0,1 50,20" fill="currentColor" opacity="0.75" />
  {:else if phaseNum === 4}
    <circle cx="50" cy="50" r="28" fill="currentColor" opacity="0.9" />
  {:else if phaseNum === 5}
    <path d="M50,20 A30,30 0 0,0 50,80 A38,30 0 0,0 50,20" fill="currentColor" opacity="0.75" />
  {:else if phaseNum === 6}
    <path d="M50,20 A30,30 0 0,0 50,80 Z" fill="currentColor" opacity="0.6" />
  {:else if phaseNum === 7}
    <path d="M50,20 A30,30 0 0,0 50,80 A22,30 0 0,0 50,20" fill="currentColor" opacity="0.5" />
  {/if}

  <!-- Craters on full-ish phases -->
  {#if showCraters && phaseNum >= 3 && phaseNum <= 5}
    <circle cx="42" cy="42" r="3" fill="#1a1a2e" opacity="0.15" />
    <circle cx="58" cy="55" r="4" fill="#1a1a2e" opacity="0.12" />
    <circle cx="50" cy="65" r="2.5" fill="#1a1a2e" opacity="0.1" />
  {/if}
</svg>

<style>
  .moon-phase-svg {
    display: block;
    filter: drop-shadow(0 0 12px rgba(201, 162, 39, calc(var(--glow-intensity) * 0.8)));
  }

  .moon-phase-svg.animated {
    animation: moonPulse 3s ease-in-out infinite;
  }

  @keyframes moonPulse {
    0%, 100% {
      transform: scale(1);
      filter: drop-shadow(0 0 8px rgba(201, 162, 39, calc(var(--glow-intensity) * 0.5)));
    }
    50% {
      transform: scale(1.05);
      filter: drop-shadow(0 0 20px rgba(201, 162, 39, calc(var(--glow-intensity) * 1.2)));
    }
  }

  .moon-star {
    animation: twinkle 2s ease-in-out infinite;
    opacity: 0.4;
  }

  @keyframes twinkle {
    0%, 100% { opacity: 0.2; transform: scale(0.8); }
    50%      { opacity: 0.9; transform: scale(1.3); }
  }
</style>
