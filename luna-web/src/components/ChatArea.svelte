<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { isStreaming, currentMode, messages, sessions, currentSessionId } from '../stores.js';
  import { sendMessage, cancelStream, SSEManager, fetchSessionMessages, sessionAction } from '../api.js';
  import ChatHeader from './ChatHeader.svelte';
  import MessagesList from './MessagesList.svelte';
  import ChatInput from './ChatInput.svelte';

  export let sessionId = null;

  let sseManager = new SSEManager();
  let currentAssistantId = null;
  let thinkingId = null;
  let lastConnectedSessionId = null;

  function removeAllThinking(msgs) {
    return msgs.filter(m => m.type !== 'thinking');
  }

  function handleEvent(event) {
    if (!event) return;
    if (event.sessionId && event.sessionId !== sessionId) return;

    // v3.6-fix: Deduplicate events by ID — SSE may resend historical events on reconnect
    if (event.id) {
      const exists = $messages.some(m => m.id === event.id);
      if (exists) return;
    }

    const { type } = event;

    switch (type) {
      case 'user': {
        // v3.6-fix: Handle user messages from SSE history sync
        messages.update(msgs => {
          // Avoid duplicates
          if (msgs.some(m => m.id === event.id)) return msgs;
          return [...msgs, {
            id: event.id || 'user-' + Date.now(),
            type: 'user',
            content: event.content || event.text || '',
            timestamp: event.timestamp || new Date().toISOString()
          }];
        });
        break;
      }
      case 'thinking_start': {
        messages.update(msgs => {
          const cleaned = removeAllThinking(msgs);
          const newId = 'think-' + Date.now();
          thinkingId = newId;
          return [...cleaned, {
            id: newId,
            type: 'thinking',
            content: '',
            timestamp: new Date().toISOString()
          }];
        });
        break;
      }
      case 'thinking_delta': {
        if (thinkingId) {
          messages.update(msgs =>
            msgs.map(m => m.id === thinkingId ? { ...m, content: event.fullThinking || event.text || '' } : m)
          );
        }
        break;
      }
      case 'response_delta': {
        messages.update(msgs => removeAllThinking(msgs));
        thinkingId = null;

        if (!currentAssistantId) {
          currentAssistantId = 'resp-' + Date.now();
          messages.update(msgs => [...msgs, {
            id: currentAssistantId,
            type: 'assistant',
            content: event.text || '',
            timestamp: new Date().toISOString()
          }]);
        } else {
          messages.update(msgs =>
            msgs.map(m => m.id === currentAssistantId ? { ...m, content: event.fullResponse || (m.content + (event.text || '')) } : m)
          );
        }
        break;
      }
      case 'action_start': {
        const toolId = 'tool-' + Date.now();
        messages.update(msgs => [...msgs, {
          id: toolId,
          type: 'tool',
          tool: event.tool,
          params: event.params || {},
          result: null,
          duration: 0,
          timestamp: new Date().toISOString()
        }]);
        break;
      }
      case 'action_end': {
        messages.update(msgs => {
          const toolMsgs = msgs.filter(m => m.type === 'tool' && m.tool === event.tool && !m.result);
          const lastTool = toolMsgs[toolMsgs.length - 1];
          if (lastTool) {
            return msgs.map(m =>
              m.id === lastTool.id
                ? { ...m, result: event.result, duration: event.duration || 0 }
                : m
            );
          }
          return msgs;
        });
        break;
      }
      case 'response_done': {
        if (currentAssistantId && event.response) {
          messages.update(msgs =>
            msgs.map(m => m.id === currentAssistantId ? { ...m, content: event.response } : m)
          );
        }
        currentAssistantId = null;
        break;
      }
      case 'done': {
        messages.update(msgs => removeAllThinking(msgs));
        thinkingId = null;
        const finalResponse = event.result?.response || event.response;
        if (finalResponse && !currentAssistantId) {
          messages.update(msgs => [...msgs, {
            id: 'resp-' + Date.now(),
            type: 'assistant',
            content: finalResponse,
            timestamp: new Date().toISOString()
          }]);
        } else if (finalResponse && currentAssistantId) {
          messages.update(msgs =>
            msgs.map(m => m.id === currentAssistantId ? { ...m, content: finalResponse } : m)
          );
        }
        isStreaming.set(false);
        currentAssistantId = null;
        break;
      }
      case 'error': {
        messages.update(msgs => removeAllThinking(msgs));
        thinkingId = null;
        messages.update(msgs => [...msgs, {
          id: 'err-' + Date.now(),
          type: 'error',
          content: event.error || event.message || event.text || 'Erro desconhecido',
          timestamp: new Date().toISOString()
        }]);
        isStreaming.set(false);
        break;
      }
      case 'warning':
      case 'system': {
        messages.update(msgs => [...msgs, {
          id: (type === 'warning' ? 'warn-' : 'sys-') + Date.now(),
          type: 'system',
          content: event.message || '',
          timestamp: new Date().toISOString()
        }]);
        break;
      }
      case 'mode_detected': {
        if (event.mode) currentMode.set(event.mode);
        break;
      }
      case 'compact_start':
      case 'compact_end':
      case 'plan_start':
      case 'plan_error':
      case 'plan_complete': {
        messages.update(msgs => [...msgs, {
          id: 'plan-' + Date.now(),
          type: 'system',
          content: event.message || `${type}`,
          timestamp: new Date().toISOString()
        }]);
        break;
      }
    }
  }

  async function connectSSE() {
    if (!sessionId) return;
    // NAO reconecta se ja esta conectado na mesma sessao
    if (lastConnectedSessionId === sessionId && sseManager.eventSource) return;

    currentAssistantId = null;
    thinkingId = null;
    sseManager.disconnect();
    sseManager = new SSEManager();

    // v3.6-fix: Load full message history from backend instead of clearing
    try {
      const history = await fetchSessionMessages(sessionId);
      if (history.ok && history.messages) {
        const loaded = [];
        let currentAssistantContent = '';
        let currentThinkingContent = '';
        let currentThinkingId = null;
        for (const msg of history.messages) {
          if (msg.role === 'user') {
            loaded.push({
              id: msg.id || 'msg-' + Math.random().toString(36).slice(2),
              type: 'user',
              content: msg.content || '',
              timestamp: msg.timestamp || new Date().toISOString(),
            });
          } else if (msg.type === 'thinking_start') {
            currentThinkingContent = '';
            currentThinkingId = 'think-' + Math.random().toString(36).slice(2);
            loaded.push({
              id: currentThinkingId,
              type: 'thinking',
              content: '',
              timestamp: msg.timestamp || new Date().toISOString(),
            });
          } else if (msg.type === 'thinking_delta') {
            currentThinkingContent = msg.fullThinking || msg.text || currentThinkingContent;
            if (currentThinkingId) {
              const thinkMsg = loaded.find(m => m.id === currentThinkingId);
              if (thinkMsg) thinkMsg.content = currentThinkingContent;
            }
          } else if (msg.type === 'response_delta' && msg.content) {
            // Remove thinking when response starts
            if (currentThinkingId) {
              const idx = loaded.findIndex(m => m.id === currentThinkingId);
              if (idx !== -1) loaded.splice(idx, 1);
              currentThinkingId = null;
            }
            currentAssistantContent = msg.content;
          } else if (msg.type === 'done') {
            // Remove any leftover thinking
            if (currentThinkingId) {
              const idx = loaded.findIndex(m => m.id === currentThinkingId);
              if (idx !== -1) loaded.splice(idx, 1);
              currentThinkingId = null;
            }
            const finalText = msg.result?.response || msg.content || currentAssistantContent || '';
            if (finalText) {
              loaded.push({
                id: msg.id || 'resp-' + Math.random().toString(36).slice(2),
                type: 'assistant',
                content: finalText,
                timestamp: msg.timestamp || new Date().toISOString(),
              });
            }
            currentAssistantContent = '';
            currentThinkingContent = '';
          } else if (msg.type === 'error') {
            loaded.push({
              id: msg.id || 'err-' + Math.random().toString(36).slice(2),
              type: 'error',
              content: msg.content || 'Erro desconhecido',
              timestamp: msg.timestamp || new Date().toISOString(),
            });
          } else if (msg.type === 'action_start' && msg.tool) {
            loaded.push({
              id: msg.id || 'tool-' + Math.random().toString(36).slice(2),
              type: 'tool',
              tool: msg.tool,
              params: msg.params || {},
              result: null,
              timestamp: msg.timestamp || new Date().toISOString(),
            });
          } else if (msg.type === 'action_end' && msg.result) {
            const lastTool = loaded.slice().reverse().find(m => m.type === 'tool' && !m.result);
            if (lastTool) {
              lastTool.result = msg.result;
            }
          }
        }
        messages.set(loaded);
      } else {
        messages.set([]);
      }
    } catch (e) {
      console.error('Failed to load session history:', e);
      messages.set([]);
    }

    sseManager.connect(sessionId, handleEvent);
    lastConnectedSessionId = sessionId;
  }

  $: if (sessionId && sessionId !== lastConnectedSessionId) {
    connectSSE();
  }

  onMount(() => {
    if (sessionId && sessionId !== lastConnectedSessionId) {
      connectSSE();
    }
  });

  async function handleSend(msg, files) {
    if (!msg.trim()) return;

    // v3.7-fix: Auto-create session if none exists
    let activeSessionId = sessionId;
    if (!activeSessionId) {
      try {
        const res = await sessionAction('create', null, msg.slice(0, 40));
        if (res.ok && res.session) {
          activeSessionId = res.session.id;
          // v3.7-fix: Update stores so the session appears in sidebar immediately
          const newSession = { ...res.session, updatedAt: new Date().toISOString() };
          sessions.update(s => [newSession, ...s]);
          currentSessionId.set(res.session.id);
        } else {
          messages.update(msgs => [...msgs, {
            id: 'err-' + Date.now(),
            type: 'error',
            content: 'Falha ao criar sessão',
            timestamp: new Date().toISOString()
          }]);
          return;
        }
      } catch (e) {
        console.error('Create session error:', e);
        messages.update(msgs => [...msgs, {
          id: 'err-' + Date.now(),
          type: 'error',
          content: 'Falha ao criar sessão: ' + e.message,
          timestamp: new Date().toISOString()
        }]);
        return;
      }
    }

    // v3.6-fix: Reset assistant tracking before sending new message
    currentAssistantId = null;
    thinkingId = null;

    const userMsg = {
      id: 'user-' + Date.now(),
      type: 'user',
      content: msg,
      files: files || [],
      timestamp: new Date().toISOString()
    };
    messages.update(msgs => [...msgs, userMsg]);
    isStreaming.set(true);

    try {
      await sendMessage(msg, activeSessionId, $currentMode);
    } catch (e) {
      console.error('Send error:', e);
      isStreaming.set(false);
      messages.update(msgs => [...msgs, {
        id: 'err-' + Date.now(),
        type: 'error',
        content: 'Falha ao enviar mensagem: ' + e.message,
        timestamp: new Date().toISOString()
      }]);
    }
  }

  async function handleCancel() {
    if (sessionId) {
      await cancelStream(sessionId);
      isStreaming.set(false);
    }
  }

  function handleClear() {
    messages.set([]);
  }

  function handleExport() {
    const msgs = $messages;
    const content = msgs.map(m => {
      const role = m.type === 'user' ? 'Usuario' : m.type === 'assistant' ? 'Luna' : 'Sistema';
      return `[${role}] ${m.content || ''}`;
    }).join('\n\n---\n\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `luna-chat-${sessionId || 'export'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  onDestroy(() => {
    sseManager.disconnect();
  });
</script>

<div class="chat-area">
  <ChatHeader
    title={$messages.find(m => m.type === 'user')?.content?.slice(0, 50) || 'Nova Conversa'}
    mode={$currentMode}
    isStreaming={$isStreaming}
    on:modeChange={(e) => currentMode.set(e.detail)}
    on:clear={handleClear}
    on:export={handleExport}
  />

  <MessagesList messages={$messages} />

  <ChatInput
    onSend={handleSend}
    onCancel={handleCancel}
    disabled={$isStreaming}
  />
</div>

<style>
  .chat-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
  }
</style>
