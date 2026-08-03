// Luna Extension — Injected into MAIN world of provider pages (kimi.com, chat.deepseek.com, etc.)
// v2.5.2: Thinking/source-of-truth extraction based on Kimi's .thinking-container.
// Rule: text INSIDE the .thinking-container is reasoning; text OUTSIDE is the answer/tool.
// v11.7-fix: detect the thinking container as early as possible via a lightweight
// chat-container MutationObserver, so we capture the reasoning from the start instead
// of joining it mid-stream.
// v2.6.0: Robust thinking/response separation with expanded selectors and fallback heuristic.

(function setupLunaDomObserver() {
  if (window.__lunaDomObserver) {
    try { window.__lunaDomObserver.version = '2.6.0'; } catch (e) {}
    return;
  }

  const VERSION = '2.6.3';
  const POLL_MS = 80;           // read DOM every 80ms while generating
  const HEARTBEAT_MS = 600;     // full-state resync while streaming
  const BATCH_MS = 40;          // batch postMessage calls to content script
  const TOOL_DEDUP_TTL_MS = 120000;

  // ── Provider-specific selector chains. Order matters: first match wins. ──
  function getSelectors() {
    const host = window.location.hostname;
    if (host.includes('deepseek.com') || host.includes('deepseek.ai')) {
      return {
        chatContainer: '.ds-chat, .chat-content, [class*="chat-content"], [class*="conversation-list"], main',
        assistantSegment: [
          '.ds-message[data-message-role="assistant"]',
          '.message.assistant-message',
          '[data-message-role="assistant"]',
          '.ds-message'
        ].join(','),
        thinkingContainer: [
          '.ds-thinking',
          '[class*="thinking"]',
          '[class*="reasoning"]'
        ].join(','),
        thinkingText: [
          '.ds-markdown',
          '.markdown',
          '.message-content'
        ].join(','),
        responseContainer: [
          '.ds-markdown',
          '.message-content',
          '.ds-message .markdown'
        ].join(','),
        codeBlock: [
          'pre code',
          '.ds-markdown pre code',
          '.ds-message pre code'
        ].join(','),
        toolContainer: [
          '[class*="toolcall"]'
        ].join(','),
        sendButton: [
          'div[role="button"].ds-button--primary',
          'div[role="button"][aria-label*="send" i]',
          'button[type="submit"]'
        ].join(','),
        stopButton: [
          'div[role="button"] svg[class*="stop"]',
          'div[role="button"][aria-label*="stop" i]',
          '[class*="stop"]'
        ].join(',')
      };
    }

    // Default: Kimi Web (covers 2026-07 refresh and legacy variants)
    return {
      chatContainer: [
        '.chat-content',
        '.chat-main',
        '[class*="chat-content"]',
        '[class*="conversation-list"]',
        '[class*="chat-list"]',
        'main'
      ].join(','),
      assistantSegment: [
        '.chat-content-item.chat-content-item-assistant',
        '.segment.segment-assistant',
        '[data-message-role="assistant"]',
        '[data-testid="segment-assistant"]',
        '.assistant-segment',
        '.message.assistant'
      ].join(','),
      // Source of truth: the dedicated thinking container rendered by Kimi.
      // v11.8: expanded to cover current and future class variants.
      thinkingContainer: [
        '.toolcall-container.thinking-container',
        '.thinking-container',
        '[class*="thinking-container"]',
        '[class*="think-container"]',
        '[class*="reasoning-container"]',
        '[class*="thought-container"]',
        '[class*="toolcall-container"][class*="thinking"]'
      ].join(','),
      // Where to read the actual reasoning text from inside the container.
      // v11.8: cover more markdown/text container variants.
      thinkingText: [
        '.toolcall-container.thinking-container .markdown-container',
        '.toolcall-container.thinking-container .markdown',
        '.thinking-container .markdown-container',
        '.thinking-container .markdown',
        '[class*="thinking-container"] .markdown-container',
        '[class*="thinking-container"] .markdown',
        '[class*="think-container"] .markdown-container',
        '[class*="reasoning-container"] .markdown-container',
        '[class*="thought-container"] .markdown-container'
      ].join(','),
      // Response comes from markdown/text containers that are NOT inside the thinking container.
      // v11.8: removed .segment-content-box and .segment-text — they are ancestors of the
      // thinking container and leak reasoning text into the response when the thinking
      // container is not found in time. Prefer leaf paragraphs/markdown containers.
      responseContainer: [
        '.markdown-container .markdown',
        '.markdown-container',
        '.message-content',
        '[class*="message-content"]',
        '.segment-assistant .paragraph',
        '.segment-assistant p',
        '[class*="segment-content"] .paragraph',
        '[class*="segment-content"] p',
        '.block-item .paragraph',
        '.block-item p'
      ].join(','),
      codeBlock: [
        'pre code',
        '.segment-code',
        '.markdown-container pre code',
        '.markdown pre code',
        '[class*="code-block"] code'
      ].join(','),
      toolContainer: [
        '[class*="toolcall"]',
        '.toolcall-ipython',
        '.toolcall-web_search',
        '.toolcall-web_open_url',
        '.toolcall-search_image',
        '.toolcall-browser',
        '.toolcall-computer'
      ].join(','),
      sendButton: [
        '.send-button-container',
        'button[type="submit"]',
        '.send-btn',
        '[data-testid="send-button"]',
        '[aria-label*="send" i]'
      ].join(','),
      stopButton: [
        '.stop-button-container',
        'button.stop-btn',
        '.stop-generation',
        '[data-testid="stop-button"]',
        '[aria-label*="stop" i]',
        '[class*="stop"]'
      ].join(',')
    };
  }

  const SELECTORS = getSelectors();

  // ── Extension presence markers ──
  window.__lunaObserverVersion = VERSION;
  try {
    if (window.__lunaDomObserver && typeof window.__lunaDomObserver.teardown === 'function') {
      window.__lunaDomObserver.teardown();
    }
    // If the legacy Playwright fallback was already injected, tear it down.
    if (window.__lunaUltraLightObserver && typeof window.__lunaUltraLightObserver.docObserver !== 'undefined') {
      window.__lunaUltraLightObserver.docObserver.disconnect();
      window.__lunaUltraLightObserver = undefined;
    }
    if (window.__lunaEventQueue && typeof window.__lunaEventQueue === 'object') {
      window.__lunaEventQueue = undefined;
    }
    if (window.__lunaDomObserver && window.__lunaDomObserver.observer) {
      window.__lunaDomObserver.observer.disconnect();
    }
  } catch (e) {}

  // ── Event batcher ──
  let _eventQueue = [];
  let _flushTimer = null;

  function flushEvents() {
    if (_eventQueue.length === 0) return;
    const batch = _eventQueue.slice();
    _eventQueue = [];
    try {
      window.postMessage({
        source: 'luna-injected',
        version: VERSION,
        type: 'luna_event_batch',
        events: batch,
        timestamp: Date.now(),
        url: window.location.href
      }, '*');
    } catch (e) {}
  }

  function queueEvent(type, data) {
    _eventQueue.push({ type, data, timestamp: Date.now(), url: window.location.href });
    if (_flushTimer) clearTimeout(_flushTimer);
    _flushTimer = setTimeout(flushEvents, BATCH_MS);
  }

  // ── Utilities ──
  function safeQuery(selector, root) {
    try { return (root || document).querySelectorAll(selector); }
    catch (e) { return []; }
  }

  function safeText(el) {
    try { return (el.textContent || '').trim(); }
    catch (e) { return ''; }
  }

  function isVisible(el) {
    try {
      if (!el) return false;
      return !!(el.offsetParent !== null && window.getComputedStyle(el).display !== 'none');
    } catch (e) { return false; }
  }

  function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return h;
  }

  function className(el) {
    try { return (el.className || '').toLowerCase(); }
    catch (e) { return ''; }
  }

  function isInsideThinkingContainer(el, thinkingContainer) {
    if (!thinkingContainer || !el) return false;
    return el === thinkingContainer || thinkingContainer.contains(el);
  }

  function isCopyButton(el) {
    try {
      const text = (el.textContent || '').toLowerCase();
      const cls = className(el);
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      return text.includes('copy') || text.includes('复制') || text.includes('複製') || text.includes('copiar') ||
             cls.includes('copy') || aria.includes('copy');
    } catch (e) { return false; }
  }

  function isCodeElement(el) {
    try {
      const tag = (el.tagName || '').toLowerCase();
      const cls = className(el);
      return tag === 'pre' || tag === 'code' || cls.includes('code') || cls.includes('language-');
    } catch (e) { return false; }
  }

  // ── Assistant / thinking / response extraction ──
  function findChatContainer() {
    for (const node of safeQuery(SELECTORS.chatContainer)) {
      if (isVisible(node)) return node;
    }
    return document.body;
  }

  function findLastAssistant() {
    const segs = safeQuery(SELECTORS.assistantSegment);
    if (segs.length > 0) return segs[segs.length - 1];
    const fallbacks = document.querySelectorAll('[class*="assistant"], [class*="bot-message"]');
    return fallbacks.length ? fallbacks[fallbacks.length - 1] : null;
  }

  function findThinkingContainer(assistant) {
    if (!assistant) return null;
    // v11.8: prefer the most specific match first, then fall back to any thinking-ish container.
    const candidates = safeQuery(SELECTORS.thinkingContainer, assistant);
    for (const node of candidates) {
      const cls = className(node);
      if (cls.includes('thinking-container')) return node;
    }
    for (const node of candidates) {
      const cls = className(node);
      if (cls.includes('thinking') || cls.includes('think-container') || cls.includes('reasoning') || cls.includes('thought')) return node;
    }
    return null;
  }

  // Extract ALL reasoning text from the container, not just the first markdown leaf.
  function extractThinking(thinkingContainer) {
    if (!thinkingContainer) return '';
    try {
      // Try the explicit markdown container first, but collect ALL matching containers
      // in case Kimi splits the thinking into multiple blocks.
      let combined = '';
      const explicitNodes = thinkingContainer.querySelectorAll(SELECTORS.thinkingText);
      if (explicitNodes.length > 0) {
        // v2.6.2-fix: selectors may match nested containers (e.g. .markdown-container
        // and the .markdown inside it). Keep only the deepest nodes to avoid duplicating
        // the same text for every ancestor/descendant pair.
        const keep = [];
        for (const node of explicitNodes) {
          const hasDescendantSelected = Array.from(explicitNodes).some(other =>
            other !== node && node.contains(other)
          );
          if (!hasDescendantSelected) keep.push(node);
        }
        for (const node of keep) {
          const t = collectTextIgnoringChrome(node);
          if (t) combined += t + '\n\n';
        }
        if (combined) return stripThinkingHeader(combined);
      }

      // Fallback: walk the container ignoring non-reasoning UI chrome.
      return stripThinkingHeader(collectTextIgnoringChrome(thinkingContainer));
    } catch (e) { return ''; }
  }

  // Collect text from an element, skipping headers, copy buttons and code blocks.
  function collectTextIgnoringChrome(root) {
    let text = '';
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent || '';
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (isCopyButton(node)) return;
      if (isCodeElement(node)) {
        // Still include the text of JSON code blocks if they are inside the thinking,
        // because the model may be emitting the JSON wrapper there. But skip copy buttons.
        const cls = className(node);
        const isJsonBlock = cls.includes('json') || /["']tool["']|"response"/.test(node.textContent || '');
        if (!isJsonBlock) return;
      }
      // Skip a standalone header element (covers Portuguese UI variants too).
      // Only treat it as a header if the node has no element children; otherwise
      // returning here would discard the entire reasoning block when the container
      // itself starts with "Analisando...".
      const nodeText = safeText(node);
      const hasElementChildren = Array.from(node.childNodes).some(n => n.nodeType === Node.ELEMENT_NODE);
      if (!hasElementChildren && nodeText && /^\s*(Think|Thinking|Pensando|Analisando|Analisar|Raciocínio|Raciocinando|Concluído|Concluindo|Raciocínio concluído|Reasoning|Processando|Searching|Buscando)\b/i.test(nodeText)) {
        return;
      }
      for (const child of node.childNodes) walk(child);
    };
    walk(root);
    return text;
  }

  function stripThinkingHeader(text) {
    return text
      .replace(/^\s*(Think|Thinking|Pensando|Analisando|Analisar|Raciocínio|Raciocinando|Concluído|Concluindo|Raciocínio concluído|Reasoning|Processando|Searching|Buscando)\s*[.:]?\s*/i, '')
      .replace(/\s*JSON\s*Copy\s*$/i, '')
      .trim();
  }

  function extractResponse(assistant, thinkingContainer) {
    try {
      let text = '';
      for (const node of safeQuery(SELECTORS.responseContainer, assistant)) {
        if (isInsideThinkingContainer(node, thinkingContainer)) continue;
        if (node.closest && node.closest(SELECTORS.thinkingContainer)) continue;
        if (node.closest && node.closest(SELECTORS.toolContainer)) continue;
        // v11.8-fix: skip any response candidate that is an ancestor of the thinking
        // container (e.g. .segment-content-box / .segment-text). safeText on those
        // would pull the collapsed reasoning text into the response.
        if (thinkingContainer && node !== thinkingContainer && node.contains && node.contains(thinkingContainer)) continue;
        // v11.8-fix: also skip if this node contains ANY thinking-ish container.
        const hasThinkingDescendant = thinkingContainer
          ? false
          : !!node.querySelector && node.querySelector(SELECTORS.thinkingContainer);
        if (hasThinkingDescendant) continue;
        const t = safeText(node);
        if (t) text += t + '\n\n';
      }
      return text.trim();
    } catch (e) { return ''; }
  }

  // v2.6.3: The boundary rule is absolute — everything inside the thinking
  // container is reasoning; everything outside is response/tool. We no longer
  // treat a "JSON Copy" button or a JSON code block inside the thinking container
  // as a signal that reasoning ended; those elements are still part of Kimi's
  // reasoning UI and must stay in the thinking bubble.

  // ── JSON block detection (response/tool blocks outside the thinking container) ──
  function extractFirstJsonObject(text) {
    if (!text || text.length < 2) return null;
    let i = 0;
    while (i < text.length) {
      if (text[i] !== '{') { i++; continue; }
      const start = i;
      let depth = 1;
      let inString = false;
      let escape = false;
      i++;
      while (i < text.length && depth > 0) {
        const c = text[i];
        if (escape) {
          escape = false;
        } else if (c === '\\') {
          escape = true;
        } else if (c === '"') {
          if (inString) {
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j])) j++;
            if (j >= text.length || text[j] === ',' || text[j] === ':' || text[j] === '}' || text[j] === ']') {
              inString = false;
            }
          } else {
            inString = true;
          }
        } else if (!inString) {
          if (c === '{') depth++;
          else if (c === '}') depth--;
        }
        i++;
      }
      if (depth === 0) return text.slice(start, i);
    }
    return null;
  }

  function parseJsonBlock(text) {
    if (!text || text.length < 5) return null;
    const isJsonLike = (text.startsWith('{') && text.includes('"')) ||
                       (text.startsWith('[') && text.includes('"'));
    if (!isJsonLike) return null;
    try { return JSON.parse(text); }
    catch (e) {
      const objText = extractFirstJsonObject(text);
      if (objText) try { return JSON.parse(objText); } catch (e2) { return null; }
    }
    return null;
  }

  function detectJsonBlocks(container, thinkingContainer) {
    const results = { actions: [], responses: [] };
    try {
      for (const block of safeQuery(SELECTORS.codeBlock, container)) {
        if (isInsideThinkingContainer(block, thinkingContainer)) continue;
        const parsed = parseJsonBlock(safeText(block));
        if (!parsed) continue;
        if (parsed.tool !== undefined || parsed.action !== undefined) {
          results.actions.push({ tool: parsed.tool || parsed.action, params: parsed.params || parsed.arguments || {} });
        } else if (parsed.response !== undefined || parsed.result !== undefined) {
          results.responses.push({ response: parsed.response || parsed.result });
        }
      }
    } catch (e) {}
    return results;
  }

  // ── Button state ──
  function detectButtonState() {
    const state = { sendVisible: false, stopVisible: false };
    try {
      const sendBtn = document.querySelector(SELECTORS.sendButton);
      const stopBtn = document.querySelector(SELECTORS.stopButton);
      if (sendBtn) state.sendVisible = isVisible(sendBtn) && !sendBtn.disabled;
      if (stopBtn) state.stopVisible = isVisible(stopBtn) && !stopBtn.disabled;
    } catch (e) {}
    return state;
  }

  // ── Streaming state machine ──
  let _currentAssistant = null;
  let _lastSentThinking = '';
  let _lastSentResponse = '';
  let _thinkingStartedEmitted = false;
  let _wasStreaming = false;
  let _detectedToolKeys = new Set();
  let _detectedResponseKeys = new Set();
  let _lastDedupCleanup = Date.now();
  let _lastButtonState = {};
  let _lastSeenThinkingContainer = null;
  let _firstThinkingSnapshot = '';

  function getToolKey(tool, params) {
    try {
      const paramsStr = JSON.stringify(params);
      if (paramsStr.length > 200) return `${tool}::${hashString(paramsStr)}`;
      return `${tool}::${paramsStr}`;
    } catch (e) { return `${tool}::${Date.now()}`; }
  }

  function cleanupDedup() {
    if (Date.now() - _lastDedupCleanup < TOOL_DEDUP_TTL_MS) return;
    if (_detectedToolKeys.size > 300) _detectedToolKeys = new Set(Array.from(_detectedToolKeys).slice(-200));
    if (_detectedResponseKeys.size > 300) _detectedResponseKeys = new Set(Array.from(_detectedResponseKeys).slice(-200));
    _lastDedupCleanup = Date.now();
  }

  // v11.8-fix: fallback heuristic — when Kimi's DOM does not expose a dedicated
  // thinking container, detect the reasoning prefix in the response text and split it out.
  // Returns { thinking, response }.
  const THINK_STARTERS = /^(O usu[áa]rio|Vou |Agora |Preciso |Primeiro |Vamos |Ent[aã]o |Deixa |Hmm |Ok |Okay |Let me |I need |I'll |First |Now |So |The user |Pensando|Analisando|Raciocinando|Reasoning|Thinking|Processando|Buscando|Searching|Concluindo|Conclu[íi]do)/i;
  function splitThinkingAndResponse(rawText, hasThinkingContainer) {
    if (!rawText || hasThinkingContainer) return { thinking: '', response: rawText || '' };
    // If there is a JSON/code block and text before it looks like reasoning, split.
    const codeIdx = rawText.indexOf('```');
    const jsonIdx = rawText.search(/\{\s*"/);
    const firstRealIdx = codeIdx >= 0 && jsonIdx >= 0 ? Math.min(codeIdx, jsonIdx)
      : codeIdx >= 0 ? codeIdx
      : jsonIdx >= 0 ? jsonIdx
      : -1;
    if (firstRealIdx > 10) {
      const before = rawText.slice(0, firstRealIdx).trim();
      const after = rawText.slice(firstRealIdx).trim();
      if (THINK_STARTERS.test(before) || before.length < 500) {
        return { thinking: before, response: after };
      }
    }
    // Entire text is reasoning.
    if (!rawText.includes('```') && !rawText.includes('{') && (THINK_STARTERS.test(rawText) || rawText.length < 300)) {
      return { thinking: rawText, response: '' };
    }
    return { thinking: '', response: rawText };
  }

  function resetAssistantState() {
    _lastSentThinking = '';
    _lastSentResponse = '';
    _thinkingStartedEmitted = false;
    _lastSeenThinkingContainer = null;
    _firstThinkingSnapshot = '';
  }

  function emitStreamState(thinking, response, isStreaming) {
    queueEvent('stream_state', {
      thinking: thinking || '',
      response: response || '',
      isStreaming: isStreaming ?? true,
      isComplete: false
    });
  }

  // v2.6.1-fix: source-of-truth full thinking replacement. The Kimi page is the
  // source of truth; sending the complete reasoning text every cycle lets the
  // frontend replace the bubble content exactly, instead of relying on fragile
  // delta accumulation when the DOM alternates thinking/response states.
  function emitThinkingUpdate(thinking) {
    if (!thinking) return;
    queueEvent('thinking_update', {
      fullThinking: thinking,
      timestamp: Date.now()
    });
  }

  function detectAndEmit(forceResync = false) {
    try {
      const assistant = findLastAssistant();
      const btnState = detectButtonState();
      const nowStreaming = btnState.stopVisible;

      // Reset state when the assistant bubble changes (new turn)
      if (assistant !== _currentAssistant) {
        _currentAssistant = assistant;
        resetAssistantState();
      }

      if (!assistant) return;

      const thinkingContainer = findThinkingContainer(assistant);

      // v11.8-fix: if a brand-new thinking container appears inside the same assistant
      // bubble (e.g. before a second/third tool), treat it as a fresh reasoning step.
      if (thinkingContainer && thinkingContainer !== _lastSeenThinkingContainer) {
        _lastSeenThinkingContainer = thinkingContainer;
        _firstThinkingSnapshot = extractThinking(thinkingContainer);
        _thinkingStartedEmitted = false;
        _lastSentThinking = '';
      }

      // v2.6.3: Absolute boundary rule — everything inside the thinking container is
      // reasoning; everything outside is response/tool. We never stop extracting
      // thinking just because a JSON Copy button or code block appears inside it.
      let thinking = extractThinking(thinkingContainer);
      let response = extractResponse(assistant, thinkingContainer);

      // v11.8-fix: if no dedicated thinking container was found, use heuristic fallback
      // to avoid reasoning text leaking into the response.
      if (!thinkingContainer && response) {
        const split = splitThinkingAndResponse(response, false);
        if (split.thinking && !thinking) {
          thinking = split.thinking;
          response = split.response;
        }
      }

      // ── thinking lifecycle ──
      if (thinking && !_thinkingStartedEmitted) {
        queueEvent('thinking_start', { thinking: _firstThinkingSnapshot || thinking });
        _thinkingStartedEmitted = true;
        // Emit a stream_state immediately with the full snapshot so the bridge/frontend
        // initialize the bubble with everything we have, not just future deltas.
        emitStreamState(_firstThinkingSnapshot || thinking, '', true);
        // v2.6.1-fix: also emit a source-of-truth full replacement for the thinking bubble.
        emitThinkingUpdate(_firstThinkingSnapshot || thinking);
        _lastSentThinking = _firstThinkingSnapshot || thinking;
      }

      if (thinking && (forceResync || thinking !== _lastSentThinking)) {
        _lastSentThinking = thinking;
        emitStreamState(thinking, '', true);
        // v2.6.1-fix: source-of-truth full replacement so the frontend always mirrors Kimi.
        emitThinkingUpdate(thinking);
      }

      // ── response ──
      if (response && (forceResync || response !== _lastSentResponse)) {
        _lastSentResponse = response;
        emitStreamState(thinking || _lastSentThinking, response, true);
      }

      // ── tools / responses ──
      const jsonBlocks = detectJsonBlocks(assistant, thinkingContainer);
      for (const action of jsonBlocks.actions) {
        const key = getToolKey(action.tool, action.params);
        if (!_detectedToolKeys.has(key)) {
          _detectedToolKeys.add(key);
          queueEvent('tool_call_detected', { tool: action.tool, params: action.params });
          queueEvent('json_block_added', { actions: [{ tool: action.tool, params: action.params }], responses: [] });
        }
      }
      for (const resp of jsonBlocks.responses) {
        const key = hashString(String(resp.response));
        if (!_detectedResponseKeys.has(key)) {
          _detectedResponseKeys.add(key);
          queueEvent('tool_response_detected', { response: resp.response });
          queueEvent('json_block_added', { actions: [], responses: [{ response: resp.response }] });
        }
      }

      // ── stream end detection ──
      if (_wasStreaming && !nowStreaming && !btnState.stopVisible) {
        queueEvent('stream_end', {
          finalTextLength: _lastSentResponse.length,
          finalThinkingLength: _lastSentThinking.length
        });
      }
      _wasStreaming = nowStreaming;

      // ── button state changes ──
      if (JSON.stringify(btnState) !== JSON.stringify(_lastButtonState)) {
        queueEvent('button_state', btnState);
        _lastButtonState = btnState;
      }

      cleanupDedup();
    } catch (e) {}
  }

  // ── Polling loops ──
  const pollTimer = setInterval(() => detectAndEmit(false), POLL_MS);
  const heartbeatTimer = setInterval(() => {
    const btnState = detectButtonState();
    if (btnState.stopVisible || _lastSentThinking || _lastSentResponse) {
      detectAndEmit(true);
    }
  }, HEARTBEAT_MS);

  // v11.7-fix: lightweight observer on the chat container only. This catches new
  // assistant segments and thinking containers the moment they appear, so we don't
  // miss the beginning of the reasoning while waiting for the poll timer.
  let _chatObserver = null;
  function setupChatObserver() {
    try {
      const chatContainer = findChatContainer();
      if (!chatContainer || _chatObserver) return;
      _chatObserver = new MutationObserver((mutations) => {
        let shouldScan = false;
        for (const m of mutations) {
          if (m.type === 'childList' && m.addedNodes.length > 0) {
            for (const node of m.addedNodes) {
              if (node.nodeType !== Node.ELEMENT_NODE) continue;
              const cls = className(node);
              if (cls.includes('assistant') || cls.includes('segment') || cls.includes('thinking') || cls.includes('toolcall')) {
                shouldScan = true;
                break;
              }
            }
          }
          if (m.type === 'attributes') {
            const name = (m.attributeName || '').toLowerCase();
            if (name === 'class' || name === 'data-status') shouldScan = true;
          }
          if (shouldScan) break;
        }
        if (shouldScan) {
          detectAndEmit(false);
        }
      });
      _chatObserver.observe(chatContainer, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-status'] });
    } catch (e) {}
  }
  setupChatObserver();

  setTimeout(() => detectAndEmit(false), 50);

  function teardown() {
    try {
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      if (_flushTimer) clearTimeout(_flushTimer);
      if (_chatObserver) _chatObserver.disconnect();
      flushEvents();
      delete window.__lunaDomObserver;
      delete window.__lunaObserverVersion;
    } catch (e) {}
  }

  window.__lunaDomObserver = {
    teardown,
    version: VERSION,
    stats: () => ({
      isObserving: true,
      url: window.location.href,
      lastAssistant: !!_currentAssistant,
      lastThinkingLen: _lastSentThinking.length,
      lastResponseLen: _lastSentResponse.length
    })
  };

  window.addEventListener('beforeunload', teardown, { once: true });

  // SPA navigation hooks
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    queueEvent('spa_navigate', { method: 'pushState', url: window.location.href });
    return result;
  };
  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    queueEvent('spa_navigate', { method: 'replaceState', url: window.location.href });
    return result;
  };

  queueEvent('observer_ready', { url: window.location.href, version: VERSION });
  console.log(`[Luna Injected] v${VERSION} active — mirroring Kimi UI every ${POLL_MS}ms`);
})();
