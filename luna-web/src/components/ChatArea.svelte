<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { isStreaming, currentMode, messages, sessions, currentSessionId, planModeState, mascotState, mascotMessage, activeModal } from '../stores.js';
  import { sendMessage, cancelStream, SSEManager, fetchSessionMessages, sessionAction, startPlanMode, approvePlan, rejectPlan, submitRevision, systemRestart, systemStop, systemStart, systemStatus, systemHealth, systemLogs, executeLunaTool, startHeartbeat, stopHeartbeat, turnOffAgent } from '../api.js';
  import { SLASH_COMMANDS, isSlashCommand } from '../lib/slashCommands.js';
  import { playSound } from '../sound.js';
  import ChatHeader from './ChatHeader.svelte';
  import MessagesList from './MessagesList.svelte';
  import ChatInput from './ChatInput.svelte';
  import TaskDashboardModal from './TaskDashboardModal.svelte';
  import LeadDashboardModal from './LeadDashboardModal.svelte';
  import FinanceDashboardModal from './FinanceDashboardModal.svelte';
  import VotingDashboardModal from './VotingDashboardModal.svelte';

  export let sessionId = null;

  let sseManager = new SSEManager();
  let currentAssistantId = null;
  let thinkingId = null;
  let lastConnectedSessionId = null;
  let toolStartTimes = new Map(); // toolName -> startTimestamp
  let toolTimeoutTimers = new Map(); // toolName -> timeout timer id
  const TOOL_TIMEOUT_MS = 60000; // 60s timeout for any tool
  let processedEventIds = new Set(); // v4.2: Track processed SSE event IDs to prevent duplicates
  let userMessageAdded = false; // v5.6-fix: Ensure user message is in store before assistant responses
  let streamingSafetyTimer = null; // v5.7-fix: Detect SSE inactivity (NOT thinking time)
  let currentMessageId = null; // v6.1-fix: Track current message ID to ignore stale SSE events
  let responseBuffer = ''; // v8.3-fix: Buffer response_delta to avoid showing raw JSON/tool blocks during streaming
  let showTyping = false; // v8.3-fix: Show typing indicator for INSTANT mode
  const SSE_INACTIVITY_MS = 600000; // v8.2-fix: 10 min — user explicitly wants to wait for long operations
  let flushedContentHashes = new Set(); // v9.1-fix: Track flushed content hashes to prevent duplicate assistant messages
  let pendingToolCount = 0; // v9.3-fix: Track only CURRENT turn's tools, not full history
  let runningToolTimers = new Map(); // v9.4-fix: toolId -> { intervalId, startTime } for real-time execution timer
  const progressBuffers = new Map(); // v9.5: tool -> { chunks[], raf } for rAF batching of action_progress
  let toolInstanceMap = new Map(); // backend toolInstanceId -> frontend message id

  // v8.2-fix: User explicitly disabled inactivity timeout — he waits for long operations.
  // The timer is cleared but NEVER restarted, so SSE never aborts due to silence.
  function resetStreamingInactivityTimer() {
    if (streamingSafetyTimer) {
      clearTimeout(streamingSafetyTimer);
      streamingSafetyTimer = null;
    }
    // NOTE: setTimeout removed per user request. SSE stays alive indefinitely.
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

  // v8.3-fix: Flush accumulated response buffer, parsing out any complete JSON blocks.
  // Only creates/updates assistant bubble with CLEAN text (no raw tool JSON).
  function flushResponseBuffer(forceText = null) {
    const text = forceText !== null ? forceText : responseBuffer;
    if (!text || !text.trim()) return;

    // v9.0-fix: Strip tool blocks using the same logic as AssistantMessage
    let cleanText = stripToolBlocksFromBuffer(text);
    // v8.5-fix: removed aggressive meaningfulContent check that discarded short replies
    if (!cleanText || !cleanText.trim()) {
      if (forceText !== null) responseBuffer = '';
      return;
    }

    // v9.1-fix: Deduplicate by content hash — prevents duplicate messages from multiple SSE events
    // (response_delta + response_detected + done can all carry the same text)
    const contentHash = hashContent(cleanText.trim());
    if (flushedContentHashes.has(contentHash)) {
      console.log('[flushResponseBuffer] Duplicate content hash detected, skipping');
      if (forceText !== null) responseBuffer = '';
      return;
    }
    // Also check if any recent assistant message has this exact content
    const msgs = get(messages);
    const recentAssistants = msgs.slice().reverse().filter(m => m.type === 'assistant').slice(0, 3);
    const isDuplicate = recentAssistants.some(m => {
      const existing = (m.content || '').trim();
      return existing === cleanText.trim() || existing.includes(cleanText.trim());
    });
    if (isDuplicate) {
      console.log('[flushResponseBuffer] Content already exists in recent assistant message, skipping');
      if (forceText !== null) responseBuffer = '';
      return;
    }

    flushedContentHashes.add(contentHash);
    // v8.5-fix: Eviction when Set grows too large
    if (flushedContentHashes.size > 1000) {
      const iter = flushedContentHashes.values();
      flushedContentHashes.delete(iter.next().value);
    }

    if (!currentAssistantId) {
      currentAssistantId = 'resp-' + Date.now();
      messages.update(msgs => [...msgs, {
        id: currentAssistantId,
        type: 'assistant',
        content: cleanText,
        timestamp: new Date().toISOString()
      }]);
    } else {
      // v9.3-fix: forceText means COMPLETE text (response_detected/done) — REPLACE.
      // No forceText means delta buffer flush — APPEND.
      if (forceText !== null) {
        messages.update(msgs =>
          msgs.map(m => m.id === currentAssistantId
            ? { ...m, content: cleanText }
            : m
          )
        );
      } else {
        messages.update(msgs =>
          msgs.map(m => m.id === currentAssistantId
            ? { ...m, content: (m.content || '') + cleanText }
            : m
          )
        );
      }
    }

    if (forceText !== null) {
      responseBuffer = '';
    }
  }

  // v9.2-fix: Detect incomplete JSON blocks to prevent leaking raw tool JSON
  // v8.5-fix: Only block if it looks like a Luna tool wrapper
  function hasIncompleteJsonBlock(text) {
    if (!text) return false;
    const hasToolMarker = text.includes('"tool"') || text.includes('"params"');
    if (!hasToolMarker) return false;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (!inString) {
        if (c === '{') depth++;
        else if (c === '}') depth--;
      }
    }
    return depth > 0;
  }

  // v9.1-fix: Simple content hash for deduplication
  function hashContent(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return String(hash);
  }

  // v9.0-fix: Reusable tool block stripper for buffer text
  function stripToolBlocksFromBuffer(text) {
    if (!text) return text;
    let cleaned = text;

    // Pass 1: JSON label + Copy + JSON block
    cleaned = cleaned.replace(/\bJSON\b\s*(?:Copy|复制|複製)?\s*\n\s*(\{[\s\S]*?"tool"[\s\S]*?\})\s*\n?/gi, '');
    cleaned = cleaned.replace(/\bJSON\b\s*(?:Copy|复制|複製)?\s*\n?\s*(\{[\s\S]*?"tool"[\s\S]*?\})\s*\n?/gi, '');

    // Pass 2: Code fences with tool JSON
    cleaned = cleaned.replace(/```(?:json|javascript|js|text)?\s*\n?[\s\S]*?"tool"[\s\S]*?\n?```/gi, '');

    // Pass 3: Inline JSON via brace counting — extract response wrappers, skip tool blocks
    let result = '';
    let i = 0;
    while (i < cleaned.length) {
      if (cleaned[i] === '{') {
        let depth = 1, j = i + 1;
        let inString = false, escape = false;
        while (j < cleaned.length && depth > 0) {
          const c = cleaned[j];
          if (escape) escape = false;
          else if (c === '\\') escape = true;
          else if (c === '"') inString = !inString;
          else if (!inString) { if (c === '{') depth++; else if (c === '}') depth--; }
          j++;
        }
        if (depth === 0) {
          const block = cleaned.slice(i, j);
          // Extract {"response": "..."} wrappers — keep the response text
          try {
            const parsed = JSON.parse(block);
            if (parsed.response !== undefined && typeof parsed.response === 'string') {
              result += parsed.response;
              i = j;
              continue;
            }
          } catch {
            // v9.3-fix: JSON.parse failed — try regex extraction for malformed response wrappers
            const respMatch = block.match(/"response"\s*:\s*"((?:\\.|[^"\\])*)"/);
            if (respMatch) {
              result += respMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
              i = j;
              continue;
            }
          }
          // Skip tool call JSON blocks
          if (/"tool"\s*:/.test(block)) { i = j; continue; }
        }
      }
      result += cleaned[i];
      i++;
    }

    // Pass 4: Clean up orphaned labels
    result = result.replace(/\bCopy\b\s*(?:复制|複製)?\s*\n?/gi, '');
    result = result.replace(/\bJSON\b\s*\n?/gi, '');

    // Pass 5: Remove orphaned JSON punctuation (braces, brackets that leaked through)
    // Matches lines that are ONLY JSON punctuation characters
    result = result.replace(/^[\s]*[\}\]\)\,]+[\s]*$/gm, '');
    // Remove stray "}" or "]" at start/end of lines
    result = result.replace(/^[\s]*[\}\]\)]+/gm, '');
    result = result.replace(/[\{\[\(]+[\s]*$/gm, '');

    // v9.3-fix: Remove orphaned key-value fragments like "response": "..."} or "tool": "..."
    result = result.replace(/"response"\s*:\s*"[^"]*"\s*\}?/gi, '');
    result = result.replace(/"tool"\s*:\s*"[^"]*"\s*,?/gi, '');

    // v9.5-fix: Remove inline JSON fragments that leaked through (e.g. tool params snippets)
    // Matches things like: "params": {"command": "..."} or "params": {"path": "..."}
    result = result.replace(/"params"\s*:\s*\{[^{}]*"(?:command|path|script|code|query)"[^{}]*\}/gi, '');
    // Matches trailing JSON fragments like: teShell", "params": {...}
    result = result.replace(/\w*"\s*,\s*"params"\s*:\s*\{[^{}]*\}/gi, '');
    // Matches stray tool name fragments
    result = result.replace(/"tool"\s*:\s*"[^"]*"\s*,?\s*"?\w*"?\s*[:\{\}]?/gi, '');

    result = result.replace(/\n{3,}/g, '\n\n');
    return result.trim();
  }

  // v9.5: rAF-batched progress chunk flushing — prevents UI freeze on fast streams
  // v8.5-fix: Use toolMsgId instead of tool name to avoid collision between same-type tools
  function flushProgressBuffer(toolMsgId) {
    const buf = progressBuffers.get(toolMsgId);
    if (!buf || buf.chunks.length === 0) return;
    const batch = buf.chunks.splice(0);
    buf.raf = null;
    messages.update(msgs => {
      const lastT = msgs.find(m => m.id === toolMsgId && m.type === 'tool');
      if (lastT) {
        return msgs.map(m =>
          m.id === lastT.id
            ? { ...m, liveOutput: (m.liveOutput || '') + batch.join('') }
            : m
        );
      }
      return msgs;
    });
  }
  function queueProgressChunk(toolMsgId, chunk) {
    let buf = progressBuffers.get(toolMsgId);
    if (!buf) {
      buf = { chunks: [], raf: null };
      progressBuffers.set(toolMsgId, buf);
    }
    buf.chunks.push(chunk);
    if (!buf.raf) {
      buf.raf = requestAnimationFrame(() => flushProgressBuffer(toolMsgId));
    }
  }

  function getEventHash(event) {
    // v5.5-fix: Create a unique hash for an event based on its CONTENT + params, not id.
    // The backend generates unique ids per event ('ev-' + Date.now()), so using id
    // in the hash makes deduplication useless — duplicates have different ids.
    // For tool events, include params so two action_start's with different params
    // don't get incorrectly deduplicated.
    const type = event.type || 'unknown';
    const tool = event.tool || '';
    const paramsKey = event.params ? JSON.stringify(event.params).slice(0, 50) : '';
    const text = event.text || event.content || event.fullResponse || '';
    // v8.5-fix: include currentMessageId to prevent collision across different messages
    const raw = `${currentMessageId || ''}:${type}:${tool}:${paramsKey}:${text.slice(0, 100)}`;
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

    // v8.5-fix: Ignore fallback polling events while actively streaming
    if (event.source === 'fallback' && $isStreaming) {
      return;
    }

    // v6.1-fix: If the event has a messageId that doesn't match the current message,
    // it's a stale event from a previous message — ignore it.
    if (event.messageId && currentMessageId && event.messageId !== currentMessageId) {
      console.log('[SSE] Ignoring stale event from previous message:', event.type, event.messageId);
      return;
    }

    // v5.6-fix: Ignore response events until user message is confirmed in store
    const isResponseEvent = ['assistant', 'thinking', 'response_detected', 'partial', 'done', 'tool', 'action_start', 'action_end', 'action_progress'].includes(event.type);
    if (isResponseEvent && !userMessageAdded) {
      console.log('[SSE] Delaying response event until user message is added:', event.type);
      // v9.0-fix: Retry with exponential backoff, max 10 attempts
      event._retryCount = (event._retryCount || 0) + 1;
      if (event._retryCount <= 10) {
        setTimeout(() => handleEvent(event), 100 * event._retryCount);
      } else {
        console.warn('[SSE] Dropping event after 10 retries — user message never confirmed:', event.type);
      }
      return;
    }

    // v9.0-fix: Deduplicate by event hash — prevents duplicate rendering on reconnects
    // NOTE: For action_start/action_end, we use a unique id-based key instead of hash
    // to prevent deduplication of legit sequential tool calls of the same type.
    let dedupKey;
    if (event.type === 'action_start' || event.type === 'action_end' || event.type === 'action_progress') {
      // v10.0-fix: Remove Date.now() from dedupKey — it prevented deduplication entirely,
      // causing pendingToolCount to get stuck > 0 forever. The backend already generates
      // unique ids per event, so tool+id is sufficient.
      dedupKey = `tool:${event.type}:${event.tool || ''}:${event.id || ''}`;
    } else {
      dedupKey = getEventHash(event);
    }
    if (processedEventIds.has(dedupKey)) {
      console.log('[SSE] Deduplicated:', event.type, event.tool || '', event.id || '');
      return;
    }
    processedEventIds.add(dedupKey);
    // Limit set size to prevent memory leaks — increased to 5000 for long sessions
    if (processedEventIds.size > 5000) {
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
        // v8.5-fix: Unify INSTANT and THINKING modes — always use typing indicator, never thinking bubble
        showTyping = true;
        // Clean up any old thinking bubbles from previous messages
        messages.update(msgs => removeAllThinking(msgs));
        thinkingId = null;
        break;
      }
      case 'thinking_delta': {
        // v8.5-fix: Ignore thinking deltas in both instant and thinking modes
        break;
      }
      case 'response_delta': {
        playSound('messageReceived');
        const deltaText = event.text || '';
        // v7.0-fix: Don't process empty deltas.
        if (!deltaText) {
          break;
        }

        // v8.3-fix: Buffer response_delta instead of immediately rendering.
        // This prevents raw JSON/tool blocks from appearing during streaming.
        responseBuffer += deltaText;

        // Hide thinking/typing when response starts arriving
        showTyping = false;
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

        // v9.2-fix: Only flush if there's no incomplete JSON block in the buffer.
        // Flushing incomplete JSON causes raw tool JSON to leak into the chat.
        if (!hasIncompleteJsonBlock(responseBuffer)) {
          flushResponseBuffer();
        }
        break;
      }
      case 'response_detected': {
        // v8.3-fix: response_detected carries the FULL extracted response.
        // Add to buffer and flush immediately since this is a complete chunk.
        playSound('messageReceived');
        showTyping = false;

        const newContent = event.text || event.response || '';
        if (!newContent || newContent.trim().length === 0) {
          console.warn('[ChatArea] response_detected with empty content — skipping, waiting for done');
          break;
        }

        // v9.0-fix: response_detected carries the FULL extracted response.
        // Flush it directly (force) instead of appending to buffer to avoid duplicates.
        flushResponseBuffer(newContent);
        break;
      }
      case 'action_start': {
        mascotState.set('working');
        mascotMessage.set(event.tool ? `Usando ${event.tool}...` : 'Trabalhando...');
        pendingToolCount++; // v9.3-fix
        const toolId = 'tool-' + Date.now();
        const backendToolId = event.toolInstanceId || event.id || ('tool-' + Date.now());
        toolInstanceMap.set(backendToolId, toolId);
        toolStartTimes.set(event.tool, Date.now());

        // v9.5-fix: Close the current assistant bubble before showing the tool card.
        // This ensures the NEXT assistant response starts as a NEW message below the tool,
        // instead of being appended to the previous assistant message.
        // Also remove the last assistant message if it only contains leaked tool JSON or is empty.
        messages.update(msgs => {
          if (msgs.length === 0) return msgs;
          const lastIdx = msgs.length - 1;
          const lastMsg = msgs[lastIdx];
          if (lastMsg && lastMsg.type === 'assistant') {
            const content = lastMsg.content || '';
            const stripped = stripToolBlocksFromBuffer(content);
            const hasToolJson = /"tool"\s*:/.test(content) || /"params"\s*:\s*\{/.test(content) || /"command"\s*:/.test(content);
            // Remove if it's raw JSON, empty after stripping, or very short (likely just a tool call)
            if (hasToolJson || !content.trim() || !stripped.trim() || stripped.trim().length < 10) {
              console.log('[action_start] Removing leaked/empty assistant message before tool card');
              return msgs.slice(0, -1);
            }
          }
          return msgs;
        });
        // CRITICAL: Reset assistant tracking so the next response becomes a NEW message
        currentAssistantId = null;
        responseBuffer = '';

        messages.update(msgs => [...msgs, {
          id: toolId,
          type: 'tool',
          tool: event.tool,
          backendToolId,
          params: event.params || {},
          result: null,
          duration: 0,
          status: 'running', // v9.4-fix
          liveOutput: '',
          timestamp: new Date().toISOString()
        }]);
        
        // v9.4-fix: Start real-time execution timer
        const timerStart = Date.now();
        const intervalId = setInterval(() => {
          const elapsed = ((Date.now() - timerStart) / 1000).toFixed(1);
          mascotMessage.set(`${event.tool || 'Tool'}... ${elapsed}s`);
          messages.update(msgs => {
            const toolMsg = msgs.find(m => m.id === toolId);
            if (toolMsg && toolMsg.status === 'running') {
              return msgs.map(m => m.id === toolId ? { ...m, duration: parseFloat(elapsed) } : m);
            }
            return msgs;
          });
        }, 100);
        runningToolTimers.set(toolId, { intervalId, startTime: timerStart });
        break;
      }
      case 'action_progress': {
        if (!event.chunk) break;
        const targetToolId = toolInstanceMap.get(event.toolInstanceId || event.id);
        if (targetToolId) {
          queueProgressChunk(targetToolId, event.chunk);
        } else {
          queueProgressChunk(event.tool, event.chunk);
        }
        break;
      }
      case 'action_end': {
        playSound('toolComplete');
        // v9.4-fix: Stop real-time timer and get accurate duration
        // v8.5-fix: Use toolInstanceMap to match by backend toolInstanceId
        const msgs = get(messages);
        const targetToolId = toolInstanceMap.get(event.toolInstanceId || event.id);
        let lastTool = targetToolId ? msgs.find(m => m.id === targetToolId) : null;
        if (lastTool) {
          toolInstanceMap.delete(event.toolInstanceId || event.id);
        }
        // Fallback to old behavior if not found
        if (!lastTool) {
          const toolMsgs = msgs.filter(m => m.type === 'tool' && m.tool === event.tool && !m.result);
          lastTool = toolMsgs[toolMsgs.length - 1];
        }
        let duration = 0;
        if (lastTool) {
          const timerInfo = runningToolTimers.get(lastTool.id);
          if (timerInfo) {
            clearInterval(timerInfo.intervalId);
            runningToolTimers.delete(lastTool.id);
            duration = ((Date.now() - timerInfo.startTime) / 1000).toFixed(1);
          } else {
            // Fallback to backend duration if available
            duration = event.result?._meta?.duration ? (event.result._meta.duration / 1000).toFixed(1) : 0;
          }
        }
        toolStartTimes.delete(event.tool);
        // v9.5: Flush any pending progress buffer immediately so final output is complete
        flushProgressBuffer(lastTool ? lastTool.id : event.tool);
        progressBuffers.delete(lastTool ? lastTool.id : event.tool);
        const isSuccess = event.result?.success !== false;
        messages.update(msgs => {
          const tMsgs = msgs.filter(m => m.type === 'tool' && m.tool === event.tool && !m.result);
          const lastT = tMsgs[tMsgs.length - 1];
          if (lastT) {
            return msgs.map(m =>
              m.id === lastT.id
                ? { ...m, result: event.result, duration: parseFloat(duration), status: isSuccess ? 'completed' : 'failed' }
                : m
            );
          }
          return msgs;
        });
        
        // v9.3-fix: Decrement and check ONLY current turn's tools
        pendingToolCount = Math.max(0, pendingToolCount - 1);
        if (pendingToolCount <= 0) {
          mascotState.set('idle');
          mascotMessage.set('O que mais posso fazer?');
          isStreaming.set(false);
        } else {
          mascotMessage.set('Próxima tool...');
        }
        break;
      }
      case 'response_done': {
        showTyping = false;
        // v8.3-fix: Flush any remaining buffer with the final response
        const finalText = event.response || event.text || '';
        if (finalText) {
          responseBuffer = finalText;
          flushResponseBuffer(finalText);
        }
        currentAssistantId = null;
        responseBuffer = '';
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
        showTyping = false;
        messages.update(msgs => removeAllThinking(msgs));
        thinkingId = null;
        const finalResponse = event.result?.response || event.response || event.text;
        console.log('[done] finalResponse length:', finalResponse?.length, 'content:', finalResponse?.substring(0, 100));

        // v8.5-fix: prevent duplicate final message if response_done already handled it
        const msgs = get(messages);
        const alreadyHasDone = msgs.some(m => m.messageId === (event.messageId || currentMessageId) && m.type === 'done');
        if (alreadyHasDone) {
          console.log('[DEBUG-LUNA] Skipping duplicate done event');
          break;
        }
        
        // v9.3-fix: Only flush if we haven't already rendered this response.
        // response_done already flushes and resets currentAssistantId —
        // flushing again here would create a DUPLICATE message.
        if (finalResponse && currentAssistantId) {
          responseBuffer = finalResponse;
          flushResponseBuffer(finalResponse);
        } else if (finalResponse && !currentAssistantId) {
          // v9.4-fix: If response_done reset currentAssistantId but we still have
          // a final response (e.g., no tools were used), create a new assistant message.
          responseBuffer = finalResponse;
          flushResponseBuffer(finalResponse);
        }
        
        // v9.3-fix: Use pendingToolCount (current turn only) instead of scanning full history
        // v8.5-fix: safety timeout for stuck tools
        const toolStuckTimeout = 300000; // 5 min
        if (pendingToolCount > 0) {
          const stuckTool = Array.from(toolStartTimes.values()).some(startTime => (Date.now() - startTime) > toolStuckTimeout);
          if (stuckTool) {
            console.warn('[done] Tools stuck for >5min — forcing pendingToolCount = 0');
            pendingToolCount = 0;
          } else {
            console.log('[done] Tools ainda em execução — mantendo isStreaming=true até action_end chegar');
            mascotState.set('working');
            mascotMessage.set('Finalizando tools...');
          }
        }
        if (pendingToolCount <= 0) {
          isStreaming.set(false);
          mascotState.set('idle');
          mascotMessage.set('O que mais posso fazer?');
        }
        currentAssistantId = null;
        responseBuffer = '';
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
    responseBuffer = ''; // v9.5-fix: Clear buffer on session switch/reconnect
    processedEventIds.clear(); // v4.2: Clear dedup set on reconnect
    sseManager.disconnect();
    sseManager = new SSEManager();

    // v3.6-fix: Load full message history from backend instead of clearing
    try {
      const history = await fetchSessionMessages(sessionId);
      if (history.ok && history.messages) {
        const loaded = [];
        let currentAssistantContent = '';
        for (const msg of history.messages) {
          if (msg.role === 'user') {
            loaded.push({
              id: msg.id || 'msg-' + Math.random().toString(36).slice(2),
              type: 'user',
              content: msg.content || '',
              files: msg.files || [],
              timestamp: msg.timestamp || new Date().toISOString(),
            });
          } else if (msg.type === 'thinking_start' || msg.type === 'thinking_delta') {
            // v8.5-fix: Ignore thinking events in history load
            continue;
          } else if (msg.type === 'response_delta' && msg.content) {
            currentAssistantContent = msg.content;
          } else if (msg.type === 'done') {
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

    // v9.1-fix: Clear flushed content hashes for new message to allow fresh responses
    flushedContentHashes.clear();

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
    // v9.5-fix: Also reset responseBuffer to prevent new responses from appending to old ones
    currentAssistantId = null;
    thinkingId = null;
    responseBuffer = '';

    // v4.0-fix: Remove all previous thinking bubbles when sending a new message
    messages.update(msgs => removeAllThinking(msgs));

    // v8.5-fix: Unify feedback for all modes — always use typing indicator
    showTyping = true;

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
    mascotState.set('thinking');
    mascotMessage.set('Hmm... deixa eu pensar...');

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
        if (['systemRestart', 'systemStatus', 'systemStop', 'systemStart', 'systemHealth', 'systemLogs', 'turnOffAgent', 'refreshAgent', 'fullRefreshAgent'].includes(slashDef.handler)) {
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
            case 'refreshAgent': {
              isStreaming.set(false);
              currentAssistantId = null;
              thinkingId = null;
              responseBuffer = '';
              pendingToolCount = 0;
              processedEventIds.clear();
              flushedContentHashes.clear();
              await connectSSE();
              messages.update(msgs => [...msgs, {
                id: 'sys-' + Date.now(),
                type: 'system',
                content: '🔄 Agent refresh — estado limpo, SSE reconectado.',
                timestamp: new Date().toISOString()
              }]);
              return;
            }
            case 'fullRefreshAgent': {
              isStreaming.set(false);
              currentAssistantId = null;
              thinkingId = null;
              responseBuffer = '';
              pendingToolCount = 0;
              processedEventIds.clear();
              flushedContentHashes.clear();
              await connectSSE();
              // Send a continuation message to the backend
              if (activeSessionId) {
                try {
                  await sendMessage('Continue de onde parou. Leia o historico e execute a proxima acao pendente.', activeSessionId, $currentMode);
                  await connectSSE();
                } catch (e) {
                  console.error('[fullRefresh] Failed to send continuation:', e);
                }
              }
              messages.update(msgs => [...msgs, {
                id: 'sys-' + Date.now(),
                type: 'system',
                content: '🔁 Full refresh — reconectado, retomando execucao do historico...',
                timestamp: new Date().toISOString()
              }]);
              return;
            }
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
              content: '⚡ Modos disponiveis: instant (⭐ Recomendado), thinking, agent, swarm',
              timestamp: new Date().toISOString()
            }]);
          }
          return;
        }
        // v9.3: Modal handlers — open rich dashboard modals instead of plain text
        else if (slashDef.modal) {
          isStreaming.set(false);
          activeModal.set(slashDef.modal);
          messages.update(msgs => [...msgs, {
            id: 'sys-' + Date.now(),
            type: 'system',
            content: `📊 Abrindo ${slashDef.modal}...`,
            timestamp: new Date().toISOString()
          }]);
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
    for (const { intervalId } of runningToolTimers.values()) {
      clearInterval(intervalId);
    }
    runningToolTimers.clear();
    sseManager.disconnect();
    stopHeartbeat();
    mascotState.set('sleep');
  });
</script>

<div class="chat-area">
  <ChatHeader
    title={$messages.find(m => m.type === 'user')?.content?.slice(0, 50) || 'Nova Conversa'}
    mode={$currentMode}
    isStreaming={$isStreaming}
    sessionId={sessionId}
    on:modeChange={(e) => currentMode.set(e.detail)}
    on:clear={handleClear}
    on:export={handleExport}
    on:openConfig
    on:newChat
    on:editTitle
    on:goHome={() => currentSessionId.set(null)}
  />

  <MessagesList
    messages={$messages}
    showTyping={showTyping}
    currentMode={$currentMode}
    onApprovePlan={handleApprovePlan}
    onRejectPlan={handleRejectPlan}
    onRevisePlan={handleRevisePlan}
  />

  <ChatInput
    onSend={handleSend}
    onCancel={handleCancel}
    disabled={$isStreaming}
  />

  <!-- v9.3: Rich modal responses for dashboard slash commands -->
  <TaskDashboardModal
    open={$activeModal === 'tasks'}
    onClose={() => activeModal.set(null)}
  />
  <LeadDashboardModal
    open={$activeModal === 'leads'}
    onClose={() => activeModal.set(null)}
  />
  <FinanceDashboardModal
    open={$activeModal === 'finance'}
    onClose={() => activeModal.set(null)}
  />
  <VotingDashboardModal
    open={$activeModal === 'voting'}
    onClose={() => activeModal.set(null)}
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
  /* Header is now self-contained, no wrapper needed */
</style>
