/**
 * Luna-Kimi Bridge v2.2
 * Multi-user Playwright automation for Kimi Web (kimi.com) via CDP
 * v2.2: Always uses persistent profile (~/.luna/chrome-profile) to preserve Kimi login across sessions.
 *       Kills Chrome if running with a temporary /tmp/ profile. Copies login data from user's Chrome on first run.
 *
 * Patterns borrowed from luna-cto-agent.cjs (Luna v15.1–v19.0):
 * - Persistent Logger with circular buffer + rotation
 * - Keep-alive (uncaughtException / unhandledRejection)
 * - SessionStore (CheckpointManager pattern) with debounced save
 * - Multi-strategy selector fallback
 *
 * Architecture:
 * - Single BrowserContext (contexts()[0]) — the ONLY one with logged-in cookies
 * - One Page per Telegram userId
 * - Semaphore limits max concurrent pages (default 5)
 * - Idle cleanup closes inactive pages after 10min
 * - Crash/disconnect detection with auto-reconnect
 * - Rate limiting per userId
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Lazy-load turndown — fail gracefully if not installed
let TurndownService = null;
try {
  TurndownService = require('turndown');
} catch (e) {
  console.warn('[KimiBridge] turndown not installed; Markdown extraction will fallback to plain text');
}

// ============================================================
// KEEP-ALIVE — don't let the process die
// ============================================================
process.on('uncaughtException', (err) => {
  console.error('[KIMI-KEEP-ALIVE] Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[KIMI-KEEP-ALIVE] Unhandled Rejection:', reason);
});

// ============================================================
// CONFIG
// ============================================================
const CDP_PORTS = [9222, 9223, 9224, 9225];
const DEFAULT_TIMEOUT = parseInt(process.env.KIMI_TIMEOUT, 10) || 120000;
const MAX_CONCURRENT_PAGES = parseInt(process.env.KIMI_MAX_PAGES, 10) || 5;
const IDLE_TIMEOUT_MS = parseInt(process.env.KIMI_IDLE_TIMEOUT, 10) || 10 * 60 * 1000;
const COOLDOWN_MS = parseInt(process.env.KIMI_COOLDOWN_MS, 10) || 5000;
const MAX_TEXT_TYPE_LENGTH = parseInt(process.env.KIMI_MAX_TYPE_LENGTH, 10) || 500;
const LOG_MAX_SIZE_MB = parseInt(process.env.KIMI_LOG_MAX_MB, 10) || 10;
const ARTIFACTS_DIR = path.join(__dirname, '..', 'ARTIFACTS');
const SESSION_STORE_PATH = path.join(ARTIFACTS_DIR, 'kimi-sessions.json');

function makeCdpUrl(port) { return `http://127.0.0.1:${port}`; }
function getPortFromUrl(url) {
  try { return parseInt(new URL(url).port, 10); } catch { return 9222; }
}

if (!fs.existsSync(ARTIFACTS_DIR)) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

// ============================================================
// UTILS
// ============================================================
function hashUserId(userId) {
  return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 8);
}

// ============================================================
// LOGGER — persistent with circular buffer + rotation
// ============================================================
class KimiLogger {
  constructor() {
    this.logFile = path.join(ARTIFACTS_DIR, 'kimi-bridge.log');
    this.events = [];
  }

  _h() {
    return new Date().toISOString();
  }

  _rotateIfNeeded() {
    try {
      if (fs.existsSync(this.logFile)) {
        const stats = fs.statSync(this.logFile);
        if (stats.size > LOG_MAX_SIZE_MB * 1024 * 1024) {
          const rotated = this.logFile + '.1';
          if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
          fs.renameSync(this.logFile, rotated);
        }
      }
    } catch (e) { /* ignore rotation errors */ }
  }

  _w(level, msg) {
    const line = `[${level}] [${this._h()}] ${msg}`;
    console.log(line);
    try {
      this._rotateIfNeeded();
      fs.appendFileSync(this.logFile, line + '\n');
    } catch (e) { /* ignore log write errors */ }
    this.events.push({ type: level, msg, time: this._h() });
    if (this.events.length > 200) this.events.shift();
  }

  info(m) { this._w('INFO', m); }
  success(m) { this._w('SUCCESS', m); }
  error(m) { this._w('ERROR', m); }
  warn(m) { this._w('WARN', m); }
  debug(m) { this._w('DEBUG', m); }
  getEvents() { return this.events; }
}
const log = new KimiLogger();

// ============================================================
// SESSION STORE — persists user sessions between restarts
// ============================================================
class KimiSessionStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this._load();
    this._saveTimer = null;
  }

  _load() {
    const defaults = { users: {}, lastCleanup: null };
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, '');
        const parsed = JSON.parse(raw);
        return { ...defaults, ...parsed };
      }
    } catch (err) {
      log.warn(`SessionStore load failed: ${err.message}`);
    }
    return defaults;
  }

  _saveImmediate() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      log.warn(`SessionStore save failed: ${err.message}`);
    }
  }

  save() {
    // Debounced save: batch rapid updates
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._saveImmediate(), 500);
  }

  getUser(userId) {
    return this.data.users[userId] || null;
  }

  setUser(userId, info) {
    this.data.users[userId] = { ...this.getUser(userId), ...info, updatedAt: new Date().toISOString() };
    this.save();
  }

  removeUser(userId) {
    delete this.data.users[userId];
    this.save();
  }

  getAllUserIds() {
    return Object.keys(this.data.users);
  }
}

// ============================================================
// SEMAPHORE — limits concurrent pages with ownership tracking
// ============================================================
class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release() {
    if (this.waiters.length > 0) {
      const next = this.waiters.shift();
      next();
    } else {
      this.current = Math.max(0, this.current - 1);
    }
  }
}

// ============================================================
// KIMI BRIDGE v2.1
// ============================================================
class KimiBridge {
  constructor(options = {}) {
    this.cdpUrl = options.cdpUrl || null; // discovered dynamically
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.maxPages = options.maxPages ?? MAX_CONCURRENT_PAGES;
    this.idleTimeout = options.idleTimeout ?? IDLE_TIMEOUT_MS;
    this.debug = options.debug || false;

    this.browser = null;
    this.context = null;
    this.userSessions = new Map(); // userId -> { page, chatUrl, lastActivity, processing, mode }
    this.semaphore = new Semaphore(this.maxPages);
    this.store = new KimiSessionStore(SESSION_STORE_PATH);
    this.lastRequestTime = new Map(); // userId -> timestamp (rate limiting)
    this.idleTimer = null;

    // Initialize turndown if available
    this.turndown = null;
    if (TurndownService) {
      this.turndown = new TurndownService({
        codeBlockStyle: 'fenced',
        headingStyle: 'atx',
        bulletListMarker: '-',
      });
    }
  }

  /**
   * Probe a single CDP port to see if Chrome is listening.
   */
  async _probePort(port) {
    const http = require('http');
    return new Promise((resolve) => {
      const req = http.get(`${makeCdpUrl(port)}/json/version`, (res) => {
        resolve(res.statusCode === 200 ? port : 0);
      });
      req.on('error', () => resolve(0));
      req.setTimeout(2000, () => { req.destroy(); resolve(0); });
    });
  }

  /**
   * Find first working CDP port among CDP_PORTS.
   * Returns 0 if none respond.
   */
  async _findWorkingPort() {
    for (const port of CDP_PORTS) {
      const ok = await this._probePort(port);
      if (ok) return port;
    }
    return 0;
  }

  /**
   * Get current CDP URL. Discovers dynamically on first use.
   */
  async _getCdpUrl() {
    if (this.cdpUrl) return this.cdpUrl;
    const port = await this._findWorkingPort();
    if (port) {
      this.cdpUrl = makeCdpUrl(port);
      log.info(`Auto-discovered Chrome on ${this.cdpUrl}`);
      return this.cdpUrl;
    }
    // Fallback to default for error messages
    return makeCdpUrl(CDP_PORTS[0]);
  }

  /**
   * Reset CDP URL (e.g. after Chrome restart on different port).
   */
  _resetCdpUrl() {
    this.cdpUrl = null;
  }

  _log(...args) {
    const msg = args.join(' ');
    if (this.debug) log.debug(msg);
  }

  /**
   * Save chat URL to store only if it's a valid chat URL.
   * Prevents saving empty URLs like '?chat_enter_method=new_chat'.
   */
  _saveChatUrl(userId, url, extra = {}) {
    const isValid = url && url.includes('/chat/');
    if (!isValid) {
      log.warn(`Refusing to save invalid chatUrl: ${url} — keeping previous valid URL`);
      return;
    }
    this.store.setUser(userId, { chatUrl: url, ...extra });
  }

  /**
   * Connect to Chrome via CDP. Uses browser.contexts()[0] ONLY.
   * Never creates newContext() — incognito contexts lose the Kimi login.
   */
  async connect() {
    if (this.browser) {
      this._log('Already connected');
      return this;
    }

    const cdpUrl = await this._getCdpUrl();
    log.info(`Connecting to Chrome at ${cdpUrl}`);
    try {
      this.browser = await chromium.connectOverCDP(cdpUrl);
    } catch (e) {
      // Clear cached URL so next attempt re-discovers
      this._resetCdpUrl();
      throw e;
    }
    const contexts = this.browser.contexts();

    if (!contexts || contexts.length === 0) {
      throw new Error('No browser contexts found via CDP. Is Chrome running with --remote-debugging-port?');
    }

    this.context = contexts[0];
    log.success(`Connected! Using context[0] with ${this.context.pages().length} existing page(s)`);

    // Register crash/disconnect listeners
    this.browser.on('disconnected', () => {
      log.warn('Browser disconnected via CDP');
      this.browser = null;
      this.context = null;
      this._resetCdpUrl();
    });

    // Start idle cleanup timer
    this._startIdleCleanup();

    return this;
  }

  /**
   * Disconnect: close all user pages, release semaphore, disconnect browser.
   * NEVER calls browser.close() (that kills Chrome).
   */
  async disconnect() {
    log.info('Disconnecting KimiBridge...');

    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }

    for (const [userId, session] of this.userSessions) {
      try {
        if (session.page && !session.page.isClosed()) {
          // Remove listeners before closing
          session.page.removeAllListeners('crash');
          await Promise.race([
            session.page.close(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
          ]);
          log.info(`Closed page for user ${hashUserId(userId)}`);
        }
      } catch (e) {
        log.warn(`Error closing page for ${hashUserId(userId)}: ${e.message}`);
      }
      this.semaphore.release();
    }
    this.userSessions.clear();

    if (this.browser) {
      try {
        if (typeof this.browser.disconnect === 'function') {
          await Promise.race([
            this.browser.disconnect(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
          ]);
          log.info('Browser disconnected (CDP)');
        } else {
          log.warn('browser.disconnect not available, skipping');
        }
      } catch (e) {
        log.warn(`Browser disconnect error: ${e.message}`);
      }
      this.browser = null;
      this.context = null;
    }

    log.success('KimiBridge disconnected');
  }

  /**
   * Ensure connected to CDP with auto-reconnect on disconnect
   */
  async _ensureConnected() {
    if (!this.browser || !this.context) {
      log.info('Reconnecting to Chrome...');
      await this.connect();
    }
  }

  /**
   * Rate limiting: check if user is within cooldown
   */
  _checkCooldown(userId) {
    const last = this.lastRequestTime.get(userId);
    if (last && Date.now() - last < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 1000);
      throw new Error(`Aguarde ${remaining}s antes de enviar outra mensagem`);
    }
    this.lastRequestTime.set(userId, Date.now());
  }

  /**
   * Get or create a dedicated Page for a user.
   * Reuses existing page if still open.
   */
  async _getOrCreateUserPage(userId) {
    await this._ensureConnected();

    const existing = this.userSessions.get(userId);
    if (existing && existing.page && !existing.page.isClosed()) {
      // Health-check: verify the page still responds via CDP
      try {
        await existing.page.evaluate(() => true);
        existing.lastActivity = Date.now();
        return existing.page;
      } catch (e) {
        log.warn(`Stale page for user ${hashUserId(userId)}, recreating: ${e.message}`);
        try { await existing.page.close(); } catch {}
        this.userSessions.delete(userId);
        this.semaphore.current = Math.max(0, this.semaphore.current - 1);
      }
    }

    // Acquire semaphore slot
    log.info(`Acquiring semaphore slot for user ${hashUserId(userId)} (${this.semaphore.current}/${this.maxPages})`);
    await this.semaphore.acquire();

    // Restore previous chat URL from store if available
    const stored = this.store.getUser(userId);
    const chatUrl = stored?.chatUrl || 'https://kimi.com/?chat_enter_method=new_chat';

    let page = null;
    try {
      log.info(`Creating new page for user ${hashUserId(userId)}`);
      page = await this.context.newPage();

      // Register crash listener
      page.on('crash', () => {
        log.error(`Page crashed for user ${hashUserId(userId)}`);
        this.userSessions.delete(userId);
        this.semaphore.release();
      });

      // Inject stream interceptor BEFORE navigation so it captures the chat API calls
      await this._injectStreamInterceptor(page);

      // v3.3: Inject DOM MutationObserver to detect tool calls in real-time
      await this._injectDomObserver(page);

      await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
      await page.waitForTimeout(2000);

      // v3.3-fix: Re-inject via evaluate after navigation to ensure observer is active
      // addInitScript only works for future navigations; evaluate ensures current page
      await this._injectDomObserverEvaluate(page);
    } catch (e) {
      log.warn(`Navigation failed for ${hashUserId(userId)}: ${e.message}`);
      if (page && !page.isClosed()) {
        try { await page.close(); } catch {}
      }
      this.semaphore.release();
      throw e;
    }

    const session = {
      page,
      chatUrl: page.url(),
      lastActivity: Date.now(),
      processing: false,
      mode: stored?.mode || 'instant',
    };

    this.userSessions.set(userId, session);
    this._saveChatUrl(userId, session.chatUrl, { mode: session.mode });

    log.success(`Page ready for user ${hashUserId(userId)}: ${session.chatUrl}`);
    return page;
  }

  /**
   * Verify the user session is not expired (not showing Log In screen)
   * Uses specific login selectors, not free text matching.
   */
  async _verifySession(page) {
    const isLoggedIn = await page.evaluate(() => {
      // Check for actual login form elements, not just text presence
      const hasLoginForm = !!(
        document.querySelector('form[action*="login"], form[action*="auth"]') ||
        document.querySelector('input[type="password"]') ||
        document.querySelector('button[type="submit"]') &&
        document.querySelector('input[name="email"], input[name="username"], input[type="email"]')
      );
      const hasAppContent = !!(
        document.querySelector('.chat-editor, .markdown-container, .segment-assistant-actions')
      );
      return !hasLoginForm && hasAppContent;
    }).catch(() => false);

    if (!isLoggedIn) {
      throw new Error('Kimi session expired — please log in again in Chrome');
    }
    return true;
  }

  /**
   * Extract response using multi-strategy fallback.
   * Prioritizes stream interceptor, then React Fiber, then DOM selectors.
   */
  async _extractResponse(page) {
    // Strategy 0: Stream interceptor — most reliable
    try {
      const intercepted = await page.evaluate(() => {
        const s = window.__lunaStream;
        if (s && s.active && s.content) return s.content;
        return null;
      });
      if (intercepted && intercepted.trim()) {
        log.success(`Extracted via stream-intercept: ${intercepted.slice(0, 80)}...`);
        return intercepted.trim();
      }
    } catch (e) {
      this._log(`Stream intercept extraction failed: ${e.message}`);
    }

    // Strategy 1: Browser-evaluate — React Fiber + smart DOM
    const strategies = [
      {
        type: 'evaluate',
        selector: null,
        fn: async () => {
          return await page.evaluate(() => {
            try {
              // ── Helpers ──
              function getReactFiber(dom) {
                const key = Object.keys(dom).find(k =>
                  k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
                );
                return key ? dom[key] : null;
              }
              function findMessageFiber(fiber) {
                let node = fiber;
                while (node) {
                  const props = node.memoizedProps || node.pendingProps;
                  if (props && (props.message || props.msg || props.data?.message)) return node;
                  node = node.return;
                }
                return null;
              }
              function isInsideThink(el, boundary) {
                let parent = el.parentElement;
                while (parent && parent !== boundary) {
                  const pc = (parent.className || '').toLowerCase();
                  if (pc.includes('think') || pc.includes('thinking') || pc.includes('reasoning')) return true;
                  parent = parent.parentElement;
                }
                return false;
              }

              // ── Find last assistant ──
              const assistantSelectors = [
                '.segment-assistant', '.message-assistant',
                '[data-testid="assistant-message"]', '[data-testid="message-assistant"]',
                '.chat-message--assistant',
                '[class*="assistant"][class*="segment"]',
                '[class*="assistant"][class*="message"]',
              ];
              let lastAssistant = null;
              for (const sel of assistantSelectors) {
                const els = document.querySelectorAll(sel);
                if (els.length) { lastAssistant = els[els.length - 1]; break; }
              }
              if (!lastAssistant) {
                const allMsg = document.querySelectorAll('.chat-message, .message-item, [data-testid="message-container"]');
                if (allMsg.length) lastAssistant = allMsg[allMsg.length - 1];
              }
              if (!lastAssistant) return '';

              // ── React Fiber inspection ──
              const fiber = getReactFiber(lastAssistant);
              const msgFiber = fiber ? findMessageFiber(fiber) : null;
              if (msgFiber) {
                const props = msgFiber.memoizedProps || msgFiber.pendingProps;
                const msg = props?.message || props?.msg || props?.data;
                if (msg) {
                  const content = msg.content || msg.text || msg.response || '';
                  if (content) return String(content).trim();
                }
              }

              // ── DOM: markdown containers excluding thinking ──
              const mdContainers = lastAssistant.querySelectorAll('.markdown-container, [class*="markdown"]');
              for (let i = mdContainers.length - 1; i >= 0; i--) {
                const md = mdContainers[i];
                if (!isInsideThink(md, lastAssistant)) {
                  const text = md.innerText?.trim();
                  if (text && text.length > 0) return text;
                }
              }

              // ── Fallback: assistant text minus think blocks ──
              let fullText = lastAssistant.innerText?.trim() || '';
              const thinkBlocks = lastAssistant.querySelectorAll(
                '.thinking-container, .think-block, [class*="thinking"], [class*="reasoning"]'
              );
              for (const tb of thinkBlocks) {
                fullText = fullText.replace(tb.innerText?.trim() || '', '');
              }
              return fullText.trim();
            } catch (e) {
              return '';
            }
          });
        },
      },
      // Strategy 2: Plain text from paragraph elements
      {
        type: 'paragraph',
        selector: '.markdown-container .paragraph',
        fn: async (el) => {
          const texts = await el.allInnerTexts();
          return texts.join('\n\n');
        },
      },
      // Strategy 3: Direct innerText from markdown container
      {
        type: 'innerText',
        selector: '.markdown-container .markdown',
        fn: async (el) => {
          return await el.innerText();
        },
      },
      // Strategy 4: Turndown (markdown conversion)
      {
        type: 'turndown',
        selector: '.markdown-container .markdown',
        fn: async (el) => {
          if (!this.turndown) throw new Error('turndown not available');
          const html = await el.innerHTML();
          return this.turndown.turndown(html);
        },
      },
      // Strategy 5: Fallback to body text
      {
        type: 'plaintext',
        selector: 'body',
        fn: async (el) => {
          const text = await el.innerText();
          return text.trim();
        },
      },
    ];

    for (const strategy of strategies) {
      try {
        let result;
        if (strategy.type === 'evaluate') {
          result = await strategy.fn();
        } else {
          const locator = page.locator(strategy.selector).last();
          const exists = await locator.count();
          if (exists === 0) {
            this._log(`Strategy ${strategy.type}: element not found`);
            continue;
          }
          result = await strategy.fn(locator);
        }
        if (result && result.trim()) {
          log.success(`Extracted via ${strategy.type}: ${result.slice(0, 80)}...`);
          return result.trim();
        }
      } catch (e) {
        this._log(`Strategy ${strategy.type} failed: ${e.message}`);
      }
    }

    throw new Error('EXTRACTION_FAILED: Nenhuma resposta encontrada');
  }

  /**
   * Detect the actual mode currently selected in the Kimi UI
   */
  async _detectActualMode(page) {
    try {
      const label = await page.locator('.chat-editor-action .model-name').textContent({ timeout: 5000 });
      if (label.includes('Instant')) return 'instant';
      if (label.includes('Thinking')) return 'thinking';
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Wait for response completion using Combined Signal with streaming support.
   * Calls onPartial(text, status) periodically so callers can show live updates.
   *
   * Status values:
   *   'writing'  — text changed since last poll (Kimi is generating)
   *   'thinking' — text stable for >5s but not yet complete (Kimi paused/re-reasoning)
   *   'done'     — action buttons visible + text stable for 2s (complete)
   *
   * Throws on timeout.
   */
  async _waitForResponse(page, mode = 'instant', onPartial = null, initialText = '') {
    // NO TIMEOUT — Kimi may execute Python for 10+ minutes. That's valid activity.
    // We wait until buttons appear + text is stable, forever.

    // Phase 0: Wait for text to CHANGE from initialText — this ensures we don't
    // detect the previous response as "done" when buttons are still visible.
    log.info('Waiting for new response text to appear...');
    let textHasChanged = false;
    const changeStart = Date.now();
    while (true) {
      try {
        const currentText = await page.locator('.markdown-container .markdown').last().innerText({ timeout: 2000 }).catch(() => '');
        if (currentText !== initialText && currentText.trim().length > 0) {
          textHasChanged = true;
          log.success('New response text detected');
          break;
        }
      } catch (e) {
        // Element might not exist yet
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!textHasChanged) {
      log.warn('Text did not change from initial — response may already be present or failed to start');
    }

    // Phase 1: Wait for action buttons (they appear when response is done)
    log.info('Waiting for assistant action buttons...');
    let buttonsVisible = false;
    try {
      await page.waitForSelector('.segment-assistant-actions .icon-button', {
        state: 'visible',
        timeout: 0, // NO TIMEOUT — wait forever for buttons
      });
      buttonsVisible = true;
      log.success('Action buttons detected — response likely complete');
    } catch (e) {
      log.warn(`Buttons not detected within 30s: ${e.message}`);
    }

    // Phase 2: Poll text with streaming callbacks
    log.info('Polling text with streaming...');
    const stabilityWindow = 2000;
    const thinkingWindow = 5000; // if stable >5s and buttons not visible = thinking
    const pollInterval = 1500;   // poll every 1.5s for partial updates
    let lastText = '';
    let stableSince = null;
    let thinkingNotified = false;
    const pollStartTime = Date.now();
    const MAX_POLL_TIME = 300000; // 5 minutes absolute max

    while (true) {
      // Safety: don't poll forever
      if (Date.now() - pollStartTime > MAX_POLL_TIME) {
        log.warn(`_waitForResponse: absolute timeout reached (${MAX_POLL_TIME}ms), returning lastText`);
        return lastText;
      }
      try {
        const currentText = await page.locator('.markdown-container .markdown').last().innerText({ timeout: 2000 }).catch(() => '');

        // Notify partial update when text changes
        if (currentText !== lastText && currentText.trim().length > 0) {
          stableSince = null;
          thinkingNotified = false;
          lastText = currentText;
          if (onPartial) {
            try { onPartial(currentText, 'writing'); } catch {}
          }
          continue; // skip stability check this iteration
        }

        // Text is stable
        if (currentText.trim().length > 0) {
          if (!stableSince) {
            stableSince = Date.now();
          } else {
            const stableFor = Date.now() - stableSince;

            // If buttons visible and stable >2s = DONE
            if (buttonsVisible && stableFor >= stabilityWindow) {
              log.success(`Text stable for ${stableFor}ms + buttons visible — response complete`);
              if (onPartial) {
                try { onPartial(currentText, 'done'); } catch {}
              }
              return lastText;
            }

            // If stable >5s but no buttons yet = THINKING (Kimi paused)
            if (!thinkingNotified && stableFor >= thinkingWindow) {
              thinkingNotified = true;
              log.info(`Text stable for ${stableFor}ms — Kimi may be re-reasoning`);
              if (onPartial) {
                try { onPartial(currentText, 'thinking'); } catch {}
              }
            }
          }
        }
      } catch (e) {
        // Element might not exist yet
      }

      await new Promise(r => setTimeout(r, pollInterval));
    }

    // Loop should never reach here — it returns when buttons+stable text detected.
    // Safety fallback: return last known text.
    log.warn(`_waitForResponse loop exited unexpectedly, returning lastText (${lastText.length} chars)`);
    return lastText;
  }

  /**
   * Set Kimi mode (instant or thinking) for a user's page
   */
  async setMode(userId, mode) {
    if (!['instant', 'thinking'].includes(mode)) {
      throw new Error(`Invalid mode: ${mode}. Use 'instant' or 'thinking'`);
    }

    const page = await this._getOrCreateUserPage(userId);
    const session = this.userSessions.get(userId);

    // Check if already in desired mode
    const currentLabel = await page.locator('.chat-editor-action .model-name').textContent({ timeout: 3000 }).catch(() => '');
    const targetLabel = mode === 'instant' ? 'K2.6 Instant' : 'K2.6 Thinking';

    if (currentLabel.includes(targetLabel)) {
      this._log(`Already in ${mode} mode`);
      session.mode = mode;
      this.store.setUser(userId, { mode });
      return mode;
    }

    log.info(`Switching user ${hashUserId(userId)} to ${mode} mode...`);

    try {
      // Try to dismiss any overlay first (Escape key or click on body)
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(200);

      // Click mode selector — use JS click to bypass overlay intercept
      await page.evaluate(() => {
        const el = document.querySelector('.chat-editor-action .model-name');
        if (el) el.click();
      });
      await page.waitForTimeout(500);

      // Scope to dropdown to avoid clicking wrong element
      const dropdown = page.locator('[role=listbox], .dropdown-menu, .model-dropdown').last();
      const option = dropdown.locator('text=' + targetLabel).or(page.getByText(targetLabel)).first();
      await option.click({ timeout: 3000 });
      await page.waitForTimeout(800);

      session.mode = mode;
      this.store.setUser(userId, { mode });
      log.success(`Mode switched to ${mode} for user ${hashUserId(userId)}`);
      return mode;
    } catch (e) {
      log.warn(`Mode switch failed (overlay or element not found): ${e.message}. Continuing with current mode.`);
      // Don't throw — mode switch is not critical
      return session.mode || 'instant';
    }
  }

  /**
   * Create a new chat for a user (does NOT use sendMessage)
   */
  async newChat(userId) {
    const page = await this._getOrCreateUserPage(userId);
    const session = this.userSessions.get(userId);

    // Reset stream interceptor state to prevent cross-message contamination
    await page.evaluate(() => {
      if (window.__lunaResetStream) {
        window.__lunaResetStream();
      } else if (window.__lunaStream) {
        window.__lunaStream.reasoning = '';
        window.__lunaStream.content = '';
        window.__lunaStream.events = [];
        window.__lunaStream.active = false;
        window.__lunaStream.error = null;
      }
    });

    const oldUrl = page.url();
    log.info(`Creating new chat for user ${hashUserId(userId)} (current: ${oldUrl})`);

    // v3.5-fix: Robust tab capture with extended timeout + smart fallback.
    // Kimi Web frequently takes 8-12s to open a new tab for new chats.
    let newPage = null;
    try {
      // Step 1: Try capturing new tab with extended timeout (15s)
      [newPage] = await Promise.all([
        this.context.waitForEvent('page', { timeout: 0 }),
        page.click('.sidebar-new-chat, .new-chat-btn, [class*="new-chat"]').catch(() => {
          // Fallback: try JS click if Playwright click fails
          return page.evaluate(() => {
            const btn = document.querySelector('.sidebar-new-chat, .new-chat-btn, [class*="new-chat"]');
            if (btn) btn.click();
          });
        }),
      ]);
      log.info(`New tab captured via waitForEvent: ${newPage.url()}`);
    } catch (e) {
      log.warn(`waitForEvent('page') failed (${e.message}) — trying smart fallback`);
    }

    // Step 2: Smart fallback — scan existing pages for new chat tabs
    if (!newPage) {
      await new Promise(r => setTimeout(r, 3000)); // Give Kimi time to open tab
      const allPages = this.context.pages();
      log.info(`Scanning ${allPages.length} pages for new chat tab...`);
      for (const p of allPages) {
        try {
          const url = p.url();
          if (url.includes('/chat/') && url !== oldUrl) {
            newPage = p;
            log.info(`Found new chat tab in existing pages: ${url}`);
            break;
          }
        } catch {
          // Page may be closing
        }
      }
    }

    let targetPage = newPage || page;

    // Step 3: If still no new tab, fallback to direct navigation
    if (!newPage) {
      await page.goto('https://kimi.com/?chat_enter_method=new_chat', { waitUntil: 'domcontentloaded', timeout: 0 });
      await page.waitForTimeout(2500);
      targetPage = page;
    } else {
      // Wait for new page to load
      await newPage.waitForLoadState('domcontentloaded', { timeout: 0 }).catch(() => {});
      await newPage.waitForTimeout(1500);
    }

    // Step 4: Post-navigation verification — ensure we have a valid chat URL
    let newUrl = targetPage.url();
    const isValidChat = newUrl.includes('/chat/');
    if (!isValidChat) {
      log.warn(`targetPage URL is not a valid chat: ${newUrl} — scanning for valid chat tabs...`);
      // Wait up to 10s for a valid chat tab to appear
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const allPages = this.context.pages();
        for (const p of allPages) {
          try {
            const url = p.url();
            if (url.includes('/chat/') && url !== oldUrl) {
              targetPage = p;
              newUrl = url;
              log.info(`Found valid chat tab during verification: ${url}`);
              break;
            }
          } catch {}
        }
        if (newUrl.includes('/chat/')) break;
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Step 5: Inject stream interceptor on the FINAL target page
    await this._injectStreamInterceptor(targetPage);
    await this._injectDomObserverEvaluate(targetPage);

    // v3.4: Verify we actually got a new chat URL
    const chatIdOld = oldUrl.includes('/chat/') ? oldUrl.split('/chat/')[1].split('?')[0] : null;
    const chatIdNew = newUrl.includes('/chat/') ? newUrl.split('/chat/')[1].split('?')[0] : null;
    if (chatIdOld && chatIdNew && chatIdOld === chatIdNew) {
      log.warn(`Still on same chat ID after newChat ( ${chatIdOld} ). URL did not change properly.`);
    }

    // Update session to use the new page
    session.page = targetPage;
    session.chatUrl = newUrl;
    this._saveChatUrl(userId, session.chatUrl);

    // Close old page to free resources (optional — uncomment if needed)
    // if (newPage && page !== newPage && !page.isClosed()) {
    //   await page.close().catch(() => {});
    // }

    log.success(`New chat created for user ${hashUserId(userId)}: ${session.chatUrl}`);
    return { chatUrl: session.chatUrl, mode: session.mode };
  }

  /**
   * Send an image (screenshot, file, etc.) to Kimi Web.
   * Supports optional text to accompany the image.
   *
   * Strategy:
   * 1. Decode base64 to temp PNG file
   * 2. Inject a hidden file input into the Kimi DOM
   * 3. Use Playwright setInputFiles to upload
   * 4. Trigger change event so Kimi processes the upload
   * 5. Optionally send accompanying text
   * 6. Wait for response normally
   */
  async sendImage(userId, imageBase64, text = '', options = {}) {
    if (!imageBase64 || !imageBase64.trim()) {
      throw new Error('Image base64 is required');
    }

    // Rate limiting
    this._checkCooldown(userId);

    const page = await this._getOrCreateUserPage(userId);
    const session = this.userSessions.get(userId);

    if (session.processing) {
      log.warn(`User ${hashUserId(userId)} is already processing — queueing image upload`);
      const startWait = Date.now();
      while (session.processing) {
        if (Date.now() - startWait > 60000) {
          throw new Error('Timeout waiting for previous message to complete');
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }

    session.processing = true;
    session.lastActivity = Date.now();

    try {
      await this._verifySession(page);

      if (options.newChat) {
        await page.goto('https://kimi.com/?chat_enter_method=new_chat', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
        session.chatUrl = page.url();
        this._saveChatUrl(userId, session.chatUrl);
      }

      if (options.mode) {
        await this.setMode(userId, options.mode);
      }

      const actualMode = await this._detectActualMode(page) || session.mode || 'instant';
      log.info(`User ${hashUserId(userId)} sending image (text=${text ? 'yes' : 'no'}, mode=${actualMode})`);

      await page.bringToFront();

      // Step 1: Save base64 to temp file
      const tmpDir = path.join(ARTIFACTS_DIR, 'tmp-uploads');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, `kimi-upload-${hashUserId(userId)}-${Date.now()}.png`);
      const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      fs.writeFileSync(tmpFile, buffer);
      log.info(`Image saved to temp file: ${tmpFile} (${buffer.length} bytes)`);

      // Step 2: Open toolkit and use native file input
      // Kimi Web has a toolkit-popover with a hidden input[type=file]
      const toolkitBtn = page.locator('.toolkit-trigger-btn').first();
      const hasToolkit = await toolkitBtn.count() > 0;
      
      if (hasToolkit) {
        await toolkitBtn.click();
        await page.waitForTimeout(500);
      }
      
      // Use the native hidden input (appears in toolkit-popover)
      const fileInput = page.locator('.hidden-input, input[type="file"]').first();
      await fileInput.setInputFiles(tmpFile);
      log.info(`File input populated via native input: ${tmpFile}`);
      
      // Step 3: Trigger change event for frameworks that need it
      await page.evaluate(() => {
        const input = document.querySelector('.hidden-input') || document.querySelector('input[type="file"]');
        if (input) {
          input.dispatchEvent(new Event('change', { bubbles: true }));
          // Also trigger input event for React/Vue compatibility
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });

      // Wait for image to be processed by Kimi UI (thumbnail/preview appears)
      log.info('Waiting for image upload to be processed by Kimi...');
      await page.waitForTimeout(2000);

      // Step 4: Send optional text
      if (text && text.trim()) {
        const inputLocator = page.locator('textarea, [contenteditable="true"]').first();
        await inputLocator.fill('');
        await page.waitForTimeout(300);
        if (text.length <= MAX_TEXT_TYPE_LENGTH) {
          await inputLocator.type(text, { delay: 50 });
        } else {
          await inputLocator.fill(text);
        }
        await page.waitForTimeout(500);
      }

      // Step 5: Press Enter to send
      const sendLocator = page.locator('textarea, [contenteditable="true"]').first();
      await sendLocator.press('Enter');
      log.info(`Image (+text) sent for user ${hashUserId(userId)}`);

      // Step 6: Wait for response
      const lastText = await this._waitForResponse(page, actualMode, options.onPartialResponse || null);
      let response = await this._extractResponse(page);

      // CRITICAL: _extractResponse can return incomplete text. If it's much shorter
      // than the lastText we polled, use lastText as fallback to avoid cutting off [[action]] tags.
      if (lastText && lastText.length > 0) {
        const ratio = response.length > 0 ? response.length / lastText.length : 0;
        if (ratio < 0.5 && lastText.length > response.length) {
          log.warn(`sendMessage: _extractResponse incomplete (${response.length} vs polled ${lastText.length}), using polled text as fallback`);
          response = lastText;
        }
      }

      session.chatUrl = page.url();
      this._saveChatUrl(userId, session.chatUrl);

      log.success(`Response ready for user ${hashUserId(userId)} (len=${response.length})`);

      // Cleanup temp file
      try { fs.unlinkSync(tmpFile); } catch {}

      return {
        response,
        chatUrl: session.chatUrl,
        mode: session.mode,
      };
    } catch (err) {
      try {
        await page.locator('textarea, [contenteditable="true"]').first().fill('');
      } catch {}
      throw err;
    } finally {
      session.processing = false;
      session.lastActivity = Date.now();
    }
  }

  /**
   * Send a message and wait for response
   */
  async sendMessage(userId, text, options = {}) {
    if (!text || !text.trim()) {
      throw new Error('Message text is required');
    }

    // Rate limiting
    this._checkCooldown(userId);

    const page = await this._getOrCreateUserPage(userId);

    // Reset stream interceptor state to prevent cross-message contamination
    await page.evaluate(() => {
      if (window.__lunaResetStream) {
        window.__lunaResetStream();
      } else if (window.__lunaStream) {
        // Fallback for pages created before the update
        window.__lunaStream.reasoning = '';
        window.__lunaStream.content = '';
        window.__lunaStream.events = [];
        window.__lunaStream.active = false;
        window.__lunaStream.error = null;
      }
    });
    const session = this.userSessions.get(userId);

    // Cooldown check: wait for current processing to finish
    if (session.processing) {
      log.warn(`User ${hashUserId(userId)} is already processing — queueing`);
      const startWait = Date.now();
      while (session.processing) {
        if (Date.now() - startWait > 60000) {
          throw new Error('Timeout waiting for previous message to complete');
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }

    session.processing = true;
    session.lastActivity = Date.now();

    try {
      // Verify session
      await this._verifySession(page);

      // Handle newChat option
      if (options.newChat) {
        await page.goto('https://kimi.com/?chat_enter_method=new_chat', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
        session.chatUrl = page.url();
        this._saveChatUrl(userId, session.chatUrl);
      }

      // v3.4: Verify we're on the correct chat URL. If newChat was used or
      // the page was redirected, ensure we navigate to the right conversation.
      const currentUrl = page.url();
      if (session.chatUrl && !currentUrl.includes(session.chatUrl.split('?')[0].split('/').pop())) {
        log.info(`URL mismatch: current=${currentUrl}, expected=${session.chatUrl} — navigating to correct chat`);
        await page.goto(session.chatUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
        await page.waitForTimeout(1500);
      }

      // Set mode if specified
      if (options.mode) {
        await this.setMode(userId, options.mode);
      }

      // Detect actual mode from UI for correct timeout
      const actualMode = await this._detectActualMode(page) || session.mode || 'instant';
      log.info(`User ${hashUserId(userId)} sending message (len=${text.length}, mode=${actualMode}, url=${page.url()})`);

      // Use locator (auto-resolves at action time, never stale)
      const inputLocator = page.locator('textarea, [contenteditable="true"]').first();
      const inputCount = await inputLocator.count();
      if (inputCount === 0) {
        throw new Error('Input field not found on Kimi Web');
      }

      // Bring page to front (Chrome may throttle inactive tabs)
      await page.bringToFront();

      // Capture current text BEFORE sending — critical to detect new response.
      // If captured after Enter, fast responses will be mistaken for old text.
      const initialText = await page.locator('.markdown-container .markdown').last().innerText({ timeout: 2000 }).catch(() => '');

      // Clear any existing text first
      await inputLocator.fill('');
      await page.waitForTimeout(300);

      // Type with human-like delay, but use fill for long texts
      if (text.length <= MAX_TEXT_TYPE_LENGTH) {
        await inputLocator.type(text, { delay: 50 });
      } else {
        log.info(`Text too long (${text.length} chars), using fill instead of type`);
        await inputLocator.fill(text);
      }
      await page.waitForTimeout(500 + Math.floor(Math.random() * 1000));

      // Press Enter to send
      await inputLocator.press('Enter');
      log.info(`Message sent for user ${hashUserId(userId)} (initialText=${initialText.length} chars)`);

      // Wait for response with combined signal + streaming
      const lastText = await this._waitForResponse(page, actualMode, options.onPartialResponse || null, initialText);

      // Extract response
      let response = await this._extractResponse(page);

      // CRITICAL: _extractResponse can return incomplete text. Fallback to polled text.
      if (lastText && lastText.length > 0) {
        const ratio = response.length > 0 ? response.length / lastText.length : 0;
        if (ratio < 0.5 && lastText.length > response.length) {
          log.warn(`sendMessage: _extractResponse incomplete (${response.length} vs polled ${lastText.length}), using polled text as fallback`);
          response = lastText;
        }
      }

      // Update chat URL
      session.chatUrl = page.url();
      this._saveChatUrl(userId, session.chatUrl);

      log.success(`Response ready for user ${hashUserId(userId)} (len=${response.length})`);

      return {
        response,
        chatUrl: session.chatUrl,
        mode: session.mode,
      };
    } catch (err) {
      // Try to clear input on error so next message doesn't have leftover text
      try {
        await page.locator('textarea, [contenteditable="true"]').first().fill('');
      } catch {}
      throw err;
    } finally {
      session.processing = false;
      session.lastActivity = Date.now();
    }
  }

  /**
   * Get status for a user's session
   */
  async getStatus(userId) {
    const session = this.userSessions.get(userId);
    if (!session) {
      return { active: false, message: 'No active session for this user' };
    }

    const page = session.page;
    if (!page || page.isClosed()) {
      return { active: false, message: 'Page was closed' };
    }

    const pageStatus = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      loggedIn: !document.body.innerText.includes('Log In'),
      hasResponse: !!document.querySelector('.markdown-container .paragraph'),
      mode: document.querySelector('.chat-editor-action .model-name')?.innerText?.trim() || null,
    })).catch(() => ({ error: 'Page evaluation failed' }));

    return {
      active: true,
      userId: hashUserId(userId),
      chatUrl: session.chatUrl,
      mode: session.mode,
      lastActivity: new Date(session.lastActivity).toISOString(),
      processing: session.processing,
      pageStatus,
    };
  }

  /**
   * Get global bridge status (all users)
   */
  async getGlobalStatus() {
    await this._ensureConnected();
    const users = [];
    for (const [userId, session] of this.userSessions) {
      users.push({
        userId: hashUserId(userId),
        chatUrl: session.chatUrl,
        mode: session.mode,
        lastActivity: new Date(session.lastActivity).toISOString(),
        processing: session.processing,
        pageClosed: !session.page || session.page.isClosed(),
      });
    }
    return {
      connected: !!this.browser,
      cdpUrl: this.cdpUrl,
      maxPages: this.maxPages,
      activePages: this.userSessions.size,
      semaphore: { current: this.semaphore.current, max: this.semaphore.max },
      users,
    };
  }

  /**
   * Ensure the persistent Chrome profile exists and contains login data.
   * If missing or empty, copies essential data from the user's default Chrome profile.
   */
  _ensureChromeProfile() {
    const { execSync } = require('child_process');
    const os = require('os');
    const userDataDir = path.join(os.homedir(), '.luna', 'chrome-profile');
    const sourceProfile = path.join(os.homedir(), '.config', 'google-chrome');

    // If persistent profile already has Local Storage data, assume it's good
    const localStorageDir = path.join(userDataDir, 'Default', 'Local Storage', 'leveldb');
    if (fs.existsSync(localStorageDir)) {
      const files = fs.readdirSync(localStorageDir).filter(f => f.endsWith('.ldb') || f.endsWith('.log'));
      if (files.length > 0) {
        log.info(`Persistent profile already exists with data: ${userDataDir}`);
        return userDataDir;
      }
    }

    // Create persistent profile directory
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    // If source profile doesn't exist, just return the empty persistent profile
    if (!fs.existsSync(sourceProfile)) {
      log.warn(`Source Chrome profile not found at ${sourceProfile}. Starting with empty profile.`);
      return userDataDir;
    }

    log.info(`Copying Chrome profile from ${sourceProfile} to ${userDataDir}...`);

    // Copy essential directories/files that contain login/session data
    const itemsToCopy = [
      'Default/Cookies',
      'Default/Network/Cookies',
      'Default/Login Data',
      'Default/Web Data',
      'Default/Local Storage',
      'Default/Session Storage',
      'Default/IndexedDB',
      'Default/SharedStorage',
      'Default/QuotaManager',
      'Default/QuotaManager-journal',
      'Default/Preferences',
      'Default/Secure Preferences',
      'Local State',
    ];

    for (const item of itemsToCopy) {
      const src = path.join(sourceProfile, item);
      const dst = path.join(userDataDir, item);
      if (!fs.existsSync(src)) continue;
      try {
        const dstDir = path.dirname(dst);
        if (!fs.existsSync(dstDir)) {
          fs.mkdirSync(dstDir, { recursive: true });
        }
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          // Use cp -r for directories
          execSync(`cp -r "${src}" "${dst}"`, { stdio: 'ignore' });
        } else {
          // Use cp for files
          execSync(`cp "${src}" "${dst}"`, { stdio: 'ignore' });
        }
      } catch (e) {
        log.warn(`Failed to copy ${item}: ${e.message}`);
      }
    }

    log.success(`Chrome profile copied to ${userDataDir}`);
    return userDataDir;
  }

  /**
   * Check if Chrome is running with CDP and start if needed.
   * Supports dynamic ports (9222-9225). Kills headless Chrome. Starts visible Chrome.
   * Always uses the persistent profile (~/.luna/chrome-profile).
   * Kills Chrome if it's running with a temporary /tmp/ profile.
   * Returns { running: bool, started: bool, pid?: number, error?: string, wasHeadless?: bool, port?: number }
   */
  async checkChrome() {
    const { execSync, spawn } = require('child_process');
    const http = require('http');
    const os = require('os');
    const net = require('net');
    const userDataDir = this._ensureChromeProfile();

    // Helper: check if a port has Chrome responding
    const probePort = (port) => new Promise((resolve) => {
      const req = http.get(`${makeCdpUrl(port)}/json/version`, (res) => {
        resolve(res.statusCode === 200 ? port : 0);
      });
      req.on('error', () => resolve(0));
      req.setTimeout(2000, () => { req.destroy(); resolve(0); });
    });

    // Helper: check if port is occupied by any process
    const isPortOccupied = (port) => new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(true));
      s.once('listening', () => { s.close(() => resolve(false)); });
      s.listen(port, '127.0.0.1');
    });

    // Phase 1: Scan all ports for existing Chrome
    let foundPort = 0;
    let wasHeadless = false;
    let existingProfileDir = null;
    for (const port of CDP_PORTS) {
      const ok = await probePort(port);
      if (!ok) continue;
      foundPort = port;
      // Check if this Chrome is headless or using a temporary /tmp/ profile
      try {
        const psOutput = execSync(`ps aux | grep 'chrome.*remote-debugging-port=${port}' | grep -v grep`, { encoding: 'utf8' });
        const dataDirMatch = psOutput.match(/--user-data-dir=([^\s]+)/);
        if (dataDirMatch) existingProfileDir = dataDirMatch[1];

        // Kill headless Chrome
        if (psOutput.includes('--headless') || psOutput.includes('--ozone-platform=headless')) {
          wasHeadless = true;
          log.warn(`Chrome headless detectado na porta ${port}. Matando...`);
          execSync(`pkill -f 'chrome.*remote-debugging-port=${port}'`);
          await new Promise(r => setTimeout(r, 3000));
          foundPort = 0;
          wasHeadless = false;
          existingProfileDir = null;
          continue;
        }

        // Kill Chrome if using a temporary /tmp/ profile (loses login data)
        if (existingProfileDir && existingProfileDir.startsWith('/tmp/')) {
          log.warn(`Chrome na porta ${port} está usando perfil temporário ${existingProfileDir}. Matando para usar perfil persistente...`);
          execSync(`pkill -f 'chrome.*remote-debugging-port=${port}'`);
          await new Promise(r => setTimeout(r, 3000));
          foundPort = 0;
          existingProfileDir = null;
          continue;
        }

        // Valid visible Chrome with persistent profile found
        this.cdpUrl = makeCdpUrl(port);
        return { running: true, started: false, wasHeadless: false, port };
      } catch {
        // Could not determine, assume it's ok
        this.cdpUrl = makeCdpUrl(port);
        return { running: true, started: false, wasHeadless: false, port };
      }
    }

    // Phase 2: Find first free port to start Chrome on
    let startPort = CDP_PORTS[0];
    for (const port of CDP_PORTS) {
      const occupied = await isPortOccupied(port);
      if (!occupied) { startPort = port; break; }
    }
    // If all ports occupied by non-Chrome processes, use the first one and warn
    if (startPort !== CDP_PORTS[0]) {
      const allOccupied = await Promise.all(CDP_PORTS.map(p => isPortOccupied(p)));
      if (allOccupied.every(o => o)) {
        log.warn('Todas as portas CDP ocupadas por outros processos. Usando porta 9222 mesmo assim.');
        startPort = CDP_PORTS[0];
      }
    }

    // Start visible Chrome
    const chromeCmds = [
      'google-chrome',
      'google-chrome-stable',
      'chromium',
      'chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ];
    let chromePath = null;
    for (const cmd of chromeCmds) {
      try { execSync(`which ${cmd}`, { stdio: 'ignore' }); chromePath = cmd; break; } catch {}
    }
    if (!chromePath) {
      return { running: false, started: false, error: 'Chrome não encontrado. Instale google-chrome-stable ou chromium.' };
    }

    try {
      // Always use the persistent profile, never a temporary one
      const profileDir = userDataDir;
      log.info(`Iniciando Chrome com perfil persistente: ${profileDir}`);

      const proc = spawn(chromePath, [
        `--remote-debugging-port=${startPort}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--user-data-dir=' + profileDir,
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        'https://kimi.com/',
      ], { detached: true, stdio: 'ignore', env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } });
      proc.unref();

      await new Promise(r => setTimeout(r, 5000));

      // Verify it started
      const ok = await probePort(startPort);
      if (ok) {
        this.cdpUrl = makeCdpUrl(startPort);
        return { running: true, started: true, pid: proc.pid, wasHeadless, profileDir, port: startPort };
      }
      return { running: false, started: true, pid: proc.pid, wasHeadless, profileDir, port: startPort, error: 'Chrome iniciou mas não respondeu em 5s' };
    } catch (e) {
      return { running: false, started: false, error: e.message };
    }
  }

  /**
   * Check login state on a page using browser-native selectors (no :has-text()).
   */
  async _checkLoginState(page) {
    try {
      return await page.evaluate(() => {
        const bodyText = document.body?.innerText?.toLowerCase() || '';
        // Look for actual login indicators
        const hasLoginBtn = !!(
          document.querySelector('a[href*="login"], a[href*="signin"], button[class*="login"], button[class*="signin"]') ||
          document.querySelector('input[type="password"]')
        );
        const hasChatInput = !!(
          document.querySelector('textarea[placeholder], [contenteditable="true"]') ||
          document.querySelector('div[role="textbox"]')
        );
        const hasLoginText = bodyText.includes('log in') || bodyText.includes('sign in') || bodyText.includes('登录') || bodyText.includes('entrar');
        const hasWelcome = bodyText.includes('welcome') || bodyText.includes('kimi');
        // Consider logged in if we see chat input AND no login text/button
        const loggedIn = hasChatInput && !hasLoginText && !hasLoginBtn;
        return { loggedIn, hasLoginBtn, hasChatInput, hasLoginText, hasWelcome, url: location.href };
      });
    } catch (e) {
      return { loggedIn: false, error: e.message };
    }
  }

  /**
   * Ensure user is logged into Kimi Web. Opens page and brings to front.
   * If not logged in, navigates to kimi.com and starts polling.
   */
  async ensureLogin(userId) {
    let page;
    try {
      page = await this._getOrCreateUserPage(userId);
      await page.bringToFront().catch(() => {});
    } catch (e) {
      return { loggedIn: false, error: `Failed to get page: ${e.message}`, action: 'login_required' };
    }

    // Check current state
    const state = await this._checkLoginState(page);
    if (state.loggedIn) {
      return { loggedIn: true, message: 'Já está logado no Kimi Web', url: state.url };
    }

    // Not logged in — navigate to kimi.com and bring to front
    log.info(`User not logged in, navigating to Kimi login page`);
    try {
      await page.goto('https://kimi.com/', { waitUntil: 'domcontentloaded', timeout: 0 });
      await page.waitForTimeout(1500);
      await page.bringToFront().catch(() => {});
    } catch (e) {
      log.warn(`Navigation to kimi.com failed: ${e.message}`);
      // Try again with a fresh page
      try {
        const session = this.userSessions.get(userId);
        if (session && session.page && !session.page.isClosed()) {
          await session.page.close().catch(() => {});
          this.userSessions.delete(userId);
          this.semaphore.current = Math.max(0, this.semaphore.current - 1);
        }
        page = await this._getOrCreateUserPage(userId);
        await page.bringToFront().catch(() => {});
      } catch (e2) {
        return { loggedIn: false, error: `Failed to navigate: ${e2.message}`, action: 'login_required' };
      }
    }

    // Quick re-check after navigation
    const state2 = await this._checkLoginState(page);
    if (state2.loggedIn) {
      return { loggedIn: true, message: 'Já está logado no Kimi Web', url: state2.url };
    }

    return {
      loggedIn: false,
      message: 'Naveguei para kimi.com. Por favor, faça login manualmente no navegador que abriu.',
      action: 'login_required',
      url: state2.url,
    };
  }

  /**
   * Poll the page until login is detected or timeout.
   * @returns {Promise<{loggedIn: boolean, message: string}>}
   */
  async waitForLogin(userId, maxWaitMs = 60000, intervalMs = 2500) {
    const session = this.userSessions.get(userId);
    if (!session || !session.page || session.page.isClosed()) {
      return { loggedIn: false, message: 'Página não encontrada. Use /login primeiro.' };
    }
    const page = session.page;
    const start = Date.now();
    let lastState = null;

    while (Date.now() - start < maxWaitMs) {
      const state = await this._checkLoginState(page);
      lastState = state;
      if (state.loggedIn) {
        // Update stored chat URL
        try {
          const url = await page.evaluate(() => location.href);
          session.chatUrl = url;
          this._saveChatUrl(userId, url, { mode: session.mode });
        } catch {}
        return { loggedIn: true, message: 'Login detectado! Pronto para usar.', url: state.url };
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }

    return {
      loggedIn: false,
      message: 'Tempo esgotado aguardando login. Faça login manualmente no Chrome.',
      lastState,
      action: 'login_timeout',
    };
  }

  /**
   * Logout user: close page, clear session, optionally kill Chrome.
   */
  async logout(userId, opts = {}) {
    const session = this.userSessions.get(userId);
    if (session) {
      if (session.page && !session.page.isClosed()) {
        try { await session.page.close(); } catch {}
      }
      this.userSessions.delete(userId);
      this.semaphore.current = Math.max(0, this.semaphore.current - 1);
    }

    if (opts.killChrome) {
      try {
        const { execSync } = require('child_process');
        // Kill Chrome on ALL possible CDP ports
        for (const port of CDP_PORTS) {
          try { execSync(`pkill -f 'chrome.*remote-debugging-port=${port}'`); } catch {}
        }
        this._resetCdpUrl();
        log.info('Chrome killed');
        return { success: true, message: 'Logout completo. Chrome fechado.' };
      } catch (e) {
        return { success: true, message: 'Sessão encerrada. Chrome já estava fechado.' };
      }
    }

    return { success: true, message: 'Logout completo. Sessão encerrada.' };
  }

  /**
   * Check if there's already a visible Chrome running on any CDP port.
   * Returns details including which port is in use.
   */
  async getChromeStatus() {
    const { execSync } = require('child_process');
    for (const port of CDP_PORTS) {
      try {
        const psOutput = execSync(`ps aux | grep 'chrome.*remote-debugging-port=${port}' | grep -v grep`, { encoding: 'utf8' });
        const isHeadless = psOutput.includes('--headless') || psOutput.includes('--ozone-platform=headless');
        const profileMatch = psOutput.match(/--user-data-dir=([^\s]+)/);
        const pidMatch = psOutput.match(/^\S+\s+(\d+)/);
        return {
          running: true,
          isHeadless: !!isHeadless,
          profileDir: profileMatch ? profileMatch[1] : null,
          pid: pidMatch ? parseInt(pidMatch[1]) : null,
          port,
        };
      } catch {
        // No Chrome on this port, try next
      }
    }
    return { running: false };
  }

  /**
   * Screenshot a user's page
   */
  async screenshot(userId, ssPath = null) {
    const page = await this._getOrCreateUserPage(userId);
    const filePath = ssPath || path.join(ARTIFACTS_DIR, `kimi-screenshot-${hashUserId(userId)}-${Date.now()}.png`);

    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await page.screenshot({ path: filePath, fullPage: true });
    log.info(`Screenshot saved: ${filePath}`);
    return filePath;
  }

  /**
   * Start idle cleanup timer — closes inactive pages
   */
  _startIdleCleanup() {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const [userId, session] of this.userSessions) {
        if (session.processing) continue;
        if (now - session.lastActivity > this.idleTimeout) {
          log.info(`Idle cleanup: closing page for user ${hashUserId(userId)}`);
          try {
            if (session.page && !session.page.isClosed()) {
              session.page.removeAllListeners('crash');
              session.page.close().catch(e => log.warn(`Idle close error: ${e.message}`));
            }
          } catch (e) {
            log.warn(`Idle cleanup error for ${hashUserId(userId)}: ${e.message}`);
          }
          this.userSessions.delete(userId);
          this.semaphore.release();
        }
      }
    }, 60000); // Check every minute
  }

  // ============================================================
  // STREAMING + STEER (v2.2)
  // ============================================================

  /**
   * Inject a stream interceptor script into the page to capture raw API responses.
   * This is the MOST reliable way to separate thinking from response because
   * the Kimi API returns them as separate fields (reasoning_content vs content).
   */
  async _injectStreamInterceptor(page) {
    try {
      const scriptPath = path.join(__dirname, 'kimi-bridge-interceptor-toolcalls.js');
      let script = fs.readFileSync(scriptPath, 'utf8');
      // Remove outer IIFE wrapper so it executes directly in page context
      script = script.replace(/^\s*\(\s*\)\s*=>\s*\{/, '').trim();
      if (script.endsWith('};')) {
        script = script.slice(0, -2).trim();
      } else if (script.endsWith('}')) {
        script = script.slice(0, -1).trim();
      }
      await page.addInitScript(script);
    } catch (e) {
      log.warn(`Stream interceptor injection failed: ${e.message}`);
    }
  }

  /**
   * v3.3: Inject DOM MutationObserver to detect tool call containers in real-time.
   * Adds sequence numbers and timestamps to toolcall nodes for ordered execution.
   */
  async _injectDomObserver(page) {
    try {
      await page.addInitScript(() => {
        if (window.__lunaDomObserver) return; // Already injected

        window.__lunaToolCallSeq = 0;
        window.__lunaDomObserver = true;
        window.__lunaLastToolCallAt = 0;

        const chatContainerSelectors = [
          '.chat-container',
          '.message-list',
          '.chat-message-list',
          '[class*="chat"][class*="container"]',
          '[class*="message"][class*="list"]',
        ];

        function findChatContainer() {
          for (const sel of chatContainerSelectors) {
            const el = document.querySelector(sel);
            if (el) return el;
          }
          return document.body;
        }

        function processToolCallNode(node) {
          if (!node || node.__lunaProcessed) return;
          const isToolCall = node.classList && (
            node.classList.contains('toolcall-container') ||
            node.classList.contains('toolcall-ipython') ||
            node.classList.contains('toolcall-web_search') ||
            node.classList.contains('toolcall-browser') ||
            node.classList.contains('toolcall-computer')
          );
          if (!isToolCall) return;

          window.__lunaToolCallSeq++;
          node.__lunaProcessed = true;
          node.setAttribute('data-luna-seq', String(window.__lunaToolCallSeq));
          node.setAttribute('data-luna-detected-at', String(Date.now()));
          window.__lunaLastToolCallAt = Date.now();
        }

        const chatContainer = findChatContainer();
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE) {
                processToolCallNode(node);
                // Also check children (if a parent was added containing tool calls)
                if (node.querySelectorAll) {
                  node.querySelectorAll('.toolcall-container, .toolcall-ipython, .toolcall-web_search, .toolcall-browser, .toolcall-computer')
                    .forEach(processToolCallNode);
                }
              }
            }
          }
        });

        observer.observe(chatContainer, { childList: true, subtree: true });

        // Process any existing tool calls
        chatContainer.querySelectorAll('.toolcall-container, .toolcall-ipython, .toolcall-web_search, .toolcall-browser, .toolcall-computer')
          .forEach(processToolCallNode);
      });
    } catch (e) {
      log.warn(`DOM observer injection failed: ${e.message}`);
    }
  }

  /**
   * v3.3-fix: Inject DOM observer via page.evaluate after navigation.
   * addInitScript only affects future page loads; this ensures the current
   * page has the observer active immediately.
   */
  async _injectDomObserverEvaluate(page) {
    try {
      await page.evaluate(() => {
        if (window.__lunaDomObserver) return true; // Already active

        window.__lunaToolCallSeq = 0;
        window.__lunaDomObserver = true;
        window.__lunaLastToolCallAt = 0;

        const chatContainerSelectors = [
          '.chat-container', '.message-list', '.chat-message-list',
          '[class*="chat"][class*="container"]', '[class*="message"][class*="list"]',
        ];

        function findChatContainer() {
          for (const sel of chatContainerSelectors) {
            const el = document.querySelector(sel);
            if (el) return el;
          }
          return document.body;
        }

        function processToolCallNode(node) {
          if (!node || node.__lunaProcessed) return;
          const isToolCall = node.classList && (
            node.classList.contains('toolcall-container') ||
            node.classList.contains('toolcall-ipython') ||
            node.classList.contains('toolcall-web_search') ||
            node.classList.contains('toolcall-browser') ||
            node.classList.contains('toolcall-computer')
          );
          if (!isToolCall) return;
          window.__lunaToolCallSeq++;
          node.__lunaProcessed = true;
          node.setAttribute('data-luna-seq', String(window.__lunaToolCallSeq));
          node.setAttribute('data-luna-detected-at', String(Date.now()));
          window.__lunaLastToolCallAt = Date.now();
        }

        const chatContainer = findChatContainer();
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE) {
                processToolCallNode(node);
                if (node.querySelectorAll) {
                  node.querySelectorAll('.toolcall-container, .toolcall-ipython, .toolcall-web_search, .toolcall-browser, .toolcall-computer')
                    .forEach(processToolCallNode);
                }
              }
            }
          }
        });
        observer.observe(chatContainer, { childList: true, subtree: true });

        // Process existing tool calls
        chatContainer.querySelectorAll('.toolcall-container, .toolcall-ipython, .toolcall-web_search, .toolcall-browser, .toolcall-computer')
          .forEach(processToolCallNode);

        return true;
      });
    } catch (e) {
      log.warn(`DOM observer evaluate injection failed: ${e.message}`);
    }
  }

  /**
   * Poll the DOM for current thinking and response text.
   * Uses MULTI-LAYER strategy:
   *   1. Stream interceptor (most reliable — reads raw API deltas)
   *   2. React Fiber inspection (finds component props)
   *   3. Computed-style heuristic (grey/italic = thinking)
   *   4. CSS selector fallback
   *
   * Returns { thinking, response, canSteer, isGenerating, source }
   */
  async _pollThinkingAndResponse(page) {
    // v3.5-fix: Hard timeout — if page.evaluate() hangs, don't block forever.
    const POLL_TIMEOUT_MS = 10000;
    const pollWithTimeout = async () => {
    try {
      // Layer 1: Stream interceptor (reads raw API data injected by _injectStreamInterceptor)
      const intercepted = await page.evaluate(() => {
        const s = window.__lunaStream;
        if (s && s.active) {
          return {
            thinking: s.reasoning,
            response: s.content,
            source: 'intercept',
            hasData: s.reasoning.length > 0 || s.content.length > 0,
          };
        }
        return null;
      });
      // CRITICAL: When interceptor is active, trust it EXCLUSIVELY.
      // Do NOT fallback to DOM scraping because the DOM may render
      // thinking text in containers that look like response containers.
      if (intercepted) {
        const { canSteer, isGenerating } = await this._detectUiState(page);
        this._log(`[_poll] interceptor: thinking=${intercepted.thinking.length}, response=${intercepted.response.length}, source=${intercepted.source}`);
        return { ...intercepted, canSteer, isGenerating };
      }

      // Layer 2.5: DOM structure-based extraction (most reliable for Kimi Web v2026-05)
      // Uses the ACTUAL DOM structure observed via live analysis:
      //   .segment-assistant:last-of-type
      //     .block-item
      //       ├── .toolcall-container.thinking-container
      //       │   └── .markdown-container.toolcall-content-text   ← THINKING
      //       └── .segment-content-box
      //           └── .markdown-container                          ← RESPONSE
      const structureBased = await page.evaluate(() => {
        const lastAssistant = document.querySelector('.segment-assistant:last-of-type');
        if (!lastAssistant) return null;

        const blockItem = lastAssistant.querySelector('.block-item');
        if (!blockItem) return null;

        // Extract thinking: inside .toolcall-container.thinking-container
        const thinkContainer = blockItem.querySelector('.toolcall-container.thinking-container');
        let thinking = '';
        if (thinkContainer) {
          const thinkMd = thinkContainer.querySelector('.markdown-container.toolcall-content-text');
          if (thinkMd) {
            thinking = (thinkMd.innerText || '').trim();
          }
        }

        // Extract response: inside .segment-content-box (sibling of thinking container)
        const contentBox = blockItem.querySelector('.segment-content-box');
        let response = '';
        if (contentBox) {
          const respMd = contentBox.querySelector('.markdown-container');
          if (respMd) {
            response = (respMd.innerText || '').trim();
          }
        }

        if (thinking || response) {
          return { thinking, response, source: 'dom-structure' };
        }
        return null;
      });

      if (structureBased) {
        const { canSteer, isGenerating } = await this._detectUiState(page);
        this._log(`[_poll] dom-structure: thinking=${structureBased.thinking.length}, response=${structureBased.response.length}`);
        return { ...structureBased, canSteer, isGenerating };
      }

      // Layer 2–4: DOM-based extraction (fallback heuristics)
      const domResult = await page.evaluate(() => {
        // ── Helpers ──
        function getReactFiber(dom) {
          const key = Object.keys(dom).find(k =>
            k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
          );
          return key ? dom[key] : null;
        }

        function findMessageFiber(fiber) {
          let node = fiber;
          while (node) {
            const props = node.memoizedProps || node.pendingProps;
            if (props && (props.message || props.msg || props.data?.message || props.conversation)) {
              return node;
            }
            node = node.return;
          }
          return null;
        }

        function isThinkingByStyle(el) {
          const style = window.getComputedStyle(el);
          const color = style.color;
          const fontStyle = style.fontStyle;
          // Thinking blocks are often grey-ish and italic
          const isGrey = color.includes('128') || color.includes('grey') || color.includes('gray') ||
                         color.includes('150') || color.includes('169') || color.includes('rgb(156') ||
                         color.includes('rgb(107');
          return isGrey && fontStyle === 'italic';
        }

        function isInsideThinkContainer(el, boundary) {
          let parent = el.parentElement;
          while (parent && parent !== boundary) {
            const pc = (parent.className || '').toLowerCase();
            if (pc.includes('think') || pc.includes('thinking') || pc.includes('reasoning')) return true;
            if (isThinkingByStyle(parent)) return true;
            parent = parent.parentElement;
          }
          return false;
        }

        // 1. Find last assistant message
        const assistantSelectors = [
          '.segment-assistant',
          '.message-assistant',
          '[data-testid="assistant-message"]',
          '[data-testid="message-assistant"]',
          '.chat-message--assistant',
          '[class*="assistant"][class*="segment"]',
          '[class*="assistant"][class*="message"]',
        ];
        let lastAssistant = null;
        for (const sel of assistantSelectors) {
          const els = document.querySelectorAll(sel);
          if (els.length) { lastAssistant = els[els.length - 1]; break; }
        }
        if (!lastAssistant) {
          // Fallback: last message-like container
          const allMsg = document.querySelectorAll('.chat-message, .message-item, [data-testid="message-container"]');
          if (allMsg.length) lastAssistant = allMsg[allMsg.length - 1];
        }
        if (!lastAssistant) return { thinking: '', response: '', source: 'none' };

        // 2. React Fiber deep inspection
        const fiber = getReactFiber(lastAssistant);
        const msgFiber = fiber ? findMessageFiber(fiber) : null;
        if (msgFiber) {
          const props = msgFiber.memoizedProps || msgFiber.pendingProps;
          const msg = props?.message || props?.msg || props?.data;
          if (msg) {
            const reasoning = msg.reasoning_content || msg.reasoning || msg.think || '';
            const content = msg.content || msg.text || msg.response || '';
            if (reasoning || content) {
              return {
                thinking: String(reasoning).trim(),
                response: String(content).trim(),
                source: 'react-fiber',
              };
            }
          }
        }

        // 3. Walk all text containers inside assistant and classify
        const textBlocks = [];
        const walker = document.createTreeWalker(lastAssistant, NodeFilter.SHOW_ELEMENT, null);
        let node;
        while ((node = walker.nextNode())) {
          const tag = node.tagName.toLowerCase();
          if (tag === 'p' || tag === 'div' || tag === 'span' || tag === 'pre') {
            const text = node.innerText?.trim();
            if (text && text.length > 2) {
              const isThink = isInsideThinkContainer(node, lastAssistant) || isThinkingByStyle(node);
              textBlocks.push({ text, isThink, el: node });
            }
          }
        }

        // Separate thinking and response
        let thinking = '';
        let response = '';

        // Strategy A: if we have classified blocks
        const thinkBlocks = textBlocks.filter(b => b.isThink);
        const respBlocks = textBlocks.filter(b => !b.isThink);

        if (thinkBlocks.length && respBlocks.length) {
          thinking = thinkBlocks.map(b => b.text).join('\n\n');
          response = respBlocks.map(b => b.text).join('\n\n');
          return { thinking, response, source: 'style-heuristic' };
        }

        // Strategy B: look for explicit thinking containers by class
        const thinkSelectors = [
          '.thinking-container', '.think-block', '.thinking-block',
          '.segment-thinking', '.assistant-thinking',
          '[data-testid="thinking"]', '[data-testid="think-block"]',
          '[class*="thinking"]', '[class*="reasoning"]',
        ];
        for (const sel of thinkSelectors) {
          const els = lastAssistant.querySelectorAll(sel);
          if (els.length) {
            const lastThink = els[els.length - 1];
            const text = lastThink.innerText?.trim();
            if (text && text.length > 5) {
              thinking = text;
              break;
            }
          }
        }

        // Strategy C: extract response — last markdown NOT inside think
        const mdContainers = lastAssistant.querySelectorAll('.markdown-container, [class*="markdown"]');
        for (let i = mdContainers.length - 1; i >= 0; i--) {
          const md = mdContainers[i];
          if (!isInsideThinkContainer(md, lastAssistant)) {
            const text = md.innerText?.trim();
            if (text) { response = text; break; }
          }
        }

        // Strategy D: if no markdown found, use all text minus thinking
        if (!response) {
          const allText = lastAssistant.innerText?.trim() || '';
          if (thinking && allText.includes(thinking)) {
            response = allText.replace(thinking, '').trim();
          } else {
            response = allText;
          }
        }

        // ── Heuristic: if we still have everything in response and nothing in thinking,
        // try to detect thinking vs response by content patterns ──
        if (!thinking && response.length > 500) {
          // Common thinking starters (PT/EN/ES)
          const thinkStarters = /^(O usuário|Vou |Agora |Preciso |Primeiro |Vamos |Então |Deixa |Hmm |Ok |Okay |Let me |I need |I'll |First |Now |So |The user |Hmm |Okay )/i;
          // Look for transition to structured response: code block, JSON, or markdown headers
          const codeBlockIdx = response.indexOf('```');
          const jsonStartIdx = response.search(/\{\s*"/);
          const mdHeaderIdx = response.search(/\n#{1,3}\s/);
          const transitionIdx = codeBlockIdx > 50 ? codeBlockIdx
            : (jsonStartIdx > 50 ? jsonStartIdx
            : (mdHeaderIdx > 50 ? mdHeaderIdx : -1));
          if (transitionIdx > 100 && thinkStarters.test(response)) {
            thinking = response.slice(0, transitionIdx).trim();
            response = response.slice(transitionIdx).trim();
          }
        }

        return { thinking, response, source: 'dom-fallback' };
      });

      const { canSteer, isGenerating } = await this._detectUiState(page);
      this._log(`[_poll] dom-fallback: source=${domResult.source}, think=${domResult.thinking.length}, resp=${domResult.response.length}`);
      return { ...domResult, canSteer, isGenerating };
    } catch (e) {
      return { thinking: '', response: '', canSteer: false, isGenerating: false, source: 'error' };
    }
    }; // end pollWithTimeout

    return await Promise.race([
      pollWithTimeout(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('_pollThinkingAndResponse timeout')), POLL_TIMEOUT_MS))
    ]).catch(err => {
      log.warn(`[_pollThinkingAndResponse] ${err.message} — returning empty fallback`);
      return { thinking: '', response: '', canSteer: false, isGenerating: false, source: 'timeout' };
    });
  }

  /**
   * Detect UI state: canSteer and isGenerating from DOM buttons.
   */
  async _detectUiState(page) {
    try {
      return await page.evaluate(() => {
        // Can we steer? (send button is active, not disabled)
        const sendBtnSelectors = ['.send-button-container', '[class*="send"]', 'button[type="submit"]', '[aria-label*="send" i]'];
        let canSteer = false;
        for (const sel of sendBtnSelectors) {
          const btn = document.querySelector(sel);
          if (btn) {
            canSteer = !btn.disabled && !btn.className.includes('disabled') && btn.offsetParent !== null;
            if (canSteer) break;
          }
        }

        // Is still generating? (stop button visible OR no send button = generating)
        const stopBtnSelectors = ['.stop-button-container', '[class*="stop"]', '[class*="cancel"]', '[aria-label*="stop" i]'];
        let isGenerating = false;
        for (const sel of stopBtnSelectors) {
          const btn = document.querySelector(sel);
          if (btn && btn.offsetParent !== null) {
            isGenerating = true;
            break;
          }
        }
        if (!isGenerating && !canSteer) {
          const anySend = document.querySelector('.send-button-container, [class*="send"]');
          if (!anySend || anySend.offsetParent === null) isGenerating = true;
        }
        return { canSteer, isGenerating };
      });
    } catch (e) {
      return { canSteer: false, isGenerating: false };
    }
  }

  /**
   * Detect active loading indicators in the DOM (spinners, thinking blocks, cursors).
   * Returns true if Kimi is still actively working on something.
   */
  async _hasActiveLoadingIndicators(page) {
    try {
      return await page.evaluate(() => {
        // 1. Spinners / loading dots
        const spinnerSelectors = [
          '.loading-spinner', '.spinner', '.loading-dots', '.animate-spin',
          '[class*="spinner"]', '[class*="loading"]', '[class*="animate-spin"]',
          'svg[class*="spin"]', 'svg[class*="loading"]',
        ];
        for (const sel of spinnerSelectors) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) return true;
        }

        // 2. Thinking / reasoning blocks that are still open/active
        const thinkingSelectors = [
          '.thinking-container', '.think-block', '.thinking-block',
          '.segment-thinking', '.assistant-thinking',
          '[data-testid="thinking"]', '[data-testid="think-block"]',
          '[class*="thinking"]:not([class*="completed"])',
          'details[open] .thinking-content',
        ];
        for (const sel of thinkingSelectors) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (el.offsetParent !== null) {
              const text = el.innerText || '';
              // If it contains active-verbs, it's still running
              if (/^(Pensando|Thinking|Analisando|Analysing|Processando|Processing|Buscando|Searching)/i.test(text)) {
                return true;
              }
            }
          }
        }

        // 3. Cursor / typing indicator
        const cursorSelectors = [
          '.cursor-blink', '.typing-cursor', '[class*="cursor"]',
          '[class*="typing"]', '.animate-pulse',
        ];
        for (const sel of cursorSelectors) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) return true;
        }

        // 4. Code execution blocks that show "running" status
        const codeStatusSelectors = [
          '.code-execution-status', '.execution-status',
          '[class*="execution"][class*="running"]',
        ];
        for (const sel of codeStatusSelectors) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) {
            const text = el.innerText || '';
            if (/running|executing|executando|em execução/i.test(text)) return true;
          }
        }

        // 5. Kimi Web tool calls in progress (ipython, web_search, etc.)
        const toolCallSelectors = [
          '.toolcall-ipython', '.toolcall-web_search', '.toolcall-web_open_url',
          '.toolcall-container', '.tool-call-container',
          '[class*="toolcall"]', '[class*="tool-call"]',
        ];
        for (const sel of toolCallSelectors) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (el.offsetParent !== null) {
              const text = el.innerText || '';
              // If the tool call shows active status keywords, it's still running
              if (/(executando|running|processando|processing|buscando|searching|calculando|calculating|analisando|analyzing)/i.test(text)) {
                return true;
              }
              // If the tool call has a loading/spinner indicator inside
              const hasSpinner = el.querySelector('.loading-spinner, .spinner, [class*="spin"], [class*="loading"]');
              if (hasSpinner && hasSpinner.offsetParent !== null) return true;
            }
          }
        }

        return false;
      });
    } catch (e) {
      return false; // If we can't detect, assume no loading (don't block forever)
    }
  }

  /**
   * DOM MIRROR v3.2 — Híbrida Inteligente
   * Extracts ipython code blocks, execution results, AND images from the DOM.
   *
   * Kimi Web renders:
   *   - Code: .segment-code with language-python
   *   - Stdout result: .segment-code with language-plain
   *   - Images: .ipython-images-container img
   *
   * Returns array of { code, result, images, language, source }.
   *   code   → the Python code
   *   result → stdout text from Kimi's sandbox execution
   *   images → array of { src, alt } for generated plots/diagrams
   */
  async _extractToolMirrorFromDOM(page) {
    try {
      return await page.evaluate(() => {
        // v3.3-fix: ensure seq counter exists for fallback assignment
        if (typeof window.__lunaToolCallSeq === 'undefined') window.__lunaToolCallSeq = 0;

        const results = [];
        const seen = new Set();
        let extractionSeq = 0;

        // Find the LAST assistant segment (most recent response)
        const assistantSelectors = [
          '.segment-assistant',
          '.message-assistant',
          '[data-testid="assistant-message"]',
          '[data-testid="message-assistant"]',
          '.chat-message--assistant',
          '[class*="assistant"][class*="segment"]',
          '[class*="assistant"][class*="message"]',
        ];
        let lastAssistant = null;
        for (const sel of assistantSelectors) {
          const els = document.querySelectorAll(sel);
          if (els.length) { lastAssistant = els[els.length - 1]; break; }
        }
        if (!lastAssistant) return results;

        // ── v3.3: Security — verify node is inside assistant container ──
        function isInsideAssistant(node) {
          let parent = node.parentElement;
          while (parent) {
            const pc = (parent.className || '').toLowerCase();
            if (pc.includes('assistant') || pc.includes('segment-assistant') || pc.includes('message-assistant')) {
              return true;
            }
            parent = parent.parentElement;
          }
          return false;
        }

        // ── Helper: find the closest preceding .segment-code for a result block ──
        function findPrecedingCodeBlock(resultBlock, allCodeBlocks) {
          const resultRect = resultBlock.getBoundingClientRect();
          let closest = null;
          let closestDist = Infinity;
          for (const cb of allCodeBlocks) {
            const cbRect = cb.getBoundingClientRect();
            if (cbRect.top < resultRect.top) {
              const dist = resultRect.top - cbRect.bottom;
              if (dist < closestDist) {
                closestDist = dist;
                closest = cb;
              }
            }
          }
          return closest;
        }

        // ── Strategy A: Sandbox execution blocks (.toolcall-*) ──
        // v3.3: expanded to capture all tool types, not just ipython
        const toolcallSelectors = [
          '.toolcall-container.default.toolcall-ipython',
          '.toolcall-container.default.toolcall-web_search',
          '.toolcall-container.default.toolcall-browser',
          '.toolcall-container.default.toolcall-computer',
          '.toolcall-ipython',
          '.toolcall-web_search',
          '.toolcall-browser',
          '.toolcall-computer',
        ];
        for (const sel of toolcallSelectors) {
          const containers = lastAssistant.querySelectorAll(sel);
          for (const container of containers) {
            // Security: verify node is inside assistant container
            if (!isInsideAssistant(container)) continue;

            const content = container.querySelector('.toolcall-content');
            if (!content) continue;

            // Detect tool type from className
            const className = (container.className || '').toLowerCase();
            let toolName = 'ipython';
            if (className.includes('web_search')) toolName = 'web_search';
            else if (className.includes('browser')) toolName = 'browser';
            else if (className.includes('computer')) toolName = 'computer';

            // Extract code from pre/code inside toolcall-content
            let codeText = '';
            const pre = content.querySelector('pre');
            const codeEl = content.querySelector('code');
            if (pre) codeText = pre.innerText.trim();
            else if (codeEl) codeText = codeEl.innerText.trim();
            else codeText = content.innerText.trim();

            if (!codeText || codeText.length < 5 || seen.has(codeText)) continue;
            seen.add(codeText);

            // Extract images from this container
            const images = [];
            container.querySelectorAll('img').forEach(img => {
              if (img.src && !img.src.includes('avatar.moonshot.cn') && !img.src.includes('statics.moonshot.cn')) {
                images.push({ src: img.src, alt: img.alt || '' });
              }
            });

            // Extract stdout/result text (plain text after code, not in pre/code)
            let resultText = '';
            const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, null);
            let node;
            while ((node = walker.nextNode())) {
              const text = node.textContent.trim();
              if (text && text.length > 3 && !codeText.includes(text)) {
                resultText += text + '\n';
              }
            }

            // v3.3: extract sequence number and timestamp from MutationObserver
            // Fallback: assign at extraction time if observer hasn't processed this node
            let seq = parseInt(container.getAttribute('data-luna-seq') || '0', 10);
            let detectedAt = parseInt(container.getAttribute('data-luna-detected-at') || '0', 10);
            if (seq === 0) {
              seq = ++extractionSeq;
              container.setAttribute('data-luna-seq', String(seq));
            }
            if (detectedAt === 0) {
              detectedAt = Date.now();
              container.setAttribute('data-luna-detected-at', String(detectedAt));
            }

            results.push({
              code: codeText,
              result: resultText.trim(),
              images,
              language: 'python',
              source: 'kimi-sandbox',
              sandboxExecution: true,
              tool: toolName,
              seq,
              detectedAt,
            });
          }
        }

        // ── Strategy B: .segment-code blocks (text-only examples) ──
        // When Kimi shows code as text without sandbox execution
        // v3.4-fix: ONLY capture executable code (python, bash). Skip frontend
        // languages (js, html, css, json) — they're examples, not tools to run.
        lastAssistant.querySelectorAll('.segment-code').forEach(block => {
          // Security: verify node is inside assistant container
          if (!isInsideAssistant(block)) return;

          const langEl = block.querySelector('.segment-code-lang');
          const lang = langEl ? langEl.innerText.toLowerCase() : '';

          // v3.4: Skip frontend/markup languages — they're response examples, not executable tools
          if (lang.includes('js') || lang.includes('javascript') || lang.includes('typescript') ||
              lang.includes('html') || lang.includes('css') || lang.includes('json') ||
              lang.includes('vue') || lang.includes('svelte') || lang.includes('jsx') || lang.includes('tsx')) {
            return;
          }

          const contentEl = block.querySelector('.segment-code-content, pre, code');
          if (!contentEl) return;
          let text = contentEl.innerText.trim();
          // Fallback: textContent often returns full text even when innerText is truncated
          // by virtual scrolling or lazy rendering in the DOM.
          if (text.length < 200) {
            const tc = (contentEl.textContent || '').trim();
            if (tc.length > text.length) {
              text = tc;
            }
          }
          // Also try to get text from sibling or parent if still short
          if (text.length < 200 && contentEl.parentElement) {
            const parentTc = (contentEl.parentElement.textContent || '').trim();
            if (parentTc.length > text.length && !parentTc.includes('Copy')) {
              text = parentTc;
            }
          }
          if (!text || text.length < 5 || seen.has(text)) return;
          seen.add(text);

          // Skip plain-text results — they're outputs, not code
          if (lang.includes('plain')) return;

          let language = 'python';
          if (lang.includes('bash') || lang.includes('shell')) language = 'bash';

          results.push({
            code: text,
            result: '',
            images: [],
            language,
            source: 'kimi-text',
            sandboxExecution: false,
            tool: language === 'python' ? 'ipython' : language,
            seq: 0,
            detectedAt: 0,
          });
        });

        // ── Strategy C: .ipython-images-container (standalone images) ──
        // Sometimes images appear outside the toolcall container
        const imgContainer = lastAssistant.querySelector('.ipython-images-container');
        if (imgContainer && !results.some(r => r.images.length > 0)) {
          const images = [];
          imgContainer.querySelectorAll('img').forEach(img => {
            if (img.src && !img.src.includes('avatar.moonshot.cn') && !img.src.includes('statics.moonshot.cn')) {
              images.push({ src: img.src, alt: img.alt || '' });
            }
          });
          if (images.length && results.length) {
            // Attach images to the last result if none have images yet
            results[results.length - 1].images.push(...images);
          }
        }

        // v3.3: Sort results by sequence number (MutationObserver order) for FIFO execution
        results.sort((a, b) => a.seq - b.seq || a.detectedAt - b.detectedAt);

        return results;
      });
    } catch (e) {
      log.warn(`_extractToolMirrorFromDOM failed: ${e.message}`);
      return [];
    }
  }

  /**
   * Check if extracted Python code appears complete (not mid-stream).
   * Prevents emitting incomplete code that would fail execution.
   */
  _isPythonCodeComplete(code) {
    if (!code || code.length < 10) return false;
    const lines = code.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    if (lines.length === 0) return false;

    // Balance check: parentheses, brackets, braces
    let parens = 0, brackets = 0, braces = 0;
    let inString = false, stringChar = null;
    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      const prev = code[i - 1];
      if (!inString) {
        if (ch === '"' || ch === "'") {
          inString = true; stringChar = ch;
        } else if (ch === '(') parens++;
        else if (ch === ')') parens--;
        else if (ch === '[') brackets++;
        else if (ch === ']') brackets--;
        else if (ch === '{') braces++;
        else if (ch === '}') braces--;
      } else {
        if (ch === stringChar && prev !== '\\') {
          inString = false; stringChar = null;
        }
      }
    }
    if (parens !== 0 || brackets !== 0 || braces !== 0) return false;

    // Last non-empty, non-comment line should not end with an operator or opening bracket
    const lastLine = lines[lines.length - 1].trim();
    const incompleteEnders = /[+\-*/%=<!>&|~(,[{]$/;
    if (incompleteEnders.test(lastLine)) return false;

    // Should not end with backslash (line continuation)
    if (lastLine.endsWith('\\')) return false;

    return true;
  }

  /**
   * Check if a bash code block looks complete.
   * Prevents emitting truncated heredocs or unclosed quotes as actions.
   */
  _isBashCodeComplete(code) {
    if (!code || code.length < 5) return false;

    // Check for unclosed heredoc: cat << 'EOF' ... (no closing EOF line)
    // Also handles heredocs inside bash -c "..." strings where \n is literal
    const heredocMatches = code.match(/<<\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/g);
    if (heredocMatches) {
      for (const hm of heredocMatches) {
        const m = hm.match(/<<\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
        if (!m) continue;
        const delimiter = m[1];
        // Check if the delimiter appears on its own line at the end
        const closeRe = new RegExp(`^${delimiter}\\s*$`, 'm');
        if (!closeRe.test(code)) {
          // Also check if the delimiter appears after a literal \n (common in bash -c strings)
          const literalCloseRe = new RegExp(`\\\\n${delimiter}\\b`);
          if (!literalCloseRe.test(code) && !code.includes(`\n${delimiter}`)) {
            return false;
          }
        }
      }
    }

    // Check for unclosed single/double quotes
    let inSingle = false, inDouble = false, escape = false;
    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    }
    if (inSingle || inDouble) return false;

    // Check for unclosed backticks
    const backticks = (code.match(/`/g) || []).length;
    if (backticks % 2 !== 0) return false;

    // Check for unclosed $() or ()
    let parenDepth = 0;
    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth--;
    }
    if (parenDepth !== 0) return false;

    // Last line should not end with backslash (line continuation)
    const lines = code.split('\n');
    const lastLine = lines[lines.length - 1].trim();
    if (lastLine.endsWith('\\')) return false;

    return true;
  }

  /**
   * Convert extracted ipython code into a Luna executeShell action.
   * Uses heredoc for multiline Python code to avoid escaping hell.
   */
  _convertIpythonToAction(block) {
    const { code, language } = block;

    if (language === 'bash' || language === 'shell') {
      return {
        tool: 'executeShell',
        params: { command: code },
      };
    }

    if (language === 'javascript' || language === 'node') {
      return {
        tool: 'executeShell',
        params: { command: `node -e ${JSON.stringify(code)}` },
      };
    }

    // Default: Python
    // Use heredoc to pass multiline code safely
    // Generate a unique delimiter to avoid collisions with code content
    const delimiter = `PYEOF_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const command = `python3 <<'${delimiter}'\n${code}\n${delimiter}`;

    return {
      tool: 'executeShell',
      params: { command, code },
    };
  }

  /**
   * Check if we can inject a steer message mid-response.
   */
  async canSteer(userId) {
    const session = this.userSessions.get(userId);
    if (!session || !session.page || session.page.isClosed()) return false;
    const { canSteer } = await this._pollThinkingAndResponse(session.page);
    return canSteer;
  }

  /**
   * Inject a steer message while Kimi is generating.
   * This sends new text into the conversation mid-flight.
   */
  async injectSteer(userId, text) {
    if (!text || !text.trim()) {
      throw new Error('Steer text is required');
    }

    const page = await this._getOrCreateUserPage(userId);
    const session = this.userSessions.get(userId);

    log.info(`Injecting steer for user ${hashUserId(userId)}: "${text.slice(0, 60)}..."`);

    try {
      // Check if send button is active
      const canSteer = await this.canSteer(userId);
      if (!canSteer) {
        log.warn(`Cannot steer — send button is disabled (Kimi may be finalizing)`);
        return { success: false, error: 'Send button disabled — cannot steer right now' };
      }

      // Find input and inject text
      const inputLocator = page.locator('textarea, [contenteditable="true"]').first();
      await inputLocator.fill(text);
      await page.waitForTimeout(300);

      // Click send or press Enter
      const sendBtn = page.locator('.send-button-container').first();
      const hasSendBtn = await sendBtn.count() > 0;

      if (hasSendBtn) {
        await sendBtn.click({ timeout: 3000 });
      } else {
        await inputLocator.press('Enter');
      }

      log.success(`Steer injected for user ${hashUserId(userId)}`);
      return { success: true };
    } catch (err) {
      log.error(`Steer injection failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Send message with REAL-TIME STREAMING.
   * Yields: { type: 'thinking_delta'|'response_delta'|'can_steer'|'done', text?, value? }
   *
   * Pattern inspired by ShellAgent's Provider.chat() async generator.
   */
  async *sendMessageStream(userId, text, options = {}) {
    if (!text || !text.trim()) {
      throw new Error('Message text is required');
    }

    // Rate limiting
    this._checkCooldown(userId);

    const page = await this._getOrCreateUserPage(userId);
    const session = this.userSessions.get(userId);

    // Reset stream interceptor state to prevent cross-message contamination
    await page.evaluate(() => {
      if (window.__lunaResetStream) {
        window.__lunaResetStream();
      } else if (window.__lunaStream) {
        // Fallback for pages created before the update
        window.__lunaStream.reasoning = '';
        window.__lunaStream.content = '';
        window.__lunaStream.events = [];
        window.__lunaStream.active = false;
        window.__lunaStream.error = null;
      }
    });

    // Wait for any ongoing processing
    if (session.processing) {
      log.warn(`User ${hashUserId(userId)} already processing — waiting`);
      const startWait = Date.now();
      while (session.processing) {
        if (Date.now() - startWait > 60000) {
          throw new Error('Timeout waiting for previous message');
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }

    session.processing = true;
    session.lastActivity = Date.now();

    try {
      await this._verifySession(page);

      if (options.newChat) {
        await page.goto('https://kimi.com/?chat_enter_method=new_chat', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
        session.chatUrl = page.url();
        this._saveChatUrl(userId, session.chatUrl);
      }

      if (options.mode) {
        await this.setMode(userId, options.mode);
      }

      const actualMode = await this._detectActualMode(page) || session.mode || 'instant';
      log.info(`User ${hashUserId(userId)} streaming message (mode=${actualMode})`);

      // Verify input exists
      const inputLocator = page.locator('textarea, [contenteditable="true"]').first();
      const inputCount = await inputLocator.count();
      if (inputCount === 0) {
        throw new Error('Input field not found on Kimi Web');
      }

      // Bring page to front (Chrome throttles inactive tabs)
      await page.bringToFront();

      // Capture initial text BEFORE sending — so we can detect when the new response starts.
      // CRITICAL: Must capture before Enter, because Kimi may respond instantly.
      const initialText = await page.locator('.markdown-container .markdown').last().innerText({ timeout: 2000 }).catch(() => '');

      // Send message
      await inputLocator.fill('');
      await page.waitForTimeout(300);

      if (text.length <= MAX_TEXT_TYPE_LENGTH) {
        await inputLocator.type(text, { delay: 50 });
      } else {
        // For large texts in contenteditable, use fill but also dispatch input events
        log.info(`Text too long (${text.length} chars), using fill with event dispatch`);
        await inputLocator.fill(text);
        await page.waitForTimeout(200);
        // Dispatch input event to ensure Kimi detects the text
        await page.evaluate(() => {
          const el = document.querySelector('textarea, [contenteditable="true"]');
          if (el) {
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: el.value || el.innerText }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      }
      await page.waitForTimeout(500);
      await inputLocator.press('Enter');
      log.info(`Message sent, starting stream poll`);

      // Stream polling loop — NO TIMEOUT. Runs until real completion or real error.
      const pollInterval = 400; // Poll every 400ms for responsiveness (v3.3: reduced from 800ms)

      let lastThinking = '';
      let lastResponse = '';
      let lastCanSteer = false;
      let isComplete = false;
      let buttonsVisible = false;

      // Track DOM-extracted ipython actions to avoid duplicate emits
      const emittedActionCodes = new Set();
      let domActionsCount = 0;

      // Phase 0: Wait for text to start changing — NO TIMEOUT. Waits forever until Kimi starts.
      let textHasChanged = false;
      let pollCount = 0;
      while (true) {
        const { thinking, response } = await this._pollThinkingAndResponse(page);
        const combined = thinking + response;
        if (combined !== initialText && combined.length > 0) {
          textHasChanged = true;
          break;
        }
        // Heartbeat: yield waiting status every 5 polls so TUI knows we're alive
        if (++pollCount % 5 === 0) {
          yield { type: 'waiting', message: 'Aguardando resposta do Kimi...' };
        }
        await new Promise(r => setTimeout(r, 500));
      }

      // Phase 1: Stream until truly complete — INFINITELY patient.
      // Kimi may execute Python for 10 minutes. That's valid activity.
      // We only stop when: buttons visible + not generating + text stable + no spinners.
      // FALLBACK: if text is stable for 15s without buttons, force completion to avoid infinite loops.
      let textStableSince = 0;
      let lastTextChangeTime = Date.now();
      const FORCE_COMPLETE_NO_BUTTONS_MS = 45000; // 45s fallback — Kimi sandbox tools (python/web) can take 30-60s
      const FORCE_COMPLETE_ABSOLUTE_MS = 300000;  // 5min absolute max per message
      const streamStartTime = Date.now();

      while (!isComplete) {
        const poll = await this._pollThinkingAndResponse(page);

        // Track text changes for fallback completion
        const textChanged = poll.thinking !== lastThinking || poll.response !== lastResponse;
        if (textChanged) {
          lastTextChangeTime = Date.now();
          textStableSince = 0;
        }

        // Yield thinking deltas
        if (poll.thinking && poll.thinking !== lastThinking) {
          const delta = poll.thinking.slice(lastThinking.length);
          if (delta) {
            yield { type: 'thinking_delta', text: delta };
          } else if (poll.thinking.length < lastThinking.length) {
            yield { type: 'thinking_delta', text: poll.thinking };
          }
          lastThinking = poll.thinking;
        }

        // Yield response deltas
        if (poll.response && poll.response !== lastResponse) {
          const delta = poll.response.slice(lastResponse.length);
          if (delta) {
            yield { type: 'response_delta', text: delta };
          } else if (poll.response.length < lastResponse.length) {
            yield { type: 'response_delta', text: poll.response };
          }
          lastResponse = poll.response;
        }

        // Yield steer availability
        if (poll.canSteer !== lastCanSteer) {
          yield { type: 'can_steer', value: poll.canSteer };
          lastCanSteer = poll.canSteer;
        }

        // ── DOM MIRROR v3.2: Detect ipython code + result + images ──
        // Kimi Web executes Python in her sandbox and renders code, stdout,
        // and images in the DOM. We extract ALL of it and let the soul decide
        // whether to execute locally or use Kimi's result directly.
        try {
          const codeBlocks = await this._extractToolMirrorFromDOM(page);
          for (const block of codeBlocks) {
            // Skip incomplete code (still being streamed into the DOM)
            if (block.language === 'python' && !this._isPythonCodeComplete(block.code)) {
              continue;
            }
            if (block.language === 'bash' && !this._isBashCodeComplete(block.code)) {
              continue;
            }
            const hash = crypto.createHash('sha256').update(block.code).digest('hex').slice(0, 16);
            if (!emittedActionCodes.has(hash)) {
              emittedActionCodes.add(hash);
              domActionsCount++;
              const action = this._convertIpythonToAction(block);
              log.info(`[DOM MIRROR] Detected ${block.language} block (${block.code.length} chars, result=${block.result?.length||0}, images=${block.images?.length||0})`);
              yield {
                type: 'action_detected',
                action,
                source: 'dom_mirror',
                code: block.code,
                kimiResult: block.result,
                kimiImages: block.images,
              };
            }
          }
        } catch (e) {
          // Non-critical: if DOM extraction fails, continue streaming
          log.warn(`[DOM MIRROR] Extraction error: ${e.message}`);
        }

        // Check buttons visibility
        try {
          const hasButtons = await page.locator('.segment-assistant-actions .icon-button').count() > 0;
          if (hasButtons) buttonsVisible = true;
        } catch {}

        // ── Robust completion detection ──
        // Conditions: buttons visible + not generating + text stable + no loading indicators
        if (buttonsVisible && !poll.isGenerating) {
          // Reset stability timer if text changed recently
          if (textChanged) {
            textStableSince = 0;
          } else if (textStableSince === 0) {
            textStableSince = Date.now();
          }

          // Require 3 seconds of stable text + no spinners before declaring done
          const stableFor = Date.now() - textStableSince;
          if (textStableSince > 0 && stableFor >= 3000) {
            const hasLoading = await this._hasActiveLoadingIndicators(page);
            if (!hasLoading) {
              // Double-check after 500ms to avoid race conditions
              await new Promise(r => setTimeout(r, 500));
              const recheck = await this._pollThinkingAndResponse(page);
              const recheckLoading = await this._hasActiveLoadingIndicators(page);
              if (!recheck.isGenerating && recheck.response === lastResponse && !recheckLoading) {
                isComplete = true;
                log.info(`[sendMessageStream] Completion via buttonsVisible (stable=${stableFor}ms)`);
                break;
              }
            }
          }
        } else {
          // Reset stability if generating again
          textStableSince = 0;
        }

        // ── FALLBACK completion: force done if text stable for 15s without buttons ──
        // This prevents infinite loops when button selectors are stale or response is too fast.
        const timeSinceLastChange = Date.now() - lastTextChangeTime;
        const totalStreamTime = Date.now() - streamStartTime;
        if (!isComplete && !poll.isGenerating && timeSinceLastChange >= FORCE_COMPLETE_NO_BUTTONS_MS) {
          const hasLoading = await this._hasActiveLoadingIndicators(page);
          if (!hasLoading) {
            log.warn(`[sendMessageStream] FALLBACK completion: text stable for ${timeSinceLastChange}ms, buttonsVisible=${buttonsVisible}, isGenerating=${poll.isGenerating}, lastResponse=${lastResponse.length} chars`);
            isComplete = true;
            break;
          }
        }

        // ── ABSOLUTE timeout: force done after 5 minutes regardless ──
        if (!isComplete && totalStreamTime >= FORCE_COMPLETE_ABSOLUTE_MS) {
          log.warn(`[sendMessageStream] ABSOLUTE timeout reached (${totalStreamTime}ms) — forcing completion`);
          isComplete = true;
          break;
        }

        // Heartbeat every ~10 polls so TUI knows we're alive
        if (++pollCount % 10 === 0) {
          yield { type: 'waiting', message: 'Processando...' };
        }

        await new Promise(r => setTimeout(r, pollInterval));
      }

      // Final extraction for clean response
      // CRITICAL FIX: _extractResponse can return INCOMPLETE text (e.g., 234 chars vs 3674).
      // This happens when React Fiber extracts a partially rendered message.
      // We must NOT prefer extracted if it's significantly shorter than lastResponse,
      // or we risk cutting off [[action]] tags and failing to execute tools.
      let finalResponse = lastResponse;
      try {
        const extracted = await this._extractResponse(page);
        if (extracted && extracted.trim().length > 50) {
          const ratio = lastResponse.length > 0 ? extracted.length / lastResponse.length : 1;
          // Only trust extracted if it's at least 50% of lastResponse OR lastResponse is tiny
          if (ratio >= 0.5 || lastResponse.length < 200) {
            finalResponse = extracted.trim();
            if (ratio < 0.7) {
              log.info(`_extractResponse clean text (${extracted.length} vs ${lastResponse.length}, ratio=${ratio.toFixed(2)})`);
            }
          } else {
            log.warn(`_extractResponse INCOMPLETE (${extracted.length} vs ${lastResponse.length}, ratio=${ratio.toFixed(2)}) — using lastResponse to avoid cutting off actions`);
          }
        } else if (extracted) {
          log.warn(`_extractResponse very short (${extracted.length}), using lastResponse`);
        }
      } catch (e) {
        log.warn(`_extractResponse failed: ${e.message}, using lastResponse as fallback`);
      }
      
      const hasActionTag = finalResponse.includes('[[action]]');
      const hasResponseTag = finalResponse.includes('[[response]]');
      log.info(`[sendMessageStream] finalResponse=${finalResponse.length} hasResponseTag=${hasResponseTag} hasActionTag=${hasActionTag} domActions=${domActionsCount}`);

      // ── DOM MIRROR FINAL: Actions were already emitted as 'action_detected' events ──
      // during streaming. The soul handles execution via domActionResults.
      // We do NOT append [[action]] tags to finalResponse to avoid double-execution.
      // If no DOM actions were detected, the response flows normally as CHAT.
      if (domActionsCount > 0) {
        log.info(`[DOM MIRROR] ${domActionsCount} action(s) were emitted during streaming. finalResponse remains pure text.`);
      }
      
      session.chatUrl = page.url();
      this._saveChatUrl(userId, session.chatUrl);

      // v3.4: Detect context limit warning from Kimi Web
      const isContextLimit = /getting too long|conversation.*too long|try starting a new session|context limit|token limit/i.test(finalResponse);
      if (isContextLimit) {
        log.warn(`[sendMessageStream] Context limit detected — Kimi says: "${finalResponse.slice(0, 100)}..."`);
        yield { type: 'context_limit', response: finalResponse, thinking: lastThinking };
      } else {
        yield { type: 'done', response: finalResponse, thinking: lastThinking };
      }

    } catch (err) {
      try { await page.locator('textarea, [contenteditable="true"]').first().fill(''); } catch {}
      throw err;
    } finally {
      session.processing = false;
      session.lastActivity = Date.now();
    }
  }

  /**
   * Abort current generation by clicking the stop button on Kimi Web.
   * Called when user presses Ctrl+C during processing.
   */
  async abortGeneration(userId) {
    const session = this.userSessions.get(userId);
    if (!session || !session.page || session.page.isClosed()) return false;
    const page = session.page;
    log.info(`Aborting generation for user ${hashUserId(userId)}`);
    try {
      const stopSelectors = [
        '.stop-button-container',
        '[class*="stop"]',
        '[class*="cancel"]',
        '[aria-label*="stop" i]',
        'button svg[class*="stop"]',
      ];
      for (const sel of stopSelectors) {
        const btn = page.locator(sel).first();
        const count = await btn.count();
        if (count > 0) {
          await btn.click();
          log.info('Stop button clicked');
          return true;
        }
      }
      log.warn('No stop button found to abort');
      return false;
    } catch (e) {
      log.warn(`Failed to abort generation: ${e.message}`);
      return false;
    }
  }

  /**
   * Copy last response (clicks copy button on Kimi UI)
   * Uses aria-label/title instead of hardcoded indices.
   */
  async copyLastResponse(userId) {
    const page = await this._getOrCreateUserPage(userId);
    log.info(`Clicking copy button for user ${hashUserId(userId)}`);

    await page.evaluate(() => {
      const container = document.querySelector('.segment-assistant-actions');
      if (!container) return false;
      // Find by aria-label or SVG name
      const btn = container.querySelector('[aria-label="Copy"], button[title="Copy"], .icon-button');
      if (btn) { btn.click(); return true; }
      // Fallback: first icon-button
      const fallback = container.querySelector('.icon-button');
      if (fallback) { fallback.click(); return true; }
      return false;
    }).catch(() => false);

    await page.waitForTimeout(500);
    return true;
  }

  /**
   * Regenerate last response
   */
  async regenerateLastResponse(userId) {
    const page = await this._getOrCreateUserPage(userId);
    log.info(`Clicking regenerate for user ${hashUserId(userId)}`);

    await page.evaluate(() => {
      const container = document.querySelector('.segment-assistant-actions');
      if (!container) return false;
      const btn = container.querySelector('[aria-label="Regenerate"], button[title="Regenerate"], [aria-label="Refresh"]');
      if (btn) { btn.click(); return true; }
      // Fallback: second icon-button
      const buttons = container.querySelectorAll('.icon-button');
      if (buttons.length > 1) { buttons[1].click(); return true; }
      return false;
    }).catch(() => false);

    const session = this.userSessions.get(userId);
    const actualMode = await this._detectActualMode(page) || session.mode || 'instant';
    await this._waitForResponse(page, actualMode);
    return this._extractResponse(page);
  }

  /**
   * Anonymous consultation with Kimi Web — NO LOGIN required.
   * Creates a fresh incognito context, asks Kimi, returns the response text.
   * Used by Luna to consult Kimi as a "second brain" for code review, architecture,
   * and technical decisions without interfering with the user's session.
   */
  async anonymousConsult(prompt, options = {}) {
    if (!this.browser) {
      throw new Error('Bridge not connected — call connect() first');
    }

    const mode = options.mode || 'thinking';
    log.info(`[anonymousConsult] Starting anonymous Kimi consultation (mode=${mode})`);

    let ctx = null;
    let page = null;

    try {
      // Create a completely isolated incognito context
      ctx = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        locale: 'pt-BR',
      });
      page = await ctx.newPage();

      // Navigate to Kimi
      log.info('[anonymousConsult] Navigating to kimi.com...');
      await page.goto('https://kimi.com', { waitUntil: 'domcontentloaded', timeout: 0 });
      await page.waitForTimeout(2000);

      // Dismiss cookie/terms modals if present
      try {
        const consentBtn = page.locator('button:has-text("Accept"), button:has-text("Agree"), button:has-text("OK"), [class*="consent"] button').first();
        if (await consentBtn.count() > 0) {
          await consentBtn.click();
          await page.waitForTimeout(500);
        }
      } catch {}

      // Find input and send message
      const inputLocator = page.locator('textarea, [contenteditable="true"]').first();
      await inputLocator.waitFor({ state: 'visible', timeout: 0 });
      await inputLocator.fill('');
      await page.waitForTimeout(300);
      // Use fill + event dispatch for large texts (contenteditable can be tricky with type())
      await inputLocator.fill(prompt);
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        const el = document.querySelector('textarea, [contenteditable="true"]');
        if (el) {
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: el.value || el.innerText }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      // Capture initial text BEFORE sending — critical for fast responses
      const initialText = await page.locator('.markdown-container .markdown').last().innerText({ timeout: 2000 }).catch(() => '');

      await page.waitForTimeout(500);
      await inputLocator.press('Enter');
      log.info('[anonymousConsult] Message sent, polling for response...');

      let lastResponse = '';
      let lastThinking = '';
      let isComplete = false;
      let buttonsVisible = false;
      let textStableSince = 0;
      let pollCount = 0;
      const pollInterval = 800;

      // Wait for text to start — NO TIMEOUT. Waits forever until Kimi starts.
      let textHasChanged = false;
      while (true) {
        const poll = await this._pollThinkingAndResponse(page);
        const combined = poll.thinking + poll.response;
        if (combined !== initialText && combined.length > 0) {
          textHasChanged = true;
          break;
        }
        if (++pollCount % 5 === 0) {
          log.info('[anonymousConsult] Waiting for Kimi to start...');
        }
        await new Promise(r => setTimeout(r, 500));
      }

      // Stream until complete
      let lastTextChangeTime = Date.now();
      const FORCE_COMPLETE_NO_BUTTONS_MS = 45000; // 45s fallback — Kimi sandbox tools can take 30-60s
      const FORCE_COMPLETE_ABSOLUTE_MS = 300000;
      const streamStartTime = Date.now();

      while (!isComplete) {
        const poll = await this._pollThinkingAndResponse(page);

        const textChanged = poll.thinking !== lastThinking || poll.response !== lastResponse;
        if (textChanged) {
          lastTextChangeTime = Date.now();
          textStableSince = 0;
        }

        if (poll.thinking && poll.thinking !== lastThinking) {
          lastThinking = poll.thinking;
        }
        if (poll.response && poll.response !== lastResponse) {
          lastResponse = poll.response;
        }

        // Check buttons
        try {
          const hasButtons = await page.locator('.segment-assistant-actions .icon-button').count() > 0;
          if (hasButtons) buttonsVisible = true;
        } catch {}

        // Robust completion
        if (buttonsVisible && !poll.isGenerating) {
          if (textChanged) {
            textStableSince = 0;
          } else if (textStableSince === 0) {
            textStableSince = Date.now();
          }

          const stableFor = Date.now() - textStableSince;
          if (textStableSince > 0 && stableFor >= 3000) {
            const hasLoading = await this._hasActiveLoadingIndicators(page);
            if (!hasLoading) {
              await new Promise(r => setTimeout(r, 500));
              const recheck = await this._pollThinkingAndResponse(page);
              const recheckLoading = await this._hasActiveLoadingIndicators(page);
              if (!recheck.isGenerating && recheck.response === lastResponse && !recheckLoading) {
                isComplete = true;
                break;
              }
            }
          }
        } else {
          textStableSince = 0;
        }

        // Fallback completion
        const timeSinceLastChange = Date.now() - lastTextChangeTime;
        const totalStreamTime = Date.now() - streamStartTime;
        if (!isComplete && !poll.isGenerating && timeSinceLastChange >= FORCE_COMPLETE_NO_BUTTONS_MS) {
          const hasLoading = await this._hasActiveLoadingIndicators(page);
          if (!hasLoading) {
            log.warn(`[anonymousConsult] FALLBACK completion: stable=${timeSinceLastChange}ms, buttons=${buttonsVisible}`);
            isComplete = true;
            break;
          }
        }
        if (!isComplete && totalStreamTime >= FORCE_COMPLETE_ABSOLUTE_MS) {
          log.warn(`[anonymousConsult] ABSOLUTE timeout (${totalStreamTime}ms)`);
          isComplete = true;
          break;
        }

        if (++pollCount % 10 === 0) {
          log.info(`[anonymousConsult] Still processing... response=${lastResponse.length} chars`);
        }
        await new Promise(r => setTimeout(r, pollInterval));
      }

      // Final clean extraction
      let finalResponse = lastResponse;
      try {
        const extracted = await this._extractResponse(page);
        if (extracted && extracted.trim().length > 50) {
          const ratio = lastResponse.length > 0 ? extracted.length / lastResponse.length : 1;
          if (ratio >= 0.5 || lastResponse.length < 200) {
            finalResponse = extracted.trim();
          } else {
            log.warn(`[anonymousConsult] _extractResponse incomplete (${extracted.length} vs ${lastResponse.length}) — using lastResponse`);
          }
        }
      } catch (e) {
        log.warn(`[anonymousConsult] _extractResponse failed: ${e.message}`);
      }

      log.success(`[anonymousConsult] Done — ${finalResponse.length} chars`);
      return {
        response: finalResponse,
        thinking: lastThinking,
        length: finalResponse.length,
      };

    } catch (err) {
      log.error(`[anonymousConsult] Failed: ${err.message}`);
      throw err;
    } finally {
      // Always clean up the incognito context
      if (ctx) {
        try { await ctx.close(); } catch {}
        log.info('[anonymousConsult] Incognito context closed');
      }
    }
  }
}

// ============================================================
// SINGLETON HELPERS
// ============================================================
let bridgeInstance = null;

async function getKimiBridge(options = {}) {
  if (!bridgeInstance) {
    bridgeInstance = new KimiBridge(options);
    await bridgeInstance.connect();
  }
  return bridgeInstance;
}

async function closeKimiBridge() {
  if (bridgeInstance) {
    await bridgeInstance.disconnect();
    bridgeInstance = null;
  }
}

module.exports = {
  KimiBridge,
  getKimiBridge,
  closeKimiBridge,
  KimiLogger,
  KimiSessionStore,
};
