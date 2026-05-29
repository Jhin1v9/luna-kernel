<script>
  import { formatDuration } from '../utils.js';

  export let tool = '';
  export let params = {};
  export let result = undefined;
  export let duration = 0;

  const TOOL_COLORS = {
    writeFile: '#3b82f6', readFile: '#22c55e', executeShell: '#a855f7',
    searchWeb: '#f97316', searchFiles: '#f97316', gitStatus: '#6b7280',
    gitDiff: '#6b7280', gitLog: '#6b7280', gitCommit: '#6b7280',
    dashboardCreateTask: '#ec4899', dashboardListTasks: '#ec4899',
    dashboardCreateLead: '#ec4899', dashboardListLeads: '#ec4899',
    dashboardGetFinanceSummary: '#ec4899', replaceInFile: '#06b6d4',
  };

  const TOOL_ICONS = {
    writeFile: '📄', readFile: '👁', executeShell: '⚡',
    searchWeb: '🌐', searchFiles: '🔍', gitStatus: '🌿',
    gitDiff: '📊', gitLog: '📜', gitCommit: '💾',
    dashboardCreateTask: '📋', dashboardListTasks: '📋',
    dashboardCreateLead: '👤', dashboardListLeads: '👥',
    dashboardGetFinanceSummary: '💰', replaceInFile: '✏️',
  };

  $: status = result ? (result.success !== false ? 'success' : 'error') : 'running';
  $: color = TOOL_COLORS[tool] || '#6b7280';
  $: icon = TOOL_ICONS[tool] || '🔧';
  $: displayPath = params?.path || params?.file || params?.dir || params?.url || '';
  $: truncatedOutput = result?.output
    ? result.output.length > 500
      ? result.output.slice(0, 500) + '...'
      : result.output
    : '';
</script>

<div
  class="tool-card"
  class:running={status === 'running'}
  class:success={status === 'success'}
  class:error={status === 'error'}
  style="--tool-color: {color}"
>
  <div class="tool-header">
    <div class="tool-info">
      <span class="tool-icon">{icon}</span>
      <span class="tool-name">{tool}</span>
    </div>
    <div class="tool-status">
      {#if status === 'running'}
        <span class="status-badge running">
          <svg class="spinner" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" stroke-dasharray="40 20" stroke-linecap="round"/>
          </svg>
          {formatDuration(duration)}
        </span>
      {:else if status === 'success'}
        <span class="status-badge success">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          {formatDuration(duration)}
        </span>
      {:else}
        <span class="status-badge error">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
          Erro
        </span>
      {/if}
    </div>
  </div>

  {#if displayPath}
    <code class="tool-path">{displayPath}</code>
  {/if}

  {#if status === 'running'}
    <div class="progress-bar">
      <div class="progress-fill"></div>
    </div>
  {/if}

  {#if truncatedOutput && status !== 'running'}
    <details class="tool-output">
      <summary>{status === 'error' ? 'Ver erro' : 'Ver output'}</summary>
      <pre class="output-content">{truncatedOutput}</pre>
    </details>
  {/if}

  {#if result?.error}
    <div class="error-message">{result.error}</div>
  {/if}
</div>

<style>
  .tool-card {
    background: var(--luna-surface);
    border: 1px solid rgba(255,255,255,0.06);
    border-left: 3px solid var(--tool-color);
    border-radius: 10px;
    padding: 12px 14px;
    font-size: 13px;
    max-width: 100%;
    animation: springIn 300ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .tool-card.running {
    border-color: var(--tool-color);
    animation: springIn 300ms cubic-bezier(0.34, 1.56, 0.64, 1),
               pulseGlow 2s infinite;
  }
  .tool-card.success {
    border-left-color: #22c55e;
  }
  .tool-card.error {
    border-left-color: #ef4444;
    border-color: rgba(239, 68, 68, 0.2);
  }
  @keyframes springIn {
    from { opacity: 0; transform: scale(0.9); }
    to { opacity: 1; transform: scale(1); }
  }
  @keyframes pulseGlow {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0); }
    50% { box-shadow: 0 0 12px 2px rgba(255,255,255,0.03); }
  }
  .tool-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .tool-info {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .tool-icon {
    font-size: 16px;
  }
  .tool-name {
    font-weight: 600;
    color: var(--luna-text);
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
  }
  .tool-status {
    flex-shrink: 0;
  }
  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 500;
    font-family: 'JetBrains Mono', monospace;
  }
  .status-badge.running {
    background: rgba(255,255,255,0.06);
    color: var(--luna-text-secondary);
  }
  .status-badge.success {
    background: rgba(34, 197, 94, 0.12);
    color: #4ade80;
  }
  .status-badge.error {
    background: rgba(239, 68, 68, 0.12);
    color: #fca5a5;
  }
  .spinner {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .tool-path {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: var(--luna-text-secondary);
    background: rgba(0,0,0,0.2);
    padding: 4px 8px;
    border-radius: 6px;
    margin-bottom: 8px;
    word-break: break-all;
  }
  .progress-bar {
    height: 3px;
    background: rgba(255,255,255,0.06);
    border-radius: 2px;
    overflow: hidden;
    margin-top: 8px;
  }
  .progress-fill {
    height: 100%;
    width: 50%;
    background: var(--tool-color);
    border-radius: 2px;
    animation: indeterminate 1.5s infinite linear;
  }
  @keyframes indeterminate {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(200%); }
  }
  .tool-output {
    margin-top: 8px;
  }
  .tool-output summary {
    font-size: 12px;
    color: var(--luna-text-secondary);
    cursor: pointer;
    padding: 4px 0;
    font-family: 'JetBrains Mono', monospace;
    transition: color 0.15s;
  }
  .tool-output summary:hover {
    color: var(--luna-text);
  }
  .output-content {
    margin-top: 6px;
    padding: 10px 12px;
    background: rgba(0,0,0,0.2);
    border-radius: 6px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    line-height: 1.6;
    color: var(--luna-text-secondary);
    max-height: 300px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .error-message {
    margin-top: 8px;
    padding: 8px 12px;
    background: rgba(239, 68, 68, 0.1);
    border-radius: 6px;
    color: #fca5a5;
    font-size: 12px;
    font-family: 'JetBrains Mono', monospace;
    word-break: break-word;
  }
</style>
