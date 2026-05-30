<script>
  import { onMount, onDestroy } from 'svelte';
  import { currentMode, isStreaming } from '../stores.js';
  import {
    BRIGHT_STARS,
    CONSTELLATION_LINES,
    getValidLines,
    buildStarIndex,
  } from '../lib/starData.js';

  let canvas;
  let ctx;
  let animId;
  let w, h;
  let stars = [];        // bright named stars
  let bgStars = [];      // random background stars
  let allStars = [];     // combined for dynamic connections
  let lines = [];        // constellation line indices
  let dynLines = [];     // dynamic proximity lines
  let starIndex = {};
  let time = 0;

  const BG_STAR_COUNT = 400;
  const DYN_CONNECT_DIST = 90;
  const MAX_DYN_PER_STAR = 3;

  // ─── Helpers ───────────────────────────────────────────────

  function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)]
      : [255, 255, 255];
  }

  // ─── Mode behaviour ────────────────────────────────────────

  const MODE_BEHAVIOR = {
    instant:  { twinkleMult: 1.6, brightnessMult: 1.25, drift: false, speed: 0 },
    thinking: { twinkleMult: 1.0, brightnessMult: 1.00, drift: false, speed: 0 },
    agent:    { twinkleMult: 1.1, brightnessMult: 1.05, drift: true,  speed: 0.4 },
    swarm:    { twinkleMult: 1.9, brightnessMult: 1.20, drift: true,  speed: 1.0 },
  };

  // ─── Init ──────────────────────────────────────────────────

  function initStars() {
    starIndex = buildStarIndex(BRIGHT_STARS);
    const validLines = getValidLines(BRIGHT_STARS, CONSTELLATION_LINES);
    lines = validLines.map(([a, b]) => [starIndex[a], starIndex[b]]);

    // Bright stars from real catalogue
    stars = BRIGHT_STARS.map((s) => ({
      ...s,
      x: 0,
      y: 0,
      phase: Math.random() * Math.PI * 2,
      twinkleSpeed: Math.random() * 0.4 + 0.4,
      baseRadius: Math.max(0.5, (6.2 - s.mag) * 0.62),
      baseOpacity: Math.max(0.25, Math.min(0.9, (6.5 - s.mag) * 0.16)),
      rgb: hexToRgb(s.color),
    }));

    // Background filler stars
    bgStars = [];
    for (let i = 0; i < BG_STAR_COUNT; i++) {
      const mag = Math.random() * 2.8 + 3.8;
      bgStars.push({
        nx: Math.random(),
        ny: Math.random(),
        phase: Math.random() * Math.PI * 2,
        twinkleSpeed: Math.random() * 0.25 + 0.15,
        baseRadius: Math.max(0.25, (6.8 - mag) * 0.32),
        baseOpacity: Math.random() * 0.08 + 0.04,
        rgb: [210 + Math.random() * 40, 220 + Math.random() * 30, 255],
        driftVx: (Math.random() - 0.5) * 0.015,
      });
    }

    projectStars();
    buildDynamicLines();
  }

  function projectStars() {
    for (const s of stars) {
      s.x = (s.ra / 24) * w;
      s.y = ((90 - s.dec) / 180) * h;
    }
    for (const s of bgStars) {
      s.x = s.nx * w;
      s.y = s.ny * h;
    }
    // Combined list for dynamic connections
    allStars = [...stars, ...bgStars];
  }

  function buildDynamicLines() {
    dynLines = [];
    const maxSq = DYN_CONNECT_DIST * DYN_CONNECT_DIST;
    for (let i = 0; i < allStars.length; i++) {
      let count = 0;
      for (let j = i + 1; j < allStars.length; j++) {
        const dx = allStars[i].x - allStars[j].x;
        const dy = allStars[i].y - allStars[j].y;
        const distSq = dx * dx + dy * dy;
        if (distSq < maxSq && count < MAX_DYN_PER_STAR) {
          dynLines.push({
            i,
            j,
            dist: Math.sqrt(distSq),
            phase: Math.random() * Math.PI * 2,
            speed: Math.random() * 0.3 + 0.2,
          });
          count++;
        }
      }
    }
  }

  // ─── Draw ──────────────────────────────────────────────────

  function getAccent() {
    try {
      return (
        getComputedStyle(document.documentElement)
          .getPropertyValue('--luna-accent')
          .trim() || '#a855f7'
      );
    } catch {
      return '#a855f7';
    }
  }

  function drawSoftGlow(x, y, radius, opacity, rgb) {
    // Soft radial glow — same style for all stars, just scaled by brightness
    const glowR = radius * 7;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, glowR);
    grad.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${opacity * 0.45})`);
    grad.addColorStop(0.4, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${opacity * 0.1})`);
    grad.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
    ctx.fillStyle = grad;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(x, y, glowR, 0, Math.PI * 2);
    ctx.fill();
  }

  function draw() {
    if (!ctx) return;

    // Deep space background with subtle blue tint
    const spaceGrad = ctx.createLinearGradient(0, 0, 0, h);
    spaceGrad.addColorStop(0, '#080816');
    spaceGrad.addColorStop(1, '#020208');
    ctx.fillStyle = spaceGrad;
    ctx.fillRect(0, 0, w, h);

    const accent = getAccent();
    const behavior = MODE_BEHAVIOR[lastMode] || MODE_BEHAVIOR.thinking;
    const t = time * 0.001;

    const streamBoost = streamingActive ? 1.2 : 1.0;
    const twinkleMult = behavior.twinkleMult;
    const brightnessMult = behavior.brightnessMult * streamBoost;
    const driftEnabled = behavior.drift;
    const driftSpeed = behavior.speed;

    // ── Subtle nebula-like background gradient ──
    const bgGrad = ctx.createRadialGradient(w * 0.5, h * 0.4, 0, w * 0.5, h * 0.4, h * 0.9);
    bgGrad.addColorStop(0, 'rgba(25, 20, 50, 0.35)');
    bgGrad.addColorStop(0.5, 'rgba(15, 12, 30, 0.18)');
    bgGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // ── Dynamic proximity lines (the "web" effect) ──
    ctx.lineCap = 'round';
    for (const dl of dynLines) {
      const a = allStars[dl.i];
      const b = allStars[dl.j];
      if (!a || !b) continue;
      const pulse = Math.sin(t * dl.speed * twinkleMult + dl.phase) * 0.5 + 0.5;
      const alpha = (1 - dl.dist / DYN_CONNECT_DIST) * 0.06 * pulse * brightnessMult;
      if (alpha < 0.005) continue;

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = accent;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 0.4;
      ctx.stroke();
    }

    // ── Constellation lines (fixed, more visible) ──
    ctx.lineWidth = 1.0;
    ctx.lineCap = 'round';
    ctx.shadowColor = accent;
    ctx.shadowBlur = 8;
    for (const [i, j] of lines) {
      const a = stars[i];
      const b = stars[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < Math.max(w, h) * 0.28) {
        const pulse = Math.sin(t * 0.7 + i * 0.5) * 0.15 + 0.85;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.1 * pulse * brightnessMult;
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;

    // ── Background stars ──
    for (const s of bgStars) {
      if (driftEnabled) {
        s.nx += s.driftVx * driftSpeed * 0.008;
        if (s.nx < 0) s.nx += 1;
        if (s.nx > 1) s.nx -= 1;
        s.x = s.nx * w;
      }

      const pulse = Math.sin(t * s.twinkleSpeed * twinkleMult + s.phase);
      const opacity = s.baseOpacity * (0.5 + 0.5 * pulse) * brightnessMult;
      const radius = s.baseRadius * (0.8 + 0.2 * pulse);

      ctx.globalAlpha = Math.max(0, opacity);
      ctx.fillStyle = `rgb(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(0.2, radius), 0, Math.PI * 2);
      ctx.fill();
    }

    // ── Bright stars with soft glow (no circles, no crosses) ──
    for (const s of stars) {
      const pulse = Math.sin(t * s.twinkleSpeed * twinkleMult + s.phase);
      const opacity = s.baseOpacity * (0.55 + 0.45 * pulse) * brightnessMult;
      const radius = s.baseRadius * (0.92 + 0.08 * pulse);
      const [r, g, b] = s.rgb;

      // Soft glow — same gentle style for all stars
      drawSoftGlow(s.x, s.y, radius, opacity, s.rgb);

      // Star core
      ctx.globalAlpha = Math.max(0, opacity);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(0.35, radius), 0, Math.PI * 2);
      ctx.fill();

      // Extra hot white core for very bright stars
      if (s.mag < 1.2) {
        ctx.globalAlpha = opacity * 0.9;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(s.x, s.y, Math.max(0.15, radius * 0.35), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.lineCap = 'butt';
  }

  // ─── Animation loop ────────────────────────────────────────

  function loop(now) {
    time = now;
    draw();
    animId = requestAnimationFrame(loop);
  }

  // ─── Resize ────────────────────────────────────────────────

  function resize() {
    w = window.innerWidth;
    h = window.innerHeight;
    if (canvas) {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    projectStars();
    buildDynamicLines();
  }

  // ─── Lifecycle ─────────────────────────────────────────────

  let lastMode = 'thinking';
  let streamingActive = false;
  let modeUnsub;
  let streamUnsub;

  onMount(() => {
    ctx = canvas.getContext('2d');
    resize();
    initStars();
    window.addEventListener('resize', resize);

    modeUnsub = currentMode.subscribe((m) => {
      lastMode = m;
    });

    streamUnsub = isStreaming.subscribe((s) => {
      streamingActive = s;
    });

    animId = requestAnimationFrame(loop);
  });

  onDestroy(() => {
    cancelAnimationFrame(animId);
    window.removeEventListener('resize', resize);
    if (modeUnsub) modeUnsub();
    if (streamUnsub) streamUnsub();
  });
</script>

<canvas bind:this={canvas} class="particle-bg" aria-hidden="true"></canvas>

<style>
  .particle-bg {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: -1;
    pointer-events: none;
  }
</style>
