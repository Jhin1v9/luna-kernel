<script>
  import { onMount, tick } from 'svelte';
  import { formatTime } from '../utils.js';

  export let content = '';
  export let timestamp = '';
  export let onFeedback = () => {};

  let contentEl;
  let copiedCode = null;

  const renderer = {
    code(code, language) {
      const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<div class="code-block-wrapper">
        <div class="code-header">
          <span class="code-lang">${language || 'text'}</span>
          <button class="copy-btn" data-code="${encodeURIComponent(code)}">Copiar</button>
        </div>
        <pre><code class="hljs ${language ? 'language-' + language : ''}">${escaped}</code></pre>
      </div>`;
    },
    codespan(code) {
      const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<code class="inline-code">${escaped}</code>`;
    },
    heading(text, level) {
      return `<h${level} class="md-h${level}">${text}</h${level}>`;
    },
    paragraph(text) {
      return `<p class="md-p">${text}</p>`;
    },
    strong(text) {
      return `<strong class="md-strong">${text}</strong>`;
    },
    em(text) {
      return `<em class="md-em">${text}</em>`;
    },
    link(href, title, text) {
      return `<a href="${href}" class="md-link" target="_blank" rel="noopener" title="${title || ''}">${text}</a>`;
    },
    list(body, ordered) {
      const tag = ordered ? 'ol' : 'ul';
      return `<${tag} class="md-list">${body}</${tag}>`;
    },
    listitem(text) {
      return `<li class="md-li">${text}</li>`;
    },
    blockquote(quote) {
      return `<blockquote class="md-blockquote">${quote}</blockquote>`;
    },
    hr() {
      return `<hr class="md-hr">`;
    },
    table(header, body) {
      return `<div class="md-table-wrapper"><table class="md-table"><thead>${header}</thead><tbody>${body}</tbody></table></div>`;
    },
    tablerow(content) {
      return `<tr>${content}</tr>`;
    },
    tablecell(content, flags) {
      const tag = flags.header ? 'th' : 'td';
      return `<${tag}>${content}</${tag}>`;
    }
  };

  function renderMarkdown(text) {
    if (!text) return '';
    let html = text
      .replace(/^### (.*$)/gim, '<h3 class="md-h3">$1</h3>')
      .replace(/^## (.*$)/gim, '<h2 class="md-h2">$1</h2>')
      .replace(/^# (.*$)/gim, '<h1 class="md-h1">$1</h1>')
      .replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => renderer.code(code, lang))
      .replace(/`([^`]+)`/g, (match, code) => renderer.codespan(code))
      .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.*?)\*\*/g, '<strong class="md-strong">$1</strong>')
      .replace(/\*(.*?)\*/g, '<em class="md-em">$1</em>')
      .replace(/__(.*?)__/g, '<strong class="md-strong">$1</strong>')
      .replace(/_(.*?)_/g, '<em class="md-em">$1</em>')
      .replace(/^> (.*$)/gim, '<blockquote class="md-blockquote">$1</blockquote>')
      .replace(/^- (.*$)/gim, '<li class="md-li">$1</li>')
      .replace(/^\d+\. (.*$)/gim, '<li class="md-li">$1</li>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="md-link" target="_blank" rel="noopener">$1</a>')
      .replace(/^---$/gim, '<hr class="md-hr">');

    // Wrap lists
    html = html.replace(/(<li[^>]*>.*?<\/li>\n?)+/gs, match => `<ul class="md-list">${match}</ul>`);

    // Wrap paragraphs
    const blocks = html.split('\n\n');
    html = blocks.map(block => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('<')) return trimmed;
      return `<p class="md-p">${trimmed.replace(/\n/g, '<br>')}</p>`;
    }).join('\n');

    return html;
  }

  async function highlightCode() {
    await tick();
    if (!contentEl) return;
    const hljs = await import('highlight.js');
    const blocks = contentEl.querySelectorAll('pre code');
    blocks.forEach(block => {
      try {
        hljs.default.highlightElement(block);
      } catch (e) {
        console.warn('Highlight error:', e);
      }
    });
  }

  async function handleCopy(e) {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const code = decodeURIComponent(btn.dataset.code);
    try {
      await navigator.clipboard.writeText(code);
      copiedCode = btn;
      btn.textContent = 'Copiado!';
      btn.classList.add('copied');
      setTimeout(() => {
        if (copiedCode === btn) {
          btn.textContent = 'Copiar';
          btn.classList.remove('copied');
          copiedCode = null;
        }
      }, 2000);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  }

  onMount(() => {
    highlightCode();
  });

  $: if (content) {
    highlightCode();
  }
</script>

<div class="assistant-message-wrapper">
  <div class="assistant-message">
    <div class="message-header">
      <span class="avatar">🌙</span>
      <span class="name">Luna</span>
    </div>
    <div class="message-body" bind:this={contentEl} on:click={handleCopy}>
      {@html renderMarkdown(content)}
    </div>
    <div class="message-footer">
      {#if timestamp}
        <span class="message-time">{formatTime(timestamp)}</span>
      {/if}
      <div class="feedback-buttons">
        <button class="feedback-btn" on:click={() => onFeedback('up')} title="Boa resposta" aria-label="Gostei">
          👍
        </button>
        <button class="feedback-btn" on:click={() => onFeedback('down')} title="Resposta ruim" aria-label="Nao gostei">
          👎
        </button>
        <button class="feedback-btn" on:click={() => onFeedback('retry')} title="Tentar novamente" aria-label="Tentar novamente">
          🔄
        </button>
      </div>
    </div>
  </div>
</div>

<style>
  .assistant-message-wrapper {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    margin-right: auto;
    max-width: 90%;
    animation: fadeInUp 300ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  .assistant-message {
    background: var(--luna-surface);
    border-radius: 12px;
    border-top-left-radius: 4px;
    padding: 14px 18px;
    color: var(--luna-text);
    font-size: 15px;
    line-height: 1.6;
  }
  .message-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  .avatar {
    font-size: 18px;
  }
  .name {
    font-weight: 600;
    font-size: 14px;
    color: var(--luna-primary);
  }
  .message-body :global(.md-p) {
    margin-bottom: 0.75rem;
    line-height: 1.7;
  }
  .message-body :global(.md-p:last-child) {
    margin-bottom: 0;
  }
  .message-body :global(.md-h1),
  .message-body :global(.md-h2),
  .message-body :global(.md-h3) {
    margin-top: 1.25rem;
    margin-bottom: 0.5rem;
    font-weight: 600;
    color: var(--luna-text);
  }
  .message-body :global(.md-h1) { font-size: 1.4rem; }
  .message-body :global(.md-h2) { font-size: 1.2rem; }
  .message-body :global(.md-h3) { font-size: 1.05rem; }
  .message-body :global(.md-strong) {
    font-weight: 600;
    color: var(--luna-text);
  }
  .message-body :global(.md-link) {
    color: var(--luna-primary);
    text-decoration: none;
  }
  .message-body :global(.md-link:hover) {
    text-decoration: underline;
  }
  .message-body :global(.md-list) {
    margin: 0.5rem 0 0.75rem 1.5rem;
  }
  .message-body :global(.md-li) {
    margin-bottom: 0.25rem;
  }
  .message-body :global(.md-blockquote) {
    border-left: 3px solid var(--luna-primary);
    padding-left: 1rem;
    margin: 0.75rem 0;
    color: var(--luna-text-secondary);
    font-style: italic;
  }
  .message-body :global(.md-hr) {
    border: none;
    border-top: 1px solid var(--luna-border);
    margin: 1rem 0;
  }
  .message-body :global(.md-table-wrapper) {
    overflow-x: auto;
    margin: 0.75rem 0;
  }
  .message-body :global(.md-table) {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .message-body :global(.md-table th),
  .message-body :global(.md-table td) {
    border: 1px solid var(--luna-border);
    padding: 6px 10px;
    text-align: left;
  }
  .message-body :global(.md-table th) {
    background: var(--luna-elevated);
    font-weight: 600;
  }
  .message-body :global(.inline-code) {
    background: rgba(255,255,255,0.06);
    padding: 2px 6px;
    border-radius: 4px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: var(--luna-primary-hover);
  }
  .message-body :global(.code-block-wrapper) {
    margin: 0.75rem 0;
    border-radius: 8px;
    overflow: hidden;
    background: #0d0d1a;
  }
  .message-body :global(.code-header) {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 12px;
    background: rgba(255,255,255,0.03);
    border-bottom: 1px solid var(--luna-border);
  }
  .message-body :global(.code-lang) {
    font-size: 11px;
    color: var(--luna-text-secondary);
    font-family: 'JetBrains Mono', monospace;
    text-transform: uppercase;
  }
  .message-body :global(.copy-btn) {
    font-size: 11px;
    padding: 3px 10px;
    background: rgba(255,255,255,0.06);
    border: 1px solid var(--luna-border);
    border-radius: 4px;
    color: var(--luna-text-secondary);
    cursor: pointer;
    transition: all 0.15s;
    font-family: 'JetBrains Mono', monospace;
  }
  .message-body :global(.copy-btn:hover) {
    background: rgba(255,255,255,0.1);
    color: var(--luna-text);
  }
  .message-body :global(.copy-btn.copied) {
    background: rgba(34, 197, 94, 0.2);
    color: #4ade80;
    border-color: rgba(34, 197, 94, 0.3);
  }
  .message-body :global(pre) {
    margin: 0;
    padding: 12px 14px;
    overflow-x: auto;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    line-height: 1.6;
  }
  .message-body :global(pre code) {
    background: none;
    padding: 0;
    font-family: 'JetBrains Mono', monospace;
  }
  .message-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid var(--luna-border);
  }
  .message-time {
    font-size: 11px;
    color: var(--luna-text-secondary);
    font-family: 'JetBrains Mono', monospace;
  }
  .feedback-buttons {
    display: flex;
    gap: 4px;
  }
  .feedback-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 4px;
    font-size: 14px;
    opacity: 0.5;
    transition: all 0.15s;
    min-width: 32px;
    min-height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .feedback-btn:hover {
    opacity: 1;
    background: rgba(255,255,255,0.06);
  }
  @keyframes fadeInUp {
    from { opacity: 0; transform: translateY(20px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
