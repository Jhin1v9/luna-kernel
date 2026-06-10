// Luna Extension — Injected into MAIN world of kimi.com
// v8.0: Real-time DOM observer that streams events via window.postMessage
// to the content script in ISOLATED world.

(function setupLunaDomObserver() {
  if (window.__lunaDomObserver) return;

  const VERSION = '2.0.0-v10.7';
  const DEBOUNCE_MS = 250; // v10.7-fix: Increased from 50ms to reduce CPU load during streaming
  const TOOL_DEDUP_TTL_MS = 60000; // 60s TTL for deduplicating tool calls
  const SELECTORS = {
    assistantSegment: '.segment-assistant, [data-testid="segment-assistant"], .assistant-segment, .segment-content',
    codeBlock: 'pre code, .segment-code, [class*="code"]',
    toolContainer: '[class*="toolcall"], .toolcall-ipython, .toolcall-web_search, .toolcall-web_open_url, .toolcall-search_image',
    sendButton: 'button[type="submit"], .send-btn, [data-testid="send-button"]',
    stopButton: 'button.stop-btn, .stop-generation, [data-testid="stop-button"]',
    thinking: '.thinking, [class*="thinking"], .segment-thinking, [class*="think-block"], [data-testid*="think"]',
    textContent: '.segment-text, .message-content, .markdown-container, [class*="segment-text"], [class*="message-content"]'
  };

  // ── Event Sender ──
  // Sends events to content script via window.postMessage
  function sendEvent(type, data) {
    try {
      window.postMessage({
        source: 'luna-injected',
        version: VERSION,
        type: type,
        data: data || {},
        timestamp: Date.now(),
        url: window.location.href
      }, '*');
    } catch (e) {
      // Ignore postMessage errors
    }
  }

  // ── Utilities ──
  function debounce(fn, wait) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => { try { fn.apply(this, args); } catch (e) {} }, wait);
    };
  }

  function safeQuery(selector, root) {
    try { return (root || document).querySelectorAll(selector); }
    catch (e) { return []; }
  }

  function safeText(el) {
    try { return (el.textContent || '').trim(); }
    catch (e) { return ''; }
  }

  // ── JSON Block Detection ──
  function detectJsonBlocks(container) {
    const results = { actions: [], responses: [] };
    try {
      for (const block of safeQuery(SELECTORS.codeBlock, container)) {
        const text = safeText(block);
        if (!text || text.length < 10) continue;

        const isJsonLike = (text.startsWith('{') && text.includes('"')) ||
                           (text.startsWith('[') && text.includes('"'));
        if (!isJsonLike) continue;

        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          const m = text.match(/\{[\s\S]*?\}/);
          if (m) try { parsed = JSON.parse(m[0]); } catch (e2) { continue; }
          else continue;
        }

        if (!parsed) continue;

        if (parsed.tool !== undefined || parsed.action !== undefined) {
          results.actions.push({
            tool: parsed.tool || parsed.action,
            params: parsed.params || parsed.arguments || parsed
          });
        } else if (parsed.response !== undefined || parsed.result !== undefined) {
          results.responses.push({ response: parsed.response || parsed.result });
        }
      }
    } catch (e) {}
    return results;
  }

  // ── Button State ──
  function detectButtonState() {
    const state = { sendVisible: false, stopVisible: false };
    try {
      const sendBtn = document.querySelector(SELECTORS.sendButton);
      const stopBtn = document.querySelector(SELECTORS.stopButton);
      if (sendBtn) state.sendVisible = window.getComputedStyle(sendBtn).display !== 'none' && sendBtn.offsetParent !== null;
      if (stopBtn) state.stopVisible = window.getComputedStyle(stopBtn).display !== 'none' && stopBtn.offsetParent !== null;
      if (!state.stopVisible) {
        const anyStop = document.querySelector('[class*="stop"], [aria-label*="stop"], [aria-label*="cancel"]');
        if (anyStop) state.stopVisible = window.getComputedStyle(anyStop).display !== 'none' && anyStop.offsetParent !== null;
      }
    } catch (e) {}
    return state;
  }

  // ── Assistant Segments ──
  function detectAssistantSegments(root) {
    const segments = [];
    try {
      for (const node of safeQuery(SELECTORS.assistantSegment, root)) {
        const text = safeText(node);
        const segId = node.getAttribute('data-segment-id') || node.getAttribute('id') || ('seg_' + Math.random().toString(36).slice(2, 8));
        const isNew = !node.__lunaObserved;
        if (isNew) { node.__lunaObserved = true; node.__lunaSegmentId = segId; }

        const jsonBlocks = detectJsonBlocks(node);
        segments.push({
          id: segId,
          isNew,
          textLength: text.length,
          hasCodeBlocks: jsonBlocks.actions.length > 0 || jsonBlocks.responses.length > 0,
          toolCalls: jsonBlocks.actions,
          toolResponses: jsonBlocks.responses,
          isComplete: !node.classList.contains('streaming') && !node.querySelector('[class*="streaming"], [class*="loading"]')
        });
      }
    } catch (e) {}
    return segments;
  }

  // ── Streaming Detection ──
  let _lastStreamText = '';
  let _lastStreamTs = 0;
  let _lastSentResponse = ''; // v10.7-fix: cache to avoid duplicate stream_state events

  function detectStreaming() {
    const info = { isStreaming: false, textDelta: '', thinking: '', response: '' };
    try {
      // v10.7-fix: Only process the LAST assistant, not all historical ones
      const assistants = safeQuery(SELECTORS.assistantSegment);
      const lastAssistant = assistants[assistants.length - 1];
      if (lastAssistant) {
        // Only get thinking from the last assistant
        const thinkNode = lastAssistant.querySelector(SELECTORS.thinking);
        if (thinkNode) info.thinking = safeText(thinkNode);
        // Only get text from the last assistant
        const textNodes = lastAssistant.querySelectorAll(SELECTORS.textContent);
        let currentText = '';
        for (const node of textNodes) {
          currentText += safeText(node) + ' ';
        }
        const now = Date.now();
        if (currentText !== _lastStreamText) {
          info.textDelta = currentText.slice(_lastStreamText.length);
          info.isStreaming = true;
          _lastStreamText = currentText;
          _lastStreamTs = now;
        } else {
          info.isStreaming = (now - _lastStreamTs) < 3000;
        }
        info.response = currentText;
      }
    } catch (e) {}
    return info;
  }

  // ── Mutation Processing ──
  let _lastButtonState = {};
  let _lastStreamState = {};
  const _detectedTools = new Set();   // Deduplication: tool+params keys already emitted
  let _lastDedupCleanup = Date.now();
  let _isProcessing = false; // v10.7-fix: Prevent concurrent processing

  function getToolKey(tool, params) {
    try {
      const paramsStr = JSON.stringify(params);
      // v8.2-fix: Limit key size to prevent CPU/memory spikes on large params (e.g. writeFile content)
      if (paramsStr.length > 200) {
        return `${tool}::${paramsStr.slice(0, 100)}...${paramsStr.slice(-50)}`;
      }
      return `${tool}::${paramsStr}`;
    }
    catch (e) { return `${tool}::${Date.now()}`; }
  }

  function cleanupDedupSet() {
    // Simple periodic cleanup: if set grows too large, clear old entries by age
    // Since we can't track per-item age in a Set, we use a simpler approach:
    // if the set is very large, clear it entirely (rare edge case for long sessions)
    if (_detectedTools.size > 500) {
      _detectedTools.clear();
    }
    _lastDedupCleanup = Date.now();
  }

  function processMutations(mutations) {
    // v10.7-fix: Skip if already processing to prevent stacking
    if (_isProcessing) return;
    _isProcessing = true;

    try {
      // v10.7-fix: Only process the LAST assistant segment, not all historical ones
      const assistants = safeQuery(SELECTORS.assistantSegment);
      const lastAssistant = assistants[assistants.length - 1];
      if (lastAssistant) {
        const segId = lastAssistant.getAttribute('data-segment-id') || lastAssistant.getAttribute('id') || ('seg_' + Math.random().toString(36).slice(2, 8));
        const isNew = !lastAssistant.__lunaObserved;
        if (isNew) { lastAssistant.__lunaObserved = true; lastAssistant.__lunaSegmentId = segId; }

        const jsonBlocks = detectJsonBlocks(lastAssistant);
        if (isNew) {
          sendEvent('segment_complete', {
            segmentId: segId,
            textLength: safeText(lastAssistant).length,
            hasCodeBlocks: jsonBlocks.actions.length > 0 || jsonBlocks.responses.length > 0,
            toolCallsCount: jsonBlocks.actions.length,
            isComplete: !lastAssistant.classList.contains('streaming') && !lastAssistant.querySelector('[class*="streaming"], [class*="loading"]')
          });
        }
        for (const tc of jsonBlocks.actions) {
          const toolKey = getToolKey(tc.tool, tc.params);
          if (!_detectedTools.has(toolKey)) {
            _detectedTools.add(toolKey);
            sendEvent('tool_call_detected', {
              segmentId: segId,
              tool: tc.tool,
              params: tc.params
            });
          }
        }
        for (const tr of jsonBlocks.responses) {
          sendEvent('tool_response_detected', {
            segmentId: segId,
            response: tr.response
          });
        }
      }

      // Detect button state changes
      const btnState = detectButtonState();
      if (btnState.stopVisible !== _lastButtonState.stopVisible ||
          btnState.sendVisible !== _lastButtonState.sendVisible) {
        sendEvent('button_state', {
          sendVisible: btnState.sendVisible,
          stopVisible: btnState.stopVisible
        });
        _lastButtonState = btnState;
      }

      // Detect streaming
      const streamInfo = detectStreaming();
      if (streamInfo.isStreaming && streamInfo.textDelta) {
        sendEvent('stream_chunk', {
          deltaLength: streamInfo.textDelta.length,
          thinking: streamInfo.thinking.slice(0, 200)
        });
        // v10.7-fix: Only send stream_state if response actually changed
        if (streamInfo.response !== _lastSentResponse) {
          _lastSentResponse = streamInfo.response;
          sendEvent('stream_state', {
            thinking: streamInfo.thinking,
            response: streamInfo.response,
            isStreaming: true,
            textDelta: streamInfo.textDelta
          });
        }
      }

      // Periodic dedup cleanup
      if (Date.now() - _lastDedupCleanup > TOOL_DEDUP_TTL_MS) {
        cleanupDedupSet();
      }

      // Detect newly added JSON blocks in mutations
      for (const m of mutations) {
        if (m.type === 'childList') {
          for (const added of m.addedNodes) {
            if (added.nodeType !== Node.ELEMENT_NODE) continue;
            for (const block of safeQuery('pre code, code', added)) {
              const text = safeText(block);
              if (text.includes('"tool"') || text.includes('"response"')) {
                const jsonResult = detectJsonBlocks(added);
                if (jsonResult.actions.length || jsonResult.responses.length) {
                  sendEvent('json_block_added', {
                    actions: jsonResult.actions,
                    responses: jsonResult.responses
                  });
                }
              }
            }
          }
        }
      }
    } catch (e) {}

    _isProcessing = false;
  }

  const debouncedProcess = debounce(processMutations, DEBOUNCE_MS);

  const observer = new MutationObserver((mutations) => {
    // v10.7-fix: Direct call instead of requestIdleCallback to avoid timeout pressure
    debouncedProcess(mutations);
  });

  // v10.7-fix: Observe ONLY childList + subtree. Attributes cause massive mutation records
  // during Kimi streaming (text insertion, class changes). childList is sufficient to detect
  // new assistant segments, code blocks, and buttons.
  try {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  } catch (e) {
    try {
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    } catch (e2) {}
  }

  // v10.7-fix: Heartbeat reduced from 2s to 10s — stream end detection doesn't need to be frequent
  let _streamEndEmitted = false;
  const heartbeatInterval = setInterval(() => {
    try {
      const streamInfo = detectStreaming();
      const btnState = detectButtonState();
      const wasStreaming = _lastStreamState.isStreaming;
      const nowStreaming = streamInfo.isStreaming;
      // v10.7-fix: Only send stream_state if response changed or state transitioned
      if (nowStreaming && streamInfo.response !== _lastSentResponse) {
        _lastSentResponse = streamInfo.response;
        sendEvent('stream_state', {
          thinking: streamInfo.thinking,
          response: streamInfo.response,
          isStreaming: true
        });
      }
      if (wasStreaming && !nowStreaming && !btnState.stopVisible && !_streamEndEmitted) {
        _streamEndEmitted = true;
        sendEvent('stream_end', { finalTextLength: _lastStreamText.length });
        sendEvent('stream_state', {
          thinking: streamInfo.thinking,
          response: streamInfo.response,
          isStreaming: false,
          isComplete: true
        });
      }
      if (nowStreaming) {
        _streamEndEmitted = false; // Reset when streaming resumes
      }
      _lastStreamState = { isStreaming: nowStreaming };
    } catch (e) {}
  }, 10000); // v10.7-fix: 10s instead of 2s

  // Teardown on page unload
  function teardown() {
    try {
      clearInterval(heartbeatInterval);
      observer.disconnect();
      delete window.__lunaDomObserver;
    } catch (e) {}
  }

  window.__lunaDomObserver = {
    observer,
    teardown,
    version: VERSION,
    stats: () => ({ isObserving: true, url: window.location.href })
  };

  window.addEventListener('beforeunload', teardown, { once: true });

  // SPA navigation handling
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    sendEvent('spa_navigate', { method: 'pushState', url: window.location.href });
    return result;
  };

  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    sendEvent('spa_navigate', { method: 'replaceState', url: window.location.href });
    return result;
  };

  // Signal ready
  sendEvent('observer_ready', { url: window.location.href, version: VERSION });

  console.log(`[Luna Injected] v${VERSION} DOM observer active — streaming events to content script`);
})();
