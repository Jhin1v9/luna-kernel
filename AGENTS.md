# Luna Kernel — Agent Documentation

> **Last Updated**: 2026-06-03  
> **Version**: v7.7  
> **Status**: Production-ready

---

## 1. Architecture Overview

Luna is an autonomous agent that controls Kimi Web (kimi.com) via Chrome, using Playwright's CDP (Chrome DevTools Protocol) connection. The system is composed of:

| Component | File | Responsibility |
|-----------|------|---------------|
| **Luna Server** | `luna-server.js` | Express API, SSE streaming, session management |
| **Kimi Bridge** | `kimi-bridge.cjs` | Playwright CDP automation, DOM reading, tool execution |
| **Luna Soul** | `luna-soul.cjs` | Orchestration loop, prompt construction, mode management |
| **Luna Web** | `luna-web/dist/` | Svelte frontend for chat UI |
| **Chrome Extension** | `luna-extension/` | Minimal compatibility shim (v7.5+) |

---

## 2. Core Design Principles

### 2.1 No JavaScript Injection into the Page

**CRITICAL**: As of v7.5, Luna does **NOT** inject persistent JavaScript into kimi.com pages.

Previous versions (v7.0–v7.4) relied on:
- `window.__lunaStream` — injected via `page.evaluate()` and `addInitScript()`
- `window.__lunaEventQueue` — DOM MutationObserver injected into the page
- `kimi-bridge-interceptor-toolcalls.js` — fetch/XHR interceptor

**These approaches were fragile** because:
1. kimi.com's React app restores native `fetch` after detecting tampering
2. SPA navigation (`history.pushState`) clears injected scripts
3. The extension's `injected.js` was re-injected every 5s as a hacky workaround

**v7.5 Solution**: All network interception and DOM reading happens **server-side** via Playwright/CDP native APIs. The page is treated as a black box — we observe it, never modify it.

### 2.2 CDP-Based Network Interception (Primary)

The `KimiNetworkInterceptor` class uses Chrome DevTools Protocol's `Fetch` domain to intercept API responses **server-side**:

```
CDP Session → Fetch.enable({ patterns: [...] })
              ↓
         Fetch.requestPaused event
              ↓
         Fetch.getResponseBody(requestId)
              ↓
         Parse SSE chunks server-side
              ↓
         Accumulate reasoning[] + content[]
```

**Advantages**:
- Immune to page anti-tampering
- Survives SPA navigation
- No reliance on `window.__lunaStream` or any page-global state
- Falls back to `page.on('response')` if CDP Fetch is unavailable

### 2.3 On-Demand DOM Polling (Secondary)

During active streaming, the DOM poller reads the page state every 2 seconds using **fresh** `page.evaluate()` calls:

```js
// Each poll is independent — no persistent observers
const result = await page.evaluate(() => {
  const assistants = document.querySelectorAll('.segment-assistant');
  const lastAssistant = assistants[assistants.length - 1];
  // Extract thinking from .thinking-container
  // Extract response from .segment-content-box
  return { thinking, response };
});
```

**Key insight**: Because each `evaluate()` is a fresh call, it always reads the CURRENT DOM state. There is no observer that can die or get out of sync.

### 2.4 Assistant Index Tracking

The `sendMessageStream` tracks the **exact assistant index** created during the stream:

```js
const preSendAssistantCount = await page.evaluate(() =>
  document.querySelectorAll('.segment-assistant').length
);
// ... message sent ...
const targetAssistantIndex = preSendAssistantCount; // The newly created assistant
```

This prevents the "wrong assistant" bug where `_extractResponse` would read a confirmation message that appeared AFTER the tool call.

---

## 3. Data Flow

```
User Message → Luna Server → Luna Soul → Kimi Bridge
                                          ↓
                                    Create/Reset Network Interceptor
                                          ↓
                                    Send Message to Kimi Web
                                          ↓
                                    [DOM Poller] ← reads DOM every 2s
                                          ↓
                                    [CDP Fetch] ← captures API responses
                                          ↓
                                    Stream Consumer reads from DOM Event Queue
                                          ↓
                                    Detect completion → _extractResponse()
                                          ↓
                                    Network Interceptor (primary) or DOM (fallback)
                                          ↓
                                    _extractJsonToolCalls() — robust JSON parser
                                          ↓
                                    Execute tool → Send result back to Kimi
                                          ↓
                                    Yield 'done' event → Luna Soul → Frontend
```

---

## 4. Key Components

### 4.1 KimiNetworkInterceptor

**Location**: `kimi-bridge.cjs` (top-level class)

**Purpose**: Server-side network interception using CDP Fetch domain.

**Lifecycle**:
1. Created per-user, per-page via `_getOrCreateInterceptor(userId)`
2. `start()` — attaches CDP session and enables Fetch domain
3. `reset()` — clears accumulated reasoning/content before each new message
4. `getData()` — returns `{ thinking, response, hasData, source }`
5. `stop()` — detaches CDP session on cleanup

**Implementation Details**:
- Uses `page.context().newCDPSession(page)` to create a dedicated CDP session
- Listens to `Fetch.requestPaused` events matching `*kimi*chat*` and `*api/chat*`
- Calls `Fetch.getResponseBody(requestId)` to read response body
- Always calls `Fetch.continueRequest(requestId)` so the page works normally
- Falls back to `page.on('response')` if CDP Fetch fails

### 4.2 _pollThinkingAndResponse

**Purpose**: Reads the current thinking/response state from the page.

**Priority Order**:
1. **Network Interceptor** — if `hasData`, return immediately (most reliable)
2. **Legacy JS Interceptor** — transitional, will be removed in v8.0
3. **DOM Structure-Based** (Layer 2.5) — reads `.segment-assistant:last-of-type` with thinking/response separation heuristics
4. **DOM Fallback** (Layer 2–4) — React Fiber inspection + style heuristics

**Thinking/Response Separation**:
- Thinking is extracted from `.toolcall-container.thinking-container`
- Response is extracted from `.segment-content-box`, skipping thinking containers
- If `thinkContainer` exists, any free-text before the first code block/JSON is moved to thinking
- Safety net: if response looks like thinking (short + thinking starters + no JSON), swap to thinking

### 4.3 _extractResponse

**Purpose**: Extracts the FINAL response after stream completion.

**Strategies** (in order):
1. **Network Interceptor** — uses accumulated response from CDP Fetch
2. **Target Assistant Index** — extracts from the specific assistant created during this stream
3. **Last Assistant** — fallback if target index fails
4. **Smart Fallback** — if extracted text looks like thinking but `lastResponse` has JSON/code, use `lastResponse`

### 4.4 _extractJsonToolCalls

**Purpose**: Robust JSON tool call extraction without regex.

**Algorithm**:
1. Extract from code blocks: ` ```json {...} ``` `
2. Extract raw JSON objects with `"tool"` field using brace-counting `{...}`
3. Try `JSON.parse()` on each candidate
4. Deduplicate by tool+params hash

**Why no regex?**
- Regex breaks with whitespace variations, newlines, escaped quotes
- `JSON.parse()` is the only reliable way to validate JSON structure
- Brace-counting ensures complete objects are extracted even when nested

---

## 5. Configuration

### 5.1 Chrome Startup

Chrome is started via `checkChrome()` in `kimi-bridge.cjs` with:

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --load-extension=/home/jhin/.luna-kernel/luna-extension/ \
  --user-data-dir=/home/jhin/.luna/chrome-profile \
  --no-first-run \
  --no-default-browser-check
```

The extension is now a **minimal shim** (v1.0.0-ext-v7.5) that only creates `window.__lunaEventQueue` for legacy code compatibility.

### 5.2 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHROME_CDP_URL` | `http://127.0.0.1:9222` | Chrome DevTools Protocol endpoint |
| `KIMI_MAX_PAGES` | `999` | Max concurrent Playwright pages |
| `LUNA_DATA_DIR` | `~/.luna-kernel` | Kernel data directory |

---

## 6. Best Practices for Agents

### 6.1 When Modifying the Bridge

1. **Never add page-level JavaScript injection** — use CDP or `page.evaluate()` on demand
2. **Always prefer Network Interceptor over DOM polling** — it's more reliable
3. **Use `JSON.parse()` for JSON extraction** — never regex
4. **Track assistant indices** — don't assume `:last-of-type` is the correct assistant
5. **Reset state between messages** — call `interceptor.reset()` before each send

### 6.2 When Debugging

1. Check `~/.pm2/logs/luna-server-out.log` for `[KimiNetworkInterceptor]` messages
2. Verify CDP Fetch is active: look for `Started — listening via CDP Fetch domain`
3. If CDP Fetch fails, fallback to `page.on('response')` is logged
4. DOM poller logs show `source=dom-structure` or `source=dom-fallback`

### 6.3 Testing Changes

1. Send a test message with `mode=thinking`
2. Verify `thinking` and `response` are separate in logs
3. Verify tool calls execute (files are created)
4. Send a follow-up message in the same session
5. Verify no cross-message contamination (thinking from msg 1 doesn't leak into msg 2)

---

## 7. Known Limitations

1. **CDP Fetch domain availability**: Requires Chrome 100+. Falls back to `page.on('response')` on older versions.
2. **SSE real-time capture**: CDP Fetch captures response bodies when the request is paused. For very long SSE streams, DOM polling provides better real-time updates.
3. **Extension still loaded**: The Chrome extension is kept for legacy compatibility but is no longer functionally required.

---

## 8. Changelog

### v7.5 (2026-06-03)
- **NEW**: `KimiNetworkInterceptor` — CDP Fetch domain-based network interception
- **NEW**: `_extractJsonToolCalls()` — robust JSON parser replacing regex
- **CHANGED**: `_extractResponse()` — unified DOM extraction, target assistant tracking
- **CHANGED**: `_pollThinkingAndResponse()` — Network Interceptor as primary source
- **REMOVED**: Dependency on `window.__lunaStream` and page-level JS injection
- **REMOVED**: `_injectStreamInterceptor()`, `_injectDomObserver()`, `_injectEventQueueObserver()`
- **SIMPLIFIED**: Chrome extension reduced to minimal compatibility shim

### v7.4 (2026-06-03)
- Fixed `:last-of-type` bug — now uses `querySelectorAll` + array index
- Fixed thinking/response separation in DOM structure-based extraction
- Fixed duplicate tab issue — uses `defaultContext` instead of incognito contexts

### v7.3 (2026-06-02)
- Added thinking/response separation heuristics
- Added late action detection for fast JSON responses
- Chrome auto-starts with `--load-extension`

### v7.7 (2026-06-03) — INFALÍVEL
- **Snapshot Diff extraction (`_extractResponseDiff`)**: Instead of guessing which assistant is "correct", capture ALL assistant texts BEFORE sending, then AFTER, and return the DIFFERENCE. This is immune to confirmation messages, multiple assistants, DOM changes, and index shifting.
- **`_capturePreSendSnapshot`**: New method that captures the full innerText of every assistant before sending a message.
- **Primary extraction strategy**: Both `sendMessageStream` and `sendMessage` now use `_extractResponseDiff` as the PRIMARY extraction method. Old `_extractResponse` is kept as fallback only.

### v7.6 (2026-06-03)
- **Assistant detection timeout**: Increased from 3s/5s to 10s in both `sendMessageStream` and `sendMessage`
- **Content verification**: New assistant must have `textLength > 0` or `hasMarkdown` before being considered valid
- **Network interceptor reset**: `sendMessage` now resets the interceptor to prevent stale data from previous messages
- **`_waitForResponse` targeting**: Accepts optional `targetAssistantIndex` to monitor the correct assistant instead of always `.last()`
- **Phase 0 timeout**: `sendMessageStream` now has a 60s timeout in Phase 0 to prevent infinite waiting when Kimi never generates text
- **Tool deduplication**: `luna-soul.cjs` now deduplicates by both code hash AND tool+params hash to prevent infinite loops

### v7.2 (2026-06-02)
- Late action detection: parses JSON in finalResponse for missed tool calls

### v7.1 (2026-06-02)
- SSE reconnect fix in `ChatArea.svelte`

### v7.0 (2026-06-02)
- Decoupled DOM event queue architecture
- DOM poller runs independently of stream lifecycle
