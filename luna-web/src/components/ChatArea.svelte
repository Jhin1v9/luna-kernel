<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { isStreaming, currentMode, messages, sessions, currentSessionId, planModeState, mascotState, mascotMessage } from '../stores.js';
  import { sendMessage, cancelStream, SSEManager, fetchSessionMessages, sessionAction, startPlanMode, approvePlan, rejectPlan, submitRevision, systemRestart, systemStop, systemStart, systemStatus, systemHealth, systemLogs, executeLunaTool, startHeartbeat, stopHeartbeat, turnOffAgent } from '../api.js';
  import { SLASH_COMMANDS, isSlashCommand } from '../lib/slashCommands.js';
  import { playSound } from '../sound.js';
  import ChatHeader from './ChatHeader.svelte';
  import MessagesList from './MessagesList.svelte';
  import ChatInput from './ChatInput.svelte';
  import PersonaSelector from './PersonaSelector.svelte';

  export let sessionId = null;

  let sseManager = new SSEManager();
  let currentAssistantId = null;
  let thinkingId = null;
  let lastConnectedSessionId = null;
  let toolStartTimes = new Map(); // toolName -> startTimestamp
  let processedEventIds = new Set(); // v4.2: Track processed SSE event IDs to prevent duplicates
  let userMessageAdded = false; // v5.6-fix: Ensure user message is in store before assistant responses
  let streamingSafetyTimer = null; // v5.7-fix: Detect SSE inactivity (NOT thinking time)
  let currentMessageId = null; // v6.1-fix: Track current message ID to ignore stale SSE events
  const SSE_INACTIVITY_MS = 60000; // 60s without ANY SSE event = connection probably dead

  // v5.7-fix: Reset inactivity timer on EVERY SSE event. If NO event for 60s,
  // the SSE connection is likely dead (not Kimi thinking). Force isStreaming=false.
  function resetStreamingInactivityTimer() {
    if (streamingSafetyTimer) {
      clearTimeout(streamingSafetyTimer);
      streamingSafetyTimer = null;
    }
    if ($isStreaming) {
      streamingSafetyTimer = setTimeout(() => {
        console.warn('[ChatArea] SSE inactivity timeout: no events for 60s, assuming connection dead');
        isStreaming.set(false);
        mascotState.set('idle');
        mascotMessage.set('O que mais posso fazer?');
        messages.update(msgs => removeAllThinking(msgs));
        thinkingId = null;
        currentAssistantId = null;
        streamingSafetyTimer = null;
        // Try to reconnect SSE and fetch any pending messages
        reconnectAndFetchPending();
      }, SSE_INACTIVITY_MS);
    }
  }

  async function reconnectAndFetchPending() {
    if (!sessionId) return;
    try {
      console.log('[ChatArea] Reconnecting SSE to fetch pending messages...');
      await connectSSE();
    } catch (e) {
      console.error('[ChatArea] Reconnect failed:', e.message);
    }
  }

  function removeAllThinking(msgs) {
    return msgs.filter(m => m.type !== 'thinking');
  }

  function getEventHash(event) {
    // v5.5-fix: Create a unique hash for an event based on its CONTENT + params, not id.
    // The backend generates unique ids per event ('ev-' + Date.now()), so using id
    // in the hash makes deduplication useless — duplicates have different ids.
    // For tool events, include params so two action_start's with different params
    // don't get incorrectly deduplicated.
    const type = event.type || '';
    const text = event.text || event.content || event.fullResponse || '';
    const tool = event.tool || '';
    const paramsKey = event.params ? JSON.stringify(event.params).slice(0, 50) : '';
    // Use first 100 chars of text + type + tool + params to create a simple hash
    const raw = `${type}:${tool}:${paramsKey}:${text.slice(0, 100)}`;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      const char = raw.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return String(hash);
  }

  function handleEvent(event) {
    if (!event) return;
    if (event.sessionId && event.sessionId !== sessionId) return;

    // v6.1-fix: If the event has a messageId that doesn't match the current message,
    // it's a stale event from a previous message — ignore it.
    if (event.messageId && currentMessageId && event.messageId !== currentMessageId) {
      console.log('[SSE] Ignoring stale event from previous message:', event.type, event.messageId);
      return;
    }

    // v5.6-fix: Ignore response events until user message is confirmed in store
    const isResponseEvent = ['assistant', 'thinking', 'response_detected', 'partial', 'done', 'tool', 'action_start', 'action_end'].includes(event.type);
    if (isResponseEvent && !userMessageAdded) {
      console.log('[SSE] Delaying response event until user message is added:', event.type);
      setTimeout(() => handleEvent(event), 100);
      return;
    }

    // v4.2-fix: Deduplicate by event hash — prevents duplicate rendering on reconnects
    const eventHash = getEventHash(event);
    if (processedEventIds.has(eventHash)) {
      return;
    }
    processedEventIds.add(eventHash);
    // Limit set size to prevent memory leaks
    if (processedEventIds.size > 1000) {
      const iter = processedEventIds.values();
      processedEventIds.delete(iter.next().value);
    }

    // v4.0-debug: Log every SSE event for debugging
    console.log('[SSE]', event.type, event.text ? event.text.substring(0, 80) : '', event.tool || '');

    // v3.6-fix: Also deduplicate by backend event ID
    if (event.id) {
      const exists = $messages.some(m => m.id === event.id);
      if (exists) return;
    }

    const { type } = event;

    switch (type) {
      case 'user': {
        // v3.6-fix: Handle user messages from SSE history sync
        messages.update(msgs => {
          // Avoid duplicates by ID
          if (msgs.some(m => m.id === event.id)) return msgs;
          // Avoid duplicates by content (same message sent locally + via SSE)
          const content = event.content || event.text || '';
          const recentDuplicate = msgs.some(m =>
            m.type === 'user' &&
            m.content === content &&
            Date.now() - new Date(m.timestamp).getTime() < 5000
          );
          if (recentDuplicate) return msgs;
          return [...msgs, {
            id: event.id || 'user-' + Date.now(),
            type: 'user',
            content: content,
            files: event.files || [],
            timestamp: event.timestamp || new Date().toISOString()
          }];
        });
        break;
      }
      case 'thinking_start': {
        playSound('thinkingStart');
        mascotState.set('thinking');
        mascotMessage.set('Hmm... deixa eu pensar...');
        messages.update(msgs => {
          // v4.0-fix: If there's already an active thinking bubble, reuse it
          const existingThink = msgs.find(m => m.type === 'thinking');
          if (existingThink) {
            thinkingId = existingThink.id;
            return msgs;
          }
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
        // v5.3-fix: Auto-create thinking bubble if it doesn't exist yet.
        // The bridge doesn't always emit 'thinking_start', so we create on demand.
        if (!thinkingId) {
          const newId = 'think-' + Date.now();
          thinkingId = newId;
          messages.update(msgs => [...removeAllThinking(msgs), {
            id: newId,
            type: 'thinking',
            content: event.text || '',
            timestamp: new Date().toISOString()
          }]);
        } else {
          messages.update(msgs =>
            msgs.map(m => {
              if (m.id !== thinkingId) return m;
              const newText = event.text || '';
              const current = m.content || '';
              // v4.2-fix: If delta looks like full replacement (larger than current + 50%),
              // replace instead of append to avoid repetition on DOM shrink
              if (newText.length > current.length * 1.5 && newText.includes(current.slice(0, 20))) {
                return { ...m, content: newText };
              }
              return { ...m, content: current + newText };
            })
          );
        }
        break;
      }
      case 'response_delta': {
        playSound('messageReceived');
        // v5.5-fix: Don't immediately kill thinking bubble — give user visual feedback.
        // If thinking was created less than 2s ago, keep it visible briefly.
        let thinkRemoved = false;
        messages.update(msgs => {
          const thinkMsg = msgs.find(m => m.type === 'thinking');
          if (thinkMsg && Date.now() - new Date(thinkMsg.timestamp).getTime() < 2000) {
            return msgs;
          }
          thinkRemoved = true;
          return removeAllThinking(msgs);
        });
        if (thinkRemoved) thinkingId = null;

        const deltaText = event.text || '';
        // v7.0-fix: Don't create empty assistant bubbles from empty deltas.
        // Empty deltas can arrive when the DOM observer returns empty text temporarily.
        if (!currentAssistantId && !deltaText) {
          break;
        }

        if (!currentAssistantId) {
          currentAssistantId = 'resp-' + Date.now();
          messages.update(msgs => [...msgs, {
            id: currentAssistantId,
            type: 'assistant',
            content: deltaText,
            timestamp: new Date().toISOString()
          }]);
        } else {
          messages.update(msgs =>
            msgs.map(m => {
              if (m.id !== currentAssistantId) return m;
              const newText = deltaText;
              const current = m.content || '';
              // v5.3-fix: If delta looks like full replacement (larger than current + 50%
              // and contains current start), replace instead of append to avoid duplication
              // when Kimi DOM shrinks and bridge sends full text instead of delta
              if (newText.length > current.length * 1.5 && newText.includes(current.slice(0, 20))) {
                return { ...m, content: newText };
              }
              return { ...m, content: current + newText };
            })
          );
        }
        break;
      }
      case 'response_detected': {
        // v5.4-fix: JSON-block responses from Kimi — each one is a COMPLETE message.
        // If we already have an assistant bubble created recently (from response_delta),
        // replace it instead of creating a duplicate bubble.
        playSound('messageReceived');
        // v5.5-fix: Same as response_delta — preserve thinking briefly for visual feedback
        let thinkRemoved = false;
        messages.update(msgs => {
          const thinkMsg = msgs.find(m => m.type === 'thinking');
          if (thinkMsg && Date.now() - new Date(thinkMsg.timestamp).getTime() < 2000) {
            return msgs;
          }
          thinkRemoved = true;
          return removeAllThinking(msgs);
        });
        if (thinkRemoved) thinkingId = null;

        const newContent = event.text || event.response || '';
        
        // v7.0-fix: If newContent is empty, don't create an empty bubble.
        // This can happen when the DOM observer dies and response_detected fires
        // without extracted text. The 'done' event will provide the fallback.
        if (!newContent || newContent.trim().length === 0) {
          console.warn('[ChatArea] response_detected with empty content — skipping bubble creation, waiting for done');
          break;
        }
        
        // Check if current assistant bubble was created recently (within last 10s).
        // response_delta often accumulates partial content before response_detected
        // emits the complete JSON-extracted version. We should replace, not duplicate.
        let replaced = false;
        if (currentAssistantId) {
          messages.update(msgs => {
            const currentMsg = msgs.find(m => m.id === currentAssistantId);
            if (currentMsg && currentMsg.type === 'assistant') {
              const msgAge = Date.now() - new Date(currentMsg.timestamp).getTime();
              // If message is recent (< 10s), it's likely from response_delta — replace it
              if (msgAge < 10000) {
                replaced = true;
                return msgs.map(m =>
                  m.id === currentAssistantId
                    ? { ...m, content: newContent }
                    : m
                );
              }
            }
            return msgs;
          });
        }

        if (!replaced) {
          // No duplicate found — create new bubble
          currentAssistantId = null;
          const bubbleId = 'resp-' + Date.now();
          messages.update(msgs => [...msgs, {
            id: bubbleId,
            type: 'assistant',
            content: newContent,
            timestamp: new Date().toISOString()
          }]);
          currentAssistantId = bubbleId;
        }
        break;
      }
      case 'action_start': {
        mascotState.set('working');
        mascotMessage.set(event.tool ? `Usando ${event.tool}...` : 'Trabalhando...');
        const toolId = 'tool-' + Date.now();
        toolStartTimes.set(event.tool, Date.now());
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
        playSound('toolComplete');
        mascotState.set('idle');
        mascotMessage.set('Prontinho!');
        // Calculate duration locally if backend doesn't send it
        const startTime = toolStartTimes.get(event.tool);
        let duration = event.duration;
        if (!duration && startTime) {
          duration = (Date.now() - startTime) / 1000; // seconds
        }
        toolStartTimes.delete(event.tool);
        messages.update(msgs => {
          const toolMsgs = msgs.filter(m => m.type === 'tool' && m.tool === event.tool && !m.result);
          const lastTool = toolMsgs[toolMsgs.length - 1];
          if (lastTool) {
            return msgs.map(m =>
              m.id === lastTool.id
                ? { ...m, result: event.result, duration: duration || 0 }
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
      case 'context_limit': {
        playSound('error');
        mascotState.set('idle');
        mascotMessage.set('Limite de contexto atingido');
        messages.update(msgs => removeAllThinking(msgs));
        thinkingId = null;
        messages.update(msgs => [...msgs, {
          id: 'ctxlim-' + Date.now(),
          type: 'system',
          content: event.message || '🔁 Limite de contexto atingido. Use /newchat para criar uma nova thread.',
          timestamp: new Date().toISOString()
        }]);
        isStreaming.set(false);
        currentAssistantId = null;
        break;
      }
      case 'done': {
        mascotState.set('idle');
        mascotMessage.set('O que mais posso fazer?');
        messages.update(msgs => removeAllThinking(msgs));
        thinkingId = null;
        const finalResponse = event.result?.response || event.response || event.text;
        console.log('[done] finalResponse length:', finalResponse?.length, 'content:', finalResponse?.substring(0, 100));
        
        // v7.0-fix: Robust fallback — always ensure an assistant bubble exists with the final response.
        // Cases handled:
        //   1. No assistant bubble at all (currentAssistantId is null) → create one
        //   2. Assistant bubble exists but is empty → update it
        //   3. Assistant bubble exists with content → update with final (may be more complete)
        if (finalResponse) {
          let hasAssistantBubble = false;
          let assistantBubbleEmpty = false;
          messages.update(msgs => {
            if (currentAssistantId) {
              const currentMsg = msgs.find(m => m.id === currentAssistantId);
              if (currentMsg && currentMsg.type === 'assistant') {
                hasAssistantBubble = true;
                assistantBubbleEmpty = !currentMsg.content || currentMsg.content.trim().length === 0;
              }
            }
            // Also check if there's ANY assistant message without content
            const emptyAssistant = msgs.find(m => m.type === 'assistant' && (!m.content || m.content.trim().length === 0));
            if (emptyAssistant && !currentAssistantId) {
              currentAssistantId = emptyAssistant.id;
              assistantBubbleEmpty = true;
            }
            return msgs;
          });
          
          if (!hasAssistantBubble || assistantBubbleEmpty) {
            // Create new bubble if none exists or existing is empty
            const bubbleId = currentAssistantId || ('resp-' + Date.now());
            if (!currentAssistantId) {
              messages.update(msgs => [...msgs, {
                id: bubbleId,
                type: 'assistant',
                content: finalResponse,
                timestamp: new Date().toISOString()
              }]);
              currentAssistantId = bubbleId;
            } else {
              messages.update(msgs =>
                msgs.map(m => m.id === currentAssistantId ? { ...m, content: finalResponse } : m)
              );
            }
          } else if (currentAssistantId) {
            // Update existing non-empty bubble with final response
            messages.update(msgs =>
              msgs.map(m => m.id === currentAssistantId ? { ...m, content: finalResponse } : m)
            );
          }
        }
        isStreaming.set(false);
        currentAssistantId = null;
        break;
      }
      case 'login_required': {
        playSound('error');
        mascotState.set('idle');
        mascotMessage.set('Precisa fazer login primeiro!');
        messages.update(msgs => removeAllThinking(msgs));
        thinkingId = null;
        messages.update(msgs => [...msgs, {
          id: 'login-' + Date.now(),
          type: 'login_required',
          content: event.message || '🔐 Você precisa logar primeiro no Kimi Web.',
          timestamp: new Date().toISOString()
        }]);
        isStreaming.set(false);
        break;
      }
      case 'error': {
        playSound('error');
        mascotState.set('idle');
        mascotMessage.set('Ops, algo deu errado...');
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
      case 'plan_start': {
        planModeState.update(s => ({ ...s, active: true, status: 'investigating', sessionId }));
        messages.update(msgs => [...msgs, {
          id: 'plan-start-' + Date.now(),
          type: 'system',
          content: event.message || 'Modo Detetive ativado',
          timestamp: new Date().toISOString()
        }]);
        break;
      }
      case 'plan_delta': {
        // Plan text streaming — update or create plan message
        planModeState.update(s => ({ ...s, active: true, status: 'investigating' }));
        messages.update(msgs => {
          const lastPlan = msgs.findLast(m => m.type === 'plan');
          if (lastPlan && !lastPlan.isComplete) {
            return msgs.map(m => m.id === lastPlan.id ? { ...m, content: (m.content || '') + (event.text || '') } : m);
          }
          return [...msgs, {
            id: 'plan-delta-' + Date.now(),
            type: 'plan',
            content: event.text || '',
            isComplete: false,
            timestamp: new Date().toISOString()
          }];
        });
        break;
      }
      case 'plan_display':
      case 'plan_awaiting_approval': {
        planModeState.update(s => ({ ...s, active: true, status: 'awaiting_approval', plan: event.plan, planPath: event.planPath, sessionId }));
        messages.update(msgs => {
          // Remove incomplete plan deltas
          const cleaned = msgs.filter(m => !(m.type === 'plan' && !m.isComplete));
          return [...cleaned, {
            id: 'plan-' + Date.now(),
            type: 'plan',
            content: event.plan || '',
            planPath: event.planPath,
            isComplete: true,
            status: 'awaiting_approval',
            timestamp: new Date().toISOString()
          }];
        });
        break;
      }
      case 'plan_approved': {
        planModeState.update(s => ({ ...s, active: false, status: 'idle', plan: null, planPath: null }));
        messages.update(msgs => [...msgs, {
          id: 'plan-approved-' + Date.now(),
          type: 'system',
          content: 'Plano aprovado! Iniciando execução...',
          timestamp: new Date().toISOString()
        }]);
        break;
      }
      case 'plan_rejected': {
        planModeState.update(s => ({ ...s, active: false, status: 'idle', plan: null, planPath: null }));
        messages.update(msgs => [...msgs, {
          id: 'plan-rejected-' + Date.now(),
          type: 'system',
          content: 'Plano rejeitado. Investigação encerrada.',
          timestamp: new Date().toISOString()
        }]);
        break;
      }
      case 'plan_revised': {
        planModeState.update(s => ({ ...s, active: true, status: 'awaiting_approval', plan: event.plan, planPath: event.planPath }));
        messages.update(msgs => [...msgs, {
          id: 'plan-revised-' + Date.now(),
          type: 'plan',
          content: event.plan || '',
          planPath: event.planPath,
          isComplete: true,
          status: 'awaiting_approval',
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

    // v4.0-fix: Do NOT reload history while streaming is active — prevents overwriting current state
    if ($isStreaming) {
      console.log('[connectSSE] Skipping history reload while streaming is active');
      return;
    }

    currentAssistantId = null;
    thinkingId = null;
    processedEventIds.clear(); // v4.2: Clear dedup set on reconnect
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
              files: msg.files || [],
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
        // v4.0-fix: Sort by timestamp to ensure chronological order
        loaded.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
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
    // v5.2: Start heartbeat to keep agent page alive
    startHeartbeat('web-' + sessionId, 30000);
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

    // v6.1-fix: Abort any active stream from a previous message before starting
    // a new one. This prevents stale SSE events from the previous message
    // from being processed as part of the new message.
    if ($isStreaming && sessionId) {
      console.log('[handleSend] Aborting previous stream before sending new message');
      await cancelStream(sessionId);
    }

    // v6.1-fix: Generate a new message ID for this message. If the backend
    // sends messageId in SSE events, we can validate against it.
    currentMessageId = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

    // v5.6-fix: Reset user message tracking for new message
    userMessageAdded = false;

    // v6.0-fix: DO NOT clear processedEventIds — it breaks deduplication of
    // delayed SSE events from the previous message. When a 'done' or
    // 'response_detected' event from msg N-1 arrives after handleSend() was
    // called for msg N, clearing the set allows it to be processed as new,
    // causing the previous response to be "pasted" into the chat again.
    // processedEventIds.clear(); ← REMOVED

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

    // v4.0-fix: Remove all previous thinking bubbles when sending a new message
    messages.update(msgs => removeAllThinking(msgs));

    // v5.5-fix: Create a synthetic thinking bubble that persists during streaming.
    // When Kimi generates JSON blocks, the bridge often doesn't emit thinking deltas
    // because Kimi Web doesn't render thinking text for JSON. This ensures the user
    // sees visual feedback (🧠 Pensando...) while waiting for the response.
    const syntheticThinkId = 'think-' + Date.now();
    thinkingId = syntheticThinkId;
    messages.update(msgs => [...msgs, {
      id: syntheticThinkId,
      type: 'thinking',
      content: '',
      timestamp: new Date().toISOString()
    }]);

    const userMsg = {
      id: 'user-' + Date.now(),
      type: 'user',
      content: msg,
      files: files || [],
      timestamp: new Date().toISOString()
    };
    messages.update(msgs => [...msgs, userMsg]);
    userMessageAdded = true;
    await tick(); // Ensure user message is rendered before processing response events
    isStreaming.set(true);

    try {
      playSound('messageSent');

      // v5.0: Slash commands — ALL messages starting with / go to Luna directly, NOT Kimi
      if (isSlashCommand(msg)) {
        const cmd = msg.split(' ')[0];
        const args = msg.split(' ').slice(1);
        const slashDef = SLASH_COMMANDS.find(c => c.cmd === cmd);

        if (!slashDef) {
          isStreaming.set(false);
          messages.update(msgs => [...msgs, {
            id: 'sys-' + Date.now(),
            type: 'system',
            content: `❌ Comando desconhecido: ${cmd}. Digite / para ver os comandos disponiveis.`,
            timestamp: new Date().toISOString()
          }]);
          return;
        }

        let result = null;

        // System handlers (frontend APIs)
        if (['systemRestart', 'systemStatus', 'systemStop', 'systemStart', 'systemHealth', 'systemLogs', 'turnOffAgent'].includes(slashDef.handler)) {
          switch (slashDef.handler) {
            case 'systemRestart': result = await systemRestart(); break;
            case 'systemStatus': result = await systemStatus(); break;
            case 'systemStop': result = await systemStop(); break;
            case 'systemStart': result = await systemStart(); break;
            case 'systemHealth': result = await systemHealth(); break;
            case 'systemLogs': result = await systemLogs(); break;
            case 'turnOffAgent':
              result = await turnOffAgent('web-' + sessionId);
              mascotState.set('sleep');
              mascotMessage.set('🌙 Luna dormindo. Envie uma mensagem para acordar.');
              break;
          }
        }
        // Frontend-only handlers
        else if (slashDef.handler === 'clearChat') {
          messages.set([]);
          isStreaming.set(false);
          return;
        }
        else if (slashDef.handler === 'newSession') {
          isStreaming.set(false);
          currentSessionId.set(null);
          messages.set([]);
          return;
        }
        else if (slashDef.handler === 'help') {
          isStreaming.set(false);
          const helpText = SLASH_COMMANDS.map(c => `${c.cmd} — ${c.desc}`).join('\n');
          messages.update(msgs => [...msgs, {
            id: 'sys-' + Date.now(),
            type: 'system',
            content: '📖 Comandos disponiveis:\n\n' + helpText,
            timestamp: new Date().toISOString()
          }]);
          return;
        }
        else if (slashDef.handler === 'changeMode') {
          isStreaming.set(false);
          const mode = args[0];
          if (['instant', 'thinking', 'agent', 'swarm'].includes(mode)) {
            currentMode.set(mode);
            messages.update(msgs => [...msgs, {
              id: 'sys-' + Date.now(),
              type: 'system',
              content: `⚡ Modo alterado para: ${mode}`,
              timestamp: new Date().toISOString()
            }]);
          } else {
            messages.update(msgs => [...msgs, {
              id: 'sys-' + Date.now(),
              type: 'system',
              content: '⚡ Modos disponiveis: instant, thinking, agent, swarm',
              timestamp: new Date().toISOString()
            }]);
          }
          return;
        }
        // Plan mode
        else if (slashDef.handler === 'planMode') {
          if ($isStreaming || $planModeState.status === 'processing') {
            console.log('[handleSend] Plan mode already processing, ignoring duplicate');
            isStreaming.set(false);
            return;
          }
          const planMsg = args.join(' ');
          planModeState.update(s => ({ ...s, status: 'processing' }));
          await startPlanMode(planMsg, activeSessionId);
          return;
        }
        // All other tools — execute via luna-tools.cjs backend
        else {
          // Map args to params based on tool type
          let params = {};
          if (args.length > 0) {
            if (['readFile', 'deleteFile', 'getFileInfo', 'listFiles', 'viewDirectory', 'createDirectory', 'removeDirectory', 'gitStatus', 'gitDiff', 'gitLog', 'executeShell', 'runTests', 'checkSyntax', 'installPackages', 'searchWeb', 'downloadFile', 'getCurrentDirectory'].includes(slashDef.handler)) {
              params = args.length === 1 ? args[0] : args;
            } else if (['writeFile', 'appendFile'].includes(slashDef.handler)) {
              params = { filePath: args[0], content: args.slice(1).join(' ') };
            } else if (['moveFile', 'copyFile'].includes(slashDef.handler)) {
              params = { source: args[0], destination: args[1] };
            } else if (['replaceInFile'].includes(slashDef.handler)) {
              params = { filePath: args[0], search: args[1], replacement: args.slice(2).join(' ') };
            } else if (['grep', 'searchFiles'].includes(slashDef.handler)) {
              params = { pattern: args[0], path: args[1] || '.' };
            } else if (['fetchURL'].includes(slashDef.handler)) {
              params = { url: args[0] };
            } else if (['clipboardRead', 'clipboardWrite'].includes(slashDef.handler)) {
              params = args.length > 0 ? args.join(' ') : undefined;
            } else {
              // Dashboard tools — pass as object with positional args
              params = args.length === 1 ? args[0] : Object.fromEntries(args.map((a, i) => [`arg${i}`, a]));
            }
          }
          result = await executeLunaTool(slashDef.handler, params);
        }

        isStreaming.set(false);
        if (result) {
          const content = result.ok
            ? (result.message || result.output || result.result?.stdout || result.result?.output || JSON.stringify(result.result || result, null, 2))
            : (result.error || 'Erro desconhecido');
          messages.update(msgs => [...msgs, {
            id: 'sys-' + Date.now(),
            type: 'system',
            content: content.slice(0, 4000),
            timestamp: new Date().toISOString()
          }]);
        }
      } else if ($planModeState.active) {
        // v4.2-fix: Prevent double plan submission
        if ($isStreaming || $planModeState.status === 'processing') {
          console.log('[handleSend] Plan mode already processing, ignoring duplicate');
          return;
        }
        const planMsg = msg.startsWith('/plan') ? msg.slice(5).trim() : msg;
        planModeState.update(s => ({ ...s, status: 'processing' }));
        await startPlanMode(planMsg, activeSessionId);
      } else {
        await sendMessage(msg, activeSessionId, $currentMode, files, currentMessageId);
        // v7.1-fix: Reconnect SSE after sending a new message in the same session.
        // The previous SSE connection was gracefully closed after 'done'. We need
        // a fresh connection for the new message's streaming response.
        await connectSSE();
      }
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

  async function handleApprovePlan() {
    if (!sessionId) return;
    try {
      await approvePlan(sessionId);
      planModeState.update(s => ({ ...s, active: false, status: 'idle', plan: null }));
    } catch (e) {
      console.error('Approve plan error:', e);
    }
  }

  async function handleRejectPlan() {
    if (!sessionId) return;
    try {
      await rejectPlan(sessionId);
      planModeState.update(s => ({ ...s, active: false, status: 'idle', plan: null }));
    } catch (e) {
      console.error('Reject plan error:', e);
    }
  }

  async function handleRevisePlan(revisedPlan) {
    if (!sessionId) return;
    try {
      await submitRevision(sessionId, revisedPlan);
    } catch (e) {
      console.error('Revise plan error:', e);
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
    stopHeartbeat();
    mascotState.set('sleep');
  });
</script>

<div class="chat-area">
  <div class="chat-header-row">
    <ChatHeader
      title={$messages.find(m => m.type === 'user')?.content?.slice(0, 50) || 'Nova Conversa'}
      mode={$currentMode}
      isStreaming={$isStreaming}
      on:modeChange={(e) => currentMode.set(e.detail)}
      on:clear={handleClear}
    on:export={handleExport}
  />
  <PersonaSelector sessionId={sessionId} />
  </div>

  <MessagesList
    messages={$messages}
    onApprovePlan={handleApprovePlan}
    onRejectPlan={handleRejectPlan}
    onRevisePlan={handleRevisePlan}
  />

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
  .chat-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 clamp(0.5rem, 2vw, 1rem);
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .chat-header-row > :global(.chat-header) {
    flex: 1;
  }
</style>
