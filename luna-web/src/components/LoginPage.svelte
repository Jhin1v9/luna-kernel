<script>
  import { onMount } from 'svelte';
  import { login } from '../api.js';
  import { user } from '../stores.js';
  import OrbBackground from './OrbBackground.svelte';

  let username = '';
  let password = '';
  let error = '';
  let loading = false;
  let mascotState = 'idle'; // idle | sleeping | thinking | happy
  let mascotText = '';
  let mascotTexts = [
    "E aí? Vamos fazer algo incrível?",
    "Tô de olho em você! 👁️",
    "*assobia* ...tô entediada, manda algo!",
    "Zzz... sonhando com código limpo...",
    "Deixa eu pensar... 🤔",
    "Pronta pra ação! 🚀",
    "Digita aí, tô esperando...",
  ];
  let textIndex = 0;
  let textInterval;
  let sleepTimeout;
  let showCard = false;
  let subtitleTyped = '';
  const fullSubtitle = 'Luna Web v5.0 — Agente Autônomo Inteligente';

  onMount(() => {
    // Entrance animation
    setTimeout(() => showCard = true, 100);
    
    // Typing effect for subtitle
    let i = 0;
    const typeInterval = setInterval(() => {
      if (i < fullSubtitle.length) {
        subtitleTyped += fullSubtitle[i];
        i++;
      } else {
        clearInterval(typeInterval);
      }
    }, 40);

    // Mascot text rotation
    mascotText = mascotTexts[0];
    textInterval = setInterval(() => {
      textIndex = (textIndex + 1) % mascotTexts.length;
      mascotText = mascotTexts[textIndex];
    }, 4000);

    // Sleep timeout
    resetSleep();

    return () => {
      clearInterval(textInterval);
      clearTimeout(sleepTimeout);
      clearInterval(typeInterval);
    };
  });

  function resetSleep() {
    clearTimeout(sleepTimeout);
    if (mascotState === 'sleeping') mascotState = 'idle';
    sleepTimeout = setTimeout(() => {
      mascotState = 'sleeping';
      mascotText = 'Zzz... sonhando com código limpo... 😴';
    }, 30000);
  }

  function handleInputFocus() {
    mascotState = 'thinking';
    mascotText = 'Deixa eu pensar... 🤔';
    resetSleep();
  }

  function handleInputBlur() {
    mascotState = 'idle';
    resetSleep();
  }

  function handleTyping() {
    mascotState = 'happy';
    mascotText = 'Isso aí! Quase lá... ✨';
    resetSleep();
  }

  async function handleSubmit() {
    if (!username.trim() || !password.trim()) {
      error = 'Preencha todos os campos';
      return;
    }
    loading = true;
    error = '';
    try {
      const res = await login(username, password);
      if (res.ok && res.token) {
        localStorage.setItem('luna_token', res.token);
        user.set(res.user);
      } else {
        error = res.error || 'Credenciais inválidas';
        mascotState = 'thinking';
        mascotText = 'Hmm... não reconheço essas credenciais 🤔';
      }
    } catch (e) {
      error = 'Erro de conexão';
    } finally {
      loading = false;
    }
  }

  function handleKeydown(e) {
    if (e.key === 'Enter') handleSubmit();
  }
</script>

<OrbBackground />

<div class="login-page">
  <!-- Left side: Mascot -->
  <div class="mascot-side">
    <div class="mascot-container">
      <div class="mascot-glow"></div>
      <div class="mascot-orb" class:sleeping={mascotState === 'sleeping'} class:thinking={mascotState === 'thinking'} class:happy={mascotState === 'happy'}>
        🌙
      </div>
      <div class="mascot-eyes" class:thinking={mascotState === 'thinking'} class:sleeping={mascotState === 'sleeping'} class:happy={mascotState === 'happy'}>
        <span class="eye left"></span>
        <span class="eye right"></span>
      </div>
    </div>
    
    <div class="mascot-bubble">
      <div class="bubble-tail"></div>
      <p class="bubble-text">{mascotText}</p>
    </div>

    <div class="branding">
      <h1 class="brand-title">Luna</h1>
      <p class="brand-subtitle">{subtitleTyped}<span class="cursor">|</span></p>
    </div>
  </div>

  <!-- Right side: Login card -->
  <div class="login-side">
    <div class="login-card" class:show={showCard}>
      <div class="scan-line"></div>
      
      <div class="card-header">
        <div class="logo-icon">🌙</div>
        <h2 class="card-title">Bem-vindo de volta</h2>
        <p class="card-desc">Entre com suas credenciais do NEXO</p>
      </div>

      {#if error}
        <div class="error-banner">{error}</div>
      {/if}

      <div class="form-group">
        <label>Usuário</label>
        <div class="input-wrap">
          <span class="input-icon">👤</span>
          <input
            type="text"
            placeholder="Digite seu usuário"
            bind:value={username}
            on:focus={handleInputFocus}
            on:blur={handleInputBlur}
            on:input={handleTyping}
            on:keydown={handleKeydown}
          />
        </div>
      </div>

      <div class="form-group">
        <label>Senha</label>
        <div class="input-wrap">
          <span class="input-icon">🔒</span>
          <input
            type="password"
            placeholder="••••"
            bind:value={password}
            on:focus={handleInputFocus}
            on:blur={handleInputBlur}
            on:input={handleTyping}
            on:keydown={handleKeydown}
          />
        </div>
      </div>

      <button class="login-btn" on:click={handleSubmit} disabled={loading}>
        {#if loading}
          <span class="btn-dots"><span></span><span></span><span></span></span>
        {:else}
          Entrar
        {/if}
      </button>

      <div class="users-hint">
        <span class="hint-label">Acesso restrito — CEOs NEXO Digital</span>
      </div>
    </div>
  </div>
</div>

<style>
  .login-page {
    position: fixed;
    inset: 0;
    display: flex;
    z-index: 1;
    background: #08080c;
    overflow: hidden;
  }

  /* ── Left side: Mascot ── */
  .mascot-side {
    flex: 1.2;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    position: relative;
    padding: 40px;
  }

  .mascot-container {
    position: relative;
    width: 200px;
    height: 200px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .mascot-glow {
    position: absolute;
    width: 180px;
    height: 180px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(233,69,96,0.15) 0%, transparent 70%);
    animation: glowPulse 3s ease-in-out infinite;
  }

  .mascot-orb {
    font-size: 100px;
    position: relative;
    z-index: 2;
    animation: float 4s ease-in-out infinite, rotateSlow 20s linear infinite;
    filter: drop-shadow(0 0 20px rgba(233,69,96,0.4));
    transition: all 0.5s ease;
  }

  .mascot-orb.thinking {
    animation: float 2s ease-in-out infinite, tilt 1s ease-in-out infinite alternate;
  }

  .mascot-orb.happy {
    animation: bounce 0.6s ease-in-out infinite;
  }

  .mascot-orb.sleeping {
    animation: floatSlow 6s ease-in-out infinite;
    opacity: 0.6;
    filter: drop-shadow(0 0 10px rgba(100,100,255,0.2));
  }

  .mascot-eyes {
    position: absolute;
    top: 55%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    gap: 20px;
    z-index: 3;
  }

  .eye {
    width: 12px;
    height: 12px;
    background: #fff;
    border-radius: 50%;
    box-shadow: 0 0 8px rgba(255,255,255,0.6);
    animation: blink 4s infinite;
  }

  .eye.left { animation-delay: 0.1s; }

  .mascot-eyes.thinking .eye {
    height: 3px;
    border-radius: 2px;
    animation: none;
    transform: rotate(-10deg);
  }

  .mascot-eyes.sleeping .eye {
    height: 2px;
    opacity: 0.3;
    animation: none;
  }

  .mascot-eyes.happy .eye {
    height: 6px;
    border-radius: 0 0 6px 6px;
    animation: blinkFast 1s infinite;
  }

  .mascot-bubble {
    margin-top: 24px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 16px;
    padding: 14px 20px;
    max-width: 280px;
    position: relative;
    backdrop-filter: blur(8px);
    animation: fadeInUp 0.5s ease;
  }

  .bubble-tail {
    position: absolute;
    top: -8px;
    left: 50%;
    transform: translateX(-50%);
    width: 0;
    height: 0;
    border-left: 8px solid transparent;
    border-right: 8px solid transparent;
    border-bottom: 8px solid rgba(255,255,255,0.08);
  }

  .bubble-text {
    color: #94a3b8;
    font-size: 13px;
    text-align: center;
    margin: 0;
    font-family: 'Inter', sans-serif;
    min-height: 20px;
    transition: opacity 0.3s;
  }

  .branding {
    margin-top: 40px;
    text-align: center;
  }

  .brand-title {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 48px;
    font-weight: 700;
    background: linear-gradient(135deg, #a78bfa, #22d3ee, #34d399);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin: 0;
    letter-spacing: -1px;
  }

  .brand-subtitle {
    color: #64748b;
    font-size: 14px;
    margin-top: 8px;
    font-family: 'JetBrains Mono', monospace;
  }

  .cursor {
    color: #e94560;
    animation: blinkCursor 1s step-end infinite;
  }

  /* ── Right side: Login card ── */
  .login-side {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px;
    min-width: 400px;
  }

  .login-card {
    width: 100%;
    max-width: 420px;
    background: rgba(15, 15, 22, 0.7);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 20px;
    padding: 40px 36px;
    position: relative;
    overflow: hidden;
    opacity: 0;
    transform: translateY(30px);
    transition: opacity 0.6s ease, transform 0.6s ease;
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.03),
      0 20px 60px rgba(0,0,0,0.4),
      0 0 40px rgba(233,69,96,0.05);
  }

  .login-card.show {
    opacity: 1;
    transform: translateY(0);
  }

  .scan-line {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent, rgba(233,69,96,0.4), transparent);
    animation: scanLine 4s ease-in-out infinite;
    pointer-events: none;
  }

  .card-header {
    text-align: center;
    margin-bottom: 32px;
  }

  .logo-icon {
    font-size: 40px;
    margin-bottom: 12px;
    animation: rotateSlow 15s linear infinite;
    display: inline-block;
  }

  .card-title {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 24px;
    font-weight: 700;
    color: #e2e8f0;
    margin: 0 0 6px 0;
  }

  .card-desc {
    color: #64748b;
    font-size: 14px;
    margin: 0;
  }

  .error-banner {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.2);
    color: #fca5a5;
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13px;
    margin-bottom: 20px;
    text-align: center;
  }

  .form-group {
    margin-bottom: 20px;
  }

  .form-group label {
    display: block;
    color: #94a3b8;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .input-wrap {
    display: flex;
    align-items: center;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 12px;
    padding: 0 14px;
    transition: all 0.2s ease;
  }

  .input-wrap:focus-within {
    border-color: rgba(233,69,96,0.4);
    box-shadow: 0 0 0 3px rgba(233,69,96,0.1), 0 0 20px rgba(233,69,96,0.08);
  }

  .input-icon {
    font-size: 16px;
    margin-right: 10px;
    opacity: 0.5;
  }

  .input-wrap input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: #e2e8f0;
    font-size: 14px;
    font-family: 'JetBrains Mono', monospace;
    padding: 14px 0;
    width: 100%;
  }

  .input-wrap input::placeholder {
    color: #475569;
  }

  .login-btn {
    width: 100%;
    padding: 14px;
    background: linear-gradient(135deg, #e94560, #ff6b6b);
    border: none;
    border-radius: 12px;
    color: white;
    font-size: 15px;
    font-weight: 600;
    font-family: 'Inter', sans-serif;
    cursor: pointer;
    transition: all 0.2s ease;
    margin-top: 8px;
    position: relative;
    overflow: hidden;
  }

  .login-btn:hover:not(:disabled) {
    transform: scale(1.02);
    box-shadow: 0 0 30px rgba(233,69,96,0.3);
  }

  .login-btn:disabled {
    opacity: 0.7;
    cursor: not-allowed;
  }

  .btn-dots {
    display: flex;
    gap: 6px;
    justify-content: center;
    align-items: center;
  }

  .btn-dots span {
    width: 6px;
    height: 6px;
    background: white;
    border-radius: 50%;
    animation: bounceDots 1.4s infinite ease-in-out both;
  }

  .btn-dots span:nth-child(1) { animation-delay: -0.32s; }
  .btn-dots span:nth-child(2) { animation-delay: -0.16s; }

  .users-hint {
    margin-top: 24px;
    text-align: center;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .hint-label {
    color: #475569;
    font-size: 12px;
  }

  .user-tag {
    font-size: 12px;
    font-weight: 500;
  }

  /* ── Animations ── */
  @keyframes glowPulse {
    0%, 100% { transform: scale(1); opacity: 0.6; }
    50% { transform: scale(1.2); opacity: 1; }
  }

  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-12px); }
  }

  @keyframes floatSlow {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-6px); }
  }

  @keyframes rotateSlow {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  @keyframes tilt {
    from { transform: rotate(-5deg); }
    to { transform: rotate(5deg); }
  }

  @keyframes bounce {
    0%, 100% { transform: translateY(0) scale(1); }
    50% { transform: translateY(-15px) scale(1.05); }
  }

  @keyframes blink {
    0%, 96%, 100% { transform: scaleY(1); }
    98% { transform: scaleY(0.1); }
  }

  @keyframes blinkFast {
    0%, 90%, 100% { transform: scaleY(1); }
    95% { transform: scaleY(0.1); }
  }

  @keyframes blinkCursor {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  @keyframes scanLine {
    0% { top: 0; opacity: 0; }
    10% { opacity: 1; }
    90% { opacity: 1; }
    100% { top: 100%; opacity: 0; }
  }

  @keyframes fadeInUp {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes bounceDots {
    0%, 80%, 100% { transform: scale(0); }
    40% { transform: scale(1); }
  }

  /* ── Responsive ── */
  @media (max-width: 900px) {
    .login-page {
      flex-direction: column;
    }
    .mascot-side {
      flex: none;
      padding: 30px 20px 10px;
      min-height: 40vh;
    }
    .mascot-container {
      width: 120px;
      height: 120px;
    }
    .mascot-orb {
      font-size: 60px;
    }
    .brand-title {
      font-size: 32px;
    }
    .login-side {
      flex: none;
      padding: 20px;
      min-width: auto;
    }
    .login-card {
      max-width: 100%;
      padding: 28px 24px;
    }
  }
</style>
