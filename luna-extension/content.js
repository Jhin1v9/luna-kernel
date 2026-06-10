// Luna Extension — Content Script (ISOLATED WORLD)
// v8.1: Injects observer into MAIN world, receives events via postMessage,
// forwards to background Service Worker for HTTP polling transmission.
// Also handles server responses: inserts tool results into Kimi textarea.

(function() {
  'use strict';

  const SCRIPT_ID = '__luna-dom-observer-script';
  const INJECTED_SRC = chrome.runtime.getURL('injected.js');
  let isForwarding = true;

  // v8.2-fix: Teardown old observer BEFORE injecting new one to prevent memory leak
  function teardownMainWorldObserver() {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        try {
          if (window.__lunaDomObserver && typeof window.__lunaDomObserver.teardown === 'function') {
            window.__lunaDomObserver.teardown();
          }
        } catch (e) {}
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  // ── Inject observer into MAIN world ──
  function injectObserver() {
    // If observer already exists and is healthy, don't re-inject
    if (window.__lunaDomObserver) {
      return;
    }

    const old = document.getElementById(SCRIPT_ID);
    if (old) old.remove();

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = INJECTED_SRC;
    script.type = 'text/javascript';
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectObserver);
  } else {
    injectObserver();
  }

  // v8.2-fix: SPA navigation — teardown old, then inject new. Prevents observer accumulation.
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function(...args) {
    originalPushState.apply(this, args);
    setTimeout(() => { teardownMainWorldObserver(); injectObserver(); }, 100);
  };

  history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    setTimeout(() => { teardownMainWorldObserver(); injectObserver(); }, 100);
  };

  window.addEventListener('popstate', () => {
    setTimeout(() => { teardownMainWorldObserver(); injectObserver(); }, 100);
  });

  // v10.7-fix: Removed setInterval(30s) that caused memory pressure.
  // Observer re-injection is handled by SPA navigation hooks (pushState/replaceState/popstate)
  // and by the content script's own load. If the script is removed, page refresh restores it.

  // ── Kimi Input Injection ──
  function findKimiInput() {
    // Strategy 1: contenteditable div (modern Kimi)
    const editable = document.querySelector('[contenteditable="true"]');
    if (editable) return { element: editable, type: 'contenteditable' };

    // Strategy 2: textarea (fallback)
    const textarea = document.querySelector('textarea');
    if (textarea) return { element: textarea, type: 'textarea' };

    return null;
  }

  function setInputValue(input, text) {
    const el = input.element;
    el.focus();

    if (input.type === 'contenteditable') {
      // Use execCommand for reliable contenteditable insertion
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    } else if (input.type === 'textarea') {
      el.value = text;
      el.selectionStart = el.selectionEnd = text.length;
    }

    // Dispatch input events to trigger React/Vue reactivity
    const events = ['input', 'change', 'keyup'];
    for (const eventType of events) {
      const evt = new InputEvent(eventType, { bubbles: true, cancelable: true });
      el.dispatchEvent(evt);
    }
  }

  function clickSendButton() {
    // Strategy 1: Find by aria-label
    const allButtons = document.querySelectorAll('button');
    for (const btn of allButtons) {
      const aria = btn.getAttribute('aria-label') || '';
      if (/send|enviar|发送|submit/i.test(aria)) {
        btn.click();
        return { method: 'aria-button' };
      }
      // Check for SVG arrow icon inside button
      const svg = btn.querySelector('svg');
      if (svg && !btn.disabled && btn.getBoundingClientRect().width < 60) {
        btn.click();
        return { method: 'svg-button' };
      }
    }

    // Strategy 2: Press Enter on input
    const input = findKimiInput();
    if (input) {
      input.element.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true
      }));
      input.element.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true
      }));
      return { method: 'enter-key' };
    }

    return { method: 'none', error: 'No send mechanism found' };
  }

  function injectToolResult(text) {
    try {
      const input = findKimiInput();
      if (!input) {
        console.warn('[Luna Content] No input found for injection');
        return { ok: false, error: 'No input found' };
      }

      setInputValue(input, text);

      // Small delay to let React/Vue process
      setTimeout(() => {
        const result = clickSendButton();
        console.log('[Luna Content] Tool result sent:', result.method);
      }, 200);

      return { ok: true };
    } catch (e) {
      console.error('[Luna Content] Failed to inject tool result:', e.message);
      return { ok: false, error: e.message };
    }
  }

  // ── Listen for events from injected.js ──
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.source !== 'luna-injected') return;
    if (!isForwarding) return;

    try {
      chrome.runtime.sendMessage({
        type: 'luna_event',
        eventType: event.data.type,
        data: event.data.data,
        timestamp: event.data.timestamp,
        url: event.data.url,
        version: event.data.version
      }).catch((err) => {
        console.warn('[Luna Content] Forward to background failed:', err.message);
      });
    } catch (e) {
      console.warn('[Luna Content] sendMessage error:', e.message);
    }
  });

  // ── Listen for responses from server (via background) ──
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'luna_server_response') {
      const payload = message.payload;
      if (payload.type === 'tool_result' && payload.result) {
        const text = typeof payload.result === 'string'
          ? payload.result
          : JSON.stringify(payload.result, null, 2);
        const result = injectToolResult(text);
        sendResponse(result);
        return true;
      }
      if (payload.type === 'inject_text' && payload.text) {
        const result = injectToolResult(payload.text);
        sendResponse(result);
        return true;
      }
      console.log('[Luna Content] Server response (unhandled):', payload.type);
    }
    sendResponse({ ok: true });
    return false;
  });

  // ── Handle extension enable/disable ──
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'luna-content') {
      port.onDisconnect.addListener(() => {
        isForwarding = false;
      });
    }
  });

  console.log('[Luna Content] v8.1 loaded — forwarding DOM events + injection ready');
})();
