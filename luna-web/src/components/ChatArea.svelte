<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { isStreaming, currentMode, messages } from '../stores.js';
  import { sendMessage, cancelStream, SSEManager } from '../api.js';
  import ChatHeader from './ChatHeader.svelte';
  import MessagesList from './MessagesList.svelte';
  import ChatInput from './ChatInput.svelte';

  export let sessionId = null;

  let sseManager = new SSEManager();
  let currentAssistantId = null;
  let thinkingId = null;

  // Helper: remove ALL thinking bubbles from the message list
  function removeAllThinking(msgs) {
    return msgs.filter(m => m.type !== 'thinking');
  }

  function handleEvent(event) {
    if (!event) return;
    // Relaxed session check — accept events with matching or missing sessionId
    if (event.sessionId && event.sessionId !== sessionId) return;

    const { type } = event;

    switch (type) {
      case 'thinking_start': {
        // Remove any existing thinking bubbles before adding a new one
        // This prevents phantom thinking bubbles from old loops or history
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
        // ALWAYS remove all thinking bubbles when response starts
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
        // Remove all thinking bubbles on done
        messages.update(msgs => removeAllThinking(msgs));
        thinkingId = null;

        // If there's a final response in the done event and no assistant message was created yet
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
        // Remove all thinking bubbles on error
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
      case 'warning': {
        messages.update(msgs => [...msgs, {
          id: 'warn-' + Date.now(),
          type: 'system',
          content: event.message || '',
          timestamp: new Date().toISOString()
        }]);
        break;
      }
      case 'system': {
        messages.update(msgs => [...msgs, {
          id: 'sys-' + Date.now(),
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

  let lastSessionId = null;

  function connectSSE() {
    if (!sessionId) return;
    currentAssistantId = null;
    thinkingId = null;
    messages.set([]);
    sseManager.disconnect();
    sseManager.connect(sessionId, handleEvent);
    lastSessionId = sessionId;
  }

  // Watch for sessionId changes explicitly
  $: if (sessionId && sessionId !== lastSessionId) {
    connectSSE();
  }

  onMount(() => {
    if (sessionId && sessionId !== lastSessionId) {
      connectSSE();
    }
  });

  async function handleSend(msg, files) {
    if (!msg.trim() || !sessionId) return;

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
      await sendMessage(msg, sessionId, $currentMode);
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
