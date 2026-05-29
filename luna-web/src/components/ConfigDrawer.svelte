<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import { downloadFile, parseEnvFile, generateEnvFile } from '../utils.js';

  export let open = false;
  export let config = {};
  export let onSave = () => {};
  export let onClose = () => {};
  export let onRestart = () => {};

  let localConfig = {};
  let activeSection = 'telegram';
  let importInputEl;
  let showPasswordToken = false;
  let showPasswordApi = false;
  let charCount = 0;
  let lineCount = 0;
  let showTutorial = false;
  let confirmDialog = null;
  let originalSystemPrompt = '';

  $: if (open) {
    localConfig = { ...config };
    updateCounts();
    document.body.style.overflow = 'hidden';
  } else {
    if (typeof document !== 'undefined') document.body.style.overflow = '';
  }

  $: systemPromptValue = localConfig.SYSTEM_PROMPT || '';

  function updateCounts() {
    const text = localConfig.SYSTEM_PROMPT || '';
    charCount = text.length;
    lineCount = text.split('\n').length;
  }

  function handleSystemPromptChange(e) {
    localConfig = { ...localConfig, SYSTEM_PROMPT: e.target.value };
    updateCounts();
  }

  function setSection(section) {
    activeSection = activeSection === section ? null : section;
  }

  function handleSave() {
    onSave({ ...localConfig });
  }

  function handleExportEnv() {
    const env = generateEnvFile(localConfig);
    downloadFile(env, '.env', 'text/plain');
  }

  function handleImportEnv() {
    importInputEl?.click();
  }

  function processImport(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const imported = parseEnvFile(ev.target.result);
      localConfig = { ...localConfig, ...imported };
      updateCounts();
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function handleRestart() {
    confirmDialog = {
      title: 'Reiniciar Luna',
      message: 'Tem certeza que deseja reiniciar a Luna? Todas as sessoes ativas serao encerradas.',
      action: () => {
        onRestart();
        confirmDialog = null;
      }
    };
  }

  function handleResetPrompt() {
    confirmDialog = {
      title: 'Resetar System Prompt',
      message: 'Isso restaurara o system prompt para o original. Continuar?',
      action: () => {
        localConfig = { ...localConfig, SYSTEM_PROMPT: originalSystemPrompt };
        updateCounts();
        confirmDialog = null;
      }
    };
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') {
      if (confirmDialog) {
        confirmDialog = null;
      } else {
        onClose();
      }
    }
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) onClose();
  }

  onMount(() => {
    originalSystemPrompt = localConfig.SYSTEM_PROMPT || '';
  });

  onDestroy(() => {
    if (typeof document !== 'undefined') document.body.style.overflow = '';
  });

  const sections = [
    { key: 'telegram', icon: '🤖', title: 'Bot do Telegram' },
    { key: 'dashboard', icon: '📊', title: 'Dashboard NEXO PRO' },
    { key: 'kimi', icon: '🧠', title: 'Kimi Bridge' },
    { key: 'advanced', icon: '⚡', title: 'Avancado' },
    { key: 'prompt', icon: '🧬', title: 'System Prompt' },
    { key: 'tutorial', icon: '📖', title: 'Tutorial' },
  ];
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open}
  <!-- Backdrop -->
  <div
    class="drawer-backdrop"
    on:click={handleBackdropClick}
    transition:fade={{ duration: 200 }}
  />

  <!-- Drawer -->
  <aside
    class="config-drawer"
    transition:fly={{ x: 400, duration: 300, opacity: 1 }}
    role="dialog"
    aria-modal="true"
    aria-label="Configuracoes"
  >
    <!-- Header -->
    <div class="drawer-header">
      <h2 class="drawer-title">⚙️ Configuracoes</h2>
      <button class="close-btn" on:click={onClose} aria-label="Fechar">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>

    <!-- Content -->
    <div class="drawer-content">
      <!-- 🤖 Telegram -->
      <div class="section">
        <button class="section-header" on:click={() => setSection('telegram')}>
          <span>🤖 Bot do Telegram</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class:rotated={activeSection === 'telegram'}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        {#if activeSection === 'telegram'}
          <div class="section-body" transition:slideExpand>
            <div class="field">
              <label class="field-label" for="telegram-token">TELEGRAM_BOT_TOKEN</label>
              <div class="password-field">
                {#if showPasswordToken}
                  <input
                    id="telegram-token"
                    type="text"
                    class="field-input"
                    bind:value={localConfig.TELEGRAM_BOT_TOKEN}
                    placeholder="Seu token do BotFather"
                  />
                {:else}
                  <input
                    id="telegram-token"
                    type="password"
                    class="field-input"
                    bind:value={localConfig.TELEGRAM_BOT_TOKEN}
                    placeholder="Seu token do BotFather"
                  />
                {/if}
                <button class="toggle-password" on:click={() => showPasswordToken = !showPasswordToken}>
                  {showPasswordToken ? '🙈' : '👁'}
                </button>
              </div>
            </div>
            <div class="field-row">
              <span class="status-indicator online">●</span>
              <span class="status-text">Conectado</span>
              <a href="https://t.me/BotFather" target="_blank" rel="noopener" class="field-link">@BotFather</a>
            </div>
          </div>
        {/if}
      </div>

      <!-- 📊 Dashboard -->
      <div class="section">
        <button class="section-header" on:click={() => setSection('dashboard')}>
          <span>📊 Dashboard NEXO PRO</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class:rotated={activeSection === 'dashboard'}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        {#if activeSection === 'dashboard'}
          <div class="section-body" transition:slideExpand>
            <div class="field">
              <label class="field-label" for="api-token">INTERNAL_API_TOKEN</label>
              <div class="password-field">
                {#if showPasswordApi}
                  <input
                    id="api-token"
                    type="text"
                    class="field-input"
                    bind:value={localConfig.INTERNAL_API_TOKEN}
                    placeholder="Token da API interna"
                  />
                {:else}
                  <input
                    id="api-token"
                    type="password"
                    class="field-input"
                    bind:value={localConfig.INTERNAL_API_TOKEN}
                    placeholder="Token da API interna"
                  />
                {/if}
                <button class="toggle-password" on:click={() => showPasswordApi = !showPasswordApi}>
                  {showPasswordApi ? '🙈' : '👁'}
                </button>
              </div>
            </div>
            <button class="test-btn" on:click={() => alert('Teste de conexao ainda nao implementado')}>
              Testar Conexao
            </button>
          </div>
        {/if}
      </div>

      <!-- 🧠 Kimi Bridge -->
      <div class="section">
        <button class="section-header" on:click={() => setSection('kimi')}>
          <span>🧠 Kimi Bridge</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class:rotated={activeSection === 'kimi'}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        {#if activeSection === 'kimi'}
          <div class="section-body" transition:slideExpand>
            <div class="field">
              <label class="field-label" for="kimi-timeout">KIMI_TIMEOUT (ms)</label>
              <input id="kimi-timeout" type="number" class="field-input" bind:value={localConfig.KIMI_TIMEOUT} placeholder="120000" />
            </div>
            <div class="field">
              <label class="field-label" for="kimi-pages">KIMI_MAX_PAGES</label>
              <input id="kimi-pages" type="number" class="field-input" bind:value={localConfig.KIMI_MAX_PAGES} placeholder="5" />
            </div>
            <div class="field">
              <label class="field-label" for="kimi-idle">KIMI_IDLE_TIMEOUT (ms)</label>
              <input id="kimi-idle" type="number" class="field-input" bind:value={localConfig.KIMI_IDLE_TIMEOUT} placeholder="600000" />
            </div>
            <div class="field">
              <label class="field-label" for="kimi-cooldown">KIMI_COOLDOWN_MS (ms)</label>
              <input id="kimi-cooldown" type="number" class="field-input" bind:value={localConfig.KIMI_COOLDOWN_MS} placeholder="5000" />
            </div>
          </div>
        {/if}
      </div>

      <!-- ⚡ Advanced -->
      <div class="section">
        <button class="section-header" on:click={() => setSection('advanced')}>
          <span>⚡ Avancado</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class:rotated={activeSection === 'advanced'}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        {#if activeSection === 'advanced'}
          <div class="section-body" transition:slideExpand>
            <div class="field">
              <label class="field-label" for="compact-threshold">LUNA_COMPACT_THRESHOLD</label>
              <input id="compact-threshold" type="number" class="field-input" bind:value={localConfig.LUNA_COMPACT_THRESHOLD} placeholder="24" />
            </div>
            <div class="field">
              <label class="field-label" for="chrome-path">LUNA_CHROME_PATH</label>
              <input id="chrome-path" type="text" class="field-input" bind:value={localConfig.LUNA_CHROME_PATH} placeholder="/usr/bin/google-chrome" />
            </div>
            <div class="field checkbox-field">
              <label class="checkbox-label">
                <input type="checkbox" bind:checked={localConfig.LUNA_DEBUG} />
                <span>Modo Debug</span>
              </label>
            </div>
          </div>
        {/if}
      </div>

      <!-- 🧬 System Prompt -->
      <div class="section">
        <button class="section-header" on:click={() => setSection('prompt')}>
          <span>🧬 System Prompt</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class:rotated={activeSection === 'prompt'}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        {#if activeSection === 'prompt'}
          <div class="section-body" transition:slideExpand>
            <div class="prompt-warning">
              <span>⚠️</span>
              <span>Alterar o system prompt pode afetar o comportamento da Luna.</span>
            </div>
            <textarea
              class="prompt-textarea"
              rows="20"
              value={systemPromptValue}
              on:input={handleSystemPromptChange}
              placeholder="Digite o system prompt aqui..."
            />
            <div class="prompt-stats">
              {charCount.toLocaleString()} caracteres, {lineCount} linhas
            </div>
            <div class="prompt-actions">
              <button class="btn-secondary" on:click={handleResetPrompt}>🔄 Reset Original</button>
              <button class="btn-primary" on:click={handleSave}>💾 Salvar</button>
            </div>
          </div>
        {/if}
      </div>

      <!-- 📖 Tutorial -->
      <div class="section">
        <button class="section-header" on:click={() => setSection('tutorial')}>
          <span>📖 Tutorial</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class:rotated={activeSection === 'tutorial'}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        {#if activeSection === 'tutorial'}
          <div class="section-body" transition:slideExpand>
            <div class="tutorial-content">
              <h4>Bem-vindo a Luna Web!</h4>
              <p>A Luna e um agente autonomo que pode:</p>
              <ul>
                <li>💻 Criar e editar arquivos</li>
                <li>🐛 Executar comandos no terminal</li>
                <li>🌐 Pesquisar na web</li>
                <li>📊 Gerenciar tarefas no dashboard</li>
                <li>🔍 Analisar repositorios Git</li>
              </ul>
              <h4>Atalhos do teclado</h4>
              <ul>
                <li><kbd>Ctrl+K</kbd> — Nova sessao</li>
                <li><kbd>Enter</kbd> — Enviar mensagem</li>
                <li><kbd>Shift+Enter</kbd> — Nova linha</li>
                <li><kbd>Esc</kbd> — Cancelar/Close</li>
              </ul>
              <h4>Modos de resposta</h4>
              <p><strong>⭐ thinking</strong> — A Luna pensa antes de responder (mais preciso)</p>
              <p><strong>⚡ instant</strong> — Resposta rapida sem thinking</p>
            </div>
          </div>
        {/if}
      </div>
    </div>

    <!-- Footer Actions -->
    <div class="drawer-footer">
      <input
        type="file"
        accept=".env"
        bind:this={importInputEl}
        on:change={processImport}
        class="hidden-input"
      />
      <div class="footer-row">
        <button class="btn-secondary btn-small" on:click={handleExportEnv}>📥 Exportar .env</button>
        <button class="btn-secondary btn-small" on:click={handleImportEnv}>📤 Importar .env</button>
      </div>
      <button class="btn-danger" on:click={handleRestart}>🔄 Reiniciar Luna</button>
    </div>
  </aside>
{/if}

<!-- Confirmation Dialog -->
{#if confirmDialog}
  <div class="confirm-overlay" transition:fade={{ duration: 150 }}>
    <div class="confirm-dialog" transition:fly={{ y: 20, duration: 200 }}>
      <h3 class="confirm-title">{confirmDialog.title}</h3>
      <p class="confirm-message">{confirmDialog.message}</p>
      <div class="confirm-actions">
        <button class="btn-secondary" on:click={() => confirmDialog = null}>Cancelar</button>
        <button class="btn-danger" on:click={confirmDialog.action}>Confirmar</button>
      </div>
    </div>
  </div>
{/if}

<script context="module">
  function slideExpand(node, params) {
    return {
      duration: 200,
      css: t => `max-height: ${t * 2000}px; opacity: ${t}; overflow: hidden;`
    };
  }
</script>

<style>
  .drawer-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 40;
  }
  .config-drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 420px;
    max-width: 100vw;
    background: var(--luna-elevated);
    border-left: 1px solid var(--luna-border);
    z-index: 50;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .drawer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--luna-border);
    flex-shrink: 0;
  }
  .drawer-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--luna-text);
    margin: 0;
  }
  .close-btn {
    background: none;
    border: none;
    color: var(--luna-text-secondary);
    cursor: pointer;
    padding: 6px;
    border-radius: 8px;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 36px;
    min-height: 36px;
  }
  .close-btn:hover {
    color: var(--luna-text);
    background: rgba(255,255,255,0.06);
  }
  .drawer-content {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }
  .section {
    border-bottom: 1px solid var(--luna-border);
  }
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 14px 20px;
    background: none;
    border: none;
    color: var(--luna-text);
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
    text-align: left;
  }
  .section-header:hover {
    background: rgba(255,255,255,0.02);
  }
  .section-header svg {
    transition: transform 0.2s;
    opacity: 0.5;
  }
  .section-header svg.rotated {
    transform: rotate(180deg);
  }
  .section-body {
    padding: 0 20px 16px;
  }
  .field {
    margin-bottom: 12px;
  }
  .field-label {
    display: block;
    font-size: 12px;
    color: var(--luna-text-secondary);
    margin-bottom: 4px;
    font-weight: 500;
  }
  .field-input {
    width: 100%;
    padding: 10px 12px;
    background: var(--luna-surface);
    border: 1px solid var(--luna-border);
    border-radius: 8px;
    color: var(--luna-text);
    font-size: 14px;
    font-family: 'JetBrains Mono', monospace;
    outline: none;
    transition: border-color 0.2s;
  }
  .field-input:focus {
    border-color: var(--luna-primary);
  }
  .field-input::placeholder {
    color: var(--luna-text-secondary);
    opacity: 0.4;
  }
  .password-field {
    position: relative;
    display: flex;
    align-items: center;
  }
  .password-field .field-input {
    padding-right: 40px;
  }
  .toggle-password {
    position: absolute;
    right: 8px;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 16px;
    padding: 4px;
    opacity: 0.6;
    transition: opacity 0.15s;
  }
  .toggle-password:hover {
    opacity: 1;
  }
  .field-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    padding: 4px 0;
  }
  .status-indicator {
    font-size: 14px;
  }
  .status-indicator.online {
    color: #22c55e;
  }
  .status-text {
    color: var(--luna-text-secondary);
  }
  .field-link {
    color: var(--luna-primary);
    text-decoration: none;
    margin-left: auto;
    font-size: 12px;
  }
  .field-link:hover {
    text-decoration: underline;
  }
  .checkbox-field {
    padding: 4px 0;
  }
  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    font-size: 14px;
    color: var(--luna-text);
  }
  .checkbox-label input[type="checkbox"] {
    width: 18px;
    height: 18px;
    accent-color: var(--luna-primary);
    cursor: pointer;
  }
  .test-btn {
    padding: 8px 16px;
    background: var(--luna-surface);
    border: 1px solid var(--luna-border);
    border-radius: 8px;
    color: var(--luna-text);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
    font-weight: 500;
  }
  .test-btn:hover {
    background: var(--luna-elevated);
    border-color: rgba(255,255,255,0.1);
  }
  .prompt-warning {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
    background: rgba(234, 179, 8, 0.1);
    border: 1px solid rgba(234, 179, 8, 0.2);
    border-radius: 8px;
    font-size: 12px;
    color: #fde68a;
    margin-bottom: 12px;
  }
  .prompt-textarea {
    width: 100%;
    min-height: 300px;
    padding: 12px;
    background: var(--luna-surface);
    border: 1px solid var(--luna-border);
    border-radius: 8px;
    color: var(--luna-text);
    font-size: 13px;
    font-family: 'JetBrains Mono', monospace;
    line-height: 1.6;
    outline: none;
    resize: vertical;
    transition: border-color 0.2s;
  }
  .prompt-textarea:focus {
    border-color: var(--luna-primary);
  }
  .prompt-stats {
    font-size: 12px;
    color: var(--luna-text-secondary);
    margin-top: 8px;
    font-family: 'JetBrains Mono', monospace;
  }
  .prompt-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  .tutorial-content {
    font-size: 13px;
    line-height: 1.7;
    color: var(--luna-text);
  }
  .tutorial-content h4 {
    font-size: 14px;
    font-weight: 600;
    margin: 16px 0 8px;
    color: var(--luna-primary);
  }
  .tutorial-content ul {
    margin: 8px 0 8px 20px;
  }
  .tutorial-content li {
    margin-bottom: 4px;
  }
  .tutorial-content kbd {
    background: var(--luna-surface);
    border: 1px solid var(--luna-border);
    border-radius: 4px;
    padding: 2px 6px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
  }
  .drawer-footer {
    padding: 16px 20px;
    border-top: 1px solid var(--luna-border);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .footer-row {
    display: flex;
    gap: 8px;
  }
  .hidden-input {
    position: absolute;
    width: 0;
    height: 0;
    opacity: 0;
    pointer-events: none;
  }
  .btn-primary {
    padding: 10px 20px;
    background: var(--luna-primary);
    border: none;
    border-radius: 8px;
    color: white;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn-primary:hover {
    background: var(--luna-primary-hover);
  }
  .btn-secondary {
    padding: 10px 16px;
    background: var(--luna-surface);
    border: 1px solid var(--luna-border);
    border-radius: 8px;
    color: var(--luna-text);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
    font-weight: 500;
  }
  .btn-secondary:hover {
    background: var(--luna-elevated);
    border-color: rgba(255,255,255,0.1);
  }
  .btn-secondary.btn-small {
    padding: 8px 12px;
    font-size: 12px;
    flex: 1;
  }
  .btn-danger {
    padding: 10px 16px;
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 8px;
    color: #fca5a5;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    width: 100%;
  }
  .btn-danger:hover {
    background: rgba(239, 68, 68, 0.25);
  }
  .confirm-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .confirm-dialog {
    background: var(--luna-elevated);
    border: 1px solid var(--luna-border);
    border-radius: 12px;
    padding: 24px;
    max-width: 400px;
    width: 100%;
  }
  .confirm-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--luna-text);
    margin: 0 0 8px;
  }
  .confirm-message {
    font-size: 14px;
    color: var(--luna-text-secondary);
    margin: 0 0 20px;
    line-height: 1.5;
  }
  .confirm-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
  }
  @media (max-width: 768px) {
    .config-drawer {
      width: 100vw;
      left: 0;
    }
  }
</style>
