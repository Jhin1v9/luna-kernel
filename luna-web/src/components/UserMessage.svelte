<script>
  import { formatTime } from '../utils.js';

  export let content = '';
  export let timestamp = '';
  export let files = [];
</script>

<div class="user-message-wrapper">
  <div class="user-message">
    <div class="message-content">{content}</div>
    {#if files && files.length > 0}
      <div class="file-attachments">
        {#each files as file}
          <div class="file-chip">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9.5L13.5 2z"/>
              <polyline points="13 2 13 9 20 9"/>
            </svg>
            <span class="file-name">{file.name || 'Arquivo'}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
  {#if timestamp}
    <div class="message-time">{formatTime(timestamp)}</div>
  {/if}
</div>

<style>
  .user-message-wrapper {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    margin-left: auto;
    max-width: 80%;
    animation: fadeInUp 300ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  .user-message {
    background: var(--luna-elevated);
    border-radius: 12px;
    border-top-right-radius: 4px;
    padding: 12px 16px;
    color: var(--luna-text);
    font-size: 15px;
    line-height: 1.6;
    word-wrap: break-word;
  }
  .message-content {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .file-attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid rgba(255,255,255,0.06);
  }
  .file-chip {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: rgba(255,255,255,0.06);
    border-radius: 6px;
    font-size: 12px;
    color: var(--luna-text-secondary);
  }
  .file-name {
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .message-time {
    font-size: 11px;
    color: var(--luna-text-secondary);
    margin-top: 4px;
    padding-right: 4px;
    font-family: 'JetBrains Mono', monospace;
  }
  @keyframes fadeInUp {
    from { opacity: 0; transform: translateY(20px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
