<script>
  import { formatTime } from '../utils.js';

  export let content = '';
  export let timestamp = '';
  export let files = [];

  $: imageFiles = (files || []).filter(f => f.type?.startsWith('image/'));
  $: otherFiles = (files || []).filter(f => !f.type?.startsWith('image/'));
</script>

<div class="user-message-wrapper">
  <div class="user-message">
    <div class="message-content">{content}</div>

    {#if imageFiles.length > 0}
      <div class="image-attachments">
        {#each imageFiles as file}
          <div class="image-thumb">
            <img src={file.data} alt={file.name || 'Imagem anexada'} loading="lazy" />
          </div>
        {/each}
      </div>
    {/if}

    {#if otherFiles.length > 0}
      <div class="file-attachments">
        {#each otherFiles as file}
          <div class="file-chip">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9.5L13.5 2z"/>
              <polyline points="13 2 13 9 20 9"/>
            </svg>
            <span class="file-name">{file.name || 'Arquivo'}</span>
            {#if file.size}
              <span class="file-size">({(file.size / 1024).toFixed(1)} KB)</span>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
  {#if timestamp}
    <div class="message-time" title={new Date(timestamp).toLocaleString('pt-BR')}>
      {formatTime(timestamp)}
    </div>
  {/if}
</div>

<style>
  .user-message-wrapper {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    margin-left: auto;
    max-width: min(80%, 680px);
    animation: fadeInUp 300ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  .user-message {
    background: rgba(26, 26, 46, 0.65);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-radius: 12px;
    border-top-right-radius: 4px;
    padding: 12px 16px;
    color: var(--luna-text);
    font-size: 15px;
    line-height: 1.6;
    word-wrap: break-word;
    min-width: 0;
    border: 1px solid rgba(255, 255, 255, 0.06);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  }
  .message-content {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .image-attachments {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 8px;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid rgba(255,255,255,0.06);
  }
  .image-thumb {
    border-radius: 8px;
    overflow: hidden;
    background: rgba(0,0,0,0.3);
    aspect-ratio: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .image-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
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
    max-width: 100%;
  }
  .file-name {
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-size {
    opacity: 0.7;
    font-size: 11px;
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

  /* Mobile */
  @media (max-width: 640px) {
    .user-message-wrapper {
      max-width: 92%;
    }
    .user-message {
      padding: 10px 12px;
      font-size: 14px;
    }
    .image-attachments {
      grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
      gap: 6px;
    }
  }
</style>
