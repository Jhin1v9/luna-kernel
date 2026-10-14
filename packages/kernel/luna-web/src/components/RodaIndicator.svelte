<script>
  /**
   * RodaIndicator — visor do provider ativo da roda (decreto owner 13/10/2026).
   * Cardzinho no topo: nome curto (GPT-4o, Gemini, Nemotron…) + bolinha de
   * status (verde = ok, laranja = rate limit, vermelho = morto, cinza = ?).
   * Hover mostra a fila completa. Poll de 8s em ./api/roda/status.
   * Histórico: existia como widget HTML injetado no dist (tmp-roda-widget.html)
   * e SUMIA a cada rebuild — esta versão é componente nativo do produto.
   */
  import { onMount, onDestroy } from 'svelte';

  const SHORT = {
    'kimi-coding': 'Kimi', 'kimi-for-coding': 'Kimi', 'gemini': 'Gemini',
    'github-models': 'GPT-4o', 'pollinations': 'Pollinations', 'nvidia-nim': 'NVIDIA',
    'openrouter-nemotron-super': 'Nemotron', 'openrouter-nemotron-ultra': 'Nemotron Ultra',
    'openrouter-gemma-31b': 'Gemma', 'openrouter-gemma-26b': 'Gemma 26B',
    'openrouter-laguna-s': 'Laguna', 'openrouter-laguna-xs': 'Laguna XS',
    'openrouter-north-code': 'North', 'openrouter-dots-note': 'Dots',
    'openrouter-nano-omni': 'Nano Omni', 'openrouter-lightning': 'Lightning',
    'openrouter-lfm': 'LFM', 'fcc-local': 'FCC', 'colibri-local': 'Colibri'
  };

  function short(id) {
    if (!id) return '?';
    let s = String(id).replace(/^(roda|agent):/, '');
    if (SHORT[s]) return SHORT[s];
    if (s.indexOf('openrouter-') === 0) s = s.slice(11);
    return s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ');
  }

  let dot = 'unknown';
  let name = 'conectando…';
  let providers = [];
  let transitioning = false;
  let timer = null;

  function render(d) {
    if (!d || !d.ok) { dot = 'unknown'; name = 'sem roda'; providers = []; return; }
    providers = d.providers || [];
    const cur = providers.find((p) => p.current) || null;
    if (cur) {
      dot = cur.status || 'unknown';
      transitioning = true;
      setTimeout(() => { name = short(cur.id); transitioning = false; }, 180);
    }
  }

  function tick() {
    fetch('./api/roda/status').then((r) => r.json()).then(render).catch(() => {
      dot = 'unknown'; name = 'offline'; providers = [];
    });
  }

  onMount(() => { tick(); timer = setInterval(tick, 8000); });
  onDestroy(() => { if (timer) clearInterval(timer); });
</script>

<div class="roda-widget" title="Provider atual da roda">
  <span class="roda-dot {dot}"></span>
  <span class="roda-name" class:fading={transitioning}>{name}</span>
  <div class="roda-tip">
    <div class="roda-tip-title">Roda de providers</div>
    {#each providers as p}
      <div class="roda-row" class:current={p.current}>
        <span class="mini {p.status || 'unknown'}"></span>{short(p.id)}
      </div>
    {:else}
      <div class="roda-row">roda offline</div>
    {/each}
  </div>
</div>

<style>
  .roda-widget { position: relative; display: flex; align-items: center; gap: 8px;
    padding: 6px 12px; background: rgba(10, 15, 30, 0.6);
    border: 1px solid rgba(120, 140, 255, 0.18); border-radius: 999px;
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    cursor: default; user-select: none; transition: border-color .3s; flex-shrink: 0; }
  .roda-widget:hover { border-color: rgba(120, 140, 255, 0.45); }
  .roda-dot { width: 9px; height: 9px; border-radius: 50%; background: #64748b;
    box-shadow: 0 0 8px currentColor; transition: background .4s; flex-shrink: 0; }
  .roda-dot.ok { background: #22c55e; color: #22c55e; }
  .roda-dot.limited { background: #f59e0b; color: #f59e0b; }
  .roda-dot.dead { background: #ef4444; color: #ef4444; }
  .roda-dot.unknown { background: #64748b; color: #64748b; }
  .roda-name { color: #e2e8f0; font-size: 12.5px; font-weight: 600; letter-spacing: .02em;
    transition: opacity .25s; white-space: nowrap; }
  .roda-name.fading { opacity: 0; }
  .roda-tip { position: absolute; top: calc(100% + 10px); right: 0; min-width: 210px;
    background: rgba(8, 12, 26, 0.95); border: 1px solid rgba(120,140,255,0.2);
    border-radius: 12px; padding: 10px 12px; display: none;
    backdrop-filter: blur(16px); box-shadow: 0 8px 32px rgba(0,0,0,0.5); z-index: 60; }
  .roda-widget:hover .roda-tip { display: block; }
  .roda-row { display: flex; align-items: center; gap: 8px; padding: 4px 2px;
    font-size: 11.5px; color: #94a3b8; font-weight: 500; }
  .roda-row.current { color: #e2e8f0; font-weight: 600; }
  .mini { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .mini.ok { background: #22c55e; } .mini.limited { background: #f59e0b; }
  .mini.dead { background: #ef4444; } .mini.unknown { background: #475569; }
  .roda-tip-title { font-size: 10px; text-transform: uppercase; letter-spacing: .1em;
    color: #475569; padding: 2px 2px 6px; font-weight: 600; }
</style>
