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
const { jsonrepair } = require('jsonrepair');
const { WebBridgeClient } = require('./webbridge-client.cjs');
const { isPrematureCompletion } = require('./lib/stream-completion-guard.cjs');
const { createResponseCursor } = require('./lib/stream-text-cursor.cjs');
const { loadProviderConfig, listProviders, getProviderUrl, getProviderSelector, getProviderCookies, getProviderFeature, getProviderInputSelector, getProviderResponseSelectors, getProviderUiSelectors, getProviderApiPatterns } = require('./provider-loader.cjs');

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
// CONFIG — v5.2: centralized with fallback to env vars
// ============================================================
let config;
try {
  config = require('./config/luna-config');
} catch (e) {
  // Fallback if config module not available (e.g. standalone use)
  config = null;
}

const CDP_PORTS = config?.KIMI?.cdpPorts || [9222, 9223, 9224, 9225];
const DEFAULT_TIMEOUT = 1800000; // 30 minutes — was 120000
const DEFAULT_PROVIDER = 'kimi';

function getModeUrls(providerName) {
  try {
    const cfg = loadProviderConfig(providerName);
    return cfg.modeUrls || { instant: cfg.baseUrl };
  } catch (e) {
    return {
      instant: 'https://www.kimi.com/?chat_enter_method=new_chat&lang=en',
      thinking: 'https://www.kimi.com/?chat_enter_method=new_chat&lang=en',
    };
  }
}

const MAX_CONCURRENT_PAGES = parseInt(process.env.KIMI_MAX_PAGES, 10) || config?.KIMI?.maxPages || 5;
const IDLE_TIMEOUT_MS = parseInt(process.env.KIMI_IDLE_TIMEOUT, 10) || config?.TIMEOUTS?.kimiIdle || 10 * 60 * 1000;
const KIMI_PERSISTENT_MODE = process.env.KIMI_PERSISTENT_MODE === 'true' || process.env.KIMI_PERSISTENT_MODE === '1' || config?.KIMI?.persistentMode || false;
const COOLDOWN_MS = parseInt(process.env.KIMI_COOLDOWN_MS, 10) || config?.TIMEOUTS?.kimiCooldown || 5000;
const MAX_TEXT_TYPE_LENGTH = parseInt(process.env.KIMI_MAX_TYPE_LENGTH, 10) || config?.KIMI?.maxTextTypeLength || 500;
const LOG_MAX_SIZE_MB = parseInt(process.env.KIMI_LOG_MAX_MB, 10) || config?.KIMI?.logMaxSizeMB || 10;
const ARTIFACTS_DIR = config?.PATHS?.artifacts || path.join(__dirname, '..', 'ARTIFACTS');
const SESSION_STORE_PATH = path.join(ARTIFACTS_DIR, 'kimi-sessions.json');
const COOKIES_BACKUP_PATH = path.join(__dirname, 'kimi-cookies.json');
const COOKIES_MANUAL_PATH = path.join(__dirname, 'kimi-cookies.manual.json');

// v11.0: paths for connecting to the user's real Chrome instead of a cloned profile
const USER_CHROME_DIR = path.join(require('os').homedir(), '.config', 'google-chrome');
const USER_CHROME_DEVTOOLS_PORT_FILE = path.join(USER_CHROME_DIR, 'DevToolsActivePort');
const USER_CHROME_DESKTOP_FILES = [
  path.join(require('os').homedir(), '.local', 'share', 'applications', 'google-chrome.desktop'),
  path.join(require('os').homedir(), '.local', 'share', 'applications', 'com.google.Chrome.desktop'),
  '/usr/share/applications/google-chrome.desktop',
  '/usr/share/applications/com.google.Chrome.desktop',
];
const USER_CHROME_CMD_CANDIDATES = [
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/google-chrome',
  '/opt/google/chrome/chrome',
  'google-chrome-stable',
  'google-chrome',
];

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

// v10.38-fix: Normalize URLs for landing-page comparison.
// Browsers may add trailing slashes or reorder query params, so we compare
// only origin + pathname (with trailing slash removed) and ignore query/hash.
function normalizeBaseUrl(url) {
  try {
    const u = new URL(url);
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch (e) {
    return url;
  }
}

function isSameLandingPage(currentUrl, expectedUrl) {
  return normalizeBaseUrl(currentUrl) === normalizeBaseUrl(expectedUrl);
}

// v9.4-fix: JSON Accumulation Buffer — prevents code leak from multi-line JSON wrappers.
// When Kimi streams {"response": "..."} with code inside, the inner code chunks
// don't look like JSON (no "response" key, don't start with '{'). We buffer ALL
// chunks until the JSON wrapper is complete (balanced braces), then extract.

function looksLikeJsonStart(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trimStart();
  // v10.24-fix: Also detect malformed Kimi wrappers like {"success":true,"mode":"RESPONSE","message":"..."}
  return t.startsWith('{') && (
    t.includes('"response"') ||
    t.includes('"tool"') ||
    t.includes('"script"') ||
    t.includes('"mode"') ||
    (t.includes('"success"') && t.includes('"message"'))
  );
}

function isJsonComplete(text) {
  if (!text) return false;
  let depth = 0;
  let inString = false;
  let escape = false;
  let foundFirstBrace = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      // v11.1-fix: Tolerate unescaped internal quotes inside string values.
      // A closing quote is real only when the next significant char is , : } or ].
      if (inString) {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (j >= text.length || text[j] === ',' || text[j] === ':' || text[j] === '}' || text[j] === ']') {
          inString = false;
        }
        // else: unescaped internal quote, stay inside string
      } else {
        inString = true;
      }
      continue;
    }
    if (!inString) {
      if (c === '{') { depth++; foundFirstBrace = true; }
      else if (c === '}') depth--;
    }
  }
  return foundFirstBrace && depth === 0;
}

// v10.35-fix (W8-T2a: hoisted to module scope so _extractJsonToolCalls can
// reuse it — previously defined inline in the generic-provider extractor):
// robustly extract the first complete JSON object using string-aware brace
// counting. Tolerates unescaped double quotes inside string values (common
// when LLMs embed HTML/JS inside JSON): a closing quote is only real when the
// next significant character is , : } or ]. `startFrom` lets callers loop over
// multiple top-level objects in a single text.
function extractFirstCompleteJsonObject(text, startFrom = 0) {
  if (!text || text.length < 10) return null;
  let i = startFrom;
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
          // else: unescaped internal quote, stay inside string
        } else {
          inString = true;
        }
      } else if (!inString) {
        if (c === '{') depth++;
        else if (c === '}') depth--;
      }
      i++;
    }
    if (depth === 0) {
      return text.slice(start, i);
    }
  }
  return null;
}

// W8-T2c: locate a JSON wrapper ({"tool"/{"script"/{"response") that starts
// mid-delta (position > 0), so the stream accumulator can split off the prose
// prefix and buffer the wrapper instead of leaking raw JSON into the chat.
function findMidTextJsonWrapperStart(text) {
  if (!text || typeof text !== 'string') return -1;
  const keys = ['{"tool"', '{"script"', '{"response"'];
  let best = -1;
  for (const k of keys) {
    const idx = text.indexOf(k);
    if (idx > 0 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

// v11.1-fix: Manual extraction for file-write tool JSONs with unescaped quotes.
function extractWriteFileFromText(text) {
  if (!text || text.length < 30) return null;
  const toolMatch = text.match(/"tool"\s*:\s*"([^"]+)"/);
  if (!toolMatch) return null;
  const tool = toolMatch[1];
  if (!['writeFile', 'appendFile', 'replaceInFile'].includes(tool)) return null;

  function extractStringValue(key) {
    const pattern = new RegExp(`"${key}"\\s*:\\s*"`);
    const m = text.match(pattern);
    if (!m) return null;
    let i = text.indexOf(m[0]) + m[0].length;
    let val = '';
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\' && i + 1 < text.length) {
        const next = text[i + 1];
        switch (next) {
          case 'n': val += '\n'; break;
          case 't': val += '\t'; break;
          case 'r': val += '\r'; break;
          case 'b': val += '\b'; break;
          case 'f': val += '\f'; break;
          case '\\': val += '\\'; break;
          case '"': val += '"'; break;
          case '/': val += '/'; break;
          case 'u':
            if (i + 5 < text.length) {
              const hex = text.slice(i + 2, i + 6);
              const code = parseInt(hex, 16);
              if (!isNaN(code)) {
                val += String.fromCharCode(code);
                i += 4;
                break;
              }
            }
            val += next;
            break;
          default: val += next; break;
        }
        i += 2;
        continue;
      }
      if (ch === '"') {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (j >= text.length || text[j] === ',' || text[j] === '}' || text[j] === ']') {
          return val;
        }
        val += ch;
        i++;
        continue;
      }
      val += ch;
      i++;
    }
    return val;
  }

  const path = extractStringValue('path');
  const content = extractStringValue('content');
  if (!path || content === null) return null;
  const params = { path, content };
  if (tool === 'replaceInFile') {
    const oldStr = extractStringValue('oldString') || extractStringValue('old_string') || extractStringValue('old');
    const newStr = extractStringValue('newString') || extractStringValue('new_string') || extractStringValue('new');
    if (oldStr !== null) params.oldString = oldStr;
    if (newStr !== null) params.newString = newStr;
  }
  return { type: 'tool', tool, params };
}

// W6-T9: Node-side character walker — escapes RAW newline/CR/tab characters
// that appear INSIDE JSON string values (Kimi's DOM renders script JSON with
// literal newlines, which strict JSON.parse rejects). Characters outside
// strings are left untouched. Ported from the in-page tolerantJsonParse.
function _preEscapeJsonStringNewlines(str) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
    }
    out += ch;
  }
  return out;
}

/**
 * W6-T12: Pure decision helper — should a generic provider (DeepSeek etc.)
 * force-complete the response even while the UI still reports "generating"?
 * Fires when the response has been visible for >45s AND its text length has
 * been stable for >10s. Backstop for UI completion heuristics that never fire
 * (cursor blink / code-block chrome can keep isGenerating=true forever, which
 * starves tool delivery and makes Luna "stop out of nowhere").
 */
function _shouldForceGenericComplete({ firstSeenAt, lastLengthChangeAt, uiGenerating }, now) {
  if (!uiGenerating) return false;
  if (!firstSeenAt || !lastLengthChangeAt) return false;
  return (now - firstSeenAt > 45_000) && (now - lastLengthChangeAt > 10_000);
}

function extractResponseFromCompleteJson(text) {
  if (!text) return null;
  // v10.24-fix: Strip DOM-extracted code block headers before parsing
  let cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .replace(/^\s*JSON\s*(?:Copy|复制|複製)\s*/i, '')
    .replace(/^\s*json\s*(?:Copy|复制|複製)\s*/i, '')
    .trim();
  const mapParsed = (parsed) => {
    if (parsed.response !== undefined && typeof parsed.response === 'string') {
      return { type: 'response', text: parsed.response };
    }
    if (parsed.tool !== undefined) {
      return { type: 'tool', tool: parsed.tool, params: parsed.params || {} };
    }
    if (parsed.script !== undefined) {
      // W8-T2d: propagate the language so json_buffer sites don't hardcode 'bash'.
      return { type: 'script', script: parsed.script, language: parsed.language };
    }
    // v10.24-fix: Tolerate malformed wrappers where Kimi sends {"success":true,"mode":"RESPONSE","message":"..."}
    if (parsed.message !== undefined && typeof parsed.message === 'string' && !parsed.tool && !parsed.script) {
      return { type: 'response', text: parsed.message };
    }
    return null;
  };
  try {
    const mapped = mapParsed(JSON.parse(cleaned));
    if (mapped) return mapped;
  } catch {}
  // W6-T9: strict parse failed — the DOM may have emitted literal newlines/tabs
  // inside string values (common for {"script": "#!/bin/bash\n..."}). Escape
  // control characters inside strings and try again before the regex fallback.
  try {
    const mapped = mapParsed(JSON.parse(_preEscapeJsonStringNewlines(cleaned)));
    if (mapped) return mapped;
  } catch {}
  // Fallback regex extraction for malformed but complete JSON
  try {
    const respMatch = cleaned.match(/"response"\s*:\s*"([\s\S]*?)"\s*[,}]/);
    if (respMatch) {
      return { type: 'response', text: respMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') };
    }
    const msgMatch = cleaned.match(/"message"\s*:\s*"([\s\S]*?)"\s*[,}]/);
    if (msgMatch) {
      return { type: 'response', text: msgMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') };
    }
    // W6-T9: recover {"script": "...", "language": "..."} from malformed JSON
    const scriptMatch = cleaned.match(/"script"\s*:\s*"([\s\S]*?)"\s*[,}]/);
    if (scriptMatch) {
      const langMatch = cleaned.match(/"language"\s*:\s*"([^"]*)"/);
      const result = { type: 'script', script: scriptMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') };
      if (langMatch) result.language = langMatch[1];
      return result;
    }
  } catch {}
  // v11.1-fix: Last resort for file-write tool JSONs with unescaped quotes inside content.
  const writeFileTool = extractWriteFileFromText(cleaned);
  if (writeFileTool) {
    return writeFileTool;
  }
  return null;
}

// ============================================================
// v5.6: ROBUST ELEMENT INTERACTION — best practices from industry research
// https://playwright.dev/docs/best-practices
// https://www.browserstack.com/guide/playwright-locator
// ============================================================

/**
 * Smart click with multi-strategy fallback.
 * Priority: CSS selector → ARIA attributes → text content → icon detection → coordinates.
 * Uses getBoundingClientRect to click the CENTER of the element (works through shadow DOM/iframes).
 * @param {Page} page — Playwright page
 * @param {Object} strategies — { css?, aria?, text?, icon?, coords? }
 * @param {string} label — human-readable label for logging
 * @returns {Promise<boolean>} — true if clicked
 */
async function smartClick(page, strategies, label = 'element') {
  const attempts = [];

  // Strategy 1: CSS selector (most stable)
  if (strategies.css) {
    attempts.push(async () => {
      const el = page.locator(strategies.css).first();
      if (await el.count() > 0) {
        const box = await el.evaluate(el => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 };
        }).catch(() => null);
        if (box?.visible) {
          await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
          return true;
        }
      }
      return false;
    });
  }

  // Strategy 2: ARIA role + label
  if (strategies.aria) {
    attempts.push(async () => {
      const { role, label: ariaLabel, name } = strategies.aria;
      let locator;
      if (role && ariaLabel) {
        locator = page.getByRole(role, { name: ariaLabel, exact: false });
      } else if (role && name) {
        locator = page.getByRole(role, { name, exact: false });
      } else if (ariaLabel) {
        locator = page.getByLabel(ariaLabel, { exact: false });
      } else if (role) {
        locator = page.getByRole(role);
      }
      if (!locator) return false;
      if (await locator.count() > 0) {
        const box = await locator.first().evaluate(el => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 };
        }).catch(() => null);
        if (box?.visible) {
          await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
          return true;
        }
      }
      return false;
    });
  }

  // Strategy 3: Text content (regex or partial match)
  if (strategies.text) {
    attempts.push(async () => {
      const patterns = Array.isArray(strategies.text) ? strategies.text : [strategies.text];
      for (const pattern of patterns) {
        let locator;
        if (typeof pattern === 'string') {
          locator = page.getByText(pattern, { exact: false });
        } else {
          // Regex: use Playwright locator with hasText regex
          locator = page.locator('button, [role="button"], a, div').filter({ hasText: pattern }).first();
        }
        if (await locator.count() > 0) {
          const box = await locator.first().evaluate(el => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 };
          }).catch(() => null);
          if (box?.visible) {
            await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
            return true;
          }
        }
      }
      return false;
    });
  }

  // Strategy 4: Icon detection (SVG, img with specific src, etc.)
  if (strategies.icon) {
    attempts.push(async () => {
      const clicked = await page.evaluate((iconHint) => {
        const buttons = document.querySelectorAll('button, [role="button"], a');
        for (const btn of buttons) {
          const html = btn.innerHTML.toLowerCase();
          if (html.includes('svg') || html.includes('<img') || html.includes('icon')) {
            if (!iconHint || html.includes(iconHint.toLowerCase())) {
              const r = btn.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {
                // Return center coordinates
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
              }
            }
          }
        }
        return null;
      }, strategies.icon);
      if (clicked) {
        await page.mouse.click(clicked.x, clicked.y);
        return true;
      }
      return false;
    });
  }

  // Strategy 5: Coordinate fallback (last resort)
  if (strategies.coords) {
    attempts.push(async () => {
      const [x, y] = strategies.coords;
      await page.mouse.click(x, y);
      return true;
    });
  }

  // Execute strategies in order
  for (let i = 0; i < attempts.length; i++) {
    try {
      const success = await attempts[i]();
      if (success) {
        log.info(`[smartClick] Clicked ${label} via strategy ${i + 1}`);
        return true;
      }
    } catch (e) {
      // Continue to next strategy
    }
  }

  log.warn(`[smartClick] Failed to click ${label} — all strategies exhausted`);
  return false;
}

/**
 * Detect the language of the Kimi Web UI.
 * Returns 'en', 'zh', 'zh-tw', 'pt', or 'unknown'.
 */
async function detectPageLanguage(page) {
  return await page.evaluate(() => {
    const htmlLang = document.documentElement.lang || '';
    if (htmlLang.startsWith('zh')) {
      return htmlLang.includes('tw') || htmlLang.includes('hant') ? 'zh-tw' : 'zh';
    }
    if (htmlLang.startsWith('pt')) return 'pt';
    if (htmlLang.startsWith('en')) return 'en';
    // Fallback: detect by common UI text
    const bodyText = document.body.innerText;
    if (bodyText.includes('登录') || bodyText.includes('使用 Google 登录')) return 'zh';
    if (bodyText.includes('登入') || bodyText.includes('使用 Google 帳戶登入')) return 'zh-tw';
    if (bodyText.includes('Entrar') || bodyText.includes('Fazer login')) return 'pt';
    return 'unknown';
  }).catch(() => 'unknown');
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
// PROVIDER NETWORK INTERCEPTOR v7.5 — Multi-Provider
// ============================================================
// Replaces fragile JavaScript injection with native CDP network interception.
// Uses Chrome DevTools Protocol Fetch domain to intercept SSE streams in
// real-time, server-side. Immune to page anti-tampering, SPA navigation,
// React resets, or fetch restoration.

class ProviderNetworkInterceptor {
  constructor(page, providerConfig) {
    this.page = page;
    this.providerConfig = providerConfig;
    this.reasoning = [];
    this.content = [];
    this.toolCalls = [];
    this.lastActivity = Date.now();
    this._active = false;
    this._cdpSession = null;
    this._requestId = null;
    this._responseBuffer = '';
  }

  async start() {
    if (this._active) return;
    this._active = true;

    // v7.5: Use CDP Fetch domain for real-time response interception
    // This captures SSE chunks as they arrive, not just at the end.
    try {
      this._cdpSession = await this.page.context().newCDPSession(this.page);
      
      // Build patterns from provider config + fallback
      const patterns = this._buildFetchPatterns();
      
      await this._cdpSession.send('Fetch.enable', { patterns });

      this._cdpSession.on('Fetch.requestPaused', async (event) => {
        const { requestId, responseStatusCode, responseHeaders } = event;

        // Only intercept successful responses
        if (responseStatusCode && responseStatusCode >= 200 && responseStatusCode < 300) {
          this._requestId = requestId;
          this.lastActivity = Date.now();

          try {
            // Get response body (may be partial for streaming)
            const bodyResult = await this._cdpSession.send('Fetch.getResponseBody', { requestId });
            if (bodyResult.body) {
              const text = bodyResult.base64Encoded
                ? Buffer.from(bodyResult.body, 'base64').toString('utf-8')
                : bodyResult.body;
              // v8.7-fix: Limit buffer size to prevent memory growth / crash
              if (this._responseBuffer.length > 10 * 1024 * 1024) {
                this._responseBuffer = this._responseBuffer.slice(-5 * 1024 * 1024);
              }
              this._responseBuffer += text;
              this._parseSse(text);
            }
          } catch (e) {
            // Body may not be available yet for streaming responses
          }
        }

        // Always continue the request so the page works normally
        try {
          await this._cdpSession.send('Fetch.continueRequest', { requestId });
        } catch (e) {
          // Request may have been already continued
        }
      });

      log.info('[KimiNetworkInterceptor] Started — listening via CDP Fetch domain');
    } catch (e) {
      log.warn(`[KimiNetworkInterceptor] CDP Fetch failed (${e.message}), falling back to page.on('response')`);
      this._startPlaywrightFallback();
    }
  }

  _startPlaywrightFallback() {
    this._listener = async (response) => {
      const url = response.url();
      if (!this._isChatUrl(url)) return;
      this.lastActivity = Date.now();
      try {
        const body = await response.body();
        const text = body.toString('utf-8');
        this._parseSse(text);
      } catch (e) {}
    };
    this.page.on('response', this._listener);
  }

  stop() {
    if (!this._active) return;
    this._active = false;
    if (this._cdpSession) {
      this._cdpSession.detach().catch(() => {});
      this._cdpSession = null;
    }
    if (this._listener) {
      this.page.off('response', this._listener);
      this._listener = null;
    }
  }

  reset() {
    this.reasoning = [];
    this.content = [];
    this.toolCalls = [];
    this._responseBuffer = '';
    this.lastActivity = Date.now();
  }

  getData() {
    const thinking = this.reasoning.join('');
    const response = this.content.join('');
    const toolCalls = this.toolCalls.length > 0 ? this.toolCalls.splice(0, this.toolCalls.length) : [];
    return {
      thinking,
      response,
      toolCalls,
      hasData: thinking.length > 0 || response.length > 0 || toolCalls.length > 0,
      source: 'network-intercept',
    };
  }

  _isChatUrl(url) {
    return typeof url === 'string' && (
      url.includes('/api/chat') ||
      url.includes('/ChatService/Chat') ||
      url.includes('/kimi.gateway.chat') ||
      url.includes('/apiv2/kimi.chat') ||
      url.includes('/kimi.chat.v1.ChatService') ||
      url.includes('/ChatService/ChatCompletion')
    );
  }

  _parseSse(text) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line.trim() || !line.startsWith('data:')) continue;
      try {
        const json = JSON.parse(line.slice(5));

        // Kimi Connect-RPC format
        const msg = json?.result?.message || json?.message;
        if (msg) {
          if (msg.reasoning_content) this.reasoning.push(msg.reasoning_content);
          if (msg.content) this.content.push(msg.content);
          if (msg.tool_calls) this.toolCalls.push(...msg.tool_calls);
        }

        // Delta format
        const delta = json?.result?.delta || json?.delta;
        if (delta) {
          if (delta.reasoning_content) this.reasoning.push(delta.reasoning_content);
          if (delta.content) this.content.push(delta.content);
        }
      } catch (e) {
        // Ignore parse errors for malformed lines
      }
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
    this.maxPages = options.maxPages ?? 999;
    this.idleTimeout = options.idleTimeout ?? IDLE_TIMEOUT_MS;
    this.debug = options.debug || false;

    // Provider routing per user
    this.chatProviders = new Map(); // userId -> providerName
    this.defaultProvider = process.env.LUNA_DEFAULT_PROVIDER || DEFAULT_PROVIDER;

    this.browser = null;
    this.defaultContext = null; // Original Chrome context with login cookies
    this.userContexts = new Map(); // userId -> BrowserContext
    this.userSessions = new Map(); // userId -> { page, chatUrl, lastActivity, processing, mode, context }
    this.semaphore = new Semaphore(999); // Effectively unlimited
    this.store = new KimiSessionStore(SESSION_STORE_PATH);
    this.lastRequestTime = new Map(); // userId -> timestamp (rate limiting)
    this.idleTimer = null;
    this.cookieBackupTimer = null;
    this.persistentUserIds = new Set(); // userIds that should NEVER be cleaned up
    this.cancelledStreams = new Map(); // userId -> true (cancelled mid-stream)

    // v7.5: Network Interceptors — one per page, native Playwright response interception
    this.networkInterceptors = new Map(); // userId -> KimiNetworkInterceptor

    // v7.0: Decoupled DOM Event Queue — DOM reader is independent from stream lifecycle
    this.domEventQueues = new Map(); // userId -> { events: [], lastReadIndex: 0, createdAt: Date.now() }
    this.streamStopFlags = new Map(); // userId -> () => void (soft cancel signal)
    this.domPollingTasks = new Map(); // userId -> { active: boolean, startTime: number }

    // v5.6: WebBridge as PRIMARY, Playwright CDP as fallback
    this.webbridgeEnabled = true;
    this.webbridgeClients = new Map(); // userId -> WebBridgeClient
    this.webbridgeHealthy = false; // checked on connect()

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

  // ── Provider routing ──
  setChatProvider(userId, provider) {
    try {
      loadProviderConfig(provider);
    } catch (e) {
      throw new Error(`Provider desconhecido: ${provider}`);
    }
    this.chatProviders.set(userId, provider);
    log.info(`[Provider] Chat ${hashUserId(userId)} set to provider: ${provider}`);
  }

  getChatProvider(userId) {
    return this.chatProviders.get(userId) || this.defaultProvider;
  }

  getProviderConfig(userId) {
    const provider = this.getChatProvider(userId);
    try {
      return loadProviderConfig(provider);
    } catch (e) {
      log.warn(`[Provider] Failed to load config for ${provider}, falling back to ${this.defaultProvider}`);
      return loadProviderConfig(this.defaultProvider);
    }
  }

  _modeUrl(provider, mode) {
    const cfg = this._loadProviderConfig(provider);
    return cfg.modeUrls?.[mode] || cfg.baseUrl;
  }

  /**
   * Open a fresh chat on the current page WITHOUT losing login state.
   * Strategy:
   *   1. Try clicking the provider's "New Chat" UI button (.new-chat-btn on Kimi).
   *      This reuses the same tab/context/cookies and is the most reliable way to
   *      start a new thread while staying logged in.
   *   2. Fallback to the configured new-chat landing URL via goto() if the button
   *      is not available.
   * Returns the page URL after opening the new chat.
   */
  async _openNewChat(page, provider = 'kimi') {
    const newChatUrl = this._modeUrl(provider, 'instant');
    if (!page || page.isClosed()) return newChatUrl;

    try {
      // v10.36-fix: Click the native "New Chat" button when available.
      // This preserves login state because it does not reload the origin.
      const newChatBtn = page.locator('.new-chat-btn').first();
      if (await newChatBtn.count() > 0) {
        const isVisible = await newChatBtn.evaluate(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }).catch(() => false);
        if (isVisible) {
          await newChatBtn.click({ timeout: 10000 });
          log.info(`[_openNewChat] Clicked .new-chat-btn for provider=${provider}`);
          await page.waitForTimeout(1500);
          const urlAfterClick = page.url();
          log.info(`[_openNewChat] URL after click: ${urlAfterClick}`);
          return urlAfterClick;
        }
      }
    } catch (e) {
      log.warn(`[_openNewChat] Button click failed: ${e.message} — falling back to goto`);
    }

    // Fallback: navigate to the provider's new-chat landing URL.
    log.info(`[_openNewChat] Falling back to goto ${newChatUrl}`);
    await page.goto(newChatUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    return page.url();
  }

  _loadProviderConfig(provider) {
    try {
      return loadProviderConfig(provider);
    } catch (e) {
      log.warn(`[Provider] Failed to load config for ${provider}, falling back to ${this.defaultProvider}`);
      return loadProviderConfig(this.defaultProvider);
    }
  }

  _getProviderSelectors(provider) {
    const cfg = this._loadProviderConfig(provider);
    return getProviderResponseSelectors(cfg);
  }

  /**
   * Resolve the provider to use for a user.
   * Priority: explicit provider > session.provider > stored provider > default.
   */
  _resolveProvider(userId, provider = null) {
    if (provider && typeof provider === 'string') return provider;
    const session = this.userSessions.get(userId);
    if (session?.provider) return session.provider;
    const stored = this.store?.getUser?.(userId);
    if (stored?.provider) return stored.provider;
    return this.defaultProvider || 'kimi';
  }

  /**
   * Return the base hostname for a provider config (e.g. "kimi.com").
   */
  _providerDomain(provider) {
    const cfg = this._loadProviderConfig(provider);
    try {
      return new URL(cfg.baseUrl).hostname;
    } catch {
      return cfg.name;
    }
  }

  /**
   * v10.41-fix: Detect when the provider says the conversation reached its
   * context limit. Used by sendMessage/sendMessageStream to surface the flag
   * so callers can start a new chat only when actually needed.
   */
  _isContextLimitResponse(response) {
    if (!response) return false;
    const contextLimitRegex = /getting too long|conversation.*too long|try starting a new session|context limit|token limit|聊得太长|发起一个新会话|会话太长/i;
    return contextLimitRegex.test(response);
  }

  /**
   * v10.36-fix: Close stale provider landing-page tabs after migrating to a
   * new chat tab. Keeps only the active logged-in tab open so the user does not
   * see a deslogada page left behind.
   * v10.40-fix: Also close previous provider chat threads belonging to the same
   * Luna user so new chats do not pile up tabs in Chrome (Telegram mode sends
   * newChat for every turn).
   */
  async _closeStaleProviderTabs(context, keepPage, provider = 'kimi') {
    if (!context || !keepPage) return;
    const providerDomain = this._providerDomain(provider);
    const keepUserId = keepPage._lunaUserId;
    const pages = context.pages();
    for (const p of pages) {
      if (p === keepPage || p.isClosed()) continue;
      try {
        const url = p.url();
        if (!url.includes(providerDomain)) continue;
        // Close landing/new-chat pages that are not real chat threads.
        // Real threads contain /chat/<id>.
        const isStaleLanding = url.includes('chat_enter_method=new_chat') && !url.includes('/chat/');
        // Close managed chat threads owned by the same Luna user. This prevents
        // an infinite stack of Kimi tabs when each Telegram message opens a
        // fresh chat. Tabs without _lunaUserId are left alone to avoid killing
        // manually opened provider pages.
        const sameUserManaged = keepUserId && p._lunaUserId === keepUserId;
        if (isStaleLanding || sameUserManaged) {
          await p.close();
          log.info(`[_closeStaleProviderTabs] Closed stale provider tab: ${url} (landing=${isStaleLanding}, sameUser=${sameUserManaged})`);
        }
      } catch (e) {
        // ignore
      }
    }
  }

  _log(...args) {
    const msg = args.join(' ');
    if (this.debug) log.debug(msg);
  }

  /**
   * Determine whether a URL represents a valid thread URL for a provider.
   */
  _isProviderThreadUrl(provider, url) {
    if (!url || !provider) return false;
    switch (provider) {
      case 'kimi':
        return url.includes('/chat/');
      case 'deepseek':
        return url.includes('/c/');
      default:
        // For unknown providers, accept any URL under the provider domain.
        return true;
    }
  }

  /**
   * Save chat URL to store only if it's a valid thread URL for the active provider.
   * Prevents saving URLs outside the provider domain or without a valid thread path.
   */
  _saveChatUrl(userId, url, extra = {}) {
    if (!url) return;

    const provider = this._resolveProvider(userId);
    const providerDomain = this._providerDomain(provider);

    let isValid;
    try {
      isValid = new URL(url).hostname === providerDomain && this._isProviderThreadUrl(provider, url);
    } catch {
      isValid = false;
    }

    if (!isValid) {
      log.warn(`Refusing to save invalid chatUrl for ${provider}: ${url}`);
      return;
    }
    this.store.setUser(userId, { chatUrl: url, ...extra });
  }

  /**
   * Clear the persisted chat URL for a user.
   * Used before creating a new thread to prevent navigation back to the stale URL.
   */
  _clearChatUrl(userId) {
    const session = this.userSessions.get(userId);
    if (session) {
      session.chatUrl = null;
    }
    this.store.setUser(userId, { chatUrl: null, lastActivity: Date.now() });
    log.info(`Cleared chatUrl for user ${hashUserId(userId)}`);
  }

  /**
   * Capture and persist the current page URL for a user.
   * Throws if there is no active page or the URL cannot be read.
   * Invalid chat URLs are not persisted (see _saveChatUrl).
   */
  _captureCurrentChatUrl(userId) {
    const session = this.userSessions.get(userId);
    if (!session?.page) {
      throw new Error(`No active page for user ${hashUserId(userId)}`);
    }
    const url = session.page.url();
    if (!url) {
      throw new Error(`Could not read current URL for user ${hashUserId(userId)}`);
    }
    session.chatUrl = url;
    this._saveChatUrl(userId, url);
    log.info(`Captured chatUrl for user ${hashUserId(userId)}: ${url}`);
    return url;
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

    // v5.6: Check WebBridge health FIRST — it's our PRIMARY driver
    try {
      const wb = new WebBridgeClient('luna-kimi');
      const health = await wb.healthCheck();
      if (health.ok && health.connected) {
        this.webbridgeHealthy = true;
        log.success('WebBridge PRIMARY ready on port 10086 — Playwright CDP is fallback');
      } else {
        this.webbridgeHealthy = false;
        log.warn('WebBridge not healthy — falling back to Playwright CDP');
      }
    } catch (e) {
      this.webbridgeHealthy = false;
      log.warn(`WebBridge check failed: ${e.message} — using Playwright CDP fallback`);
    }

    let cdpUrl = await this._getCdpUrl();
    log.info(`Connecting to Chrome at ${cdpUrl}`);
    try {
      this.browser = await chromium.connectOverCDP(cdpUrl);
    } catch (e) {
      // v3.7-fix: If connection fails, try to start Chrome automatically
      log.warn(`Failed to connect to Chrome at ${cdpUrl}: ${e.message}`);
      log.info('Attempting to start Chrome automatically...');
      const chromeStatus = await this.checkChrome();
      if (chromeStatus.running || chromeStatus.started) {
        // Re-discover CDP URL after starting Chrome
        this._resetCdpUrl();
        cdpUrl = await this._getCdpUrl();
        log.info(`Retrying connection to Chrome at ${cdpUrl}`);
        this.browser = await chromium.connectOverCDP(cdpUrl);
      } else {
        this._resetCdpUrl();
        throw new Error(`Cannot connect to Chrome: ${chromeStatus.error || e.message}`);
      }
    }
    const contexts = this.browser.contexts();

    if (!contexts || contexts.length === 0) {
      throw new Error('No browser contexts found via CDP. Is Chrome running with --remote-debugging-port?');
    }

    this.defaultContext = contexts[0];
    log.success(`Connected! Using default context with ${this.defaultContext.pages().length} existing page(s)`);

    // v10.36-fix: First, pull the latest cookies FROM the Chrome persistent profile
    // and write them to the master cookies file. This guarantees we always use the
    // cookies Chrome already has, instead of stale backups that log the user out.
    try {
      for (const providerName of listProviders()) {
        await this._syncMasterCookiesFromContext(providerName);
      }
    } catch (e) {
      log.warn(`Failed to sync master cookies from Chrome profile: ${e.message}`);
    }

    // v3.9-fix: Inject MASTER cookies into defaultContext so all new user contexts
    // inherit login state, even when Chrome was just started with an empty profile.
    // After v10.36 these cookies come from the persistent Chrome profile first.
    try {
      for (const providerName of listProviders()) {
        const providerCfg = loadProviderConfig(providerName);
        const cookiePaths = getProviderCookies(providerCfg);
        const masterPath = cookiePaths.master;
        if (fs.existsSync(masterPath)) {
          const masterData = JSON.parse(fs.readFileSync(masterPath, 'utf8'));
          const masterCookies = masterData.cookies || [];
          if (masterCookies.length > 0) {
            await this.defaultContext.addCookies(masterCookies);
            log.info(`Injected ${masterCookies.length} MASTER cookies for ${providerName} into defaultContext`);
          }
        }
      }
    } catch (e) {
      log.warn(`Failed to inject MASTER cookies into defaultContext: ${e.message}`);
    }

    // v3.9-fix: Also inject localStorage into defaultContext pages
    try {
      const masterLsPath = path.join(__dirname, 'cookies', 'kimi-master-localstorage.json');
      if (fs.existsSync(masterLsPath)) {
        const masterLsData = JSON.parse(fs.readFileSync(masterLsPath, 'utf8'));
        const lsData = masterLsData.data || {};
        const keys = Object.keys(lsData);
        if (keys.length > 0) {
          for (const page of this.defaultContext.pages()) {
            await page.evaluate((items) => {
              for (const [key, value] of Object.entries(items)) {
                try { localStorage.setItem(key, value); } catch (e) {}
              }
            }, lsData).catch(() => {});
          }
          log.info(`Injected ${keys.length} localStorage items into defaultContext pages`);
        }
      }
    } catch (e) {
      log.warn(`Failed to inject MASTER localStorage into defaultContext: ${e.message}`);
    }

    // Register crash/disconnect listeners
    this.browser.on('disconnected', async () => {
      log.warn('[CRASH-RECOVERY] Browser disconnected via CDP');
      this.browser = null;
      this.defaultContext = null;
      this.userContexts.clear();
      this._resetCdpUrl();
      // v8.6-fix: Auto-restart Chrome preemptively so next operation doesn't wait
      try {
        log.info('[CRASH-RECOVERY] Auto-restarting Chrome...');
        await this.checkChrome();
        log.info('[CRASH-RECOVERY] Chrome auto-restarted successfully');
      } catch (e) {
        log.warn('[CRASH-RECOVERY] Auto-restart failed:', e.message);
      }
      // v8.6-fix: Clear global state to prevent stale sessions
      this.domEventQueues.clear();
      this.streamStopFlags.clear();
      this.cancelledStreams.clear();
      this.networkInterceptors.forEach(i => i.stop());
      this.networkInterceptors.clear();
      log.info('[DEBUG-LUNA] Global state cleared after browser disconnect');
    });

    // Start idle cleanup timer
    this._startIdleCleanup();

    // Start cookie backup timer (save every 5 minutes)
    this._startCookieBackup();

    // v5.6-fix: Start background polling to keep pages alive (prevents mobile Chrome suspension)
    this._startBackgroundPolling();

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
    if (this.bgPollTimer) {
      clearInterval(this.bgPollTimer);
      this.bgPollTimer = null;
    }

    // Close all user contexts (which also closes their pages)
    for (const [userId, ctx] of this.userContexts) {
      try {
        if (ctx && typeof ctx.close === 'function') {
          log.info('[DEBUG-LUNA] Closing context with 30s timeout');
          await Promise.race([
            ctx.close(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000)),
          ]);
          log.info(`Closed context for user ${hashUserId(userId)}`);
        }
      } catch (e) {
        log.warn(`Error closing context for ${hashUserId(userId)}: ${e.message}`);
      }
      this.semaphore.release();
    }
    this.userContexts.clear();
    this.userSessions.clear();

    if (this.browser) {
      try {
        if (typeof this.browser.disconnect === 'function') {
          log.info('[DEBUG-LUNA] Disconnecting browser with 30s timeout');
          await Promise.race([
            this.browser.disconnect(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000)),
          ]);
          log.info('Browser disconnected (CDP)');
        } else {
          log.warn('browser.disconnect not available, skipping');
        }
      } catch (e) {
        log.warn(`Browser disconnect error: ${e.message}`);
      }
      this.browser = null;
      this.defaultContext = null;
    }

    log.success('KimiBridge disconnected');
  }

  /**
   * Ensure connected to CDP with auto-reconnect on disconnect
   */
  async _ensureConnected() {
    if (!this.browser || !this.defaultContext) {
      log.info('Reconnecting to Chrome...');
      await this.connect();
    }
  }

  /**
   * Get or create an isolated BrowserContext for a user.
   * Copies cookies from the default context so the user is already logged in.
   */
  async _getOrCreateUserContext(userId) {
    await this._ensureConnected();

    // v7.4-fix: Use defaultContext instead of incognito context.
    // Incognito contexts do NOT load Chrome extensions (like Luna Extension),
    // causing the DOM observer to fall back to unreliable Playwright injection.
    // The defaultContext shares the same profile as the manually-started Chrome,
    // so extensions are available and login state persists.
    const ctx = this.defaultContext;

    // Re-inject MASTER cookies to ensure login state
    try {
      for (const providerName of listProviders()) {
        const providerCfg = loadProviderConfig(providerName);
        const cookiePaths = getProviderCookies(providerCfg);
        const masterPath = cookiePaths.master;
        if (fs.existsSync(masterPath)) {
          const masterData = JSON.parse(fs.readFileSync(masterPath, 'utf8'));
          const masterCookies = masterData.cookies || [];
          if (masterCookies.length > 0) {
            await ctx.addCookies(masterCookies);
            log.info(`Re-injected ${masterCookies.length} MASTER cookies for ${providerName} into defaultContext for user ${hashUserId(userId)}`);
          }
        }
      }
    } catch (e) {
      log.warn(`Failed to re-inject MASTER cookies for ${hashUserId(userId)}: ${e.message}`);
    }

    this.userContexts.set(userId, ctx);
    return ctx;
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
   * v8.6: Recover a user's session after Chrome crash/disconnect.
   * Reconnects to Chrome, restores the chat URL, and returns the page.
   */
  async recoverSession(userId) {
    log.info(`[CRASH-RECOVERY] Recovering session for user ${hashUserId(userId)}`);
    try {
      await this._ensureConnected();
      const stored = this.store.getUser(userId);
      const provider = stored?.provider || this.defaultProvider || 'kimi';
      const chatUrl = stored?.chatUrl || this._modeUrl(provider, 'instant');
      const mode = stored?.mode || 'instant';

      // Get or create page
      const page = await this._getOrCreateUserPage(userId, provider);
      if (!page || page.isClosed()) {
        throw new Error('Failed to recover page after crash');
      }

      // Navigate back to the saved chat URL
      let currentUrl = '';
      try { currentUrl = page.url(); } catch (e) { currentUrl = ''; }
      if (!currentUrl.includes(chatUrl.split('?')[0].split('/').pop())) {
        log.info(`[CRASH-RECOVERY] Navigating to saved chat URL: ${chatUrl}`);
        log.info('[DEBUG-LUNA] Crash-recovery goto with no timeout');
        await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
        await page.waitForTimeout(2000);
      }

      log.info(`[CRASH-RECOVERY] Session recovered for user ${hashUserId(userId)} at ${chatUrl}`);
      return { page, chatUrl, mode, success: true };
    } catch (e) {
      log.error(`[CRASH-RECOVERY] Failed to recover session: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  /**
   * Get or create a dedicated Page for a user.
   * Reuses existing page if still open.
   */
  async _getOrCreateUserPage(userId, providerArg = null) {
    await this._ensureConnected();

    const provider = this._resolveProvider(userId, providerArg);
    const providerDomain = this._providerDomain(provider);

    const existing = this.userSessions.get(userId);
    if (existing && existing.page && !existing.page.isClosed()) {
      // If the existing page is on a different provider domain, don't reuse it.
      // The caller will navigate to the correct URL later, but using the wrong
      // page can cause _verifySession to run the wrong selectors.
      const currentUrl = existing.page.url();
      if (!currentUrl.includes(providerDomain)) {
        log.info(`Existing page for user ${hashUserId(userId)} is on a different domain (${currentUrl}), creating a new page for provider ${provider}`);
        try { await existing.page.close(); } catch {}
        this.userSessions.delete(userId);
      } else {
        // v3.8-fix: Removed aggressive evaluate() health-check.
        // The evaluate() call fails when the page is still loading/navigating,
        // causing the bridge to close a perfectly good logged-in page and
        // create a new unlogged one. isClosed() is sufficient.
        existing.lastActivity = Date.now();
        existing.provider = provider;
        // v7.0-fix: Re-inject observer on reused pages (may have been navigated)
        await this._injectEventQueueObserver(existing.page).catch(() => {});
        return existing.page;
      }
    }

    // v10.36-fix: ALWAYS try to reuse an existing logged-in provider page first.
    // Each Luna Web session gets a different userId ('web-<sessionId>'), but the
    // user expects every Kimi/DeepSeek session to share the same Chrome tab that
    // is already logged in. We pick the best candidate (real /chat/ thread beats
    // landing page) and reassign it to the current userId.
    const candidatePages = [];
    const existingPages = this.defaultContext?.pages() || [];
    for (const p of existingPages) {
      if (p.isClosed()) continue;
      try {
        const url = p.url();
        if (url && url.includes(providerDomain)) {
          const isChatThread = url.includes('/chat/');
          candidatePages.push({ p, url, isChatThread, score: isChatThread ? 2 : 1 });
        }
      } catch (e) {
        // Page may be closing, skip
      }
    }

    const stored = this.store.getUser(userId);
    const storedChatUrl = stored?.chatUrl || null;

    if (candidatePages.length > 0) {
      // v10.39-fix: Honor the persisted chat URL for this Luna session.
      // Each Luna Web session is linked to a specific Kimi chat URL; if the user
      // (or browser) closed the tab, we must return to that exact conversation,
      // not reuse whatever other Kimi tab happens to be open.
      const targetChatId = storedChatUrl?.includes('/chat/')
        ? storedChatUrl.split('/chat/')[1].split('?')[0]
        : null;

      let best = null;
      if (targetChatId) {
        best = candidatePages.find((c) => c.url.includes(`/chat/${targetChatId}`)) || null;
      }
      if (!best) {
        candidatePages.sort((a, b) => b.score - a.score);
        best = candidatePages[0];
      }

      const p = best.p;
      const url = best.url;
      p._lunaUserId = userId;
      p._lunaProvider = provider;

      const session = {
        page: p,
        context: this.defaultContext,
        chatUrl: storedChatUrl || url,
        provider,
        lastActivity: Date.now(),
        processing: false,
        mode: stored?.mode || 'instant',
      };
      this.userSessions.set(userId, session);

      // If we reused a page that is not on the saved thread, navigate to it.
      if (storedChatUrl && !url.includes(storedChatUrl.split('?')[0].split('/').pop())) {
        log.info(`Session ${hashUserId(userId)} has saved chat ${storedChatUrl}; current tab is ${url} — navigating to saved chat`);
        await p.goto(storedChatUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
        await p.waitForTimeout(1500);
        session.chatUrl = p.url();
      } else {
        log.info(`Reusing existing ${providerDomain} page for user ${hashUserId(userId)}: ${url}`);
      }

      this._saveChatUrl(userId, session.chatUrl, { mode: session.mode, provider });
      // v10.27-fix: Do NOT inject master localStorage into an already-open,
      // already-logged-in page — it can overwrite valid tokens and log the user out.
      // Only inject when we create a fresh page/context.
      return p;
    }

    // Acquire semaphore slot (now effectively unlimited)
    log.info(`Acquiring slot for user ${hashUserId(userId)} (${this.semaphore.current}/${this.maxPages})`);
    await this.semaphore.acquire();

    // Get or create isolated context for this user
    const userCtx = await this._getOrCreateUserContext(userId);

    // Restore previous chat URL from store if available
    const chatUrl = storedChatUrl || this._modeUrl(provider, 'instant');

    let page = null;
    try {
      log.info(`Creating new page for user ${hashUserId(userId)} (provider=${provider})`);
      page = await userCtx.newPage();
      page._lunaUserId = userId; // for cookie re-sync in _verifySession
      page._lunaProvider = provider;

      // Register crash listener
      page.on('crash', () => {
        log.error(`Page crashed for user ${hashUserId(userId)}`);
        this.userSessions.delete(userId);
        this.semaphore.release();
      });

      // v7.5: No JavaScript injection into page. Network interception is handled
      // server-side via Playwright's native page.on('response'). DOM polling uses
      // page.evaluate() on demand. This is immune to page anti-tampering.

      await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
      await page.waitForTimeout(2000);

      // v3.3-fix: Re-inject via evaluate after navigation to ensure observer is active
      // addInitScript only works for future navigations; evaluate ensures current page
      await this._injectDomObserverEvaluate(page);
      // v7.5: No page-level JS injection needed. Network Interceptor is server-side.

      // v3.9-fix: Inject localStorage tokens (access_token, refresh_token etc)
      // These are REQUIRED for provider login state in addition to cookies
      await this._injectMasterLocalStorage(page, provider);

      // v3.9-fix: Verify login state after navigation. If logged out, re-inject cookies
      // and reload. This fixes stale contexts created before master cookies were saved.
      const providerCfg = this._loadProviderConfig(provider);
      const loginSelector = getProviderSelector(providerCfg, 'loginIndicator');
      const appContentSelector = getProviderSelector(providerCfg, 'appContent');
      const isLoggedIn = await page.evaluate(({ loginSel, appSel }) => {
        const hasLoginForm = loginSel ? !!document.querySelector(loginSel) : false;
        const hasAppContent = appSel ? !!document.querySelector(appSel) : false;
        return !hasLoginForm && hasAppContent;
      }, { loginSel: loginSelector, appSel: appContentSelector }).catch(() => false);

      if (!isLoggedIn) {
        log.warn(`Page opened logged-out for ${hashUserId(userId)} — attempting cookie restore + reload...`);
        try {
          const cookiePaths = getProviderCookies(providerCfg);
          const masterPath = cookiePaths.master;
          if (fs.existsSync(masterPath)) {
            const masterData = JSON.parse(fs.readFileSync(masterPath, 'utf8'));
            const masterCookies = masterData.cookies || [];
            if (masterCookies.length > 0) {
              await userCtx.addCookies(masterCookies);
              log.info(`Injected ${masterCookies.length} MASTER cookies before reload`);
            }
          }
        } catch (e) {
          log.warn(`Cookie restore before reload failed: ${e.message}`);
        }
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
        // Re-inject localStorage after reload
        await this._injectMasterLocalStorage(page, provider);

        const stillLoggedOut = await page.evaluate(({ loginSel, appSel }) => {
          const hasLoginForm = loginSel ? !!document.querySelector(loginSel) : false;
          const hasAppContent = appSel ? !!document.querySelector(appSel) : false;
          return !hasLoginForm && !hasAppContent;
        }, { loginSel: loginSelector, appSel: appContentSelector }).catch(() => true);

        if (stillLoggedOut) {
          log.warn(`Still logged out after cookie reload — will try _autoLogin on next message`);
        } else {
          log.success(`Cookie restore + reload worked! User ${hashUserId(userId)} is now logged in.`);
        }
      }
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
      context: userCtx,
      chatUrl: page.url(),
      provider,
      lastActivity: Date.now(),
      processing: false,
      mode: stored?.mode || 'instant',
    };

    this.userSessions.set(userId, session);
    this._saveChatUrl(userId, session.chatUrl, { mode: session.mode, provider });

    log.success(`Page ready for user ${hashUserId(userId)}: ${session.chatUrl}`);
    return page;
  }

  /**
   * Auto-login fallback: opens login modal, clicks "Continue with Google",
   * and selects the nexodigital account. Used when cookie re-sync fails.
   * v3.8-fix: Handles both modal-already-visible and needs-to-click-sidebar cases.
   */
  async _autoLogin(page, userId) {
    const provider = userId ? this.getChatProvider(userId) : 'kimi';
    const cfg = this.getProviderConfig(userId || 'default');
    if (!cfg.features?.autoLogin) {
      log.info(`[_autoLogin] Skipped for provider: ${provider} (manual login required)`);
      return false;
    }
    log.info('[_autoLogin] Attempting automatic Google sign-in...');
    try {
      const context = page.context();

      // Phase 1: Ensure login modal is visible
      // v5.6-fix: Multi-language support for login detection (EN, PT, ZH, ZH-TW)
      const loginTexts = [
        'Continue with Google', 'Google', 
        '使用 Google 登录', 'Google 登录', '使用 Google 帳戶登入',
        'Entrar com Google', 'Fazer login com Google'
      ];
      let hasModal = await page.evaluate((texts) =>
        texts.some(t => document.body.innerText.includes(t))
      , loginTexts).catch(() => false);

      if (!hasModal) {
        log.info('[_autoLogin] Login modal not visible — clicking sidebar Log In button...');
        // v5.6-fix: Multi-language sidebar login button support
        const sidebarLoginTexts = ['Log In', '登录', '登入', 'Entrar', 'Fazer login', 'Sign In'];
        const clickedSidebar = await page.evaluate((texts) => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while (node = walker.nextNode()) {
            const trimmed = node.textContent.trim();
            if (texts.some(t => trimmed === t || trimmed.includes(t))) {
              // Walk up to find clickable parent (.user-info or similar)
              let el = node.parentElement;
              for (let i = 0; i < 5 && el; i++) {
                if (el.classList?.contains('user-info') ||
                    el.classList?.contains('user-info-container') ||
                    el.onclick ||
                    window.getComputedStyle(el).cursor === 'pointer') {
                  el.click();
                  return true;
                }
                el = el.parentElement;
              }
              // Fallback: click the text node parent
              node.parentElement.click();
              return true;
            }
          }
          return false;
        }, sidebarLoginTexts);

        if (!clickedSidebar) {
          // Coordinate fallback: bottom-left sidebar area where Log In lives
          await page.mouse.click(97, 585);
          log.info('[_autoLogin] Clicked sidebar Log In via coordinates fallback');
        } else {
          log.info('[_autoLogin] Clicked sidebar Log In button');
        }

        // Wait for modal to appear
        let modalAttempts = 0;
        while (modalAttempts < 20) {
          hasModal = await page.evaluate((texts) =>
            texts.some(t => document.body.innerText.includes(t))
          , loginTexts).catch(() => false);
          if (hasModal) break;
          await page.waitForTimeout(500);
          modalAttempts++;
        }

        if (!hasModal) {
          log.warn('[_autoLogin] Login modal did not appear after clicking sidebar');
          return false;
        }
        log.info('[_autoLogin] Login modal is now visible');
      }

      // Phase 2: Click "Continue with Google" inside the modal
      // v5.6-fix: Try multiple strategies to find the Google button
      let clicked = false;
      
      // Strategy 1: Locator with regex (covers EN, PT, ZH)
      const googleBtn = page.locator('button, [role="button"], div[role="button"]')
        .filter({ hasText: /Continue with Google|Google|使用 Google|Google 登录|Google 登入|Entrar com Google|Fazer login/i })
        .first();
      if (!clicked && await googleBtn.count() > 0) {
        await googleBtn.click({ timeout: 5000 });
        clicked = true;
        log.info('[_autoLogin] Clicked "Continue with Google" via locator');
      }
      
      // Strategy 2: Look for any button containing Google logo/icon
      if (!clicked) {
        const iconBtn = await page.evaluate(() => {
          const buttons = document.querySelectorAll('button, [role="button"]');
          for (const btn of buttons) {
            const html = btn.innerHTML.toLowerCase();
            if (html.includes('google') || html.includes('g-') || html.includes('svg')) {
              btn.click();
              return true;
            }
          }
          return false;
        });
        if (iconBtn) {
          clicked = true;
          log.info('[_autoLogin] Clicked Google button via icon detection');
        }
      }
      
      // Strategy 3: Coordinate fallback (center of modal)
      if (!clicked) {
        await page.mouse.click(640, 300);
        clicked = true;
        log.info('[_autoLogin] Clicked "Continue with Google" via coordinates fallback');
      }

      // Phase 3: Wait for Google auth flow
      // The auth can happen in 3 ways:
      // A) New popup/tab with accounts.google.com (account chooser)
      // B) Same-page redirect to accounts.google.com
      // C) Already logged in — immediate redirect back to Kimi (no chooser)
      await page.waitForTimeout(3000);
      
      let googlePage = null;
      let attempts = 0;
      while (attempts < 20) {
        const pages = context.pages();
        googlePage = pages.find(p => p.url().includes('accounts.google.com'));
        if (googlePage) break;
        
        // Also check if current page redirected to Google
        const currentUrl = page.url();
        if (currentUrl.includes('accounts.google.com')) {
          googlePage = page;
          break;
        }
        
        await page.waitForTimeout(500);
        attempts++;
      }
      
      if (!googlePage) {
        // Case C: No Google page appeared — maybe already logged in or redirect happened instantly
        log.info('[_autoLogin] No Google auth page appeared — checking if already logged in...');
      } else {
        log.info('[_autoLogin] Google auth page detected');
        
        // Phase 4: Select available Google account on chooser
        let selectedAccount = null;
        
        // Wait a moment for the chooser to fully render
        await googlePage.waitForTimeout(1500);
        
        // Strategy 1: Try nexodigital first
        const nexodigitalBtn = googlePage.locator('div[role="button"], div[role="link"], [data-email]')
          .filter({ hasText: /nexodigital\.sys@gmail\.com|nexodigital/i })
          .first();
        if (await nexodigitalBtn.count() > 0) {
          await nexodigitalBtn.click({ timeout: 10000 });
          selectedAccount = 'nexodigital';
        } else {
          const altNexo = googlePage.getByText('nexodigital', { exact: false }).first();
          if (await altNexo.count() > 0) {
            await altNexo.click();
            selectedAccount = 'nexodigital';
          }
        }
        
        // Strategy 2: Fallback to Abner Gabriel
        if (!selectedAccount) {
          const abnerBtn = googlePage.locator('div[role="button"], div[role="link"], [data-email]')
            .filter({ hasText: /Abner Gabriel|nninguem17@gmail\.com/i })
            .first();
          if (await abnerBtn.count() > 0) {
            await abnerBtn.click({ timeout: 10000 });
            selectedAccount = 'Abner Gabriel';
          } else {
            const altAbner = googlePage.getByText('Abner Gabriel', { exact: false }).first();
            if (await altAbner.count() > 0) {
              await altAbner.click();
              selectedAccount = 'Abner Gabriel';
            }
          }
        }
        
        // Strategy 3: Select first account with @ email
        if (!selectedAccount) {
          const firstAccount = googlePage.locator('div[role="button"], div[role="link"]')
            .filter({ hasText: /@/ })
            .first();
          if (await firstAccount.count() > 0) {
            const accountText = await firstAccount.textContent();
            await firstAccount.click({ timeout: 10000 });
            selectedAccount = accountText?.trim().split('\n')[0] || 'first-available';
          }
        }
        
        // Strategy 4: If no account chooser but there's a "Continue" or password field,
        // the user might need to confirm — try clicking first interactive element
        if (!selectedAccount) {
          const anyBtn = googlePage.locator('button, [role="button"]').first();
          if (await anyBtn.count() > 0) {
            const btnText = await anyBtn.textContent();
            log.info(`[_autoLogin] No account found, clicking first button: ${btnText?.substring(0, 50)}`);
            await anyBtn.click({ timeout: 10000 });
            selectedAccount = 'auto-clicked';
          }
        }
        
        if (!selectedAccount) {
          log.warn('[_autoLogin] Could not find any Google account or button on auth page');
          return false;
        }
        log.info(`[_autoLogin] Selected account: ${selectedAccount}`);
      }

      // Phase 5: Wait for redirect back to Kimi and verify login
      log.info('[_autoLogin] Waiting for login to complete...');
      let loginAttempts = 0;
      let isLoggedIn = false;
      while (loginAttempts < 30) {
        isLoggedIn = await page.evaluate(() => {
          const hasLoginForm = !!(
            document.querySelector('form[action*="login"], form[action*="auth"]') ||
            document.querySelector('input[type="password"]')
          );
          const hasAppContent = !!(document.querySelector('.chat-editor, .markdown-container, .segment-assistant-actions'));
          return !hasLoginForm && hasAppContent;
        }).catch(() => false);
        
        if (isLoggedIn) break;
        await page.waitForTimeout(1000);
        loginAttempts++;
      }

      if (isLoggedIn) {
        log.success('[_autoLogin] Automatic login successful!');
        try {
          const cookies = await context.cookies();
          if (cookies && cookies.length > 0) {
            const backupPath = path.join(ARTIFACTS_DIR, 'kimi-cookies-backup.json');
            fs.writeFileSync(backupPath, JSON.stringify(cookies, null, 2));
            log.info(`[_autoLogin] Backed up ${cookies.length} cookies to ${backupPath}`);
          }
        } catch (e) {
          log.warn(`[_autoLogin] Cookie backup after login failed: ${e.message}`);
        }
        return true;
      }
      log.warn('[_autoLogin] Login did not complete successfully');
      return false;
    } catch (e) {
      log.warn(`[_autoLogin] Error during auto-login: ${e.message}`);
      return false;
    }
  }

  /**
   * Verify the user session is not expired (not showing Log In screen)
   * Uses provider-specific login selectors.
   */
  async _verifySession(page) {
    const provider = page._lunaProvider || this.defaultProvider || 'kimi';
    const providerCfg = this._loadProviderConfig(provider);
    const loginSelector = getProviderSelector(providerCfg, 'loginIndicator');
    const appContentSelector = getProviderSelector(providerCfg, 'appContent');

    const evalLoggedIn = async () => {
      return page.evaluate(({ loginSel, appSel }) => {
        const loginEl = loginSel ? document.querySelector(loginSel) : null;
        const pwdEl = document.querySelector('input[type="password"]');
        const appEl = appSel ? document.querySelector(appSel) : null;
        const result = {
          hasLoginForm: !!loginEl,
          hasPassword: !!pwdEl,
          hasAppContent: !!appEl,
        };
        return { loggedIn: !(result.hasLoginForm || result.hasPassword) && result.hasAppContent, debug: result };
      }, { loginSel: loginSelector, appSel: appContentSelector }).catch((e) => ({ loggedIn: false, debug: { error: e.message } }));
    };

    const evalResult = await evalLoggedIn();
    let isLoggedIn = evalResult.loggedIn;
    log.info(`[_verifySession] provider=${provider} isLoggedIn=${isLoggedIn}`);

    if (!isLoggedIn) {
      // Attempt cookie restoration before giving up
      let restored = false;
      try {
        const userId = page._lunaUserId;
        const ctx = userId ? this.userContexts.get(userId) : null;

        // Step 0: Kimi may show a login modal or sidebar "Log In" button even when
        // a valid auth cookie is present. Trigger the OAuth flow so the modal closes
        // and the existing cookie session is activated.
        if (!restored && provider === 'kimi') {
          try {
            const modal = page.locator('.login-modal-mask, .login-modal').first();
            const hasModal = await modal.count() > 0 && await modal.isVisible();
            if (hasModal) {
              // Prefer Google OAuth inside the modal — it uses the browser's saved
              // Google session and dismisses the modal automatically.
              const googleBtn = modal.locator('.google-login-btn, button:has-text("Continue with Google"), button:has-text("Google")').first();
              if (await googleBtn.count() > 0 && await googleBtn.isVisible()) {
                log.info(`[_verifySession] Clicking Kimi Google login button in modal for ${hashUserId(userId)}`);
                await googleBtn.click();
                await page.waitForTimeout(4000);
                if (await evalLoggedIn()) {
                  log.success(`Google login modal click restored session for user ${hashUserId(userId)}`);
                  // The modal may still be open even though the cookie session is active.
                  // Reload to dismiss the overlay so subsequent clicks (new chat, send) work.
                  try {
                    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
                    await page.waitForTimeout(2000);
                    log.info(`[_verifySession] Reloaded page to dismiss login modal`);
                  } catch (e) {
                    log.warn(`[_verifySession] Post-login reload failed: ${e.message}`);
                  }
                  restored = true;
                }
              }
            }
            if (!restored) {
              const loginBtn = page.locator('button:has-text("Log In"), button:has-text("Log in")').first();
              if (await loginBtn.count() > 0 && await loginBtn.isVisible()) {
                log.info(`[_verifySession] Clicking Kimi Log In button to activate cookie session for ${hashUserId(userId)}`);
                await loginBtn.click();
                await page.waitForTimeout(3000);
                if (await evalLoggedIn()) {
                  log.success(`Log In button click restored session for user ${hashUserId(userId)}`);
                  restored = true;
                }
              }
            }
          } catch (e) {
            log.warn(`[_verifySession] Login button click failed: ${e.message}`);
          }
        }

        // Step 1: Try loading from MASTER cookies file (permanent save after manual login)
        if (!restored && ctx) {
          const cookiePaths = getProviderCookies(providerCfg);
          const masterPath = cookiePaths.master;
          if (fs.existsSync(masterPath)) {
            try {
              const masterData = JSON.parse(fs.readFileSync(masterPath, 'utf8'));
              const masterCookies = masterData.cookies || [];
              if (masterCookies.length > 0) {
                await ctx.addCookies(masterCookies);
                log.info(`Loaded ${masterCookies.length} cookies from MASTER backup for user ${hashUserId(userId)} (provider=${provider})`);
                await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
                await page.waitForTimeout(2000);
                if (await evalLoggedIn()) {
                  log.success(`MASTER cookies restored session for user ${hashUserId(userId)}`);
                  restored = true;
                }
              }
            } catch (e) {
              log.warn(`MASTER cookie load failed: ${e.message}`);
            }
          }
        }

        // Step 2: Try re-sync from default context
        if (!restored && userId && this.defaultContext && ctx) {
          const cookies = await this.defaultContext.cookies();
          if (cookies && cookies.length > 0) {
            await ctx.addCookies(cookies);
            log.info(`Re-synced ${cookies.length} cookies from default context for user ${hashUserId(userId)}`);
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(1500);
            if (await evalLoggedIn()) {
              log.success(`Cookie re-sync restored session for user ${hashUserId(userId)}`);
              restored = true;
            }
          }
        }

        // Step 3: Try loading from persistent backup file
        if (!restored && ctx) {
          const loaded = await this._loadCookiesFromFile(ctx);
          if (loaded) {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(1500);
            if (await evalLoggedIn()) {
              log.success(`Cookie backup restored session for user ${hashUserId(userId)}`);
              restored = true;
            }
          }
        }
      } catch (e) {
        log.warn(`Cookie re-sync failed: ${e.message}`);
      }

      if (!restored) {
        // Step 4: Attempt automatic provider login as last resort (only if supported)
        log.warn(`Session expired for user ${hashUserId(page._lunaUserId)} — attempting auto-login...`);
        const autoLoginOk = await this._autoLogin(page, page._lunaUserId);
        if (autoLoginOk) {
          log.success(`Auto-login restored session for user ${hashUserId(page._lunaUserId)}`);
          return true;
        }
        throw new Error(`${provider.toUpperCase()}_LOGIN_REQUIRED`);
      }
      return true;
    }
    return true;
  }

  /**
   * v7.7-INFALÍVEL: Extract ALL new content since preSendSnapshot.
   * Instead of guessing which assistant is the "correct" one, we capture
   * the DOM state BEFORE sending, then AFTER the response is complete,
   * and return the DIFFERENCE. This is immune to:
   * - Confirmation messages appearing after the real response
   * - Multiple assistants being created
   * - DOM structure changes
   * - Index shifting
   */
  async _extractResponseDiff(page, preSendSnapshot = []) {
    const provider = page._lunaProvider || this.defaultProvider || 'kimi';
    if (provider !== 'kimi') {
      // v10.27-fix: snapshot diff relies on Kimi-specific .segment-assistant.
      // For non-Kimi providers, use the generic extraction path directly.
      return this._extractResponse(page, {});
    }

    if (!preSendSnapshot || preSendSnapshot.length === 0) {
      // Fallback: no snapshot, use last assistant
      return this._extractResponse(page, {});
    }

    try {
      const postSnapshot = await page.evaluate(() => {
        const assistants = document.querySelectorAll('.segment-assistant');
        return Array.from(assistants).map((el, i) => {
          // Extract all meaningful text from this assistant
          let text = '';
          const contentBox = el.querySelector('.segment-content-box');
          if (contentBox) {
            const codeBlocks = contentBox.querySelectorAll('.segment-code, pre code, [class*="code-block"]');
            for (const cb of codeBlocks) {
              const t = (cb.innerText || cb.textContent || '').trim();
              if (t) text += t + '\n\n';
            }
            const paragraphs = contentBox.querySelectorAll('.paragraph, p, [class*="text"]');
            for (const p of paragraphs) {
              const t = (p.innerText || p.textContent || '').trim();
              if (t) text += t + '\n\n';
            }
          }
          return {
            index: i,
            text: text.trim(),
            textLength: text.trim().length,
          };
        });
      });

      let newContent = '';
      let sources = [];

      // Strategy A: New assistants (index >= preSendSnapshot.length)
      for (let i = preSendSnapshot.length; i < postSnapshot.length; i++) {
        const assistant = postSnapshot[i];
        if (assistant.textLength > 0) {
          newContent += assistant.text + '\n\n';
          sources.push(`new-assistant-${i}`);
        }
      }

      // Strategy B: Existing assistants that changed significantly
      for (let i = 0; i < Math.min(preSendSnapshot.length, postSnapshot.length); i++) {
        const preText = preSendSnapshot[i] || '';
        const postText = postSnapshot[i]?.text || '';
        if (postText.length > preText.length + 10) {
          // Significant change — extract only the NEW part
          const newPart = postText.slice(preText.length).trim();
          if (newPart.length > 10) {
            newContent += newPart + '\n\n';
            sources.push(`changed-assistant-${i}`);
          }
        }
      }

      newContent = newContent.trim();

      if (newContent.length > 0) {
        log.success(`[v7.7] Extracted via snapshot-diff (${sources.join(', ')}): ${newContent.length} chars`);
        return newContent;
      }

      // If no diff found, try extracting from the last assistant as fallback
      const lastAssistant = postSnapshot[postSnapshot.length - 1];
      if (lastAssistant && lastAssistant.textLength > 0) {
        log.warn(`[v7.7] No diff detected, falling back to last assistant (${lastAssistant.textLength} chars)`);
        return lastAssistant.text;
      }
    } catch (e) {
      log.warn(`[v7.7] Snapshot diff failed: ${e.message} — falling back to _extractResponse`);
    }

    return this._extractResponse(page, {});
  }

  /**
   * v7.7: Capture a snapshot of all assistant texts before sending.
   * This snapshot is used by _extractResponseDiff to compute the difference.
   */
  async _capturePreSendSnapshot(page) {
    try {
      const snapshot = await page.evaluate(() => {
        const assistants = document.querySelectorAll('.segment-assistant');
        return Array.from(assistants).map((el) => {
          let text = '';
          const contentBox = el.querySelector('.segment-content-box');
          if (contentBox) {
            const codeBlocks = contentBox.querySelectorAll('.segment-code, pre code, [class*="code-block"]');
            for (const cb of codeBlocks) {
              const t = (cb.innerText || cb.textContent || '').trim();
              if (t) text += t + '\n\n';
            }
            const paragraphs = contentBox.querySelectorAll('.paragraph, p, [class*="text"]');
            for (const p of paragraphs) {
              const t = (p.innerText || p.textContent || '').trim();
              if (t) text += t + '\n\n';
            }
          }
          return text.trim();
        });
      });
      log.info(`[v7.7] Captured pre-send snapshot: ${snapshot.length} assistants`);
      return snapshot;
    } catch (e) {
      log.warn(`[v7.7] Failed to capture pre-send snapshot: ${e.message}`);
      return [];
    }
  }

  /**
   * Extract response using multi-strategy fallback.
   * Prioritizes stream interceptor, then React Fiber, then DOM selectors.
   * v7.7: Kept as fallback for _extractResponseDiff.
   */
  async _extractResponse(page, options = {}) {
    // v7.5: Unified DOM extraction using the SAME logic as _pollThinkingAndResponse Layer 2.5
    // This ensures consistency between the DOM poller and final extraction.
    const { preferAssistantIndex, userId } = options;

    // v7.5: Strategy 0 — Network Interceptor (PRIMARY, server-side)
    // Uses Playwright's native page.on('response') — immune to page anti-tampering.
    if (userId) {
      const interceptor = this.networkInterceptors.get(userId);
      if (interceptor) {
        const data = interceptor.getData();
        if (data.response && data.response.trim().length > 0) {
          log.success(`[v7.5] Extracted via network-intercept: ${data.response.slice(0, 80)}...`);
          return data.response.trim();
        }
      }
    }

    // Strategy 0b: Legacy JS-injected stream interceptor (DEPRECATED)
    try {
      const intercepted = await page.evaluate(() => {
        const s = window.__lunaStream;
        if (s && s.active && s.content) {
          return Array.isArray(s.content) ? s.content.join('') : (s.content || '');
        }
        return null;
      });
      if (intercepted && intercepted.trim()) {
        log.success(`Extracted via stream-intercept-legacy: ${intercepted.slice(0, 80)}...`);
        return intercepted.trim();
      }
    } catch (e) {
      this._log(`Stream intercept extraction failed: ${e.message}`);
    }

    // v7.5: Strategy 1 — Unified DOM extraction (same as _pollThinkingAndResponse Layer 2.5)
    try {
      const domResult = await page.evaluate((prefIdx) => {
        const assistants = document.querySelectorAll('.segment-assistant');
        if (!assistants.length) return null;

        // v7.5-fix: If preferAssistantIndex is provided, use it. Otherwise use last.
        // This allows the caller to specify which assistant to extract from.
        let assistant = assistants[assistants.length - 1];
        if (prefIdx !== undefined && prefIdx >= 0 && prefIdx < assistants.length) {
          assistant = assistants[prefIdx];
        }

        let thinking = '';
        let response = '';

        const thinkContainer = assistant.querySelector('.toolcall-container.thinking-container');
        if (thinkContainer) {
          const thinkMd = thinkContainer.querySelector('.markdown-container.toolcall-content-text');
          if (thinkMd) thinking = (thinkMd.innerText || '').trim();
        }

        const thinkStarters = /^(O usuário|Vou |Agora |Preciso |Primeiro |Vamos |Então |Deixa |Hmm |Ok |Okay |Let me |I need |I'll |First |Now |So |The user |Hmm |Okay )/i;
        const contentBox = assistant.querySelector('.segment-content-box');
        if (!contentBox) return null;

        // Extract from markdown containers
        const markdownContainers = contentBox.querySelectorAll('.markdown-container');
        let rawResponse = '';
        for (const md of markdownContainers) {
          if (thinkContainer && md.closest('.toolcall-container.thinking-container')) continue;
          const codeBlocks = md.querySelectorAll('.segment-code, pre code, [class*="code-block"]');
          for (const cb of codeBlocks) {
            const text = (cb.innerText || cb.textContent || '').trim();
            if (text) {
              // v8.5-fix: skip tool call JSON blocks from being exposed as response text
              if (text.startsWith('{') && text.includes('"tool"')) {
                // This is a tool call block, not user-facing text
              } else {
                rawResponse += text + '\n\n';
              }
            }
          }
          const paragraphs = md.querySelectorAll('.paragraph, p, [class*="text"]');
          for (const p of paragraphs) {
            const text = (p.innerText || p.textContent || '').trim();
            if (text) rawResponse += text + '\n\n';
          }
        }

        // OLD structure fallback
        if (!rawResponse) {
          const containerBlock = contentBox.querySelector('.container-block');
          const blockItems = containerBlock
            ? containerBlock.querySelectorAll('.block-item')
            : contentBox.querySelectorAll('.block-item');
          for (const item of blockItems) {
            if (item.querySelector('.toolcall-container.thinking-container')) continue;
            const codeBlocks = item.querySelectorAll('.segment-code, pre code, [class*="code-block"]');
            for (const cb of codeBlocks) {
              // v9.5-fix: Use textContent FIRST for code blocks — innerText can be truncated
              const text = (cb.textContent || cb.innerText || '').trim();
              if (text) rawResponse += text + '\n\n';
            }
            const paragraphs = item.querySelectorAll('.paragraph, p, [class*="text"]');
            for (const p of paragraphs) {
              const text = (p.innerText || p.textContent || '').trim();
              if (text) rawResponse += text + '\n\n';
            }
          }
        }

        rawResponse = rawResponse.trim();

        // v7.5: Apply same thinking/response separation logic
        if (thinkContainer && rawResponse) {
          const codeBlockIdx = rawResponse.indexOf('```');
          const jsonStartIdx = rawResponse.search(/\{\s*"/);
          const firstRealIdx = codeBlockIdx >= 0 && jsonStartIdx >= 0
            ? Math.min(codeBlockIdx, jsonStartIdx)
            : (codeBlockIdx >= 0 ? codeBlockIdx : jsonStartIdx);

          if (firstRealIdx > 10) {
            const beforeReal = rawResponse.slice(0, firstRealIdx).trim();
            const afterReal = rawResponse.slice(firstRealIdx).trim();
            if (thinkStarters.test(beforeReal) || beforeReal.length < 400) {
              thinking = thinking ? thinking + '\n\n' + beforeReal : beforeReal;
              response = afterReal;
            } else {
              response = rawResponse;
            }
          } else if (firstRealIdx === 0) {
            response = rawResponse;
          } else if (!rawResponse.includes('```') && !rawResponse.includes('{')) {
            thinking = thinking ? thinking + '\n\n' + rawResponse : rawResponse;
            response = '';
          } else {
            response = rawResponse;
          }
        } else {
          response = rawResponse;
        }

        if (!thinkContainer && response && !thinking) {
          const isThink = thinkStarters.test(response) && response.length < 500 &&
                          !response.includes('"response"') && !response.includes('"tool"');
          if (isThink) {
            thinking = response;
            response = '';
          }
        }

        return { thinking: thinking || '', response: response || '', source: 'dom-unified', assistantIndex: prefIdx };
      }, preferAssistantIndex);

      if (domResult && domResult.response) {
        log.success(`Extracted via dom-unified (assistant ${domResult.assistantIndex ?? 'last'}): ${domResult.response.slice(0, 80)}...`);
        return domResult.response.trim();
      }
    } catch (e) {
      this._log(`DOM unified extraction failed: ${e.message}`);
    }

    // v7.5: Strategy 2 — Try previous assistant if last one looks like a confirmation
    // This handles the case where Kimi adds a new "confirmation" assistant after the tool call
    try {
      const prevResult = await page.evaluate(() => {
        const assistants = document.querySelectorAll('.segment-assistant');
        if (assistants.length < 2) return null;
        const prevAssistant = assistants[assistants.length - 2];
        if (!prevAssistant) return null;

        let response = '';
        const contentBox = prevAssistant.querySelector('.segment-content-box');
        if (contentBox) {
          const codeBlocks = contentBox.querySelectorAll('.segment-code, pre code');
          for (const cb of codeBlocks) {
            const text = (cb.innerText || cb.textContent || '').trim();
            if (text) response += text + '\n\n';
          }
        }
        return response.trim() || null;
      });
      if (prevResult && prevResult.includes('{') && prevResult.includes('"tool"')) {
        log.success(`Extracted via previous-assistant: ${prevResult.slice(0, 80)}...`);
        return prevResult;
      }
    } catch (e) {
      this._log(`Previous assistant extraction failed: ${e.message}`);
    }

    // Strategy 3 — Generic provider fallback
    const provider = page._lunaProvider || this.defaultProvider || 'kimi';
    if (provider !== 'kimi') {
      const generic = await this._genericProviderExtraction(page, provider);
      if (generic.response && generic.response.trim().length > 0) {
        log.success(`Extracted via generic-provider: ${generic.response.slice(0, 80)}...`);
        return generic.response.trim();
      }
    }

    throw new Error('EXTRACTION_FAILED: Nenhuma resposta encontrada');
  }

  /**
   * Generic extraction fallback for non-Kimi providers.
   * Uses provider config response selectors.
   */
  async _genericProviderExtraction(page, provider) {
    try {
      const cfg = this._loadProviderConfig(provider);
      const selectors = getProviderResponseSelectors(cfg);
      const codeBlockSelector = getProviderSelector(cfg, 'codeBlock') || 'pre code';
      const raw = await page.evaluate(({ containerSel, assistantSel, codeBlockSel }) => {
        let response = '';
        if (assistantSel) {
          const assistants = document.querySelectorAll(assistantSel);
          const last = assistants[assistants.length - 1];
          if (last) response = (last.innerText || last.textContent || '').trim();
        }
        if (!response && containerSel) {
          const containers = document.querySelectorAll(containerSel);
          const last = containers[containers.length - 1];
          if (last) response = (last.innerText || last.textContent || '').trim();
        }
        // Gather all code-block texts for tool JSON detection.
        const codeBlocks = [];
        try {
          document.querySelectorAll(codeBlockSel).forEach(el => {
            const text = (el.textContent || el.innerText || '').trim();
            if (text) codeBlocks.push(text);
          });
        } catch {}
        return { response, codeBlocks };
      }, { containerSel: selectors.container, assistantSel: selectors.assistant, codeBlockSel: codeBlockSelector });

      // v10.27-fix: Clean up DeepSeek code-block artifacts ("json\nCopy\nDownload\n{...}")
      // and unwrap JSON wrappers like {"response": "..."}.
      let response = raw.response || '';
      response = response.replace(/^json\s*[\r\n]+/i, '').trim();
      response = response.replace(/^(Copy\s+Download\s*[\r\n]+)/i, '').trim();
      response = response.replace(/\n\s*Copy\s*\n\s*Download\s*\n?/i, '\n').trim();

      // v10.35-fix: Robustly extract {"response":"..."} / {"message":"..."} wrappers.
      // DeepSeek may stream partial JSON or reset the DOM, so we scan character-by-character
      // to find the outermost complete JSON object and ignore trailing fragments.
      const findWrapperObject = (str) => {
        let i = 0;
        while (i < str.length) {
          if (str[i] !== '{') { i++; continue; }
          const start = i;
          let depth = 1;
          let inString = false;
          let escape = false;
          i++;
          while (i < str.length && depth > 0) {
            const c = str[i];
            if (escape) {
              escape = false;
            } else if (c === '\\') {
              escape = true;
            } else if (c === '"') {
              inString = !inString;
            } else if (!inString) {
              if (c === '{') depth++;
              else if (c === '}') depth--;
            }
            i++;
          }
          if (depth === 0) {
            const block = str.slice(start, i);
            if ((/"response"\s*:/.test(block) || /"message"\s*:/.test(block)) && !/"tool"\s*:/.test(block)) {
              return block;
            }
          }
        }
        return null;
      };

      const wrapperBlock = findWrapperObject(response);
      if (wrapperBlock) {
        try {
          const parsed = JSON.parse(wrapperBlock);
          if (parsed && typeof parsed.response === 'string') {
            response = parsed.response.trim();
          } else if (parsed && typeof parsed.message === 'string' && !parsed.tool && !parsed.script) {
            response = parsed.message.trim();
          }
        } catch (e) {
          // Malformed wrapper — fall back to regex extraction instead of keeping raw JSON.
          const m = wrapperBlock.match(/"response"\s*:\s*"((?:\\.|[^"\\])*?)"/);
          if (m) {
            response = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          } else {
            const m2 = wrapperBlock.match(/"message"\s*:\s*"((?:\\.|[^"\\])*?)"/);
            if (m2) {
              response = m2[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            }
          }
        }
      }

      // v10.35-fix / W8-T2a: extractFirstCompleteJsonObject is now module-level
      // (hoisted so _extractJsonToolCalls reuses the same string-aware walker).
      // The call below resolves to the module function — behavior unchanged.

      // v11.1-fix: Manual extraction for writeFile/appendFile when JSON is malformed with
      // unescaped quotes inside the content string. We pull path and content directly so
      // large HTML/JS payloads are not lost.
      function extractWriteFileFallback(text) {
        if (!text || text.length < 30) return null;
        const toolMatch = text.match(/"tool"\s*:\s*"([^"]+)"/);
        if (!toolMatch) return null;
        const tool = toolMatch[1];
        if (!['writeFile', 'appendFile', 'replaceInFile'].includes(tool)) return null;

        function extractStringValue(key) {
          const pattern = new RegExp(`"${key}"\\s*:\\s*"`);
          const m = text.match(pattern);
          if (!m) return null;
          let i = text.indexOf(m[0]) + m[0].length;
          let val = '';
          while (i < text.length) {
            const ch = text[i];
            if (ch === '\\' && i + 1 < text.length) {
              const next = text[i + 1];
              switch (next) {
                case 'n': val += '\n'; break;
                case 't': val += '\t'; break;
                case 'r': val += '\r'; break;
                case 'b': val += '\b'; break;
                case 'f': val += '\f'; break;
                case '\\': val += '\\'; break;
                case '"': val += '"'; break;
                case '/': val += '/'; break;
                case 'u':
                  if (i + 5 < text.length) {
                    const hex = text.slice(i + 2, i + 6);
                    const code = parseInt(hex, 16);
                    if (!isNaN(code)) {
                      val += String.fromCharCode(code);
                      i += 4;
                      break;
                    }
                  }
                  val += next;
                  break;
                default: val += next; break;
              }
              i += 2;
              continue;
            }
            if (ch === '"') {
              let j = i + 1;
              while (j < text.length && /\s/.test(text[j])) j++;
              if (j >= text.length || text[j] === ',' || text[j] === '}' || text[j] === ']') {
                return val;
              }
              val += ch;
              i++;
              continue;
            }
            val += ch;
            i++;
          }
          return val;
        }

        const path = extractStringValue('path');
        const content = extractStringValue('content');
        if (!path || content === null) return null;
        const params = { path, content };
        if (tool === 'replaceInFile') {
          const oldStr = extractStringValue('oldString') || extractStringValue('old_string') || extractStringValue('old');
          const newStr = extractStringValue('newString') || extractStringValue('new_string') || extractStringValue('new');
          if (oldStr !== null) params.oldString = oldStr;
          if (newStr !== null) params.newString = newStr;
        }
        return { tool, params };
      }

      // v10.32-fix: Detect tool JSON blocks in code blocks and raw response for non-Kimi providers.
      const detectedTools = [];
      function tryParseToolJson(text) {
        if (!text || text.length < 10) return null;
        if (!text.includes('"tool"')) return null;
        // v11.0-fix: Helper that tries strict JSON, then jsonrepair for malformed LLM output.
        function tolerantParse(raw) {
          try {
            return JSON.parse(raw);
          } catch {}
          try {
            const repaired = jsonrepair(raw);
            if (repaired && repaired !== raw) return JSON.parse(repaired);
          } catch {}
          return null;
        }
        // First try the whole text directly (strict or repaired).
        const parsed = tolerantParse(text);
        if (parsed) {
          if (parsed && typeof parsed.tool === 'string' && parsed.params && typeof parsed.params === 'object') {
            return { tool: parsed.tool, params: parsed.params };
          }
          if (parsed && typeof parsed.tool === 'string' && (parsed.path || parsed.command || parsed.script || parsed.query)) {
            return { tool: parsed.tool, params: parsed };
          }
        }
        // v10.35-fix: If direct parse fails, try extracting the first complete JSON object.
        const completeObj = extractFirstCompleteJsonObject(text);
        if (completeObj && completeObj !== text) {
          const parsed2 = tolerantParse(completeObj);
          if (parsed2 && typeof parsed2.tool === 'string' && parsed2.params && typeof parsed2.params === 'object') {
            return { tool: parsed2.tool, params: parsed2.params };
          }
        }
        // v11.1-fix: Last resort for file-write tools with raw HTML/JS content.
        const writeFileFallback = extractWriteFileFallback(text);
        if (writeFileFallback) {
          log.warn(`[tryParseToolJson] Used writeFile fallback for malformed JSON (tool=${writeFileFallback.tool}, path=${writeFileFallback.params.path})`);
          return writeFileFallback;
        }
        return null;
      }
      for (const block of raw.codeBlocks || []) {
        // Strip DeepSeek code-block artifacts before parsing.
        let cleaned = block.replace(/^json\s*[\r\n]+/i, '').trim();
        cleaned = cleaned.replace(/^Copy\s+Download\s*[\r\n]+/i, '').trim();
        const toolAction = tryParseToolJson(cleaned);
        if (toolAction) detectedTools.push(toolAction);
      }
      // Also scan the raw response itself for any JSON tool object.
      const responseTool = tryParseToolJson(response);
      if (responseTool) detectedTools.push(responseTool);

      return { response: response.trim(), detectedTools, source: 'generic-provider', raw: (raw.response || '').substring(0, 200) };
    } catch (e) {
      return { response: '', detectedTools: [], source: 'generic-provider-error' };
    }
  }

  /**
   * Detect the actual mode currently selected in the Kimi UI or page URL
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
  async _waitForResponse(page, mode = 'instant', onPartial = null, initialText = '', targetAssistantIndex = -1) {
    log.info('[DEBUG-LUNA] _waitForResponse started');
    // NO TIMEOUT — Kimi may execute Python for 10+ minutes. That's valid activity.
    // We wait until buttons appear + text is stable, forever.

    // v7.6-fix: Helper to get text from target assistant or last markdown
    const getCurrentText = async () => {
      if (targetAssistantIndex >= 0) {
        return await page.evaluate((idx) => {
          const assistants = document.querySelectorAll('.segment-assistant');
          if (idx >= assistants.length) return '';
          const assistant = assistants[idx];
          const markdown = assistant.querySelector('.markdown-container .markdown');
          return markdown ? (markdown.innerText || '').trim() : '';
        }, targetAssistantIndex).catch(() => '');
      }
      // v10.18-fix: Use finite timeout — landing page has no markdown yet.
      return await page.locator('.markdown-container .markdown').last().innerText({ timeout: 2000 }).catch(() => '');
    };

    // Phase 0: Wait for text to CHANGE from initialText — this ensures we don't
    // detect the previous response as "done" when buttons are still visible.
    log.info(`Waiting for new response text to appear${targetAssistantIndex >= 0 ? ` (assistant ${targetAssistantIndex})` : ''}...`);
    let textHasChanged = false;
    const changeStart = Date.now();
    while (true) {
      try {
        const currentText = await getCurrentText();
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
    const MAX_POLL_TIME = 999999999; // [DONO ABSOLUTO] sem limite de poll

    while (true) {
      // Safety: don't poll forever
      if (Date.now() - pollStartTime > MAX_POLL_TIME) {
        log.warn(`_waitForResponse: absolute timeout reached (${MAX_POLL_TIME}ms), returning lastText`);
        return lastText;
      }
      try {
        const currentText = await getCurrentText();

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
              log.info('[DEBUG-LUNA] _waitForResponse finished successfully');
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
    log.info('[DEBUG-LUNA] _waitForResponse finished (fallback)');
    return lastText;
  }

  /**
   * Set Kimi mode for a user's page.
   * For 'instant'/'thinking': clicks the Kimi mode selector.
   */
  async setMode(userId, mode, providerArg = null) {
    const provider = this._resolveProvider(userId, providerArg);
    const page = await this._getOrCreateUserPage(userId, provider);
    const session = this.userSessions.get(userId);
    session.provider = provider;

    // Instant / Thinking modes: use the Kimi mode selector dropdown (Kimi only)
    if (provider !== 'kimi') {
      session.mode = mode;
      this.store.setUser(userId, { mode, provider });
      this._log(`Mode ${mode} stored for provider ${provider} (no UI switch available)`);
      return mode;
    }

    const kimiMode = mode === 'instant' ? 'instant' : 'thinking';
    const currentLabel = await page.locator('.chat-editor-action .model-name').textContent({ timeout: 3000 }).catch(() => '');
    const targetLabel = kimiMode === 'instant' ? 'K2.6 Instant' : 'K2.6 Thinking';

    if (currentLabel.includes(targetLabel)) {
      this._log(`Already in ${mode} mode`);
      session.mode = mode;
      this.store.setUser(userId, { mode, provider });
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
      this.store.setUser(userId, { mode, provider });
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
   * @param {Object} [opts] - options
   * @param {boolean} [opts.requireChatUrl=true] - If false, allows returning the
   *   provider's "new chat" landing page URL. The real chat URL will be captured
   *   after the first message is sent. Used by context compaction.
   */
  async newChat(userId, providerArg = null, opts = {}) {
    const { requireChatUrl = true } = opts;
    const provider = this._resolveProvider(userId, providerArg);
    const providerDomain = this._providerDomain(provider);
    const newChatUrl = this._modeUrl(provider, 'instant');

    const page = await this._getOrCreateUserPage(userId, provider);
    const session = this.userSessions.get(userId);
    session.provider = provider;

    // Clear any stale chatUrl before creating a new thread.
    this._clearChatUrl(userId);

    // v3.7-fix: Ensure interceptor is active on reused pages
    await this._injectStreamInterceptorEvaluate(page);

    // Reset stream interceptor state to prevent cross-message contamination
    await page.evaluate(() => {
      if (window.__lunaResetStream) {
        window.__lunaResetStream();
      } else if (window.__lunaStream) {
        // v3.7-fix: Must reset to empty ARRAYS, not strings, or .push() breaks
        window.__lunaStream.reasoning = [];
        window.__lunaStream.content = [];
        window.__lunaStream.events = [];
        window.__lunaStream.active = false;
        window.__lunaStream.error = null;
      }
    });

    const oldUrl = page.url();
    const context = page.context();
    const pagesBefore = new Set(context.pages());
    log.info(`Creating new chat for user ${hashUserId(userId)} provider=${provider} (current: ${oldUrl}, pages=${pagesBefore.size})`);

    // v10.36-fix: Open a new chat via the provider UI button when possible.
    // This keeps the same tab/context/cookies and avoids landing-page reloads
    // that can drop login state.
    const openedUrl = await this._openNewChat(page, provider);
    await page.waitForTimeout(1000);

    // Find any new page that opened in the same context (some providers open a tab)
    let newPage = null;
    const pagesAfter = context.pages();
    for (const p of pagesAfter) {
      if (!pagesBefore.has(p)) {
        let url = '';
        try { url = p.url(); } catch (e) { url = ''; }
        log.info(`newChat detected new tab: ${url}`);
        if (url.includes('/chat/') || url.includes(providerDomain)) {
          newPage = p;
          break;
        }
      }
    }

    if (newPage) {
      // Migrate to the new tab
      try {
        if (!page.isClosed()) await page.close();
        log.info(`Closed stale tab for user ${hashUserId(userId)}`);
      } catch (e) {
        log.warn(`Failed to close stale tab: ${e.message}`);
      }
      session.page = newPage;
      newPage._lunaUserId = userId;
      newPage._lunaProvider = provider;

      // v10.36-fix: Close any other leftover landing-page tabs.
      await this._closeStaleProviderTabs(context, newPage, provider);
    }

    let newUrl = newPage ? newPage.url() : openedUrl;

    // v5.3-fix: Post-navigation verification — aguardar URL válida com paciência
    const isValidChatUrl = (url) => (provider === 'kimi' ? url.includes('/chat/') : url.includes(providerDomain));
    if (!isValidChatUrl(newUrl)) {
      log.warn(`newChat: URL ainda não é chat válido (${newUrl}), aguardando...`);
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        newUrl = session.page.url();
        if (isValidChatUrl(newUrl)) break;
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // v5.3-fix: Inject stream interceptor na página atual (evaluate) + futuras (addInitScript)
    // ISSO é a correção crítica: sem _injectStreamInterceptorEvaluate, o agente não captura
    // as respostas da API na aba atual e fica "dormindo" para sempre.
    await this._injectStreamInterceptor(session.page);           // addInitScript — para futuras navs
    await this._injectStreamInterceptorEvaluate(session.page);   // evaluate — para página ATUAL (CRÍTICO!)
    await this._injectDomObserverEvaluate(session.page);
    await this._injectEventQueueObserver(session.page);          // v8.5: ultra-light observer para tempo real

    // v3.4: Verify we actually got a new chat URL
    const chatIdOld = oldUrl.includes('/chat/') ? oldUrl.split('/chat/')[1].split('?')[0] : null;
    const chatIdNew = newUrl.includes('/chat/') ? newUrl.split('/chat/')[1].split('?')[0] : null;
    if (chatIdOld && chatIdNew && chatIdOld === chatIdNew) {
      log.warn(`Still on same chat ID after newChat ( ${chatIdOld} ). URL did not change properly.`);
    }

    // v10.28-fix: For context compaction we may land on the provider's "new chat"
    // landing page. The real /chat/<id> URL only appears after the first message
    // is sent. Allow the caller to opt-in to this intermediate state.
    // v10.38-fix: Normalize URLs before comparison so trailing slashes or
    // reordered query params do not reject a valid landing page.
    const isNewChatLanding = isSameLandingPage(newUrl, newChatUrl);
    if (!isValidChatUrl(newUrl) && (!isNewChatLanding || requireChatUrl)) {
      log.error(`newChat failed for user ${hashUserId(userId)}: URL is not a valid chat (${newUrl}).`);
      throw new Error(`NEW_CHAT_FAILED: Não foi possível criar uma nova thread válida em ${provider} (URL: ${newUrl})`);
    }

    // Step 6: Mark chat with user identifier
    try {
      await session.page.evaluate((uid) => {
        const titleEl = document.querySelector('[class*="chat-title"], [class*="title"], h1, .chat-header-title');
        if (titleEl && !titleEl.textContent.includes(uid)) {
          titleEl.textContent = `[${uid}] ${titleEl.textContent}`;
        }
        document.body.dataset.lunaUserId = uid;
      }, hashUserId(userId));
      log.info(`Marked chat with user identifier: ${hashUserId(userId)}`);
    } catch (e) {
      log.warn(`Failed to mark chat with user ID: ${e.message}`);
    }

    // Update session (session.page was already migrated to the new tab above)
    session.chatUrl = newUrl;
    this._saveChatUrl(userId, newUrl, { provider });

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
  async sendImage(userId, imageBase64, text = '', options = {}, provider = 'kimi') {
    if (!imageBase64 || !imageBase64.trim()) {
      throw new Error('Image base64 is required');
    }

    // Rate limiting
    this._checkCooldown(userId);

    const resolvedProvider = this._resolveProvider(userId, provider);
    const page = await this._getOrCreateUserPage(userId, resolvedProvider);
    const session = this.userSessions.get(userId);
    session.provider = resolvedProvider;

    if (session.processing) {
      log.warn(`User ${hashUserId(userId)} is already processing — queueing image upload`);
      // v8.4: NO TIMEOUT — wait forever for previous message to finish.
      while (session.processing) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    session.processing = true;
    session.lastActivity = Date.now();

    try {
      await this._verifySession(page);

      if (options.newChat) {
        const openedUrl = await this._openNewChat(page, resolvedProvider);
        if (session) {
          session.chatUrl = openedUrl;
          this._saveChatUrl(userId, session.chatUrl, { provider: resolvedProvider });
        }
      }

      // v10.39-fix: Keep image uploads in the correct Luna-linked chat thread.
      if (!options.newChat && session?.chatUrl) {
        const currentUrl = page.url();
        const expectedId = session.chatUrl.split('?')[0].split('/').pop();
        if (expectedId && !currentUrl.includes(expectedId)) {
          log.info(`[sendImage] URL mismatch for ${hashUserId(userId)}: current=${currentUrl}, expected=${session.chatUrl} — navigating to correct chat`);
          await page.goto(session.chatUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
          await page.waitForTimeout(1500);
        }
      }

      if (options.mode) {
        await this.setMode(userId, options.mode, resolvedProvider);
      }

      const actualMode = await this._detectActualMode(page) || session?.mode || 'instant';
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
        // W7-T4: Lexical-safe fill — fill() desyncs the React/Lexical
        // EditorState (visible text, Enter becomes a no-op).
        await this._fillContentEditable(inputLocator, text);
        await page.waitForTimeout(500);
      }

      // Step 5: Press Enter to send (W7-T4: verify-and-retry)
      const sendLocator = page.locator('textarea, [contenteditable="true"]').first();
      await this._submitWithVerification(page, sendLocator, text, { provider: resolvedProvider });
      log.info(`Image (+text) sent for user ${hashUserId(userId)}`);

      // Step 6: Wait for response
      const lastText = await this._waitForResponse(page, actualMode, options.onPartialResponse || null);
      let response = await this._extractResponse(page, { userId });

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
      // W7-T4: Lexical-safe clear (fill('') leaves desynced text in the box).
      try {
        await this._fillContentEditable(page.locator('textarea, [contenteditable="true"]').first(), '');
      } catch {}
      throw err;
    } finally {
      session.processing = false;
      session.lastActivity = Date.now();
    }
  }

  /**
   * Send a generic file (txt, pdf, etc.) to Kimi Web.
   * v5.3: Generalized from sendImage — supports any file type.
   *
   * @param {string} userId
   * @param {string|Buffer} fileData — base64 string (with/without data URI) or Buffer
   * @param {string} fileName — e.g. 'message.txt', 'doc.pdf'
   * @param {string} text — optional accompanying text
   * @param {object} options
   */
  async sendFile(userId, fileData, fileName, text = '', options = {}, provider = 'kimi') {
    if (!fileData) {
      throw new Error('File data is required');
    }

    // Rate limiting
    this._checkCooldown(userId);

    const resolvedProvider = this._resolveProvider(userId, provider);

    // v5.6: Try WebBridge FIRST (PRIMARY), Playwright as fallback
    if (this.webbridgeHealthy) {
      try {
        log.info(`[sendFile] Using WebBridge PRIMARY for user ${hashUserId(userId)} provider=${resolvedProvider}`);
        const result = await this._sendFileViaWebBridge(userId, fileData, fileName, text, options, resolvedProvider);
        if (result && result.success) {
          log.success(`[sendFile] WebBridge succeeded for user ${hashUserId(userId)}`);
          return result;
        }
      } catch (wbErr) {
        log.warn(`[sendFile] WebBridge failed: ${wbErr.message} — falling back to Playwright CDP`);
      }
    }

    const page = await this._getOrCreateUserPage(userId, resolvedProvider);
    const session = this.userSessions.get(userId);
    session.provider = resolvedProvider;

    if (session.processing) {
      log.warn(`User ${hashUserId(userId)} already processing — queueing file upload`);
      // v8.4: NO TIMEOUT — wait forever for previous message to finish.
      while (session.processing) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    session.processing = true;
    session.lastActivity = Date.now();

    try {
      await this._verifySession(page);

      if (options.newChat) {
        const openedUrl = await this._openNewChat(page, resolvedProvider);
        if (session) {
          session.chatUrl = openedUrl;
          this._saveChatUrl(userId, session.chatUrl, { provider: resolvedProvider });
        }
      }

      // v10.39-fix: Keep file uploads in the correct Luna-linked chat thread.
      if (!options.newChat && session?.chatUrl) {
        const currentUrl = page.url();
        const expectedId = session.chatUrl.split('?')[0].split('/').pop();
        if (expectedId && !currentUrl.includes(expectedId)) {
          log.info(`[sendFile] URL mismatch for ${hashUserId(userId)}: current=${currentUrl}, expected=${session.chatUrl} — navigating to correct chat`);
          await page.goto(session.chatUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
          await page.waitForTimeout(1500);
        }
      }

      if (options.mode) {
        await this.setMode(userId, options.mode, resolvedProvider);
      }

      const actualMode = await this._detectActualMode(page) || session?.mode || 'instant';
      log.info(`User ${hashUserId(userId)} sending file ${fileName} (text=${text ? 'yes' : 'no'}, mode=${actualMode})`);

      await page.bringToFront();

      // Step 1: Save file data to temp file
      const tmpDir = path.join(ARTIFACTS_DIR, 'tmp-uploads');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      const ext = path.extname(fileName) || '.txt';
      const tmpFile = path.join(tmpDir, `kimi-upload-${hashUserId(userId)}-${Date.now()}${ext}`);

      let buffer;
      if (Buffer.isBuffer(fileData)) {
        buffer = fileData;
      } else if (typeof fileData === 'string' && fileData.includes('base64')) {
        // Strip data URI prefix if present
        const base64 = fileData.replace(/^data:[^;]+;base64,/, '');
        buffer = Buffer.from(base64, 'base64');
      } else if (typeof fileData === 'string') {
        buffer = Buffer.from(fileData, 'utf8');
      } else {
        throw new Error('Unsupported fileData type');
      }
      fs.writeFileSync(tmpFile, buffer);
      log.info(`File saved to temp file: ${tmpFile} (${buffer.length} bytes)`);

      // Helper: check if login modal appeared mid-operation and recover
      // v5.7-fix: When login is recovered, check if file is still in input.
      // The user reported that file stays in the field during login modal.
      const checkAndRecoverLogin = async (stepName) => {
        // First check — modal may appear temporarily during file processing
        let hasLoginModal = await page.evaluate(() => {
          return !!(
            document.querySelector('form[action*="login"], form[action*="auth"]') ||
            document.querySelector('input[type="password"]') ||
            document.querySelector('.login-modal, [class*="login-modal"], [class*="auth-modal"]')
          );
        }).catch(() => false);
        
        if (!hasLoginModal) return false;
        
        // Modal detected — wait a moment, it might disappear on its own (session refresh)
        log.warn(`[sendFile] Login modal detected after ${stepName} — waiting to see if it resolves...`);
        await page.waitForTimeout(5000);
        
        // Check again
        hasLoginModal = await page.evaluate(() => {
          return !!(
            document.querySelector('form[action*="login"], form[action*="auth"]') ||
            document.querySelector('input[type="password"]') ||
            document.querySelector('.login-modal, [class*="login-modal"], [class*="auth-modal"]')
          );
        }).catch(() => false);
        
        if (!hasLoginModal) {
          log.info(`[sendFile] Login modal resolved itself after ${stepName} — continuing`);
          return false;
        }
        
        // Modal persisted — attempt auto-login
        log.warn(`[sendFile] Login modal persisted after ${stepName} — attempting auto-login...`);
        const recovered = await this._autoLogin(page, page._lunaUserId);
        if (!recovered) {
          throw new Error('KIMI_LOGIN_REQUIRED');
        }
        log.success(`[sendFile] Auto-login recovered after ${stepName}`);
        
        // v5.7-fix: Check if file is still in the input after login recovery.
        // _autoLogin does NOT reload the page, so the file should still be there.
        const fileStillThere = await page.evaluate(() => {
          const input = document.querySelector('.hidden-input') || document.querySelector('input[type="file"]');
          return !!(input && (input.files?.length > 0 || input.value));
        }).catch(() => false);
        
        if (fileStillThere) {
          log.info(`[sendFile] File still in input after login recovery — continuing without restart`);
          return false; // Continue normally, file is still there
        }
        
        log.warn(`[sendFile] File lost from input after login recovery — will restart upload`);
        return 'RESTART_UPLOAD';
      };

      // v5.7-fix: Upload with login-recovery loop.
      // If login modal appears and file is lost, restart upload from scratch.
      let uploadAttempt = 0;
      const maxUploadAttempts = 2;
      let needRestart = false;

      while (uploadAttempt < maxUploadAttempts) {
        uploadAttempt++;
        needRestart = false;

        // Step 2: Open toolkit and use native file input
        const toolkitBtn = page.locator('.toolkit-trigger-btn').first();
        const hasToolkit = await toolkitBtn.count() > 0;

        if (hasToolkit) {
          await toolkitBtn.click();
          await page.waitForTimeout(500);
        }
        const toolkitResult = await checkAndRecoverLogin('toolkit click');
        if (toolkitResult === 'RESTART_UPLOAD') { needRestart = true; continue; }

        // Use the native hidden input
        const fileInput = page.locator('.hidden-input, input[type="file"]').first();
        await fileInput.setInputFiles(tmpFile);
        log.info(`File input populated via native input: ${tmpFile}`);
        const inputResult = await checkAndRecoverLogin('file input');
        if (inputResult === 'RESTART_UPLOAD') { needRestart = true; continue; }

        // Step 3: Trigger change event
        await page.evaluate(() => {
          const input = document.querySelector('.hidden-input') || document.querySelector('input[type="file"]');
          if (input) {
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
        });

        // Wait for file to be processed by Kimi UI
        log.info('Waiting for file upload to be processed by Kimi...');
        await page.waitForTimeout(2000);
        const processingResult = await checkAndRecoverLogin('file processing');
        if (processingResult === 'RESTART_UPLOAD') { needRestart = true; continue; }

        // If we got here without restart, break the loop
        break;
      }

      if (needRestart && uploadAttempt >= maxUploadAttempts) {
        throw new Error('Upload failed: login recovery caused file loss and max attempts reached');
      }

      // Step 4: Send optional text
      if (text && text.trim()) {
        const inputLocator = page.locator('textarea, [contenteditable="true"]').first();
        // W7-T4: Lexical-safe fill — fill() desyncs the React/Lexical
        // EditorState (visible text, Enter becomes a no-op).
        await this._fillContentEditable(inputLocator, text);
        await page.waitForTimeout(500);
      }

      // Step 5: Press Enter to send (W7-T4: verify-and-retry)
      const sendLocator = page.locator('textarea, [contenteditable="true"]').first();
      await this._submitWithVerification(page, sendLocator, text, { provider: resolvedProvider });
      log.info(`File (+text) sent for user ${hashUserId(userId)}`);
      const sendResult = await checkAndRecoverLogin('send message');
      if (sendResult === 'RESTART_UPLOAD') {
        // If login happened after send, the message may have been sent already.
        // Just continue to wait for response.
        log.info('[sendFile] Login recovered after send — continuing to wait for response');
      }

      // Step 6: Wait for response
      const lastText = await this._waitForResponse(page, actualMode, options.onPartialResponse || null);
      let response = await this._extractResponse(page, { userId });

      if (lastText && lastText.length > 0) {
        const ratio = response.length > 0 ? response.length / lastText.length : 0;
        if (ratio < 0.5 && lastText.length > response.length) {
          log.warn(`sendFile: _extractResponse incomplete (${response.length} vs polled ${lastText.length}), using polled text as fallback`);
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
      // W7-T4: Lexical-safe clear (fill('') leaves desynced text in the box).
      try { await this._fillContentEditable(page.locator('textarea, [contenteditable="true"]').first(), ''); } catch {}
      throw err;
    } finally {
      session.processing = false;
      session.lastActivity = Date.now();
    }
  }

  /**
   * Send a message and wait for response
   */
  // ============================================================
  // v5.6: WebBridge PRIMARY methods
  // ============================================================

  async _sendFileViaWebBridge(userId, fileData, fileName, text = '', options = {}, provider = 'kimi') {
    const wb = new WebBridgeClient(`luna-${hashUserId(userId)}`);
    const providerDomain = this._providerDomain(provider);
    const newChatUrl = this._modeUrl(provider, 'instant');

    // Step 1: Navigate to provider or find existing tab
    const listRes = await wb.listTabs();
    const providerTab = listRes.tabs?.find(t => t.url && t.url.includes(providerDomain));
    if (providerTab) {
      await wb.findTab(providerTab.url);
      log.info(`[WebBridge] Found existing ${provider} tab: ${providerTab.url}`);
    } else {
      await wb.navigate(newChatUrl, true);
      log.info(`[WebBridge] Opened new ${provider} tab`);
    }

    // Step 2: Save file to disk (WebBridge needs file paths)
    const tmpDir = path.join(ARTIFACTS_DIR, 'tmp-uploads');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const ext = path.extname(fileName) || '.txt';
    const tmpFile = path.join(tmpDir, `wb-upload-${hashUserId(userId)}-${Date.now()}${ext}`);

    let buffer;
    if (Buffer.isBuffer(fileData)) {
      buffer = fileData;
    } else if (typeof fileData === 'string' && fileData.includes('base64')) {
      const base64 = fileData.replace(/^data:[^;]+;base64,/, '');
      buffer = Buffer.from(base64, 'base64');
    } else if (typeof fileData === 'string') {
      buffer = Buffer.from(fileData, 'utf8');
    } else {
      throw new Error('Unsupported fileData type');
    }
    fs.writeFileSync(tmpFile, buffer);
    log.info(`[WebBridge] File saved to ${tmpFile} (${buffer.length} bytes)`);

    // Step 3: Use evaluate to reveal file input and set files DIRECTLY
    // This is the MOST RELIABLE method — bypasses accessibility tree entirely
    await this._sleep(1500);
    log.info('[WebBridge] Injecting file into Kimi via DOM evaluate...');
    
    // v5.7-fix: Check for login modal BEFORE attempting upload
    const loginCheck = await wb.evaluate(`
      (() => {
        const hasModal = !!(
          document.querySelector('form[action*="login"], form[action*="auth"]') ||
          document.querySelector('input[type="password"]') ||
          document.querySelector('.login-modal, [class*="login-modal"], [class*="auth-modal"]')
        );
        const loginTexts = ['Continue with Google', 'Google', '使用 Google 登录', 'Google 登录', '使用 Google 帳戶登入', 'Entrar com Google', 'Fazer login com Google'];
        const hasLoginText = loginTexts.some(t => document.body.innerText.includes(t));
        return { hasLoginModal: hasModal || hasLoginText };
      })()
    `);
    if (loginCheck.data?.value?.hasLoginModal) {
      log.warn('[WebBridge] Login modal detected — WebBridge cannot handle login. Falling back to Playwright CDP');
      throw new Error('LOGIN_MODAL_WEBBRIDGE_CANNOT_HANDLE');
    }

    const injectResult = await wb.evaluate(`
      (async () => {
        // Find or create file input
        let input = document.querySelector('input[type="file"]');
        
        // If not found, click toolkit button to reveal it
        if (!input) {
          const toolkitBtn = document.querySelector('.toolkit-trigger-btn, button[class*="toolkit"], [class*="upload"]');
          if (toolkitBtn) {
            toolkitBtn.click();
            await new Promise(r => setTimeout(r, 500));
            input = document.querySelector('input[type="file"]');
          }
        }
        
        if (!input) {
          // Create a hidden file input as last resort
          input = document.createElement('input');
          input.type = 'file';
          input.style.display = 'none';
          document.body.appendChild(input);
        }
        
        // Make sure it's visible and interactive
        input.style.display = 'block';
        input.style.visibility = 'visible';
        input.style.opacity = '1';
        input.style.position = 'fixed';
        input.style.top = '0';
        input.style.left = '0';
        input.style.zIndex = '999999';
        
        return { found: true, hasInput: !!input, tag: input?.tagName };
      })()
    `);
    log.info(`[WebBridge] File input ready: ${JSON.stringify(injectResult.data?.value)}`);

    // Step 4: Upload file using CSS selector (input is now visible)
    await this._sleep(500);
    try {
      await wb.upload("input[type='file']", [tmpFile]);
      log.info(`[WebBridge] Uploaded file via CSS selector`);
    } catch (uploadErr) {
      log.warn(`[WebBridge] Upload API failed: ${uploadErr.message}`);
      throw uploadErr;
    }

    // Step 5: Fill accompanying text using WebBridge fill (supports contenteditable natively)
    if (text && text.trim()) {
      await this._sleep(800);
      try {
        await wb.fill("textarea, [contenteditable='true']", text);
        log.info(`[WebBridge] Filled input with text via fill API`);
      } catch (fillErr) {
        log.warn(`[WebBridge] Fill API failed: ${fillErr.message} — using evaluate fallback`);
        await wb.evaluate(`
          const input = document.querySelector('textarea, [contenteditable="true"]');
          if (input) {
            if (input.isContentEditable) {
              input.focus();
              const sel = window.getSelection();
              const range = document.createRange();
              range.selectNodeContents(input);
              sel.removeAllRanges();
              sel.addRange(range);
              document.execCommand('insertText', false, ${JSON.stringify(text)});
            } else {
              const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
              setter.call(input, ${JSON.stringify(text)});
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        `);
      }
    }

    // v6.1-fix: Capture the last response text BEFORE sending, so we can
    // distinguish between the previous response and the new one.
    const initialRes = await wb.evaluate(`
      const containers = document.querySelectorAll('.markdown-container .markdown, .segment-assistant, [class*="assistant"]');
      const last = containers[containers.length - 1];
      return last ? last.innerText : '';
    `);
    const initialText = initialRes.data?.value || '';
    log.info(`[WebBridge] Captured initial text (${initialText.length} chars) before sending`);

    // Step 6: Send message — click send button or press Enter
    await this._sleep(500);
    try {
      const sendResult = await wb.evaluate(`
        (() => {
          // Strategy 1: Find send button by SVG icon or aria-label
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
          const input = document.querySelector('textarea, [contenteditable="true"]');
          if (input) {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
            return { method: 'enter-key' };
          }
          
          return { method: 'none', error: 'No send mechanism found' };
        })()
      `);
      log.info(`[WebBridge] Sent message via: ${JSON.stringify(sendResult.data?.value)}`);
    } catch (e) {
      log.warn(`[WebBridge] Send failed: ${e.message}`);
    }

    // Step 7: Poll for response using evaluate (most reliable)
    log.info('[WebBridge] Waiting for response...');
    let response = '';
    let lastText = '';
    let stableFor = 0;
    const pollInterval = 1000;
    const maxWait = Number.MAX_SAFE_INTEGER;
    const startTime = Date.now();

    log.info('[DEBUG-LUNA] _waitForResponse started (no timeout)');
    while (Date.now() - startTime < maxWait) {
      await this._sleep(pollInterval);

      const evalRes = await wb.evaluate(`
        const containers = document.querySelectorAll('.markdown-container .markdown, .segment-assistant, [class*="assistant"]');
        const last = containers[containers.length - 1];
        return last ? last.innerText : '';
      `);
      const currentText = evalRes.data?.value || '';

      // v6.1-fix: Ignore text that matches the initial (pre-send) response.
      // This prevents the previous response from being detected as the new one.
      if (currentText && currentText === initialText) {
        continue;
      }

      if (currentText && currentText !== lastText) {
        lastText = currentText;
        stableFor = 0;
      } else {
        stableFor += pollInterval;
      }

      // Check for completion: copy/regenerate buttons visible
      const doneCheck = await wb.evaluate(`
        const btn = document.querySelector('.segment-assistant-actions button, [class*="copy"], [class*="regenerate"]');
        return !!btn;
      `);
      const hasDoneButton = doneCheck.data?.value === true;

      if (hasDoneButton && stableFor > 3000 && currentText.length > 10) {
        response = currentText;
        break;
      }
      if (stableFor > 20000 && currentText.length > 10) {
        response = currentText;
        break;
      }
    }

    // Cleanup
    try { fs.unlinkSync(tmpFile); } catch {}

    return {
      success: true,
      response: response || lastText,
      chatUrl: this._modeUrl(provider, 'instant'),
      mode: options.mode || 'instant',
      provider,
    };
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * v10.18-fix: Dispatch native Enter key events to submit the Kimi input.
   * Playwright's press('Enter') does not trigger the Lexical editor's submit
   * handler on Kimi's landing page; native KeyboardEvent does.
   */
  async _pressEnterOnInput(inputLocator) {
    try {
      const el = await inputLocator.elementHandle();
      if (el) {
        await el.evaluate((node) => {
          for (const type of ['keydown', 'keypress', 'keyup']) {
            node.dispatchEvent(new KeyboardEvent(type, {
              key: 'Enter',
              code: 'Enter',
              keyCode: 13,
              which: 13,
              bubbles: true,
              cancelable: true,
              composed: true,
            }));
          }
        });
        return;
      }
    } catch (e) {
      log.warn(`_pressEnterOnInput dispatch failed: ${e.message}`);
    }
    // Fallback to Playwright's press if element handle is unavailable
    await inputLocator.press('Enter');
  }

  /**
   * v10.35-fix: Fill a contenteditable/Lexical editor reliably.
   * Playwright's fill() does not register in React/Lexical contenteditable
   * on Kimi's landing/agent page. We use document.execCommand('insertText')
   * inside the focused editor, which Lexical observes correctly.
   */
  async _fillContentEditable(inputLocator, text) {
    await inputLocator.evaluate((el) => el.focus());
    await inputLocator.evaluate((el) => {
      // Select all and delete first
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    });
    await inputLocator.evaluate((el, txt) => {
      document.execCommand('insertText', false, txt);
      // Dispatch input events so React/Lexical state updates and send button enables
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: txt }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, text);
  }

  /**
   * W7-T4: Submit the typed message and VERIFY it actually left the input.
   * Kimi's Lexical editor can silently swallow the synthetic Enter (text
   * visible in the DOM but an empty/desynced EditorState) — the message then
   * sits in the box until the user presses Enter manually. Strategy chain,
   * one per attempt, with a ~10s verification poll after each:
   *   1. synthetic KeyboardEvent Enter (_pressEnterOnInput);
   *   2. Lexical-safe re-fill + TRUSTED Enter (Playwright click + keyboard);
   *   3. click the .send-button-container (same selector the steer uses).
   * Verification only fires on TRANSITIONS measured against a pre-submit
   * baseline — never on pre-existing DOM state: the input clearing after it
   * was OBSERVED holding the typed text, the assistant-segment count
   * increasing, the stop (generating) button appearing, or the send button
   * flipping to disabled. Throws SEND_NOT_CONFIRMED when all attempts fail
   * so the turn errors visibly instead of hanging silently (Wave 6 contract).
   */
  async _submitWithVerification(page, inputLocator, text, options = {}) {
    const prefix = (text || '').slice(0, 100);
    // Whitespace-normalized comparison: contenteditable innerText can render
    // whitespace differently from the inserted string (collapsed runs, NBSP).
    const normPrefix = prefix.replace(/\s+/g, ' ').trim();
    const readInput = async () => {
      if (!normPrefix) return '';
      const current = await inputLocator.inputValue().catch(() =>
        inputLocator.evaluate((el) => el.innerText || el.textContent || '').catch(() => '')
      );
      return (current || '').replace(/\s+/g, ' ').trim();
    };
    const readState = () => page.evaluate(() => {
      const assistants = document.querySelectorAll('.segment-assistant').length;
      const sendBtn = document.querySelector('.send-button-container');
      const sendDisabled = sendBtn
        ? (sendBtn.classList.contains('disabled') || sendBtn.getAttribute('aria-disabled') === 'true')
        : false;
      const generating = !!document.querySelector('.stop-button-container');
      return { assistants, sendDisabled, generating };
    }).catch(() => null);

    // Pre-submit baseline. Only CHANGES relative to this state confirm the
    // submit — a stop button left over from a previous turn or a send button
    // disabled on an empty input must not count as success.
    const baseline = await readState() || { assistants: 0, sendDisabled: false, generating: false };
    // Sticky: true once the box is OBSERVED holding the typed text. An input
    // clear only proves the send if the text was there before — otherwise a
    // silent fill failure would look exactly like a successful submit.
    let inputHeldPrefix = normPrefix ? (await readInput()).includes(normPrefix) : false;
    if (normPrefix && !inputHeldPrefix) {
      log.warn('[_submitWithVerification] typed text not visible in the input at baseline — pre-submit fill may have failed');
    }
    const strategies = ['synthetic-enter', 'trusted-enter', 'send-button-click'];

    for (let attempt = 0; attempt < strategies.length; attempt++) {
      const strategy = strategies[attempt];
      try {
        if (strategy === 'synthetic-enter') {
          await this._pressEnterOnInput(inputLocator);
        } else if (strategy === 'trusted-enter') {
          // The first Enter may have hit a desynced Lexical state — re-fill so
          // the EditorState actually holds the text, then send a TRUSTED Enter
          // via a real Playwright click + keyboard press.
          await this._fillContentEditable(inputLocator, text || '');
          if (normPrefix && !inputHeldPrefix) {
            // Read the box back: only trust the re-fill if the text stuck.
            inputHeldPrefix = (await readInput()).includes(normPrefix);
            if (!inputHeldPrefix) {
              log.warn('[_submitWithVerification] re-fill did not stick — input still missing the typed text');
            }
          }
          await page.waitForTimeout(300);
          await inputLocator.click({ timeout: 5000 }).catch(() => inputLocator.evaluate((el) => el.focus()));
          await page.keyboard.press('Enter');
        } else {
          const sendBtn = page.locator('.send-button-container').first();
          if (await sendBtn.count() > 0) {
            await sendBtn.click({ timeout: 5000 });
          } else {
            log.warn('[_submitWithVerification] .send-button-container not found — click strategy skipped');
          }
        }
      } catch (e) {
        log.warn(`[_submitWithVerification] strategy '${strategy}' threw: ${e.message}`);
      }

      // Empty-text sends (image/file without caption) have no input-text
      // signal; delivery is verified downstream by the response wait.
      if (!normPrefix) {
        log.info(`[_submitWithVerification] empty-text submit via '${strategy}' (attempt ${attempt + 1}) — no input signal to verify`);
        return { confirmed: true, strategy, weak: true };
      }

      // Verify the submit: poll ~10s for a transition vs the baseline.
      const verifyDeadline = Date.now() + 10_000;
      while (Date.now() < verifyDeadline) {
        const current = await readInput();
        if (current.includes(normPrefix)) inputHeldPrefix = true;
        const inputCleared = inputHeldPrefix && !current.includes(normPrefix);
        const state = await readState();

        if (inputCleared
          || (state && state.assistants > baseline.assistants)
          || (state && !baseline.generating && state.generating)
          || (state && !baseline.sendDisabled && state.sendDisabled)) {
          log.info(`[_submitWithVerification] submit confirmed via '${strategy}' (attempt ${attempt + 1})`);
          return { confirmed: true, strategy };
        }
        await page.waitForTimeout(300);
      }
      log.warn(`[_submitWithVerification] attempt ${attempt + 1} ('${strategy}') NOT confirmed — no submit transition observed`);
    }

    throw new Error('SEND_NOT_CONFIRMED: texto permanece no input da Kimi — a mensagem digitada não foi enviada após 3 tentativas (Enter sintético, Enter confiável, clique no botão de enviar)');
  }

  async sendMessage(userId, text, options = {}, provider = 'kimi') {
    if (!text || !text.trim()) {
      throw new Error('Message text is required');
    }

    // Rate limiting
    this._checkCooldown(userId);

    const resolvedProvider = this._resolveProvider(userId, provider);
    const providerDomain = this._providerDomain(resolvedProvider);
    const page = await this._getOrCreateUserPage(userId, resolvedProvider);

    // Reset stream interceptor state to prevent cross-message contamination
    await page.evaluate(() => {
      if (window.__lunaResetStream) {
        window.__lunaResetStream();
      } else if (window.__lunaStream) {
        // Fallback for pages created before the update
        // v3.7-fix: Must reset to empty ARRAYS, not strings, or .push() breaks
        window.__lunaStream.reasoning = [];
        window.__lunaStream.content = [];
        window.__lunaStream.events = [];
        window.__lunaStream.active = false;
        window.__lunaStream.error = null;
      }
    });
    const session = this.userSessions.get(userId);
    session.provider = resolvedProvider;

    // Cooldown check: wait for current processing to finish
    if (session.processing) {
      log.warn(`User ${hashUserId(userId)} is already processing — queueing`);
      // v8.4: NO TIMEOUT — wait forever for previous message to finish.
      while (session.processing) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    session.processing = true;
    session.lastActivity = Date.now();

    // v7.6-fix: Reset network interceptor to prevent stale data from previous messages
    const interceptor = await this._getOrCreateInterceptor(userId);
    if (interceptor) interceptor.reset();

    try {
      // Verify session
      await this._verifySession(page);

      // Handle newChat option
      if (options.newChat) {
        const pageContext = page.context();
        const pagesBefore = new Set(pageContext.pages());
        const openedUrl = await this._openNewChat(page, resolvedProvider);

        // v10.36-fix: Kimi sometimes opens the new chat in a new tab.
        const pagesAfter = pageContext.pages();
        for (const p of pagesAfter) {
          if (!pagesBefore.has(p) && !p.isClosed()) {
            let url = '';
            try { url = p.url(); } catch (e) { url = ''; }
            log.info(`[sendMessage] detected new tab: ${url}`);
            if (url.includes('/chat/') || url.includes('kimi.com')) {
              try { if (!page.isClosed()) await page.close(); } catch (e) {}
              session.page = p;
              p._lunaUserId = userId;
              p._lunaProvider = resolvedProvider;
              page = p;
              break;
            }
          }
        }

        session.chatUrl = page.url();
        this._saveChatUrl(userId, session.chatUrl, { provider: resolvedProvider });

        // v10.36-fix: Close leftover landing-page tabs so the user does not see
        // a deslogada page after the new chat opens in a new tab.
        await this._closeStaleProviderTabs(pageContext, page, resolvedProvider);
      }

      // v3.4: Verify we're on the correct chat URL. If newChat was used or
      // the page was redirected, ensure we navigate to the right conversation.
      const currentUrl = page.url();
      if (session.chatUrl && !currentUrl.includes(session.chatUrl.split('?')[0].split('/').pop())) {
        log.info(`URL mismatch: current=${currentUrl}, expected=${session.chatUrl} — navigating to correct chat`);
        await page.goto(session.chatUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
        await page.waitForTimeout(1500);
      }

      // Set mode if specified (clicks the dropdown for instant/thinking)
      if (options.mode) {
        await this.setMode(userId, options.mode, resolvedProvider);
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
      // v10.18-fix: Use a finite timeout. On Kimi's landing page there is no
      // .markdown-container yet; timeout: 0 hangs forever waiting for one.
      const initialText = await page.locator('.markdown-container .markdown').last().innerText({ timeout: 2000 }).catch(() => '');

      // v10.35-fix: Use Lexical-safe fill helper for Kimi contenteditable editor.
      await this._fillContentEditable(inputLocator, text);
      await page.waitForTimeout(500 + Math.floor(Math.random() * 1000));

      // v7.7-INFALÍVEL: Capture full snapshot before sending
      const preSendSnapshot = await this._capturePreSendSnapshot(page);
      const preSendAssistantCount = preSendSnapshot.length;

      // W7-T4: Press Enter to send with verify-and-retry (typed text must
      // never sit unsent in the Kimi input).
      await this._submitWithVerification(page, inputLocator, text, { provider: resolvedProvider });
      log.info(`Message sent for user ${hashUserId(userId)} (initialText=${initialText.length} chars, snapshot=${preSendAssistantCount} assistants)`);

      // v7.6-fix: Assistant detection for logging/compatibility
      // v10.27-fix: Skip Kimi-specific .segment-assistant detection for non-Kimi providers.
      let targetAssistantIndex = -1;
      if (resolvedProvider === 'kimi') {
        let newAssistantWaitCount = 0;
        while (targetAssistantIndex < 0 && newAssistantWaitCount < 100) { // 10s
          const assistants = await page.evaluate(() => {
            const nodes = document.querySelectorAll('.segment-assistant');
            return Array.from(nodes).map((el, i) => ({
              index: i,
              textLength: el.innerText?.length || 0,
              hasMarkdown: !!el.querySelector('.markdown-container, .markdown'),
            }));
          });
          const currentCount = assistants.length;
          if (currentCount > preSendAssistantCount) {
            const newAssistant = assistants[preSendAssistantCount];
            if (newAssistant && (newAssistant.textLength > 0 || newAssistant.hasMarkdown)) {
              targetAssistantIndex = preSendAssistantCount;
              log.info(`[sendMessage] New assistant detected at index ${targetAssistantIndex}, textLen=${newAssistant.textLength}`);
            }
          }
          await new Promise(r => setTimeout(r, 100));
          newAssistantWaitCount++;
        }
      } else {
        log.info(`[sendMessage] Skipping Kimi assistant detection for provider=${resolvedProvider}`);
      }

      // Wait for response with combined signal + streaming
      const lastText = await this._waitForResponse(page, actualMode, options.onPartialResponse || null, initialText, targetAssistantIndex);

      // v7.7-INFALÍVEL: Extract using snapshot diff (PRIMARY)
      let response = '';
      try {
        const extracted = await this._extractResponseDiff(page, preSendSnapshot);
        if (extracted && extracted.trim().length > 0) {
          response = extracted.trim();
          log.info(`[sendMessage] _extractResponseDiff success: ${response.length} chars`);
        }
      } catch (e) {
        log.warn(`[sendMessage] _extractResponseDiff failed: ${e.message}`);
      }

      // Fallback: old extraction strategy
      if (!response) {
        const extractOptions = targetAssistantIndex >= 0
          ? { preferAssistantIndex: targetAssistantIndex, userId }
          : { userId };
        response = await this._extractResponse(page, extractOptions);
      }

      // CRITICAL: _extractResponse can return incomplete text. Fallback to polled text.
      if (lastText && lastText.length > 0) {
        const ratio = response.length > 0 ? response.length / lastText.length : 0;
        if (ratio < 0.5 && lastText.length > response.length) {
          log.warn(`sendMessage: extraction incomplete (${response.length} vs polled ${lastText.length}), using polled text as fallback`);
          response = lastText;
        }
      }

      // Update chat URL
      session.chatUrl = page.url();
      this._saveChatUrl(userId, session.chatUrl);

      log.success(`Response ready for user ${hashUserId(userId)} (len=${response.length})`);

      // v10.41-fix: Surface context-limit flag so the Telegram pipeline can
      // decide whether to start a fresh chat. Prevents throwing away context
      // on every turn when newChat is false by default.
      const isContextLimit = this._isContextLimitResponse(response);
      if (isContextLimit) {
        log.warn(`[sendMessage] Context limit detected for user ${hashUserId(userId)}`);
      }

      return {
        response,
        chatUrl: session.chatUrl,
        mode: session.mode,
        contextLimit: isContextLimit,
      };
    } catch (err) {
      // Try to clear input on error so next message doesn't have leftover text.
      // W7-T4: _fillContentEditable(locator, '') clears the Lexical EditorState
      // for real — fill('') leaves the desynced text in the box.
      try {
        await this._fillContentEditable(page.locator('textarea, [contenteditable="true"]').first(), '');
      } catch {}
      throw err;
    } finally {
      session.processing = false;
      session.lastActivity = Date.now();
    }
  }

  /**
   * Send a message to the provider Web UI without waiting for the full response.
   * Use this for checkpoint messages where we only need delivery confirmation.
   * Returns once the submit is verified (input cleared / assistant segment /
   * generating signal) — W7-T4: up to 3 submit attempts (~10s verification
   * each) plus a 30s belt-and-suspenders delivery poll.
   * @throws SEND_NOT_CONFIRMED if all 3 submit attempts fail; 'Delivery
   *   confirmation timed out' if the post-submit poll sees no transition.
   */
  async sendMessageNoWait(userId, text, options = {}) {
    if (!text || !text.trim()) {
      throw new Error('Message text is required');
    }

    const page = await this._getOrCreateUserPage(userId);
    const session = this.userSessions.get(userId);
    if (!session) {
      throw new Error(`No session for user ${hashUserId(userId)}`);
    }

    this._checkCooldown(userId);

    if (session.processing) {
      log.warn(`User ${hashUserId(userId)} is already processing — queueing no-wait message`);
      while (session.processing) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    session.processing = true;

    try {
      session.lastActivity = Date.now();
      await this._verifySession(page);

      if (options.mode) {
        await this.setMode(userId, options.mode);
      }

      const inputLocator = page.locator('textarea, [contenteditable="true"]').first();
      const inputCount = await inputLocator.count();
      if (inputCount === 0) {
        throw new Error('Input field not found on provider page');
      }

      await page.bringToFront();
      await inputLocator.evaluate((el) => el.focus());
      await page.waitForTimeout(200);

      // v10.38-fix: Use Lexical-safe fill helper so the editor state updates
      // and the send button enables correctly on Kimi's contenteditable input.
      await this._fillContentEditable(inputLocator, text);
      await page.waitForTimeout(500);

      // W7-T4: verify-and-retry submit (Enter → trusted Enter → send-button
      // click). The 30s delivery poll below is belt-and-suspenders and
      // confirms immediately once the submit transition is visible.
      const preSubmitAssistants = await page.evaluate(() => document.querySelectorAll('.segment-assistant').length).catch(() => 0);
      await this._submitWithVerification(page, inputLocator, text);
      log.info(`[sendMessageNoWait] Submitted message for user ${hashUserId(userId)}`);

      // Delivery poll: input cleared, a new assistant segment, or the stop
      // (generating) button — the same transitions the submit helper accepts,
      // so a confirmed send can never time out here just because the input
      // visually retained the text.
      let confirmed = false;
      const deliveryDeadline = Date.now() + 30000;
      while (Date.now() < deliveryDeadline) {
        let inputCleared = false;
        try {
          const currentValue = await inputLocator.inputValue().catch(async () => {
            return await inputLocator.evaluate((el) => el.innerText || el.textContent || '');
          });
          inputCleared = !currentValue || !currentValue.includes(text.slice(0, 100));
        } catch (e) {
          // ignore transient read errors
        }
        const state = await page.evaluate((base) => ({
          assistantsGrew: document.querySelectorAll('.segment-assistant').length > base,
          generating: !!document.querySelector('.stop-button-container'),
        }), preSubmitAssistants).catch(() => null);
        if (inputCleared || (state && (state.assistantsGrew || state.generating))) {
          confirmed = true;
          log.info(`[sendMessageNoWait] Delivery confirmed for user ${hashUserId(userId)}`);
          break;
        }
        await page.waitForTimeout(300);
      }

      if (!confirmed) {
        throw new Error('Delivery confirmation timed out');
      }

      session.chatUrl = page.url();
      this._saveChatUrl(userId, session.chatUrl);

      return { sent: true, chatUrl: session.chatUrl, mode: session.mode };
    } catch (err) {
      // W7-T4: Lexical-safe clear (fill('') leaves desynced text in the box).
      try {
        await this._fillContentEditable(page.locator('textarea, [contenteditable="true"]').first(), '');
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
   * v11.0: Discover a CDP endpoint for the user's real Chrome.
   * Chrome 144+ can expose one via chrome://inspect/#remote-debugging
   * (writes DevToolsActivePort). Older Chrome needs --remote-debugging-port.
   */
  _discoverUserChromeCdp() {
    const fs = require('fs');
    const path = require('path');
    const http = require('http');

    // 1) Chrome 144+ DevToolsActivePort file
    if (fs.existsSync(USER_CHROME_DEVTOOLS_PORT_FILE)) {
      try {
        const lines = fs.readFileSync(USER_CHROME_DEVTOOLS_PORT_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
        if (lines.length >= 2) {
          const port = parseInt(lines[0], 10);
          const wsPath = lines[1];
          if (port > 0 && wsPath) {
            return { port, wsPath, source: 'DevToolsActivePort' };
          }
        }
      } catch (e) { /* ignore */ }
    }

    // 2) Fallback: check if user's Chrome was launched with --remote-debugging-port
    try {
      const { execSync } = require('child_process');
      const ps = execSync("ps aux | grep -E '/opt/google/chrome/chrome|/usr/bin/google-chrome' | grep -v grep", { encoding: 'utf8' });
      const m = ps.match(/--remote-debugging-port=(\d+)/);
      if (m) {
        const port = parseInt(m[1], 10);
        return { port, wsPath: null, source: 'process' };
      }
    } catch (e) { /* ignore */ }

    return null;
  }

  /**
   * v11.0: Modify the user's Chrome .desktop launcher to always include
   * --remote-debugging-port, then gracefully restart Chrome so Luna can attach
   * to the user's real profile and reuse real login sessions.
   */
  async _enableUserChromeRemoteDebugging() {
    const fs = require('fs');
    const path = require('path');
    const { execSync, spawn } = require('child_process');
    const os = require('os');

    const flag = '--remote-debugging-port=9222';

    // Patch the first writable .desktop file we find
    let patchedFile = null;
    for (const desktopPath of USER_CHROME_DESKTOP_FILES) {
      if (!fs.existsSync(desktopPath)) continue;
      try {
        let content = fs.readFileSync(desktopPath, 'utf8');
        if (content.includes(flag)) { patchedFile = desktopPath; break; }
        // Add flag right after the chrome binary in Exec= lines
        const original = content;
        content = content.replace(
          /(Exec=\S*google-chrome(?:-stable)?\b)(\s+%U)?/g,
          `$1 ${flag}$2`
        );
        content = content.replace(
          /(Exec=\S*chrome(?:-stable)?\b)(\s+--app-id|\s+--incognito|\s+%U)?/g,
          `$1 ${flag}$2`
        );
        if (content !== original) {
          fs.writeFileSync(desktopPath, content, 'utf8');
          patchedFile = desktopPath;
          log.info(`Patched Chrome launcher for CDP: ${desktopPath}`);
          break;
        }
      } catch (e) {
        log.warn(`Could not patch ${desktopPath}: ${e.message}`);
      }
    }

    // Find the Chrome binary
    let chromePath = null;
    for (const cmd of USER_CHROME_CMD_CANDIDATES) {
      if (cmd.startsWith('/')) {
        if (fs.existsSync(cmd)) { chromePath = cmd; break; }
      } else {
        try { chromePath = execSync(`which ${cmd}`, { stdio: 'ignore', encoding: 'utf8' }).trim(); break; } catch {}
      }
    }
    if (!chromePath) {
      log.warn('Could not find Chrome binary to restart with CDP');
      return false;
    }

    // Gracefully close user's Chrome processes (except any already-debuggable one)
    const isUserChrome = (cmdline) => {
      return cmdline.includes('/opt/google/chrome/chrome') || cmdline.includes('/usr/bin/google-chrome');
    };

    try {
      const ps = execSync('ps aux', { encoding: 'utf8' });
      const pids = ps.split('\n')
        .filter(line => isUserChrome(line) && !line.includes('remote-debugging-port'))
        .map(line => parseInt(line.trim().split(/\s+/)[1], 10))
        .filter(n => n && !isNaN(n));

      if (pids.length === 0) {
        // Nothing to restart; launch a fresh user-Chrome with CDP
        try {
          const proc = spawn(chromePath, [flag, '--restore-last-session'], { detached: true, stdio: 'ignore', env: process.env });
          proc.unref();
          await new Promise(r => setTimeout(r, 3000));
          return true;
        } catch (e) {
          log.warn(`Failed to launch user Chrome with CDP: ${e.message}`);
          return false;
        }
      }

      log.info(`Requesting graceful shutdown of ${pids.length} user Chrome process(es) to enable CDP...`);
      for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }

      // Wait up to 12s for processes to exit
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const still = execSync('ps aux', { encoding: 'utf8' })
            .split('\n')
            .filter(line => isUserChrome(line) && !line.includes('remote-debugging-port'));
          if (still.length === 0) break;
        } catch {}
      }

      // Last resort: SIGKILL anything still running
      try {
        const still = execSync('ps aux', { encoding: 'utf8' })
          .split('\n')
          .filter(line => isUserChrome(line) && !line.includes('remote-debugging-port'))
          .map(line => parseInt(line.trim().split(/\s+/)[1], 10))
          .filter(n => n && !isNaN(n));
        for (const pid of still) {
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
      } catch {}

      await new Promise(r => setTimeout(r, 1000));

      // Restart user's Chrome with CDP and session restore
      const proc = spawn(chromePath, [flag, '--restore-last-session'], { detached: true, stdio: 'ignore', env: process.env });
      proc.unref();
      log.info(`Restarted user Chrome with CDP (pid ${proc.pid})`);
      await new Promise(r => setTimeout(r, 4000));
      return true;
    } catch (e) {
      log.warn(`Error enabling user Chrome remote debugging: ${e.message}`);
      return false;
    }
  }

  /**
   * Ensure the Luna Chrome profile directory exists. We use a single isolated
   * directory for the CDP browser so the user can log in once inside it and
   * the session (cookies, localStorage, tokens) persists across restarts.
   * v11.0: Stop cloning the user's main profile — it invalidates device-bound
   * session tokens. Instead the user logs in directly inside Luna's Chrome.
   */
  _ensureChromeProfile() {
    // v11.1: Always use the kernel's own directory for the Chrome profile.
    // This guarantees the profile travels with the kernel installation and
    // survives restarts regardless of what LUNA_HOME/LUNA_DIR points to.
    const lunaProfile = path.join(__dirname, 'chrome-profile');
    if (!fs.existsSync(lunaProfile)) {
      fs.mkdirSync(lunaProfile, { recursive: true });
    }
    return lunaProfile;
  }

  /**
   * Check if Chrome/Chromium is running with CDP and start if needed.
   * v11.0: Best practice is to attach to the user's REAL Chrome profile via CDP
   * (Chrome 144+ remote-debugging toggle, or --remote-debugging-port). This
   * reuses the user's live login sessions without copying profiles. If that is
   * unavailable we fall back to the Luna-isolated profile copied from the user.
   */
  async checkChrome() {
    const { execSync, spawn } = require('child_process');
    const http = require('http');
    const os = require('os');
    const net = require('net');

    const probePort = (port) => new Promise((resolve) => {
      const req = http.get(`${makeCdpUrl(port)}/json/version`, (res) => {
        resolve(res.statusCode === 200 ? port : 0);
      });
      req.on('error', () => resolve(0));
      req.setTimeout(2000, () => { req.destroy(); resolve(0); });
    });

    const isPortOccupied = (port) => new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(true));
      s.once('listening', () => { s.close(() => resolve(false)); });
      s.listen(port, '127.0.0.1');
    });

    // v11.0: Use Luna's isolated persistent profile. The user will log in
    // directly inside this Chrome instance once, and the session will persist
    // across Luna restarts because we always reuse the same user-data-dir.
    const profileDir = this._ensureChromeProfile();

    // Phase 1: Scan for an existing Luna Chrome with CDP on our ports
    for (const port of CDP_PORTS) {
      const ok = await probePort(port);
      if (!ok) continue;
      try {
        const psOutput = execSync(`ps aux | grep -E 'chrom(?:e|ium).*remote-debugging-port=${port}' | grep -v grep`, { encoding: 'utf8' });
        const dataDirMatch = psOutput.match(/--user-data-dir=([^\s]+)/);
        const existingProfileDir = dataDirMatch ? dataDirMatch[1] : null;

        if (psOutput.includes('--headless') || psOutput.includes('--ozone-platform=headless')) {
          log.warn(`Headless Chrome detected on port ${port}. Killing...`);
          execSync(`pkill -f 'chrom.*remote-debugging-port=${port}'`);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }

        if (existingProfileDir && existingProfileDir.startsWith('/tmp/')) {
          log.warn(`Chrome on port ${port} is using a temporary profile ${existingProfileDir}. Killing...`);
          execSync(`pkill -f 'chrom.*remote-debugging-port=${port}'`);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }

        this.cdpUrl = makeCdpUrl(port);
        log.info(`Reusing existing CDP Chrome on port ${port} (profile: ${existingProfileDir || 'default'})`);
        return { running: true, started: false, wasHeadless: false, port };
      } catch {
        this.cdpUrl = makeCdpUrl(port);
        return { running: true, started: false, wasHeadless: false, port };
      }
    }

    // Phase 2: Find a free CDP port
    let startPort = CDP_PORTS[0];
    for (const port of CDP_PORTS) {
      const occupied = await isPortOccupied(port);
      if (!occupied) { startPort = port; break; }
    }

    // Phase 3: Start visible Chrome/Chromium with the Luna profile (synced from user)
    const chromeCmds = [
      '/opt/google/chrome/google-chrome',
      '/opt/google/chrome/chrome',
      '/usr/local/bin/google-chrome-stable',
      '/usr/local/bin/google-chrome',
      '/usr/local/bin/chromium',
      '/usr/local/bin/chromium-browser',
      'google-chrome-stable',
      'google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      'chromium',
      'chromium-browser',
    ];
    let chromePath = null;
    for (const cmd of chromeCmds) {
      if (cmd.startsWith('/')) {
        if (fs.existsSync(cmd)) { chromePath = cmd; break; }
      } else {
        try { chromePath = execSync(`which ${cmd}`, { stdio: 'ignore', encoding: 'utf8' }).trim(); break; } catch {}
      }
    }
    if (!chromePath) {
      return { running: false, started: false, error: 'Chrome/Chromium não encontrado. Instale google-chrome-stable ou chromium.' };
    }

    try {
      log.info(`Starting ${chromePath} with Luna profile (synced from user): ${profileDir}`);

      const extensionPath = path.join(__dirname, 'luna-extension');
      const extensionArgs = [];
      if (fs.existsSync(extensionPath) && fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
        extensionArgs.push('--load-extension=' + extensionPath);
      }

      const isRoot = process.getuid && process.getuid() === 0;
      const proc = spawn(chromePath, [
        `--remote-debugging-port=${startPort}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--user-data-dir=' + profileDir,
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        ...(isRoot ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
        ...extensionArgs,
        this._modeUrl(this.defaultProvider || 'kimi', 'instant'),
      ], { detached: true, stdio: 'ignore', env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } });
      proc.unref();

      proc.on('error', (err) => log.warn(`[checkChrome] Chrome process error: ${err.message}`));
      proc.on('exit', (code, signal) => {
        if (code !== 0 && code !== null) {
          log.warn(`[checkChrome] Chrome process exited with code ${code}, signal ${signal}`);
        }
      });

      // Wait up to 30s for Chrome to open its CDP port
      let ok = false;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await probePort(startPort)) { ok = true; break; }
      }

      if (ok) {
        this.cdpUrl = makeCdpUrl(startPort);
        return { running: true, started: true, pid: proc.pid, profileDir, port: startPort };
      }
      return { running: false, started: true, pid: proc.pid, profileDir, port: startPort, error: 'Chrome iniciou mas não respondeu em 30s' };
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
   * Ensure user is logged into the configured provider. Opens page and brings to front.
   * If not logged in, navigates to provider base URL and starts polling.
   */
  async ensureLogin(userId, providerArg = null) {
    const provider = this._resolveProvider(userId, providerArg);
    const providerCfg = this._loadProviderConfig(provider);
    const loginUrl = providerCfg.baseUrl;

    let page;
    try {
      page = await this._getOrCreateUserPage(userId, provider);
      await page.bringToFront().catch(() => {});
    } catch (e) {
      return { loggedIn: false, error: `Failed to get page: ${e.message}`, action: 'login_required' };
    }

    // Check current state
    const state = await this._checkLoginState(page);
    if (state.loggedIn) {
      return { loggedIn: true, message: `Já está logado em ${providerCfg.displayName}`, url: state.url, provider };
    }

    // Not logged in — navigate to provider base URL and bring to front
    log.info(`User not logged in, navigating to ${provider} login page`);
    try {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
      await page.waitForTimeout(1500);
      await page.bringToFront().catch(() => {});
    } catch (e) {
      log.warn(`Navigation to ${loginUrl} failed: ${e.message}`);
      // Try again with a fresh page
      try {
        const session = this.userSessions.get(userId);
        if (session && session.page && !session.page.isClosed()) {
          await session.page.close().catch(() => {});
          this.userSessions.delete(userId);
          this.semaphore.current = Math.max(0, this.semaphore.current - 1);
        }
        page = await this._getOrCreateUserPage(userId, provider);
        await page.bringToFront().catch(() => {});
      } catch (e2) {
        return { loggedIn: false, error: `Failed to navigate: ${e2.message}`, action: 'login_required' };
      }
    }

    // Quick re-check after navigation
    const state2 = await this._checkLoginState(page);
    if (state2.loggedIn) {
      return { loggedIn: true, message: `Já está logado em ${providerCfg.displayName}`, url: state2.url, provider };
    }

    return {
      loggedIn: false,
      message: `Naveguei para ${loginUrl}. Por favor, faça login manualmente no navegador que abriu.`,
      action: 'login_required',
      url: state2.url,
      provider,
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
   * Save cookies from default context to persistent JSON file
   */
  async _saveCookiesToFile() {
    if (!this.defaultContext) return;
    try {
      const cookies = await this.defaultContext.cookies();
      if (cookies && cookies.length > 0) {
        fs.writeFileSync(COOKIES_BACKUP_PATH, JSON.stringify(cookies, null, 2), 'utf8');
        log.info(`[Cookies] Saved ${cookies.length} cookies to backup file`);
      }
    } catch (e) {
      log.warn(`[Cookies] Failed to save: ${e.message}`);
    }
  }

  /**
   * v10.36-fix: Sync master cookies JSON from the current Chrome profile.
   * This forces the bridge to use the cookies already saved by Chrome instead
   * of stale file backups that can log the user out.
   */
  async _syncMasterCookiesFromContext(providerName = 'kimi') {
    if (!this.defaultContext) return false;
    try {
      const providerCfg = loadProviderConfig(providerName);
      const cookiePaths = getProviderCookies(providerCfg);
      const masterPath = cookiePaths.master;
      const cookies = await this.defaultContext.cookies();
      if (!cookies || cookies.length === 0) {
        log.info(`[_syncMasterCookiesFromContext] No cookies in Chrome profile yet for ${providerName}`);
        return false;
      }
      // Build master file in the expected format
      const providerDomain = providerCfg.domain || '.kimi.com';
      const providerCookies = cookies.filter(c => c.domain.includes(providerDomain.replace(/^\./, '')) || c.domain.endsWith(providerDomain));
      const masterData = {
        savedAt: new Date().toISOString(),
        totalCookies: cookies.length,
        kimiCookies: providerCookies.length,
        cookies,
      };
      fs.mkdirSync(path.dirname(masterPath), { recursive: true });
      fs.writeFileSync(masterPath, JSON.stringify(masterData, null, 2), 'utf8');
      log.info(`[_syncMasterCookiesFromContext] Synced ${cookies.length} cookies (${providerCookies.length} for ${providerName}) from Chrome profile to ${masterPath}`);
      return true;
    } catch (e) {
      log.warn(`[_syncMasterCookiesFromContext] Failed to sync: ${e.message}`);
      return false;
    }
  }

  /**
   * Load cookies from persistent JSON file into a context
   */
  async _loadCookiesFromFile(targetCtx) {
    const sources = [
      { path: COOKIES_BACKUP_PATH, name: 'auto-backup' },
      { path: COOKIES_MANUAL_PATH, name: 'manual' },
    ];
    for (const src of sources) {
      try {
        if (!fs.existsSync(src.path)) continue;
        const raw = fs.readFileSync(src.path, 'utf8');
        const cookies = JSON.parse(raw);
        if (Array.isArray(cookies) && cookies.length > 0) {
          await targetCtx.addCookies(cookies);
          log.info(`[Cookies] Restored ${cookies.length} cookies from ${src.name}`);
          return true;
        }
      } catch (e) {
        log.warn(`[Cookies] Failed to load from ${src.name}: ${e.message}`);
      }
    }
    return false;
  }

  /**
   * Start periodic cookie backup timer
   */
  _startCookieBackup() {
    if (this.cookieBackupTimer) clearInterval(this.cookieBackupTimer);
    this.cookieBackupTimer = setInterval(() => {
      this._saveCookiesToFile().catch(() => {});
    }, 5 * 60 * 1000); // every 5 minutes
    // Also save immediately on start
    this._saveCookiesToFile().catch(() => {});
  }

  /**
   * v5.6-fix: Background polling to keep pages alive and detect new messages.
   * Prevents Chrome mobile from suspending the tab when user switches apps.
   * Polls every 30s: brings page to front and evaluates a no-op to keep alive.
   */
  _startBackgroundPolling() {
    if (this.bgPollTimer) clearInterval(this.bgPollTimer);
    this.bgPollTimer = setInterval(async () => {
      for (const [userId, session] of this.userSessions) {
        if (!session.page || session.page.isClosed()) continue;
        try {
          // v9.5-fix: REMOVED bringToFront() — it was causing command bursts when user
          // returned to the Kimi tab. Chrome already runs with anti-throttling flags:
          // --disable-background-timer-throttling --disable-backgrounding-occluded-windows
          // --disable-renderer-backgrounding. The evaluate no-op is enough to keep alive.
          await session.page.evaluate(() => {
            window.__lunaKeepAlive = Date.now();
            // Small real DOM work that Chrome cannot optimize away
            const el = document.createElement('span');
            el.style.display = 'none';
            el.id = '__luna-keepalive-' + Date.now();
            document.body.appendChild(el);
            setTimeout(() => el.remove(), 100);
          }).catch(() => {});
        } catch (e) {
          // Ignore errors — page may be navigating
        }
      }
    }, 10000); // Every 10 seconds
    log.info('Background polling started (10s interval, no bringToFront)');
  }

  /**
   * Mark a userId as persistent (never close its page due to idle timeout)
   */
  setPersistent(userId) {
    this.persistentUserIds.add(userId);
    log.info(`Persistent mode enabled for user ${hashUserId(userId)}`);
  }

  /**
   * Unmark a userId as persistent
   */
  unsetPersistent(userId) {
    this.persistentUserIds.delete(userId);
    log.info(`Persistent mode disabled for user ${hashUserId(userId)}`);
  }

  /**
   * Start idle cleanup timer — closes inactive pages (skips persistent users)
   */
  _startIdleCleanup() {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const [userId, session] of this.userSessions) {
        if (session.processing) continue;
        // v5.2-fix: Never clean up persistent users
        if (this.persistentUserIds.has(userId)) {
          continue;
        }
        if (KIMI_PERSISTENT_MODE) {
          // In global persistent mode, only clean up if explicitly not persistent
          // and idle for > 30min (double the normal timeout)
          if (now - session.lastActivity > this.idleTimeout * 3) {
            log.info(`Persistent mode: long-idle cleanup for user ${hashUserId(userId)}`);
          } else {
            continue;
          }
        }
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
          // v8.7-fix: NEVER close defaultContext — it's shared across all users.
          // Only isolated contexts should be closed. defaultContext is managed externally.
          const ctx = this.userContexts.get(userId);
          if (ctx && ctx !== this.defaultContext && typeof ctx.close === 'function') {
            ctx.close().catch(e => log.warn(`Idle context close error: ${e.message}`));
            this.userContexts.delete(userId);
            log.info(`Idle cleanup: closed isolated context for user ${hashUserId(userId)}`);
          } else if (ctx === this.defaultContext) {
            this.userContexts.delete(userId);
          }
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
   * v3.7-fix: Inject stream interceptor via page.evaluate after navigation.
   * addInitScript only works for future page loads; this ensures the current
   * page has the interceptor active immediately. Also re-injects on page reuse.
   */
  async _injectStreamInterceptorEvaluate(page) {
    try {
      const alreadyActive = await page.evaluate(() => !!window.__lunaStream);
      if (alreadyActive) return true;

      const scriptPath = path.join(__dirname, 'kimi-bridge-interceptor-toolcalls.js');
      let script = fs.readFileSync(scriptPath, 'utf8');
      script = script.replace(/^\s*\(\s*\)\s*=>\s*\{/, '').trim();
      if (script.endsWith('};')) {
        script = script.slice(0, -2).trim();
      } else if (script.endsWith('}')) {
        script = script.slice(0, -1).trim();
      }
      await page.evaluate(script => eval(script), script);
      log.info('Stream interceptor re-injected via evaluate');
      return true;
    } catch (e) {
      log.warn(`Stream interceptor evaluate injection failed: ${e.message}`);
      return false;
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
        if (window.__lunaSimpleObserver) return true; // Already active

        window.__lunaToolCallSeq = 0;
        window.__lunaSimpleObserver = true;
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
   * v7.0: Inject the MutationObserver-based event queue into the browser.
   * This observer runs independently of the stream and populates window.__lunaEventQueue.
   */
  async _injectEventQueueObserver(page) {
    try {
      // v7.0-ext: Check if Chrome extension already injected the observer
      const hasExtension = await page.evaluate(() => {
        return typeof window.__lunaEventQueue !== 'undefined' && window.__lunaObserverVersion;
      });
      if (hasExtension) {
        log.info(`[v7.0] Chrome extension observer active (v${await page.evaluate(() => window.__lunaObserverVersion)})`);
        return true;
      }

      // Fallback: inject manually (for users without the extension)
      const observerPath = path.join(__dirname, 'kimi-dom-observer.js');
      const observerScript = fs.readFileSync(observerPath, 'utf8');
      await page.addInitScript(observerScript);
      await page.evaluate(observerScript);
      log.info('[v7.0] Event queue observer injected (fallback — consider installing the Chrome extension for 100% reliability)');
      return true;
    } catch (e) {
      log.warn(`[v7.0] Event queue observer injection failed: ${e.message}. Install the Luna Extension for reliable DOM observation.`);
      return false;
    }
  }

  // ============================================================
  // v7.0: DECOUPLED DOM EVENT QUEUE — DOM reader independent from stream
  // ============================================================

  /**
   * v7.5: Initialize or retrieve the KimiNetworkInterceptor for a user.
   * The interceptor uses Playwright's native page.on('response') to capture
   * API responses server-side. This is immune to page anti-tampering.
   */
  async _getOrCreateInterceptor(userId) {
    const session = this.userSessions.get(userId);
    if (!session || !session.page || session.page.isClosed()) return null;

    let interceptor = this.networkInterceptors.get(userId);
    if (!interceptor || interceptor.page !== session.page) {
      // Page changed or interceptor doesn't exist — create new one
      if (interceptor) interceptor.stop();
      interceptor = new ProviderNetworkInterceptor(session.page, this._loadProviderConfig(this.userSessions.get(userId)?.provider || 'kimi'));
      await interceptor.start();
      this.networkInterceptors.set(userId, interceptor);
      log.info(`[KimiNetworkInterceptor] Created for user ${hashUserId(userId)}`);
    }
    return interceptor;
  }

  /**
   * v7.5: Reset the interceptor before sending a new message.
   * Clears accumulated reasoning/content so the next message starts fresh.
   */
  _resetInterceptor(userId) {
    const interceptor = this.networkInterceptors.get(userId);
    if (interceptor) {
      interceptor.reset();
      log.info(`[KimiNetworkInterceptor] Reset for user ${hashUserId(userId)}`);
    }
  }

  /**
   * v8.6: Consume events from Chrome Extension's global buffer.
   * The extension runs in the MAIN world of kimi.com and streams DOM events
   * directly via HTTP to luna-extension-handler.cjs, which buffers them in
   * global.__lunaExtensionEventBuffers. This is Layer 0 — highest priority.
   *
   * Wave2-fix (cross-user event theft): events are filtered by tab URL so a
   * poller only consumes events from ITS OWN page. The extension sessionId
   * has no relation to the luna userId, so draining every buffer let one
   * user's poller steal another user's streamed text/tool events.
   */
  _consumeExtensionEvents(expectedUrl) {
    try {
      const buffers = global.__lunaExtensionEventBuffers;
      if (!buffers || buffers.size === 0) return [];

      // Same chat thread, tolerant of tracking params: strip query, hash,
      // and trailing slashes before comparing.
      const normalizeUrl = (u) => {
        if (!u || typeof u !== 'string') return '';
        return u.split('#')[0].split('?')[0].replace(/\/+$/, '');
      };
      const expected = normalizeUrl(expectedUrl);
      const multiBuffer = buffers.size > 1;
      let loggedNoUrl = false;

      const allEvents = [];
      for (const [sessionId, buf] of buffers) {
        if (!buf || buf.length === 0) continue;
        // Partition: matching events are consumed, the rest STAY in the
        // buffer for the poller that owns their tab.
        const remaining = [];
        for (const raw of buf) {
          const rawUrl = raw.tabUrl || raw.url || '';
          let belongs;
          if (!rawUrl) {
            // No URL info (older extension build): only safe to consume when
            // exactly one buffer exists (single-user dev scenario preserved).
            belongs = !multiBuffer;
            if (!loggedNoUrl) {
              log.debug(`[ChromeExt] Event without url/tabUrl — ${belongs ? 'consuming (single buffer)' : 'skipping (multiple buffers, ownership unknown)'}`);
              loggedNoUrl = true;
            }
          } else {
            belongs = expected !== '' && normalizeUrl(rawUrl) === expected;
          }
          if (!belongs) {
            remaining.push(raw);
            continue;
          }
          // Translate extension event format to bridge internal format
          switch (raw.eventType) {
            case 'stream_state': {
              if (raw.data) {
                allEvents.push({
                  type: 'state_change',
                  thinking: raw.data.thinking || '',
                  response: raw.data.response || '',
                  isStreaming: raw.data.isStreaming ?? true,
                  isComplete: raw.data.isComplete ?? false,
                  timestamp: raw.timestamp || raw.bufferedAt || Date.now(),
                });
              }
              break;
            }
            case 'stream_end': {
              allEvents.push({
                type: 'completion_candidate',
                reason: 'stream_end',
                timestamp: raw.timestamp || raw.bufferedAt || Date.now(),
              });
              break;
            }
            case 'tool_call_detected': {
              if (raw.data && raw.data.tool) {
                allEvents.push({
                  type: 'action_detected',
                  action: { tool: raw.data.tool, params: raw.data.params || {} },
                  source: 'chrome_extension',
                  timestamp: raw.timestamp || raw.bufferedAt || Date.now(),
                });
              }
              break;
            }
            case 'tool_response_detected': {
              if (raw.data && raw.data.response !== undefined) {
                allEvents.push({
                  type: 'response_detected',
                  response: typeof raw.data.response === 'string' ? raw.data.response : JSON.stringify(raw.data.response),
                  source: 'chrome_extension',
                  timestamp: raw.timestamp || raw.bufferedAt || Date.now(),
                });
              }
              break;
            }
            case 'segment_complete': {
              // v8.7-fix: segment_complete is an internal instrumentation event.
              // It must NEVER be translated into a state_change with response text,
              // or it will leak into the chat as raw text. Log internally only.
              if (raw.data) {
                log.debug(`[ChromeExt] segment_complete: ${raw.data.textLength || 0} chars, ${raw.data.toolCallsCount || 0} tools, complete=${raw.data.isComplete}`);
              }
              break;
            }
            case 'json_block_added': {
              if (raw.data && raw.data.actions) {
                for (const action of raw.data.actions) {
                  allEvents.push({
                    type: 'action_detected',
                    action: { tool: action.tool, params: action.params || {} },
                    source: 'chrome_extension',
                    timestamp: raw.timestamp || raw.bufferedAt || Date.now(),
                  });
                }
              }
              if (raw.data && raw.data.responses) {
                for (const resp of raw.data.responses) {
                  allEvents.push({
                    type: 'response_detected',
                    response: typeof resp.response === 'string' ? resp.response : JSON.stringify(resp.response),
                    source: 'chrome_extension',
                    timestamp: raw.timestamp || raw.bufferedAt || Date.now(),
                  });
                }
              }
              break;
            }
            case 'button_state': {
              // Used indirectly — if stop button is not visible and we were streaming,
              // it signals completion. We handle this via stream_end though.
              break;
            }
            default: {
              // Unknown event type — ignore
              break;
            }
          }
        }
        if (remaining.length > 0) buffers.set(sessionId, remaining);
        else buffers.delete(sessionId); // fully drained — drop the empty buffer
      }
      return allEvents;
    } catch (e) {
      return [];
    }
  }

  /**
   * v7.0: Start a persistent DOM poller that runs independently of the stream.
   * This is the core of the decoupled architecture: the DOM is read continuously,
   * and the stream only consumes events from the queue.
   */
  _startDomPoller(userId) {
    const session = this.userSessions.get(userId);
    if (!session || !session.page || session.page.isClosed()) return;
    if (session.domPollerActive) return; // Already running

    session.domPollerActive = true;
    session.domPollerStartTime = Date.now();
    log.info(`[DomPoller] Starting for user ${hashUserId(userId)}`);

    const runLoop = async () => {
      while (session.domPollerActive && session.page && !session.page.isClosed()) {
        try {
          const provider = session.provider || 'kimi';
          // v8.6: LAYER 0 — Chrome Extension events (PRIMARY real-time source)
          // These come directly from the extension's injected.js DOM observer,
          // bypassing all Playwright overhead and network interception fallbacks.
          try {
            // Wave2-fix: pass this poller's page URL so only events from its
            // own tab are consumed (cross-user event theft fix).
            let pageUrl = '';
            try { pageUrl = session.page.url(); } catch (_) { pageUrl = ''; }
            const extEvents = this._consumeExtensionEvents(pageUrl);
            for (const ev of extEvents) {
              // v11.1-fix: DeepSeek's DOM observer emits partial tool_call events while
              // the JSON code block is still streaming. Each mutation yields a different
              // incomplete command, causing duplicate/mid-stream executions. For DeepSeek,
              // rely on generic-provider extraction only after generation is complete.
              if (provider === 'deepseek' && (
                ev.type === 'tool_call' ||
                ev.type === 'json_block_added' ||
                (ev.type === 'action_detected' && ev.source !== 'network_intercept')
              )) {
                continue;
              }
              switch (ev.type) {
                case 'state_change': {
                  this._enqueueDomEvent(userId, {
                    type: 'state_change',
                    thinking: ev.thinking || '',
                    response: ev.response || '',
                    isGenerating: ev.isStreaming ?? true,
                    canSteer: false,
                    source: 'chrome_extension',
                    timestamp: ev.timestamp || Date.now(),
                  });
                  break;
                }
                case 'thinking_delta': {
                  this._enqueueDomEvent(userId, {
                    type: 'thinking_delta',
                    text: ev.text || '',
                    fullThinking: ev.fullThinking || ev.thinking || '',
                    source: 'chrome_extension',
                    timestamp: ev.timestamp || Date.now(),
                  });
                  break;
                }
                case 'response_delta': {
                  this._enqueueDomEvent(userId, {
                    type: 'response_delta',
                    text: ev.text || '',
                    fullResponse: ev.fullResponse || ev.response || '',
                    source: 'chrome_extension',
                    timestamp: ev.timestamp || Date.now(),
                  });
                  break;
                }
                case 'action_detected': {
                  if (ev.action) {
                    this._enqueueDomEvent(userId, {
                      type: 'action_detected',
                      action: ev.action,
                      source: ev.source || 'chrome_extension',
                      timestamp: ev.timestamp || Date.now(),
                    });
                  }
                  break;
                }
                case 'response_detected': {
                  if (ev.response) {
                    this._enqueueDomEvent(userId, {
                      type: 'response_detected',
                      response: typeof ev.response === 'string' ? ev.response : JSON.stringify(ev.response),
                      source: ev.source || 'chrome_extension',
                      timestamp: ev.timestamp || Date.now(),
                    });
                  }
                  break;
                }
                case 'completion_candidate': {
                  this._enqueueDomEvent(userId, {
                    type: 'completion_candidate',
                    reason: ev.reason || 'stream_end',
                    timestamp: ev.timestamp || Date.now(),
                  });
                  break;
                }
              }
            }
          } catch (extErr) {
            // Extension buffer may not exist yet — ignore
          }

          // v7.5: Poll DOM state via _pollThinkingAndResponse (uses Network Interceptor as primary)
          const poll = await this._pollThinkingAndResponse(session.page, userId);

          // v8.0-fix: Emit tool calls detected by network interceptor
          if (poll.toolCalls && poll.toolCalls.length > 0) {
            for (const tc of poll.toolCalls) {
              this._enqueueDomEvent(userId, {
                type: 'action_detected',
                action: { tool: tc.name, params: tc.params || tc.arguments || {} },
                code: tc.raw || JSON.stringify(tc),
                source: 'network_intercept',
                timestamp: Date.now(),
              });
            }
          }

          // v7.0: Only enqueue state events if not skipping non-critical
          if (!session.domPollerSkipNonCritical) {
            log.info(`[DomPoller] enqueue state_change response=${poll.response.length} isGen=${poll.isGenerating}`);
            this._enqueueDomEvent(userId, {
              type: 'state_change',
              thinking: poll.thinking,
              response: poll.response,
              isGenerating: poll.isGenerating,
              canSteer: poll.canSteer,
              source: poll.source,
              timestamp: Date.now(),
            });

            // Detect completion candidate
            this._checkCompletionCandidate(userId, poll);
          }

          // v7.0: SECONDARY — Consume events from browser-side MutationObserver
          try {
            const observerEvents = await session.page.evaluate(() => {
              if (!window.__lunaEventQueue) return [];
              return window.__lunaEventQueue.swap();
            });

            for (const ev of observerEvents) {
              // Translate observer events to internal format
              switch (ev.type) {
                case 'tool_call': {
                  if (ev.data && ev.data.tool) {
                    this._enqueueDomEvent(userId, {
                      type: 'action_detected',
                      action: { tool: ev.data.tool, params: ev.data.params || {} },
                      source: 'json_block',
                      timestamp: ev.ts || Date.now(),
                    });
                  }
                  break;
                }
                case 'tool_response': {
                  if (ev.data && ev.data.response) {
                    this._enqueueDomEvent(userId, {
                      type: 'response_detected',
                      response: typeof ev.data.response === 'string' ? ev.data.response : JSON.stringify(ev.data.response),
                      source: 'json_block',
                      timestamp: ev.ts || Date.now(),
                    });
                  }
                  break;
                }
                case 'json_block_added': {
                  if (ev.data && ev.data.actions) {
                    for (const action of ev.data.actions) {
                      this._enqueueDomEvent(userId, {
                        type: 'action_detected',
                        action: { tool: action.tool, params: action.params },
                        source: 'json_block',
                        timestamp: ev.ts || Date.now(),
                      });
                    }
                  }
                  if (ev.data && ev.data.responses) {
                    for (const resp of ev.data.responses) {
                      this._enqueueDomEvent(userId, {
                        type: 'response_detected',
                        response: typeof resp.response === 'string' ? resp.response : JSON.stringify(resp.response),
                        source: 'json_block',
                        timestamp: ev.ts || Date.now(),
                      });
                    }
                  }
                  break;
                }
                // v7.0-ext: Chrome extension emits these directly
                case 'action_detected': {
                  if (ev.action) {
                    this._enqueueDomEvent(userId, {
                      type: 'action_detected',
                      action: ev.action,
                      source: ev.source || 'json_block',
                      timestamp: ev.timestamp || Date.now(),
                    });
                  }
                  break;
                }
                case 'response_detected': {
                  if (ev.response) {
                    this._enqueueDomEvent(userId, {
                      type: 'response_detected',
                      response: typeof ev.response === 'string' ? ev.response : JSON.stringify(ev.response),
                      source: ev.source || 'json_block',
                      timestamp: ev.timestamp || Date.now(),
                    });
                  }
                  break;
                }
                // v8.5-fix: Ultra-light observer emits thinking_delta and response_delta
                case 'thinking_delta': {
                  if (ev.data && ev.data.text) {
                    this._enqueueDomEvent(userId, {
                      type: 'thinking_delta',
                      text: ev.data.text,
                      fullThinking: ev.data.fullThinking || '',
                      source: 'dom_observer',
                      timestamp: ev.ts || Date.now(),
                    });
                  }
                  break;
                }
                case 'response_delta': {
                  if (ev.data && ev.data.text) {
                    this._enqueueDomEvent(userId, {
                      type: 'response_delta',
                      text: ev.data.text,
                      fullResponse: ev.data.fullResponse || '',
                      source: 'dom_observer',
                      timestamp: ev.ts || Date.now(),
                    });
                  }
                  break;
                }
                case 'stream_end': {
                  this._enqueueDomEvent(userId, {
                    type: 'completion_candidate',
                    reason: 'stream_end',
                    timestamp: ev.ts || Date.now(),
                  });
                  break;
                }
                case 'tool_container': {
                  if (ev.data && ev.data.preview) {
                    this._enqueueDomEvent(userId, {
                      type: 'action_detected',
                      action: { tool: 'executeShell', params: { command: ev.data.preview } },
                      code: ev.data.preview,
                      source: 'dom_mirror',
                      timestamp: ev.ts || Date.now(),
                    });
                  }
                  break;
                }
              }
            }
          } catch (e) {
            // Observer not available — fallback to direct DOM extraction
            // v11.1-fix: For DeepSeek, skip DOM tool extraction fallbacks because the
            // code blocks are still mutating while streaming and produce partial tools.
            if (provider !== 'deepseek') {
              try {
                const jsonBlocks = await this._extractJsonBlocksFromDOM(session.page, session?._turnAssistantMarker);
                for (const action of jsonBlocks.actions) {
                  this._enqueueDomEvent(userId, { type: 'action_detected', action, source: 'json_block', timestamp: Date.now() });
                }
                for (const resp of jsonBlocks.responses) {
                  this._enqueueDomEvent(userId, { type: 'response_detected', response: resp.response, source: 'json_block', timestamp: Date.now() });
                }
              } catch (e2) {}
              try {
                const toolBlocks = await this._extractToolMirrorFromDOM(session.page);
                for (const block of toolBlocks) {
                  this._enqueueDomEvent(userId, { type: 'action_detected', action: this._convertIpythonToAction(block), code: block.code, kimiResult: block.result, kimiImages: block.images, source: 'dom_mirror', timestamp: Date.now() });
                }
              } catch (e2) {}
            }
          }
        } catch (e) {
          log.warn(`[DomPoller] Error for user ${hashUserId(userId)}: ${e.message}`);
        }

        // Poll interval: relaxed when processing to avoid freezing Kimi page
        // v8.5-fix: 400ms → 1500ms during processing — DOM evaluate was competing with React main thread
        const interval = session.processing ? 1500 : 3000;
        await new Promise(r => setTimeout(r, interval));
      }

      session.domPollerActive = false;
      if (session._domPollerStoppedResolve) {
        session._domPollerStoppedResolve();
        session._domPollerStoppedResolve = null;
      }
      log.info(`[DomPoller] Stopped for user ${hashUserId(userId)}`);
    };

    runLoop().catch(e => {
      log.error(`[DomPoller] Fatal error for user ${hashUserId(userId)}: ${e.message}`);
      session.domPollerActive = false;
      if (session._domPollerStoppedResolve) {
        session._domPollerStoppedResolve();
        session._domPollerStoppedResolve = null;
      }
    });
  }

  /**
   * v7.0: Stop the DOM poller for a user. Returns a Promise that resolves when stopped.
   */
  async _stopDomPoller(userId) {
    log.info(`[DEBUG-LUNA] _stopDomPoller called for user ${hashUserId(userId)}`);
    const session = this.userSessions.get(userId);
    if (!session || !session.domPollerActive) return;

    const wasActive = session.domPollerActive;
    session.domPollerActive = false;
    log.info(`[DomPoller] Stop requested for user ${hashUserId(userId)}`);

    // Wait for the poller loop to actually exit
    if (wasActive) {
      await new Promise(resolve => {
        session._domPollerStoppedResolve = resolve;
        // Safety: resolve after 2s even if poller didn't stop
        setTimeout(resolve, 2000);
      });
    }
    log.info(`[DEBUG-LUNA] _stopDomPoller finished for user ${hashUserId(userId)}`);
  }

  /**
   * v7.0: Enqueue a DOM event for a user.
   */
  _enqueueDomEvent(userId, event) {
    let queue = this.domEventQueues.get(userId);
    if (!queue) {
      // v7.0-fix: Auto-create queue if poller runs before sendMessageStream
      queue = { events: [], lastReadIndex: 0, createdAt: Date.now(), queueId: `auto-${Date.now()}` };
      this.domEventQueues.set(userId, queue);
    }
    // W6-T6: cross-turn dedup for phantom-prone content events. Per-stream dedup
    // sets are recreated every loop turn, but the DOM still shows the PREVIOUS
    // turn's last assistant segment, so some detectors can re-emit its tool JSON
    // as new actions. A stable content hash (same logical event, different
    // timestamp) catches those re-emissions. Scoped to action_detected/
    // response_detected only: state_change/deltas are handled by per-source
    // cursors, and completion_candidate has no content (constant key) —
    // deduping it would break completion on every later turn.
    // Cleared on real user sends (sendMessageStream, !options.isAutoContinue).
    // Entries expire after SEEN_TTL_MS WITHOUT refresh: phantoms are re-emitted
    // seconds after the original (next turn's poll start), so they stay dropped
    // across consecutive turns, while a legitimate identical re-issue in a later
    // loop turn (e.g. re-run `npm test` after a fix — the soul's policy is
    // one replay then re-execute for real) is only suppressed inside this window.
    if (event.type === 'action_detected' || event.type === 'response_detected') {
      const session = this.userSessions.get(userId);
      if (session) {
        const SEEN_TTL_MS = 120 * 1000;
        if (!session._domEventSeen) session._domEventSeen = new Map();
        const seen = session._domEventSeen;
        const key = event.type + ':' + crypto.createHash('sha256')
          .update(JSON.stringify({ t: event.type, a: event.action, r: event.response, c: event.code }))
          .digest('hex').slice(0, 16);
        const now = Date.now();
        const seenAt = seen.get(key);
        if (seenAt !== undefined && now - seenAt < SEEN_TTL_MS) return; // phantom re-detection — drop
        if (seen.has(key)) seen.delete(key); // keep FIFO order honest on re-insert
        if (seen.size >= 500) seen.delete(seen.keys().next().value); // FIFO eviction
        seen.set(key, now);
      }
    }
    queue.events.push(event);
    // Circular buffer: trim to max 2000 events
    if (queue.events.length > 2000) {
      queue.events = queue.events.slice(-2000);
    }
  }

  /**
   * v7.0: Check for completion candidate based on DOM state.
   * Uses signal voting for robustness.
   */
  _checkCompletionCandidate(userId, poll) {
    const session = this.userSessions.get(userId);
    if (!session) return;

    const now = Date.now();
    const text = (poll.thinking || '') + (poll.response || '');

    // Initialize tracking
    if (!session._completionState) {
      session._completionState = {
        lastText: '',
        textStableSince: 0,
        lastIsGenerating: false,
        generatingStoppedAt: 0,
        signals: { buttonSend: 0, noGeneratingFlag: 0, textStable: 0, networkIdle: 0 },
      };
    }
    const cs = session._completionState;

    // Signal 1: Text stability
    if (text !== cs.lastText) {
      cs.textStableSince = 0;
      cs.signals.textStable = 0;
    } else if (cs.textStableSince === 0) {
      cs.textStableSince = now;
    }
    const textStableFor = cs.textStableSince ? now - cs.textStableSince : 0;
    if (textStableFor > 1500) cs.signals.textStable = 2;
    else if (textStableFor > 500) cs.signals.textStable = 1;

    // Signal 2: Generation stopped
    if (!poll.isGenerating && cs.lastIsGenerating) {
      cs.generatingStoppedAt = now;
    }
    const generatingStoppedFor = cs.generatingStoppedAt ? now - cs.generatingStoppedAt : 0;
    if (!poll.isGenerating) {
      cs.signals.noGeneratingFlag = generatingStoppedFor > 1000 ? 2 : 1;
    } else {
      cs.signals.noGeneratingFlag = 0;
      cs.generatingStoppedAt = 0;
    }

    // Signal 3: Button state (send visible = completion)
    cs.signals.buttonSend = poll.canSteer ? 2 : 0;

    // Signal 4: Network idle (inferred from no text changes + not generating)
    if (!poll.isGenerating && textStableFor > 3000) {
      cs.signals.networkIdle = 2;
    } else {
      cs.signals.networkIdle = 0;
    }

    cs.lastText = text;
    cs.lastIsGenerating = poll.isGenerating;

    // Vote: require sum >= 4 for completion, sustained for 800ms
    const totalSignal = cs.signals.textStable + cs.signals.noGeneratingFlag + cs.signals.buttonSend + cs.signals.networkIdle;
    if (totalSignal >= 4) {
      if (!cs.candidateSince) cs.candidateSince = now;
      else if (now - cs.candidateSince > 800) {
        // Emit completion candidate
        this._enqueueDomEvent(userId, {
          type: 'completion_candidate',
          signals: { ...cs.signals },
          timestamp: now,
        });
        cs.candidateSince = 0; // Reset to avoid duplicate
      }
    } else {
      cs.candidateSince = 0;
    }
  }

  /**
   * v3.9-fix: Inject master localStorage data into page.
   * Kimi uses localStorage tokens (access_token, refresh_token) in addition
   * to cookies. Without these, the page appears logged-out even with cookies.
   */
  async _injectMasterLocalStorage(page, provider = 'kimi') {
    try {
      const providerCfg = this._loadProviderConfig(provider);
      const cookiePaths = getProviderCookies(providerCfg);
      const masterPath = cookiePaths.localStorage;
      if (!fs.existsSync(masterPath)) {
        log.warn(`No master localStorage file found for provider ${provider}`);
        return false;
      }
      const masterData = JSON.parse(fs.readFileSync(masterPath, 'utf8'));
      const data = masterData.data || masterData.localStorage || masterData || {};
      const keys = Object.keys(data);
      if (keys.length === 0) {
        log.warn(`Master localStorage file is empty for provider ${provider}`);
        return false;
      }
      await page.evaluate((items) => {
        for (const [key, value] of Object.entries(items)) {
          try { localStorage.setItem(key, value); } catch (e) {}
        }
      }, data);
      log.info(`Injected ${keys.length} localStorage items into page for provider ${provider}`);
      return true;
    } catch (e) {
      log.warn(`Failed to inject master localStorage for provider ${provider}: ${e.message}`);
      return false;
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
  async _pollThinkingAndResponse(page, userId = null) {
    // v3.6-fix: NO TIMEOUT — if page.evaluate() hangs, we wait. The user explicitly
    // requested no timeouts anywhere in the agent. Kimi may take 10+ minutes for
    // sandbox tools (python, web_search, browser). We wait patiently.
    const pollWithTimeout = async () => {
    const provider = page._lunaProvider || this.defaultProvider || 'kimi';
    try {
      // Wave 2 Fix A: hoist session lookup to the top of the try block so the
      // shared empty-extraction tail can reference it for the Kimi provider too
      // (it was previously declared only inside the generic-provider block,
      // making the empty-wait branch throw ReferenceError for provider='kimi').
      const session = userId ? this.userSessions.get(userId) : null;

      // v7.5: Layer 1 — Native Playwright Network Interceptor (PRIMARY)
      // This replaces fragile JavaScript injection with server-side response capture.
      // Immune to page anti-tampering, SPA navigation, or React resets.
      let networkData = null;
      if (userId) {
        const interceptor = this.networkInterceptors.get(userId);
        if (interceptor) {
          networkData = interceptor.getData();
          if (networkData.hasData) {
            const { canSteer, isGenerating } = await this._detectUiState(page, provider);
            log.info(`[_poll] network-intercept: thinking=${networkData.thinking.length}, response=${networkData.response.length}, source=${networkData.source}`);
            return { ...networkData, canSteer, isGenerating };
          }
        }
      }

      // v7.5: Layer 1b — Legacy JS-injected stream interceptor (DEPRECATED, will be removed)
      // Kept briefly as transitional fallback while Network Interceptor stabilizes.
      const intercepted = await page.evaluate(() => {
        const s = window.__lunaStream;
        if (s && s.active) {
          const thinking = Array.isArray(s.reasoning) ? s.reasoning.join('') : (s.reasoning || '');
          const response = Array.isArray(s.content) ? s.content.join('') : (s.content || '');
          return {
            thinking,
            response,
            source: 'intercept-legacy',
            hasData: thinking.length > 0 || response.length > 0,
            active: s.active,
            contentLen: s.content?.length || 0,
            reasoningLen: s.reasoning?.length || 0,
          };
        }
        return null;
      });
      if (intercepted && intercepted.hasData) {
        const { canSteer, isGenerating } = await this._detectUiState(page, provider);
        log.info(`[_poll] interceptor-legacy: thinking=${intercepted.thinking.length}, response=${intercepted.response.length}`);
        return { ...intercepted, canSteer, isGenerating };
      }

      // Layer 2.5: DOM structure-based extraction (most reliable for Kimi Web v2026-05)
      // Supports TWO DOM structures:
      //   OLD: .segment-content-box > .container-block > .block-item > ...
      //   NEW: .segment-content-box > .markdown-container > .markdown > .segment-code
      // v10.0-fix: Filter out tool JSON code blocks from response text to prevent
      // tool JSON from leaking into the chat. Detected tools are returned separately
      // and enqueued as action_detected events by the caller.
      // W6-T6: when the session has a pre-send assistant marker, only scan
      // assistant segments at index >= marker — the previous turn's last segment
      // is still in the DOM and must not be re-detected. null marker => scan
      // everything, exactly as before (non-Kimi providers, no active send).
      const turnAssistantMarker = (session && typeof session._turnAssistantMarker === 'number') ? session._turnAssistantMarker : null;
      const structureBased = await page.evaluate((assistantMarker) => {
        const assistants = document.querySelectorAll('.segment-assistant');
        const scoped = typeof assistantMarker === 'number' ? Array.from(assistants).slice(assistantMarker) : Array.from(assistants);
        const lastAssistant = scoped[scoped.length - 1];
        if (!lastAssistant) return null;

        let thinking = '';
        let response = '';
        const detectedTools = [];

        // Helper: try to parse a code block as a tool JSON
        function tryParseToolJson(text) {
          if (!text || text.length < 10) return null;
          // Quick reject: must contain "tool" key
          if (!text.includes('"tool"')) return null;
          try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed.tool === 'string' && parsed.params && typeof parsed.params === 'object') {
              return { tool: parsed.tool, params: parsed.params };
            }
            // Also accept flat structure {tool, path, content}
            if (parsed && typeof parsed.tool === 'string' && (parsed.path || parsed.command || parsed.script || parsed.query)) {
              return { tool: parsed.tool, params: parsed };
            }
          } catch (e) {
            // Not valid JSON — not a tool
          }
          return null;
        }

        // ── Extract thinking (anywhere inside assistant) ──
        const thinkContainer = lastAssistant.querySelector('.toolcall-container.thinking-container');
        if (thinkContainer) {
          const thinkMd = thinkContainer.querySelector('.markdown-container.toolcall-content-text');
          if (thinkMd) {
            thinking = (thinkMd.innerText || '').trim();
          }
        }

        // v7.4-fix: Thinking starters heuristic — used to detect leaked thinking text
        const thinkStarters = /^(O usuário|Vou |Agora |Preciso |Primeiro |Vamos |Então |Deixa |Hmm |Ok |Okay |Let me |I need |I'll |First |Now |So |The user |Hmm |Okay )/i;

        // ── Extract response from content box ──
        const contentBox = lastAssistant.querySelector('.segment-content-box');
        if (!contentBox) return null;

        // Strategy A: NEW structure — .markdown-container > .markdown > .segment-code
        const markdownContainers = contentBox.querySelectorAll('.markdown-container');
        let rawResponse = '';
        for (const md of markdownContainers) {
          // Skip if this markdown is inside the thinking container
          if (thinkContainer && md.closest('.toolcall-container.thinking-container')) continue;

          const codeBlocks = md.querySelectorAll('.segment-code, pre code, [class*="code-block"]');
          for (const cb of codeBlocks) {
            // v9.5-fix: Use textContent FIRST for code blocks — innerText can be truncated
            // when the code block has scroll or lazy rendering. textContent returns all DOM text.
            const text = (cb.textContent || cb.innerText || '').trim();
            if (!text) continue;
            // v10.0-fix: Check if this code block is a tool JSON. If so, extract it
            // separately and do NOT include it in the response text.
            const toolAction = tryParseToolJson(text);
            if (toolAction) {
              detectedTools.push(toolAction);
              continue; // skip adding to rawResponse
            }
            rawResponse += text + '\n\n';
          }
          const paragraphs = md.querySelectorAll('.paragraph, p, [class*="text"]');
          for (const p of paragraphs) {
            const text = (p.innerText || p.textContent || '').trim();
            if (text) rawResponse += text + '\n\n';
          }
        }

        // Strategy B: OLD structure — .container-block > .block-item
        if (!rawResponse) {
          const containerBlock = contentBox.querySelector('.container-block');
          const blockItems = containerBlock
            ? containerBlock.querySelectorAll('.block-item')
            : contentBox.querySelectorAll('.block-item');
          for (const item of blockItems) {
            const itemThink = item.querySelector('.toolcall-container.thinking-container');
            if (itemThink) continue; // skip thinking block

            const codeBlocks = item.querySelectorAll('.segment-code, pre code, [class*="code-block"]');
            for (const cb of codeBlocks) {
              // v9.5-fix: Use textContent FIRST for code blocks — innerText can be truncated
              const text = (cb.textContent || cb.innerText || '').trim();
              if (!text) continue;
              // v10.0-fix: Check if this code block is a tool JSON
              const toolAction = tryParseToolJson(text);
              if (toolAction) {
                detectedTools.push(toolAction);
                continue;
              }
              rawResponse += text + '\n\n';
            }
            const paragraphs = item.querySelectorAll('.paragraph, p, [class*="text"]');
            for (const p of paragraphs) {
              const text = (p.innerText || p.textContent || '').trim();
              if (text) rawResponse += text + '\n\n';
            }
          }
        }

        rawResponse = rawResponse.trim();

        // v7.4-fix: If we detected thinking (thinkContainer exists), any free-text
        // at the START of rawResponse that looks like thinking should be MOVED to thinking.
        // In thinking mode, the assistant ALWAYS thinks first, then responds with code/JSON.
        if (thinkContainer && rawResponse) {
          // Find first code block or JSON block — everything before is thinking
          const codeBlockIdx = rawResponse.indexOf('```');
          const jsonStartIdx = rawResponse.search(/\{\s*"/);
          const firstRealIdx = codeBlockIdx >= 0 && jsonStartIdx >= 0
            ? Math.min(codeBlockIdx, jsonStartIdx)
            : (codeBlockIdx >= 0 ? codeBlockIdx : jsonStartIdx);

          if (firstRealIdx > 10) {
            const beforeReal = rawResponse.slice(0, firstRealIdx).trim();
            const afterReal = rawResponse.slice(firstRealIdx).trim();
            // If the text before the real response looks like thinking, move it
            if (thinkStarters.test(beforeReal) || beforeReal.length < 400) {
              thinking = thinking ? thinking + '\n\n' + beforeReal : beforeReal;
              response = afterReal;
            } else {
              response = rawResponse;
            }
          } else if (firstRealIdx === 0) {
            // Response starts directly with code/JSON — no leaked thinking
            response = rawResponse;
          } else if (!rawResponse.includes('```') && !rawResponse.includes('{')) {
            // No code/JSON at all — entire rawResponse is likely thinking
            thinking = thinking ? thinking + '\n\n' + rawResponse : rawResponse;
            response = '';
          } else {
            response = rawResponse;
          }
        } else {
          response = rawResponse;
        }

        // v7.4-fix: Final safety net — if response is still thinking-like and short, swap
        if (!thinkContainer && response && !thinking) {
          const isThink = thinkStarters.test(response) && response.length < 500 &&
                          !response.includes('"response"') && !response.includes('"tool"');
          if (isThink) {
            thinking = response;
            response = '';
          }
        }

        if (thinking || response || detectedTools.length > 0) {
          return { thinking, response: response.trim(), detectedTools, source: 'dom-structure' };
        }
        return null;
      }, turnAssistantMarker);

      if (structureBased) {
        const { canSteer, isGenerating } = await this._detectUiState(page, provider);
        // v10.0-fix: Enqueue detected tools as action_detected events so they are
        // processed separately from the response text.
        if (structureBased.detectedTools && structureBased.detectedTools.length > 0 && userId) {
          // W6-T6 review: route through _enqueueDomEvent so cross-turn dedup and
          // queue management apply uniformly to every action_detected event.
          for (const toolAction of structureBased.detectedTools) {
            this._enqueueDomEvent(userId, {
              type: 'action_detected',
              action: toolAction,
              source: 'dom_structure_tool_filter',
              timestamp: Date.now(),
            });
          }
        }
        log.info(`[_poll] dom-structure: thinking=${structureBased.thinking.length}, response=${structureBased.response.length}, tools=${(structureBased.detectedTools || []).length}`);
        return { ...structureBased, canSteer, isGenerating };
      }
      log.info(`[_poll] dom-structure: NOT FOUND`);

      // v8.5-fix: REMOVED Layer 2-4 (React fiber + TreeWalker + getComputedStyle)
      // The heavy DOM traversal every 400ms was freezing the Kimi page by competing
      // with React's main thread. We now rely on:
      //   - Layer 1: Network interceptor (CDP)
      //   - Layer 1b: Legacy JS-injected stream interceptor (window.__lunaStream)
      //   - Layer 2.5: Lightweight DOM structure extraction
      // If none of those work, return empty and wait for next poll cycle.

      // Generic provider fallback for DeepSeek and future providers
      if (provider !== 'kimi') {
        const generic = await this._genericProviderExtraction(page, provider);
        // W6-T12: reset force-complete tracking between turns — when no
        // response is visible the previous turn's timers must not leak forward.
        if (session && !generic.response) {
          session._genericFirstSeenAt = null;
          session._genericLastLengthChangeAt = null;
          session._genericLastLength = 0;
        }
        if (generic.response || (generic.detectedTools && generic.detectedTools.length > 0)) {
          let uiState = await this._detectUiState(page, provider);
          // v10.27-fix: DeepSeek's send button is disabled when the input is empty,
          // so _detectUiState reports canSteer=false/isGenerating=true forever.
          // Use response stability as a completion heuristic for non-Kimi providers.
          if (session) {
            if (session._lastPollResponse === generic.response && generic.response.length > 0) {
              session._responseStableCycles = (session._responseStableCycles || 0) + 1;
            } else {
              session._responseStableCycles = 0;
            }
            session._lastPollResponse = generic.response;
            // W6-T12: track first-seen time and length stability for the
            // force-complete cap consulted below.
            if (generic.response && generic.response.length > 0) {
              if (!session._genericFirstSeenAt) session._genericFirstSeenAt = Date.now();
              if (session._genericLastLength !== generic.response.length) {
                session._genericLastLengthChangeAt = Date.now();
                session._genericLastLength = generic.response.length;
              }
            }
            // v10.34-fix: Require more stable cycles for DeepSeek to avoid partial responses.
            // Quality over speed: only declare completion when we are confident.
            if (session._responseStableCycles >= 5) {
              uiState.isGenerating = false;
              uiState.canSteer = true; // enable buttonSend completion signal
            }
          }
          // Avoid log spam when the response is stable and idle.
          const shouldLogGeneric = !session || session._lastLoggedGenericResponse !== generic.response || session._lastLoggedGenericIsGen !== uiState.isGenerating;
          if (shouldLogGeneric) {
            log.info(`[_poll] generic-provider: response=${generic.response.length} chars tools=${(generic.detectedTools || []).length} isGen=${uiState.isGenerating}`);
            if (session) {
              session._lastLoggedGenericResponse = generic.response;
              session._lastLoggedGenericIsGen = uiState.isGenerating;
            }
          }
          // v10.34-fix: Do NOT stream partial responses for non-Kimi providers.
          // Wait until generation is complete, then return the full cleaned response
          // so JSON tool blocks are parsed and executed correctly.
          // W6-T12: force-complete cap — independent of UI heuristics. If the
          // response has been visible for >45s and its length stable for >10s,
          // complete even when _detectUiState still says "generating" (DeepSeek
          // cursor blink can keep that true forever, starving tool delivery).
          if (session && _shouldForceGenericComplete({
            firstSeenAt: session._genericFirstSeenAt,
            lastLengthChangeAt: session._genericLastLengthChangeAt,
            uiGenerating: uiState.isGenerating,
          }, Date.now())) {
            uiState.isGenerating = false;
            // W6-T12 review: mirror the stability backstop above — a declared
            // completion must also raise canSteer so the completion-candidate
            // vote (buttonSend signal) can reach quorum even when the extracted
            // text never goes byte-stable, and post-complete steer is not blocked.
            uiState.canSteer = true;
            log.warn(`[_poll] generic-provider: force-complete cap reached (45s seen + 10s length-stable) — completing despite UI still generating`);
          }
          if (uiState.isGenerating) {
            return { thinking: '', response: '', canSteer: uiState.canSteer, isGenerating: true, source: generic.source };
          }
          // v10.32-fix: Enqueue detected tool actions so Luna can execute them.
          if (generic.detectedTools && userId) {
            for (const toolAction of generic.detectedTools) {
              this._enqueueDomEvent(userId, { type: 'action_detected', action: toolAction, source: 'generic-provider-tool', timestamp: Date.now() });
            }
          }
          return { thinking: '', response: generic.response, canSteer: uiState.canSteer, isGenerating: false, source: generic.source };
        }
      }

      // Throttle this log to avoid spamming when the page is idle.
      const now = Date.now();
      if (!session || !session._lastEmptyLayersLogAt || now - session._lastEmptyLayersLogAt > 5000) {
        log.info(`[_poll] All lightweight layers exhausted — returning empty, will retry`);
        if (session) session._lastEmptyLayersLogAt = now;
      }
      const uiState = await this._detectUiState(page, provider);
      return { thinking: '', response: '', canSteer: uiState.canSteer, isGenerating: uiState.isGenerating, source: 'empty-wait' };
    } catch (e) {
      return { thinking: '', response: '', canSteer: false, isGenerating: false, source: 'error' };
    }
    }; // end pollWithTimeout

    // v3.6: No timeout — we patiently wait for the page to respond.
    // The user explicitly requested zero timeouts in the agent.
    return await pollWithTimeout().catch(err => {
      log.warn(`[_pollThinkingAndResponse] ${err.message} — returning empty fallback`);
      return { thinking: '', response: '', canSteer: false, isGenerating: false, source: 'error' };
    });
  }

  /**
   * Detect UI state: canSteer and isGenerating from DOM buttons.
   * v10.27-fix: Accept provider-specific UI selectors so non-Kimi providers
   * don't get misclassified by overly broad generic selectors.
   */
  async _detectUiState(page, provider = null) {
    try {
      const providerCfg = provider ? this._loadProviderConfig(provider) : null;
      const uiSelectors = providerCfg ? getProviderUiSelectors(providerCfg) : {};
      const result = await page.evaluate(({ sendBtnSel, stopBtnSel, generatingSel }) => {
        // Can we steer? Prefer provider-specific send button, fall back to generics.
        const sendBtnSelectors = sendBtnSel
          ? sendBtnSel.split(',').map(s => s.trim())
          : ['.send-button-container', '[class*="send"]', 'button[type="submit"]', '[aria-label*="send" i]'];
        let canSteer = false;
        for (const sel of sendBtnSelectors) {
          const btn = document.querySelector(sel);
          if (btn) {
            canSteer = !btn.disabled && !btn.className.includes('disabled') && btn.offsetParent !== null;
            if (canSteer) break;
          }
        }

        // Is still generating? Prefer provider-specific stop/generating selectors.
        const stopBtnSelectors = stopBtnSel
          ? stopBtnSel.split(',').map(s => s.trim())
          : ['.stop-button-container', '[class*="stop"]', '[class*="cancel"]', '[aria-label*="stop" i]'];
        let isGenerating = false;
        for (const sel of stopBtnSelectors) {
          const btn = document.querySelector(sel);
          if (btn && btn.offsetParent !== null) {
            isGenerating = true;
            break;
          }
        }
        if (!isGenerating && generatingSel) {
          const indicators = generatingSel.split(',').map(s => s.trim());
          for (const sel of indicators) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) {
              isGenerating = true;
              break;
            }
          }
        }
        if (!isGenerating && !canSteer) {
          const anySend = document.querySelector('.send-button-container, [class*="send"]');
          if (!anySend || anySend.offsetParent === null) isGenerating = true;
        }
        return { canSteer, isGenerating };
      }, { sendBtnSel: uiSelectors.sendButton || '', stopBtnSel: uiSelectors.stopButton || '', generatingSel: uiSelectors.generatingIndicator || '' });
      return result;
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
   * v5.3: Extract JSON code blocks from the DOM in REAL-TIME.
   * Returns { responses: [], actions: [] } for FIFO streaming.
   * Detects {"response": "..."} and {"tool": "...", "params": {...}} blocks.
   * W6-T6: optional assistantMarker (count of pre-send .segment-assistant nodes)
   * scopes the scan to segments created by the current turn; when null/undefined
   * the behavior is exactly as before (scan the last assistant match).
   */
  async _extractJsonBlocksFromDOM(page, assistantMarker = null) {
    try {
      return await page.evaluate((marker) => {
        const responses = [];
        const actions = [];
        const seen = new Set();

        // v10.24-fix: Detect plain code blocks (bash/python) that are not wrapped in JSON.
        function detectScriptBlock(text, el) {
          const t = text.trim();
          if (t.length < 3) return null;
          if (t.startsWith('#!/bin/bash') || t.startsWith('#!/usr/bin/env bash') || t.startsWith('#!/bin/sh')) {
            return { tool: 'executeScript', params: { code: t, language: 'bash' } };
          }
          if (t.startsWith('#!/usr/bin/env python') || t.startsWith('#!/usr/bin/python')) {
            return { tool: 'executeScript', params: { code: t, language: 'python' } };
          }
          if (t.startsWith('#!/usr/bin/env node') || t.startsWith('#!/usr/bin/node')) {
            return { tool: 'executeScript', params: { code: t, language: 'node' } };
          }
          const langClass = Array.from(el.classList || []).find(c => c.startsWith('language-'));
          const lang = langClass ? langClass.replace('language-', '').toLowerCase() : '';
          if (['bash', 'shell', 'sh', 'zsh'].includes(lang)) {
            return { tool: 'executeScript', params: { code: t, language: 'bash' } };
          }
          if (['python', 'py', 'python3'].includes(lang)) {
            return { tool: 'executeScript', params: { code: t, language: 'python' } };
          }
          if (['powershell', 'ps1', 'pwsh'].includes(lang)) {
            return { tool: 'executeScript', params: { code: t, language: 'powershell' } };
          }
          if (['javascript', 'js', 'node'].includes(lang)) {
            return { tool: 'executeScript', params: { code: t, language: 'node' } };
          }
          return null;
        }

        // Find the LAST assistant segment
        const assistantSelectors = [
          '.segment-assistant', '.message-assistant',
          '[data-testid="assistant-message"]', '[data-testid="message-assistant"]',
          '.chat-message--assistant', '[class*="assistant"][class*="segment"]',
          '[class*="assistant"][class*="message"]',
        ];
        let lastAssistant = null;
        for (const sel of assistantSelectors) {
          const els = document.querySelectorAll(sel);
          if (!els.length) continue;
          // W6-T6: the marker counts .segment-assistant nodes present before the
          // current send. When set, only segments beyond it belong to this turn;
          // if none exist yet, there is nothing new to extract — do NOT fall
          // through to broader selectors (they would re-match the same stale
          // nodes, e.g. [class*="assistant"][class*="segment"] also matches
          // .segment-assistant elements). null marker => today's behavior.
          if (sel === '.segment-assistant' && typeof marker === 'number') {
            if (els.length > marker) lastAssistant = els[els.length - 1];
            break;
          }
          lastAssistant = els[els.length - 1];
          break;
        }
        if (!lastAssistant) return { responses, actions };

        // Find ALL code blocks in the assistant message
        const codeSelectors = [
          '.segment-code', '.message-code', '[class*="code"][class*="segment"]',
          '.toolcall-content pre', '.toolcall-content code',
          '.markdown pre code', '.markdown-container pre code',
        ];
        const allCodeEls = [];
        for (const sel of codeSelectors) {
          lastAssistant.querySelectorAll(sel).forEach(el => {
            if (!allCodeEls.includes(el)) allCodeEls.push(el);
          });
        }

        // v5.3-fix: Exclude code blocks inside the thinking container.
        // The thinking text may contain examples that look like JSON —
        // we must NOT emit them as responses/actions.
        // v8.5-fix: BUT in THINKING mode, Kimi may place REAL tool calls inside
        // the thinking container. We scan them too, but only accept if they look
        // like actual tool calls (have 'tool'/'script'/'action' keys).
        const thinkContainer = lastAssistant.querySelector('.toolcall-container.thinking-container, .thinking-container, [class*="thinking-container"]');
        const isInsideThinking = (el) => {
          if (!thinkContainer) return false;
          let parent = el.parentElement;
          while (parent && parent !== lastAssistant) {
            if (parent === thinkContainer) return true;
            parent = parent.parentElement;
          }
          return false;
        };
        const filteredCodeEls = allCodeEls.filter(el => !isInsideThinking(el));
        const thinkingCodeEls = allCodeEls.filter(el => isInsideThinking(el));

        for (const el of filteredCodeEls) {
          let text = '';
          // Try innerText first, then textContent
          text = (el.innerText || el.textContent || '').trim();
          // Fallback: get from parent pre if innerText is empty
          if (!text && el.parentElement && el.parentElement.tagName === 'PRE') {
            text = (el.parentElement.innerText || el.parentElement.textContent || '').trim();
          }
          if (!text || text.length < 10 || seen.has(text)) continue;
          seen.add(text);

          // Clean up JSON wrapper artifacts from DOM extraction
          const cleaned = text
            .replace(/^\s*JSON\s*(?:Copy|复制|複製)\s*/i, '')
            .replace(/^\s*json\s*(?:Copy|复制|複製)\s*/i, '');

          // v5.3-fix: Tolerant JSON parser that handles literal newlines inside strings
          // Kimi sometimes renders JSON code blocks with real newlines inside string values
          function tolerantJsonParse(str) {
            // v5.3-fix: Only parse COMPLETE JSON blocks.
            // If the string doesn't end with '}', it's still being streamed — skip it.
            const trimmed = str.trim();
            if (!trimmed.endsWith('}')) return null;

            // 1. Try standard JSON parse first
            try { return JSON.parse(str); } catch {}
            // 2. Try extracting first JSON object
            const firstBrace = str.indexOf('{');
            const lastBrace = str.lastIndexOf('}');
            if (firstBrace >= 0 && lastBrace > firstBrace) {
              const extracted = str.slice(firstBrace, lastBrace + 1);
              try { return JSON.parse(extracted); } catch {}
            }
            // 3. Regex-based extraction for tool/action JSON blocks
            // This handles malformed JSON with literal newlines inside strings
            const toolMatch = str.match(/"tool"\s*:\s*"([^"]+)"/);
            if (!toolMatch) return null;
            const tool = toolMatch[1];
            // Extract the entire params object - find "params": { ... }
            const paramsStart = str.indexOf('"params"');
            if (paramsStart === -1) return { tool, params: {} };
            let braceDepth = 0;
            let paramsStr = '';
            let inStr = false;
            let strChar = null;
            let escaped = false;
            for (let i = paramsStart; i < str.length; i++) {
              const ch = str[i];
              if (escaped) {
                paramsStr += ch;
                escaped = false;
                continue;
              }
              if (ch === '\\') {
                paramsStr += ch;
                escaped = true;
                continue;
              }
              if (!inStr) {
                if (ch === '"' || ch === "'") {
                  inStr = true; strChar = ch;
                } else if (ch === '{') {
                  braceDepth++;
                } else if (ch === '}') {
                  braceDepth--;
                  if (braceDepth === 0) {
                    paramsStr += ch;
                    break;
                  }
                }
                paramsStr += ch;
              } else {
                if (ch === strChar) {
                  inStr = false; strChar = null;
                }
                paramsStr += ch;
              }
            }
            // Replace literal newlines inside the params string with escaped newlines
            // We do this by walking again and only escaping newlines that are inside quotes
            let fixedParams = '';
            inStr = false; strChar = null; escaped = false;
            for (let i = 0; i < paramsStr.length; i++) {
              const ch = paramsStr[i];
              if (escaped) {
                fixedParams += ch;
                escaped = false;
                continue;
              }
              if (ch === '\\') {
                fixedParams += ch;
                escaped = true;
                continue;
              }
              if (!inStr) {
                if (ch === '"' || ch === "'") {
                  inStr = true; strChar = ch;
                }
                fixedParams += ch;
              } else {
                if (ch === strChar) {
                  inStr = false; strChar = null;
                  fixedParams += ch;
                } else if (ch === '\n') {
                  fixedParams += '\\n';
                } else if (ch === '\r') {
                  fixedParams += '\\r';
                } else if (ch === '\t') {
                  fixedParams += '\\t';
                } else {
                  fixedParams += ch;
                }
              }
            }
            try {
              const params = JSON.parse(fixedParams);
              return { tool, params };
            } catch {
              // Incomplete JSON — don't emit partial actions
              return null;
            }
          }

          const parsed = tolerantJsonParse(cleaned);

          if (!parsed) {
            // v10.24-fix: JSON failed — maybe this is a plain bash/python code block.
            const scriptBlock = detectScriptBlock(cleaned, el);
            if (scriptBlock) {
              actions.push({ ...scriptBlock, raw: text });
            }
            continue;
          }

          // Detect response block
          if (parsed.response !== undefined && !parsed.tool && !parsed.script) {
            responses.push({ response: parsed.response, raw: text });
          }
          // Detect action/tool block
          else if (parsed.tool && parsed.params !== undefined) {
            actions.push({
              tool: parsed.tool,
              params: parsed.params,
              raw: text,
            });
          }
          // Detect script block
          else if (parsed.script) {
            actions.push({
              tool: 'executeScript',
              params: { code: parsed.script, language: parsed.language || 'bash' },
              raw: text,
            });
          }
        }

        // v8.5-fix: Also scan code blocks inside the thinking container, but ONLY
        // accept actual tool calls (not examples). In THINKING mode, Kimi may place
        // real JSON tool calls inside the thinking panel.
        for (const el of thinkingCodeEls) {
          let text = (el.innerText || el.textContent || '').trim();
          if (!text && el.parentElement && el.parentElement.tagName === 'PRE') {
            text = (el.parentElement.innerText || el.parentElement.textContent || '').trim();
          }
          if (!text || text.length < 10 || seen.has(text)) continue;
          seen.add(text);

          const cleaned = text
            .replace(/^\s*JSON\s*(?:Copy|复制|複製)\s*/i, '')
            .replace(/^\s*json\s*(?:Copy|复制|複製)\s*/i, '');

          function tolerantJsonParseThinking(str) {
            const trimmed = str.trim();
            if (!trimmed.endsWith('}')) return null;
            try { return JSON.parse(str); } catch {}
            const firstBrace = str.indexOf('{');
            const lastBrace = str.lastIndexOf('}');
            if (firstBrace >= 0 && lastBrace > firstBrace) {
              const extracted = str.slice(firstBrace, lastBrace + 1);
              try { return JSON.parse(extracted); } catch {}
            }
            const toolMatch = str.match(/"tool"\s*:\s*"([^"]+)"/);
            if (!toolMatch) return null;
            const tool = toolMatch[1];
            const paramsStart = str.indexOf('"params"');
            if (paramsStart === -1) return { tool, params: {} };
            let braceDepth = 0;
            let paramsStr = '';
            let inStr = false;
            let strChar = null;
            let escaped = false;
            for (let i = paramsStart; i < str.length; i++) {
              const ch = str[i];
              if (escaped) { paramsStr += ch; escaped = false; continue; }
              if (ch === '\\') { paramsStr += ch; escaped = true; continue; }
              if (!inStr) {
                if (ch === '"' || ch === "'") { inStr = true; strChar = ch; }
                else if (ch === '{') braceDepth++;
                else if (ch === '}') { braceDepth--; if (braceDepth === 0) { paramsStr += ch; break; } }
                paramsStr += ch;
              } else {
                if (ch === strChar) { inStr = false; strChar = null; }
                paramsStr += ch;
              }
            }
            let fixedParams = '';
            inStr = false; strChar = null; escaped = false;
            for (let i = 0; i < paramsStr.length; i++) {
              const ch = paramsStr[i];
              if (escaped) { fixedParams += ch; escaped = false; continue; }
              if (ch === '\\') { fixedParams += ch; escaped = true; continue; }
              if (!inStr) {
                if (ch === '"' || ch === "'") { inStr = true; strChar = ch; }
                fixedParams += ch;
              } else {
                if (ch === strChar) { inStr = false; strChar = null; fixedParams += ch; }
                else if (ch === '\n') fixedParams += '\\n';
                else if (ch === '\r') fixedParams += '\\r';
                else if (ch === '\t') fixedParams += '\\t';
                else fixedParams += ch;
              }
            }
            try {
              const params = JSON.parse(fixedParams);
              return { tool, params };
            } catch { return null; }
          }

          const parsed = tolerantJsonParseThinking(cleaned);
          if (!parsed) continue;

          // Only accept REAL tool calls from thinking container — ignore examples
          if (parsed.tool && parsed.params !== undefined) {
            actions.push({ tool: parsed.tool, params: parsed.params, raw: text });
          } else if (parsed.script) {
            actions.push({
              tool: 'executeScript',
              params: { code: parsed.script, language: parsed.language || 'bash' },
              raw: text,
            });
          }
        }

        return { responses, actions };
      }, assistantMarker);
    } catch (e) {
      log.warn(`_extractJsonBlocksFromDOM failed: ${e.message}`);
      return { responses: [], actions: [] };
    }
  }

  /**
   * v7.5: Robust JSON tool call extractor — replaces fragile regex with actual JSON parsing.
   * Searches for JSON objects in text, including inside code blocks (```json ... ```).
   * Returns array of {tool, params} objects, or empty array if none found.
   */
  _extractJsonToolCalls(text) {
    if (!text || typeof text !== 'string') return [];
    const results = [];
    const foundKeys = new Set(); // Deduplication

    // Helper: try to parse a candidate string
    const tryParse = (candidate) => {
      try {
        const parsed = JSON.parse(candidate.trim());
        if (parsed.tool && typeof parsed.tool === 'string') {
          const key = JSON.stringify({ tool: parsed.tool, params: parsed.params || parsed.arguments || {} });
          if (!foundKeys.has(key)) {
            foundKeys.add(key);
            results.push({
              tool: parsed.tool,
              params: parsed.params || parsed.arguments || parsed,
              raw: candidate.trim(),
            });
          }
        } else if (parsed.script && typeof parsed.script === 'string') {
          // v10.24-fix: Detect JSON-wrapped scripts like {"script": "..."}.
          const key = JSON.stringify({ tool: 'executeScript', params: { code: parsed.script, language: parsed.language || 'bash' } });
          if (!foundKeys.has(key)) {
            foundKeys.add(key);
            results.push({
              tool: 'executeScript',
              params: { code: parsed.script, language: parsed.language || 'bash' },
              raw: candidate.trim(),
            });
          }
        }
      } catch (e) {
        // Not valid JSON or no tool/script field
      }
    };

    // Strategy 1: Extract from code blocks (```json ... ```)
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      tryParse(match[1]);
    }

    // Strategy 2: Extract raw JSON objects from text (W8-T2a: string-aware
    // walker — the old regex + naive brace counting cut the slice at braces
    // inside string values, e.g. writeFile HTML/JS content, and JSON.parse
    // then failed, silently dropping the tool). Walk every top-level object
    // respecting string literals/escapes; tryParse filters tool/script JSON
    // (W6-T9: script-only JSON maps to executeScript).
    let cursor = 0;
    while (cursor < text.length) {
      const objText = extractFirstCompleteJsonObject(text, cursor);
      if (!objText) break;
      tryParse(objText);
      const openIdx = text.indexOf('{', cursor);
      if (openIdx === -1) break;
      cursor = openIdx + objText.length;
    }

    return results;
  }

  /**
   * v5.6-fix: Extract clean text from JSON blocks in the final response.
   * If the DOM shows raw JSON like {"response": "..."}, returns just the text.
   * Otherwise returns the original text unchanged.
   */
  _extractParsedText(text) {
    if (!text || typeof text !== 'string') return text;
    let cleaned = text.trim();

    // Fast path: doesn't look like JSON at all
    if (!cleaned.includes('{') && !cleaned.includes('```json')) return text;

    // v10.36-fix: Strip code block fences and Kimi DOM headers like "JSON\nCopy\n".
    cleaned = cleaned
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*$/gm, '')
      .replace(/```/g, '')
      .replace(/^\s*JSON\s*(?:Copy|复制|複製)\s*/gim, '')
      .replace(/^\s*json\s*(?:Copy|复制|複製)\s*/gim, '');

    // v10.36-fix: If the model duplicated the JSON block, keep only the first one.
    const firstBlockEnd = cleaned.indexOf('}\n\n{');
    if (firstBlockEnd > 0) {
      cleaned = cleaned.slice(0, firstBlockEnd + 1);
    }

    // Try to parse as JSON
    try {
      const parsed = JSON.parse(cleaned);
      // v5.7-fix: If JSON contains a tool call, return the FULL JSON so the parser can extract it.
      // Extracting only 'response' discards tool calls completely.
      if (parsed.tool && typeof parsed.tool === 'string') {
        return cleaned; // Return raw JSON — parser will extract tool call
      }
      if (parsed.script && typeof parsed.script === 'string') {
        return cleaned; // Return raw JSON — parser will extract script call
      }
      if (parsed.response && typeof parsed.response === 'string') {
        return parsed.response.trim();
      }
      // v10.24-fix: Tolerate malformed wrappers where Kimi sends {"success":true,"mode":"RESPONSE","message":"..."}
      if (parsed.message && typeof parsed.message === 'string' && !parsed.tool && !parsed.script) {
        return parsed.message.trim();
      }
    } catch {}

    // Try extracting first JSON object
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
        if (parsed.tool && typeof parsed.tool === 'string') {
          return cleaned.slice(firstBrace, lastBrace + 1); // Return raw JSON
        }
        if (parsed.script && typeof parsed.script === 'string') {
          return cleaned.slice(firstBrace, lastBrace + 1); // Return raw JSON
        }
        if (parsed.response && typeof parsed.response === 'string') {
          return parsed.response.trim();
        }
      } catch {}
    }

    // Try regex extraction of "response" field (only if no tool field detected)
    const hasToolField = /"tool"\s*:/.test(cleaned);
    if (!hasToolField) {
      const match = cleaned.match(/"response"\s*:\s*"([\s\S]*?)"\s*[,}]/);
      if (match) return match[1].trim();
    }

    return text;
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
    const { canSteer } = await this._pollThinkingAndResponse(session.page, userId);
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

      // Find input and inject text. W7-T4 review follow-up: Lexical-safe
      // fill — fill() desyncs the Lexical EditorState, and the send-button
      // click below would then silently send nothing.
      const inputLocator = page.locator('textarea, [contenteditable="true"]').first();
      await this._fillContentEditable(inputLocator, text);
      await page.waitForTimeout(300);

      // Click send or press Enter
      const sendBtn = page.locator('.send-button-container').first();
      const hasSendBtn = await sendBtn.count() > 0;

      if (hasSendBtn) {
        await sendBtn.click({ timeout: 3000 });
      } else {
        await this._pressEnterOnInput(inputLocator);
      }

      log.success(`Steer injected for user ${hashUserId(userId)}`);
      // W6-T6: a steer is real user input mid-stream — let identical tool JSON
      // be delivered again. Marker intentionally untouched: the in-flight
      // assistant segment must keep streaming.
      if (session) session._domEventSeen = new Map();
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
  async *sendMessageStream(userId, text, options = {}, provider = 'kimi') {
    log.info(`[DEBUG-LUNA] sendMessageStream started for user ${hashUserId(userId)}`);
    if (!text || !text.trim()) {
      throw new Error('Message text is required');
    }

    // Rate limiting
    this._checkCooldown(userId);

    const resolvedProvider = this._resolveProvider(userId, provider);
    log.info(`[DEBUG-LUNA] resolvedProvider=${resolvedProvider}`);
    const page = await this._getOrCreateUserPage(userId, resolvedProvider);
    log.info(`[DEBUG-LUNA] page acquired, url=${page?.url()}`);

    // v8.6-fix: Reset completion state and soft-cancel flag at start of every message
    let session = this.userSessions.get(userId);
    log.info(`[DEBUG-LUNA] session acquired=${!!session}`);
    if (session) {
      session._completionState = null;
      session.softCancelRequested = false;
      session.provider = resolvedProvider;
    }

    // v7.5: Initialize Network Interceptor for this message
    // This replaces fragile JS injection with native Playwright response capture.
    log.info(`[DEBUG-LUNA] getting interceptor`);
    let interceptor = null;
    try {
      interceptor = await this._getOrCreateInterceptor(userId);
    } catch (interceptorErr) {
      log.warn(`[DEBUG-LUNA] Interceptor creation failed: ${interceptorErr.message} — continuing without it`);
    }
    log.info(`[DEBUG-LUNA] interceptor=${!!interceptor}`);
    if (interceptor) interceptor.reset();

    // v7.5: Also reset legacy stream interceptor (transitional, will be removed)
    log.info(`[DEBUG-LUNA] resetting legacy stream interceptor`);
    await page.evaluate(() => {
      if (window.__lunaResetStream) {
        window.__lunaResetStream();
      } else if (window.__lunaStream) {
        window.__lunaStream.reasoning = [];
        window.__lunaStream.content = [];
        window.__lunaStream.events = [];
        window.__lunaStream.active = false;
        window.__lunaStream.error = null;
      }
    });

    // v7.0-fix: Wait for any ongoing processing. Unlike v6.x, we don't throw
    // STREAM_CANCELLED here — we wait for the previous stream to drain its
    // events or for the soft-cancel signal to propagate.
    // v9.5-fix: Guard against undefined session (userSessions may not have entry yet)
    // W6-T3: bounded + self-healing. If a previous stream died without clearing
    // `processing`, an unbounded wait here would hang every future message
    // BEFORE sending anything, with no event. Past 60s the previous stream is
    // provably dead — force-clear the flag and continue sending.
    const PROCESSING_DRAIN_TIMEOUT_MS = 60_000;
    if (session?.processing) {
      log.warn(`[DEBUG-LUNA] User ${hashUserId(userId)} already processing — waiting for drain (max ${PROCESSING_DRAIN_TIMEOUT_MS}ms)`);
      const drainDeadline = Date.now() + PROCESSING_DRAIN_TIMEOUT_MS;
      while (session?.processing) {
        if (Date.now() > drainDeadline) {
          log.warn(`[sendMessageStream] Processing drain timeout (${PROCESSING_DRAIN_TIMEOUT_MS}ms) for user ${hashUserId(userId)} — previous stream is dead, force-clearing processing flag`);
          session.processing = false;
          break;
        }
        await new Promise(r => setTimeout(r, 500));
      }
      log.warn(`[DEBUG-LUNA] Previous drain complete for user ${hashUserId(userId)}`);
    }

    if (session) {
      session.processing = true;
      session.lastActivity = Date.now();
    }
    this.cancelledStreams.delete(userId);
    this.streamStopFlags.delete(userId);

    // v7.0: Initialize per-message event queue
    const queueId = `q-${Date.now()}`;
    this.domEventQueues.set(userId, { events: [], lastReadIndex: 0, createdAt: Date.now(), queueId });
    const queue = this.domEventQueues.get(userId);

    // v7.0: Start DOM poller — runs INDEPENDENTLY of the stream
    log.info(`[DEBUG-LUNA] starting DOM poller`);
    this._startDomPoller(userId);

    try {
      log.info(`[DEBUG-LUNA] Step 1: verifySession for provider=${resolvedProvider}`);
      await this._verifySession(page);
      log.info(`[DEBUG-LUNA] Step 2: verifySession OK`);

      if (options.newChat) {
        const pageContext = page.context();
        const pagesBefore = new Set(pageContext.pages());
        const openedUrl = await this._openNewChat(page, resolvedProvider);

        // v10.36-fix: Kimi sometimes opens the new chat in a new tab.
        // Detect and migrate to the new tab to keep sending on the active thread.
        const pagesAfter = pageContext.pages();
        for (const p of pagesAfter) {
          if (!pagesBefore.has(p) && !p.isClosed()) {
            let url = '';
            try { url = p.url(); } catch (e) { url = ''; }
            log.info(`[sendMessageStream] detected new tab: ${url}`);
            if (url.includes('/chat/') || url.includes('kimi.com')) {
              try { if (!page.isClosed()) await page.close(); } catch (e) {}
              session.page = p;
              p._lunaUserId = userId;
              p._lunaProvider = resolvedProvider;
              page = p;
              break;
            }
          }
        }

        session = this.userSessions.get(userId);
        if (session) {
          session.chatUrl = page.url();
          this._saveChatUrl(userId, session.chatUrl, { provider: resolvedProvider });
        }

        // v10.36-fix: Close leftover landing-page tabs so the user does not see
        // a deslogada page after the new chat opens in a new tab.
        await this._closeStaleProviderTabs(pageContext, page, resolvedProvider);
      }

      // v10.39-fix: Defensive URL check — ensure this Luna session always talks
      // in its own Kimi chat thread. If the tab got reassigned or navigated
      // elsewhere, go back to the persisted chat URL before sending.
      if (!options.newChat && session?.chatUrl) {
        const currentUrl = page.url();
        const expectedId = session.chatUrl.split('?')[0].split('/').pop();
        if (expectedId && !currentUrl.includes(expectedId)) {
          log.info(`[sendMessageStream] URL mismatch for ${hashUserId(userId)}: current=${currentUrl}, expected=${session.chatUrl} — navigating to correct chat`);
          await page.goto(session.chatUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
          await page.waitForTimeout(1500);
        }
      }

      if (options.mode) {
        await this.setMode(userId, options.mode, resolvedProvider);
      }

      log.info(`[DEBUG-LUNA] Step 3: detectActualMode`);
      const actualMode = await this._detectActualMode(page) || session?.mode || 'instant';
      log.info(`[v7.0] User ${hashUserId(userId)} streaming message (mode=${actualMode})`);

      // v6.1-fix: Inject text file contents directly into the prompt
      if (options.files && options.files.length > 0) {
        for (const file of options.files) {
          if (file.name && file.name.endsWith('.txt') && file.data && file.data.includes('base64')) {
            try {
              const base64Match = file.data.match(/^data:.*?;base64,(.+)$/);
              if (!base64Match) {
                log.warn(`[sendMessageStream] Data URI does not contain valid base64: ${file.name}`);
                continue;
              }
              const decoded = Buffer.from(base64Match[1], 'base64').toString('utf8');
              const placeholderRegex = /\[(?:Arquivo anexado|Anexo|File attached):\s*[^\]]+\]/i;
              if (placeholderRegex.test(text)) {
                text = text.replace(placeholderRegex, decoded);
                log.info(`[sendMessageStream] Injected ${decoded.length} chars from ${file.name} into prompt`);
              } else {
                text = text + '\n\n---\n' + decoded;
                log.info(`[sendMessageStream] Appended ${decoded.length} chars from ${file.name} to prompt`);
              }
              file._injected = true;
            } catch (e) {
              log.error(`[sendMessageStream] Failed to decode ${file.name}: ${e.message}`);
            }
          }
        }
        options.files = options.files.filter(f => !f._injected);
      }

      log.info(`[DEBUG-LUNA] Step 4: looking for input field`);
      const inputLocator = page.locator('textarea, [contenteditable="true"]').first();
      const inputCount = await inputLocator.count();
      log.info(`[DEBUG-LUNA] Step 4: inputCount=${inputCount}`);
      if (inputCount === 0) {
        throw new Error('Input field not found on Kimi Web');
      }

      log.info(`[DEBUG-LUNA] Step 5: bringToFront`);
      await page.bringToFront();
      // v9.6-fix: Use a real timeout (not 0) so innerText throws when no markdown
      // exists on Kimi's home screen, allowing .catch to return '' instead of
      // hanging forever waiting for an element that never appears.
      let initialText = await page.locator('.markdown-container .markdown').last().innerText({ timeout: 2000 }).catch(() => '');

      // v10.35-fix: For non-Kimi providers, the generic DOM extraction reads the LAST
      // assistant bubble. Capture the current response text via the same polling path
      // so Phase 0 ignores the previous response and only triggers when NEW content
      // arrives. This prevents immediate false-completion on DeepSeek when the prior
      // answer is still visible.
      if (resolvedProvider !== 'kimi') {
        try {
          const prePoll = await this._pollThinkingAndResponse(page, userId);
          if (prePoll && (prePoll.thinking || prePoll.response)) {
            initialText = (prePoll.thinking || '') + (prePoll.response || '');
            log.info(`[sendMessageStream] Non-Kimi pre-send response captured: ${initialText.length} chars`);
          }
        } catch (prePollErr) {
          log.warn(`[sendMessageStream] Failed to capture pre-send poll: ${prePollErr.message}`);
        }
      }

      // v7.7-INFALÍVEL: Capture FULL snapshot before sending (all assistant texts)
      // This replaces fragile assistant counting with snapshot diffing.
      const preSendSnapshot = await this._capturePreSendSnapshot(page);
      const preSendAssistantCount = preSendSnapshot.length;
      log.info(`[sendMessageStream] Pre-send snapshot: ${preSendAssistantCount} assistants captured`);

      // v10.18-fix: Focus the editor first. Kimi's Lexical contenteditable on the
      // landing page does not register fill()/Enter events unless it is focused.
      // Playwright's click() can hang on the landing editor, so we use JS focus().
      await inputLocator.evaluate((el) => el.focus());
      await page.waitForTimeout(200);

      // W7-T4: Lexical-safe fill. Playwright's fill() does not register in the
      // React/Lexical contenteditable (text visible in the DOM but EditorState
      // empty → Enter becomes a no-op and the message sits unsent in the box).
      await this._fillContentEditable(inputLocator, text);
      await page.waitForTimeout(500);
      log.info(`[DEBUG-LUNA] Step 6: pressing Enter`);
      // W7-T4: verify-and-retry submit — typed text must never sit unsent.
      await this._submitWithVerification(page, inputLocator, text, { provider: resolvedProvider });
      // Wave2-fix: discard everything the poller observed during send-prep —
      // it describes the PREVIOUS turn's DOM, not this message.
      queue.events.length = 0;
      queue.lastReadIndex = 0;
      if (session) {
        session._completionState = null;
        // W6-T12 review: per-turn reset of the force-complete tracking. The
        // poller runs during send-prep and can observe the PREVIOUS turn's
        // response without ever seeing an empty gap; without this reset
        // _genericFirstSeenAt leaks forward and the cap's 45s runway silently
        // degrades to just the 10s length-stable window on later turns.
        session._genericFirstSeenAt = null;
        session._genericLastLengthChangeAt = null;
        session._genericLastLength = 0;
      }
      // W6-T6: turn-scoped phantom-action detection.
      // (1) Pre-send assistant marker: number of .segment-assistant nodes that
      //     existed BEFORE this message was sent. Reuses the v7.7 pre-send
      //     snapshot count (captured pre-fill/pre-Enter above) — a post-Enter
      //     evaluate would race Kimi's optimistic render of this turn's
      //     placeholder segment and could exclude the whole turn from scanning.
      //     DOM detectors (dom-structure poll, _extractJsonBlocksFromDOM) only
      //     scan segments at index >= marker, so the previous turn's last
      //     assistant segment — still visible in the DOM — cannot be re-emitted
      //     as new actions. .segment-assistant is Kimi-only: other providers
      //     get null = "scan everything" (today's behavior).
      // (2) Cross-turn dom-event dedup reset: a REAL user send starts a new
      //     topic, so tool JSON identical to an earlier conversation must be
      //     allowed again. The soul marks its auto-continue loop sends with
      //     options.isAutoContinue (luna-soul.cjs); every other send clears.
      if (session) {
        session._turnAssistantMarker = resolvedProvider === 'kimi' ? preSendAssistantCount : null;
        if (!options.isAutoContinue) {
          session._domEventSeen = new Map();
        }
      }
      log.info(`[DEBUG-LUNA] Step 7: Message sent, starting v7.0 stream consumer`);

      // v7.7: Keep assistant detection for logging/compatibility, but extraction
      // will use snapshot diff which doesn't depend on correct index.
      // v10.27-fix: Kimi-specific .segment-assistant detection does not exist on
      // other providers (DeepSeek, etc.). Skip it for non-Kimi providers so the
      // generic polling path can stream the response.
      let newAssistantWaitCount = 0;
      let targetAssistantIndex = -1;
      // W6-T1: register the soft-cancel flag BEFORE the assistant-detection
      // loop so the loop can observe it (previously registered later, at
      // stream-consumer setup).
      let stopConsuming = false;
      this.streamStopFlags.set(userId, () => { stopConsuming = true; });
      // W6-T1: bounded wait — a renamed selector or a silent Enter failure must
      // not hang the stream forever (session.processing would stay true and
      // brick every future message from this user).
      const NEW_ASSISTANT_TIMEOUT_MS = 120_000;
      const newAssistantDeadline = Date.now() + NEW_ASSISTANT_TIMEOUT_MS;
      if (resolvedProvider === 'kimi') {
        while (true) {
          // W6-T1: cancel + deadline checks (this loop was previously
          // unbounded and ignored the cancel flag).
          if (stopConsuming) throw new Error('STREAM_CANCELLED');
          if (Date.now() > newAssistantDeadline) {
            throw new Error('NO_ASSISTANT_DETECTED: selector broke or send failed (no .segment-assistant within 120s)');
          }
          const assistants = await page.evaluate(() => {
            const nodes = document.querySelectorAll('.segment-assistant');
            return Array.from(nodes).map((el, i) => ({
              index: i,
              textLength: el.innerText?.length || 0,
              hasMarkdown: !!el.querySelector('.markdown-container, .markdown'),
            }));
          });
          const currentCount = assistants.length;
          if (currentCount > preSendAssistantCount) {
            const newAssistant = assistants[preSendAssistantCount];
            if (newAssistant && (newAssistant.textLength > 0 || newAssistant.hasMarkdown)) {
              targetAssistantIndex = preSendAssistantCount;
              log.info(`[sendMessageStream] New assistant detected (index ${targetAssistantIndex}, textLen=${newAssistant.textLength})`);
              break;
            }
          }
          // W6-T1: bounded wait (NEW_ASSISTANT_TIMEOUT_MS above) — Chrome may
          // lag on large prompts, but a broken selector or failed send now
          // errors out instead of hanging forever.
          if (++newAssistantWaitCount > 100) {
            log.info(`[sendMessageStream] New assistant not detected yet (wait=${newAssistantWaitCount*100}ms), continuing to wait...`);
          }
          await new Promise(r => setTimeout(r, 100));
        }
      } else {
        log.info(`[DEBUG-LUNA] Skipping Kimi assistant detection for provider=${resolvedProvider}`);
      }

      await page.waitForTimeout(600);

      // v7.0: Stream consumer — reads from event queue, NOT from DOM directly
      let lastThinking = '';
      let lastResponse = '';
      // Wave2-fix E: per-source response cursors. Each producer (chrome_extension,
      // dom-structure poll, dom_observer) emits FULL cumulative text from its own
      // extraction; diffing all of them against one shared cursor duplicated or
      // corrupted chunks. The cursor keeps a per-source watermark and swallows
      // cross-source divergent chunks instead of emitting garbage.
      // lastResponse is kept for completion/final-extraction fallbacks.
      const responseCursor = createResponseCursor();
      const divergedSourcesLogged = new Set(); // log.warn once per diverging source
      let lastCanSteer = false;
      let isComplete = false;
      // W6-T1: `stopConsuming` is declared and registered earlier (above the
      // new-assistant detection loop) so that loop can observe cancellation.
      let pollCount = 0;
      let textHasChanged = false;

      // v9.4-fix: JSON Accumulation Buffer state
      let jsonAccumulator = '';
      let isAccumulatingJson = false;

      // Track emitted actions for deduplication
      const emittedActionCodes = new Set();
      const emittedResponseHashes = new Set();
      const emittedJsonActionHashes = new Set();
      let domActionsCount = 0;

      // Phase 0: Wait for first text change via queue events.
      // W6-T3: bounded — chrome lag with huge prompts is expected and gets the
      // full 5 minutes, but a SILENT send failure (Enter never landed, tab dead)
      // must surface as a visible error instead of hanging forever. The throw
      // propagates through the catch below (only STREAM_CANCELLED is swallowed)
      // up to the soul's error handling.
      const GENERATION_START_TIMEOUT_MS = 5 * 60_000;
      const generationStartDeadline = Date.now() + GENERATION_START_TIMEOUT_MS;
      log.info(`[DEBUG-LUNA] Phase 0: waiting for first text change. initialText='${initialText}' queueLen=${queue.events.length}`);
      while (!textHasChanged && !stopConsuming) {
        if (Date.now() > generationStartDeadline) {
          throw new Error('GENERATION_NEVER_STARTED: Kimi did not start generating within 5 minutes');
        }
        while (queue.lastReadIndex < queue.events.length) {
          const ev = queue.events[queue.lastReadIndex++];
          if (ev.type === 'state_change') {
            const combined = (ev.thinking || '') + (ev.response || '');
            log.info(`[DEBUG-LUNA] Phase 0 state_change: combined='${combined}' isGenerating=${ev.isGenerating} source=${ev.source}`);
            if (combined !== initialText && combined.length > 0) {
              textHasChanged = true;
              lastThinking = ev.thinking || '';
              lastResponse = ev.response || '';
              // Wave2-fix E: seed the cursor with the Phase 0 text (result
              // discarded) so the first Phase 1 delta from the same source
              // doesn't re-emit the seed text.
              responseCursor.next(ev.source || 'phase0', lastResponse);
              log.info(`[DEBUG-LUNA] Phase 0 textHasChanged=true`);
              break;
            }
            // v10.35-fix: Trigger on generation start immediately, even at pollCount 0.
            // Non-Kimi providers (DeepSeek) may have the previous answer still visible;
            // isGenerating is the most reliable signal that a NEW response is beginning.
            if (ev.isGenerating) {
              textHasChanged = true;
              log.info(`[DEBUG-LUNA] Phase 0 textHasChanged=true via isGenerating`);
              break;
            }
          }
        }
        if (++pollCount % 5 === 0) {
          log.info(`[DEBUG-LUNA] Phase 0 still waiting (pollCount=${pollCount})`);
          yield { type: 'waiting', message: 'Aguardando resposta do Kimi...' };
        }
        await new Promise(r => setTimeout(r, 500));
      }

      // Phase 1: Consume events from queue until completion or cancel.
      // W6-T3: safety net re-enabled at 60min — large-file generations survive,
      // but a truly dead stream can no longer hang forever. User can still
      // hard-cancel at any time by sending a new message.
      const MESSAGE_SAFETY_TIMEOUT_MS = 60 * 60 * 1000;
      const messageStartTime = Date.now();

      // v7.0: Soft cancel drain tracking
      let softCancelDrainStart = null;
      const SOFT_CANCEL_DRAIN_TIMEOUT = 24 * 60 * 60 * 1000; // 24h — wait forever for drain

      while (!isComplete) {
        // v7.0: HARD cancel check (from new message) — drain actions then throw
        if (stopConsuming) {
          log.warn(`[sendMessageStream] Hard cancel signaled for user ${hashUserId(userId)} — draining pending actions`);
          while (queue.lastReadIndex < queue.events.length) {
            const ev = queue.events[queue.lastReadIndex++];
            if (ev.type === 'action_detected') {
              const dedupKey = this._dedupKeyForAction(ev);
              if (!emittedActionCodes.has(dedupKey)) {
                emittedActionCodes.add(dedupKey);
                domActionsCount++;
                yield { type: 'action_detected', action: ev.action, source: ev.source, code: ev.code, kimiResult: ev.kimiResult, kimiImages: ev.kimiImages };
              }
            }
          }
          throw new Error('STREAM_CANCELLED');
        }

        // v7.0 Opção 2: SOFT cancel check (user clicked red button)
        // We stop Kimi generation but keep draining the queue until:
        //   a) No more new events AND Kimi stopped generating, OR
        //   b) Drain timeout reached
        if (session?.softCancelRequested) {
          if (!softCancelDrainStart) {
            softCancelDrainStart = Date.now();
            log.info(`[sendMessageStream] Soft-cancel drain started for user ${hashUserId(userId)}`);
          }
          const hasNewEvents = queue.lastReadIndex < queue.events.length;
          const lastStateEvent = queue.events.slice().reverse().find(e => e.type === 'state_change');
          const kimiStillGenerating = lastStateEvent?.isGenerating ?? true;
          const drainElapsed = Date.now() - softCancelDrainStart;

          if (!hasNewEvents && !kimiStillGenerating) {
            log.info(`[sendMessageStream] Soft-cancel drain complete — no new events and Kimi stopped. Exiting gracefully.`);
            isComplete = true;
            break;
          }
          if (drainElapsed > SOFT_CANCEL_DRAIN_TIMEOUT) {
            log.warn(`[sendMessageStream] Soft-cancel drain timeout (${SOFT_CANCEL_DRAIN_TIMEOUT}ms) — forcing exit`);
            isComplete = true;
            break;
          }
        }

        // W6-T3: safety-net deadline. On expiry we BREAK (not throw): the
        // final-extraction tail below still runs and yields whatever text
        // exists, so the user sees the partial response plus a visible
        // warning — never silent truncation.
        if (Date.now() - messageStartTime > MESSAGE_SAFETY_TIMEOUT_MS) {
          log.warn(`[sendMessageStream] SAFETY TIMEOUT (${MESSAGE_SAFETY_TIMEOUT_MS}ms) reached for user ${hashUserId(userId)} — breaking wait loop, running final extraction with partial content`);
          yield { type: 'waiting', message: '⏱️ Limite de segurança (60min) atingido — finalizando com o conteúdo parcial...' };
          isComplete = true;
          break;
        }

        // Process all new events in queue
        while (queue.lastReadIndex < queue.events.length && !stopConsuming) {
          const ev = queue.events[queue.lastReadIndex++];

          switch (ev.type) {
            case 'state_change': {
              const t = ev.thinking || '';
              const r = ev.response || '';

              // Yield thinking deltas
              if (t && t !== lastThinking) {
                const delta = t.slice(lastThinking.length);
                if (delta) {
                  yield { type: 'thinking_delta', text: delta, fullThinking: t };
                } else if (t.length < lastThinking.length) {
                  log.info(`[stream] thinking DOM shrank ${lastThinking.length} -> ${t.length}, skipping repeat`);
                }
                lastThinking = t;
              }

              // Yield response deltas
              // Wave2-fix E: diff against the per-source cursor instead of the
              // shared lastResponse — producers with divergent extractions no
              // longer spray duplicated/corrupted chunks.
              if (r && r !== lastResponse) {
                const { emit, diverged } = responseCursor.next(ev.source, r);
                if (diverged) {
                  const srcKey = ev.source || 'unknown';
                  if (!divergedSourcesLogged.has(srcKey)) {
                    divergedSourcesLogged.add(srcKey);
                    log.warn(`[sendMessageStream] Response source '${srcKey}' diverged from committed text — swallowing chunk to avoid duplicated stream`);
                  }
                }
                if (emit) {
                  let delta = emit;
                  // W8-T2c: a JSON wrapper starting mid-delta (prose followed by
                  // {"tool"/{"script"/{"response") used to leak raw JSON into the
                  // chat and lose the tool. Emit the prose prefix as normal text
                  // and let the existing accumulator path buffer the wrapper tail.
                  if (!isAccumulatingJson && !looksLikeJsonStart(delta)) {
                    const wrapperIdx = findMidTextJsonWrapperStart(delta);
                    if (wrapperIdx > 0) {
                      yield { type: 'response_delta', text: delta.slice(0, wrapperIdx) };
                      delta = delta.slice(wrapperIdx);
                    }
                  }
                  // v9.4-fix: JSON Accumulation Buffer
                  // Once accumulating, ALL chunks go to the buffer — never emit as response_delta
                  if (isAccumulatingJson) {
                    jsonAccumulator += delta;
                    if (isJsonComplete(jsonAccumulator)) {
                      const extracted = extractResponseFromCompleteJson(jsonAccumulator);
                      isAccumulatingJson = false;
                      jsonAccumulator = '';
                      if (extracted) {
                        if (extracted.type === 'response') {
                          yield { type: 'response_delta', text: extracted.text };
                        } else if (extracted.type === 'tool') {
                          yield { type: 'action_detected', action: { tool: extracted.tool, params: extracted.params }, source: 'json_buffer' };
                        } else if (extracted.type === 'script') {
                          yield { type: 'action_detected', action: { tool: 'executeScript', params: { code: extracted.script, language: extracted.language || 'bash' } }, source: 'json_buffer' };
                        }
                        // v10.24-fix: A complete JSON wrapper means Kimi is done — finish the stream.
                        isComplete = true;
                      }
                    }
                  }
                  // If chunk looks like start of JSON wrapper, enter accumulation mode
                  else if (looksLikeJsonStart(delta)) {
                    isAccumulatingJson = true;
                    jsonAccumulator = delta;
                    // If by chance it's already complete (small JSON), process immediately
                    if (isJsonComplete(jsonAccumulator)) {
                      const extracted = extractResponseFromCompleteJson(jsonAccumulator);
                      isAccumulatingJson = false;
                      jsonAccumulator = '';
                      if (extracted) {
                        if (extracted.type === 'response') {
                          yield { type: 'response_delta', text: extracted.text };
                        } else if (extracted.type === 'tool') {
                          yield { type: 'action_detected', action: { tool: extracted.tool, params: extracted.params }, source: 'json_buffer' };
                        } else if (extracted.type === 'script') {
                          yield { type: 'action_detected', action: { tool: 'executeScript', params: { code: extracted.script, language: extracted.language || 'bash' } }, source: 'json_buffer' };
                        }
                        // v10.24-fix: A complete JSON wrapper means Kimi is done — finish the stream.
                        isComplete = true;
                      }
                    }
                  }
                  // Plain text — emit normally
                  else {
                    yield { type: 'response_delta', text: delta };
                  }
                } else if (r.length < lastResponse.length) {
                  // DOM shrank — if we were accumulating, discard and reset
                  if (isAccumulatingJson) {
                    isAccumulatingJson = false;
                    jsonAccumulator = '';
                  }
                  const cleanR = extractResponseFromCompleteJson(r);
                  if (cleanR) {
                    if (cleanR.type === 'response') {
                      yield { type: 'response_delta', text: cleanR.text };
                    } else if (cleanR.type === 'tool') {
                      yield { type: 'action_detected', action: { tool: cleanR.tool, params: cleanR.params }, source: 'json_buffer' };
                    } else if (cleanR.type === 'script') {
                      yield { type: 'action_detected', action: { tool: 'executeScript', params: { code: cleanR.script, language: cleanR.language || 'bash' } }, source: 'json_buffer' };
                    }
                    // v10.24-fix: A complete JSON wrapper means Kimi is done — finish the stream.
                    isComplete = true;
                  }
                }
                lastResponse = r;
              }

              // Yield steer availability
              if (ev.canSteer !== lastCanSteer) {
                yield { type: 'can_steer', value: ev.canSteer };
                lastCanSteer = ev.canSteer;
              }

              log.info(`[stream] queue poll: thinking=${t.length} response=${r.length} source=${ev.source||'unknown'} canSteer=${ev.canSteer} isGen=${ev.isGenerating}`);
              break;
            }

            case 'action_detected': {
              const dedupKey = this._dedupKeyForAction(ev);
              if (!emittedActionCodes.has(dedupKey)) {
                emittedActionCodes.add(dedupKey);
                domActionsCount++;
                if (ev.source === 'dom_mirror') {
                  log.info(`[DOM MIRROR] Detected ${ev.action?.tool || 'unknown'} block`);
                } else {
                  log.info(`[JSON STREAM] Action detected: ${ev.action?.tool || 'unknown'}`);
                }
                yield {
                  type: 'action_detected',
                  action: ev.action,
                  source: ev.source,
                  code: ev.code,
                  kimiResult: ev.kimiResult,
                  kimiImages: ev.kimiImages,
                };
              }
              break;
            }

            case 'response_detected': {
              const hash = crypto.createHash('sha256').update(ev.response).digest('hex').slice(0, 16);
              if (!emittedResponseHashes.has(hash)) {
                emittedResponseHashes.add(hash);
                log.info(`[JSON STREAM] Response detected (${ev.response.length} chars)`);
                yield { type: 'response_detected', response: ev.response, source: ev.source };
              }
              break;
            }

            // v8.5-fix: Direct thinking/response deltas from ultra-light observer
            case 'thinking_delta': {
              const t = ev.fullThinking || ev.text || '';
              if (t && t !== lastThinking) {
                const delta = t.slice(lastThinking.length);
                if (delta) {
                  yield { type: 'thinking_delta', text: delta, fullThinking: t };
                }
                lastThinking = t;
              }
              break;
            }
            case 'response_delta': {
              const r = ev.fullResponse || ev.text || '';
              if (r && r !== lastResponse) {
                // Wave2-fix E: same per-source cursor as the state_change case.
                const { emit, diverged } = responseCursor.next(ev.source, r);
                if (diverged) {
                  const srcKey = ev.source || 'unknown';
                  if (!divergedSourcesLogged.has(srcKey)) {
                    divergedSourcesLogged.add(srcKey);
                    log.warn(`[sendMessageStream] Response source '${srcKey}' diverged from committed text — swallowing chunk to avoid duplicated stream`);
                  }
                }
                if (emit) {
                  yield { type: 'response_delta', text: emit };
                }
                lastResponse = r;
              }
              break;
            }

            case 'completion_candidate': {
              // Wave2-fix: right after Enter the PREVIOUS turn's response is still
              // on screen and stable, so the poller can re-fire a stale candidate
              // before any text of this turn has streamed. Ignore it.
              // Assumption: every legit turn streams SOME visible text before
              // completing (tool calls render as code blocks in the polled text).
              // A hypothetical zero-text turn (text-less tool card only) would be
              // ignored until hard-cancel — fails safe vs. the old instant-done
              // with stale content.
              if (isPrematureCompletion({ lastResponse, lastThinking })) {
                log.info(`[sendMessageStream] Ignoring completion candidate — nothing streamed yet this turn (stale)`);
                break;
              }
              log.info(`[sendMessageStream] Completion candidate received (signals=${JSON.stringify(ev.signals)})`);
              // v10.35-fix: For non-Kimi providers, a completion candidate can fire during a
              // transient pause while a long JSON wrapper (e.g., writeFile with HTML content) is
              // still being streamed. If the accumulated response looks like an incomplete JSON
              // object, ignore the candidate and keep waiting for the rest.
              const looksLikeIncompleteJson = lastResponse && lastResponse.includes('{') && !isJsonComplete(lastResponse);
              if (resolvedProvider !== 'kimi' && looksLikeIncompleteJson) {
                log.warn(`[sendMessageStream] Ignoring completion candidate — response looks like incomplete JSON (${lastResponse.length} chars)`);
                break;
              }
              isComplete = true;
              break;
            }
          }
        }

        if (isComplete) break;

        // Heartbeat
        if (++pollCount % 10 === 0) {
          yield { type: 'waiting', message: 'Processando...' };
        }

        await new Promise(r => setTimeout(r, 100));
      }

      // v7.7-INFALÍVEL: Final extraction using snapshot diff (PRIMARY strategy)
      // This captures ALL new content since preSendSnapshot, regardless of how
      // many assistants were created or how the DOM structure changed.
      let finalResponse = '';
      let extractionSource = 'none';

      try {
        const extracted = await this._extractResponseDiff(page, preSendSnapshot);
        if (extracted && extracted.trim().length > 0) {
          finalResponse = extracted.trim();
          extractionSource = 'snapshot-diff';
          log.info(`[sendMessageStream] _extractResponseDiff success: ${finalResponse.length} chars`);
        }
      } catch (e) {
        log.warn(`[sendMessageStream] _extractResponseDiff failed: ${e.message}`);
      }

      // Fallback: if snapshot diff returned nothing or failed, try old strategies
      if (!finalResponse) {
        try {
          const extractOptions = targetAssistantIndex >= 0 ? { preferAssistantIndex: targetAssistantIndex, userId } : { userId };
          const extracted = await this._extractResponse(page, extractOptions);
          if (extracted && extracted.trim().length > 0) {
            finalResponse = extracted.trim();
            extractionSource = 'target-assistant';
            log.info(`[sendMessageStream] _extractResponse fallback success: ${finalResponse.length} chars (assistant ${targetAssistantIndex})`);
          }
        } catch (e) {
          log.warn(`_extractResponse fallback failed: ${e.message}`);
        }
      }

      // Smart fallback: if extracted thinking-like but lastResponse has JSON/code
      const hasJsonOrCode = (text) => text && (text.includes('"tool"') || text.includes('"response"') || text.includes('```'));
      const looksLikeThinking = (text) => text && text.length < 100 && !text.includes('{') && !text.includes('```');

      if (finalResponse && lastResponse && hasJsonOrCode(lastResponse) && looksLikeThinking(finalResponse)) {
        log.warn(`[sendMessageStream] Extracted thinking-like text (${finalResponse.length} chars) but lastResponse has JSON/code (${lastResponse.length} chars). Using lastResponse.`);
        finalResponse = lastResponse;
        extractionSource = 'lastResponse-swap';
      }

      // v10.35-fix: For non-Kimi providers, the DOM-based final extraction often returns a
      // truncated version of a long JSON tool/response, while the streaming poller already
      // saw the complete text. If lastResponse is longer and contains a valid JSON wrapper
      // or tool, prefer it so large HTML games / file writes are not cut off.
      if (lastResponse && lastResponse.length > (finalResponse?.length || 0) && hasJsonOrCode(lastResponse)) {
        try {
          const maybeJson = lastResponse.trim();
          // Accept either a JSON wrapper {"response":"..."} / {"message":"..."} or a tool JSON.
          const isValidWrapper = maybeJson.startsWith('{') && JSON.parse(maybeJson) && (maybeJson.includes('"response"') || maybeJson.includes('"message"') || maybeJson.includes('"tool"'));
          if (isValidWrapper) {
            log.warn(`[sendMessageStream] lastResponse (${lastResponse.length} chars) is longer than extracted (${finalResponse.length} chars) and contains valid JSON. Using lastResponse.`);
            finalResponse = lastResponse;
            extractionSource = 'lastResponse-longer-json';
          }
        } catch {
          // lastResponse is not parseable JSON — keep the extracted finalResponse.
        }
      }

      // CRITICAL fallback: only use lastResponse if we actually saw it change during this stream
      if (!finalResponse) {
        const sawResponseDuringStream = lastResponse && lastResponse.length > 0 && lastResponse !== initialText;
        if (sawResponseDuringStream) {
          finalResponse = lastResponse;
          extractionSource = 'lastResponse-fallback';
          log.info(`[sendMessageStream] Using lastResponse as fallback: ${finalResponse.length} chars`);
        } else if (lastThinking && lastThinking.length > 10) {
          finalResponse = lastThinking;
          extractionSource = 'lastThinking-fallback';
        }
      }

      log.info(`[sendMessageStream] finalResponse=${finalResponse.length} domActions=${domActionsCount}`);

      // v9.6-fix: Guard against undefined session (userSessions may not have entry yet)
      if (session) {
        session.chatUrl = page.url();
        this._saveChatUrl(userId, session.chatUrl);
      }

      const parsedText = this._extractParsedText(finalResponse);
      if (parsedText && parsedText !== finalResponse) {
        log.info(`[sendMessageStream] Parsed JSON response: ${finalResponse.length} -> ${parsedText.length} chars`);
        finalResponse = parsedText;
      }

      // v7.5-fix: Robust late action detection using _extractJsonToolCalls instead of regex.
      // This catches JSON tool calls anywhere in the text, including inside code blocks.
      const lateActions = this._extractJsonToolCalls(finalResponse);
      for (const action of lateActions) {
        const actionHash = this._dedupKeyForAction({ action: { tool: action.tool, params: action.params } });
        if (!emittedActionCodes.has(actionHash)) {
          emittedActionCodes.add(actionHash);
          domActionsCount++;
          log.info(`[JSON STREAM] Late action detected in finalResponse: ${action.tool}`);
          yield {
            type: 'action_detected',
            action: { tool: action.tool, params: action.params },
            source: 'json_block',
          };
        }
      }

      const isContextLimit = this._isContextLimitResponse(finalResponse);
      if (isContextLimit) {
        log.warn(`[sendMessageStream] Context limit detected`);
        yield { type: 'context_limit', response: finalResponse, thinking: lastThinking };
      } else {
        yield { type: 'done', response: finalResponse, thinking: lastThinking };
      }
      log.info(`[DEBUG-LUNA] sendMessageStream finished for user ${hashUserId(userId)}`);

    } catch (err) {
      if (err.message === 'STREAM_CANCELLED') {
        log.info(`[sendMessageStream] Stream cancelled gracefully for user ${hashUserId(userId)}`);
      } else {
        log.error(`[sendMessageStream] Error for user ${hashUserId(userId)} (provider=${resolvedProvider}): ${err.message}`);
        log.error(`[sendMessageStream] Stack: ${err.stack}`);
        // W7-T4: Lexical-safe clear (fill('') leaves desynced text in the box).
        try { await this._fillContentEditable(page.locator('textarea, [contenteditable="true"]').first(), ''); } catch {}
        throw err;
      }
    } finally {
      // Wave2-fix: the DOM poller is now bounded to the active stream.
      // Previously (v7.0) it kept running between turns and fed stale events
      // (old-turn completion_candidate / state_change) into the next message.
      // It is restarted per message at :7249 — _startDomPoller early-returns
      // only while active, so it restarts cleanly after this stop.
      try {
        await this._stopDomPoller(userId);
      } catch (e) {
        log.warn(`[sendMessageStream] _stopDomPoller failed: ${e.message}`);
      }
      if (session) {
        session.processing = false;
        session.softCancelRequested = false; // v7.0: clear soft cancel flag
        session.lastActivity = Date.now();
      }
      this.cancelledStreams.delete(userId);
      this.streamStopFlags.delete(userId);
    }
  }

  /**
   * v7.0: Helper para gerar chave de deduplicação de ação.
   * v10.24-fix: Use tool + normalized params as the single source of truth,
   * independentemente da fonte (extension, network interceptor, DOM observer,
   * snapshot diff). A mesma ação detectada por camadas diferentes deve gerar
   * a MESMA chave, impedindo execução duplicada.
   */
  _dedupKeyForAction(ev) {
    const tool = ev.action?.tool || ev.action?.type || '';
    const params = this._normalizeActionParams(ev.action?.params || {});
    const paramsJson = JSON.stringify(params);
    return crypto.createHash('sha256').update(`${tool}:${paramsJson}`).digest('hex').slice(0, 16);
  }

  /**
   * Normaliza params para deduplicação: ordena chaves de objetos e ignora
   * diferenças irrelevantes (espaços, ordem de chaves).
   */
  _normalizeActionParams(params) {
    if (params === null || typeof params !== 'object') return params;
    if (Array.isArray(params)) {
      return params.map(p => this._normalizeActionParams(p));
    }
    const sorted = {};
    for (const key of Object.keys(params).sort()) {
      sorted[key] = this._normalizeActionParams(params[key]);
    }
    return sorted;
  }

  /**
   * Cancel an active stream for a user.
   * v5.3-fix: Sets cancel flag, clicks stop button on Kimi Web, and forces processing reset.
   * This is the REAL cancellation — unlike the old server-side-only cancel.
   */
  async cancelStream(userId, soft = false) {
    log.info(`[cancelStream] v7.0 ${soft ? 'soft' : 'hard'}-cancel for user ${hashUserId(userId)}`);

    const session = this.userSessions.get(userId);

    if (soft) {
      // v7.0 Opção 2 — STOP KIMI + DRAIN:
      // User clicked red button. We STOP Kimi from generating more text,
      // but let the stream continue to drain any pending tools from the queue.
      // Input is freed immediately so user can type the next message.
      log.info(`[cancelStream] Soft-cancel (stop+drain) for user ${hashUserId(userId)}`);

      // 1. Click stop button on Kimi Web — stop generating more tokens
      await this.abortGeneration(userId);

      // 2. Set flag so sendMessageStream knows to drain and exit gracefully
      if (session) {
        session.softCancelRequested = true;
        session.processing = false; // free input
        session.lastActivity = Date.now();
        log.info(`[cancelStream] Soft-cancel: Kimi stopped, input freed for user ${hashUserId(userId)}, stream will drain pending tools`);
      }

      // 3. Do NOT call stopFn — the stream stays alive to drain the queue
      return true;
    }

    // HARD CANCEL (new message sent, or explicit kill):
    // Stop Kimi generation AND kill the stream.

    // 1. Click stop button on Kimi Web to halt generation
    await this.abortGeneration(userId);

    // 2. Signal the stream to stop consuming NEW events.
    const stopFn = this.streamStopFlags.get(userId);
    if (stopFn) {
      stopFn();
      log.info(`[cancelStream] Hard-cancel signal sent to stream for user ${hashUserId(userId)}`);
    } else {
      // Fallback: if no stream is actively listening, set legacy cancel flag
      this.cancelledStreams.set(userId, true);
    }

    // 3. Tell poller to skip non-critical events so queue drains faster
    if (session) {
      session.domPollerSkipNonCritical = true;
      session.lastActivity = Date.now();
      
      // Wait for stream to drain (max 3s)
      const drainStart = Date.now();
      while (session.processing && Date.now() - drainStart < 3000) {
        await new Promise(r => setTimeout(r, 200));
      }
      if (session.processing) {
        log.warn(`[cancelStream] Stream did not drain in 3s — forcing processing=false`);
        session.processing = false;
      }
      
      // Reset skip flag after drain
      session.domPollerSkipNonCritical = false;
    }

    this.cancelledStreams.delete(userId);
    return true;
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
    return this._extractResponse(page, { userId });
  }

  /**
   * Anonymous consultation with Kimi Web — NO LOGIN required.
   * Creates a fresh incognito context, asks Kimi, returns the response text.
   * Used by Luna to consult Kimi as a "second brain" for code review, architecture,
   * and technical decisions without interfering with the user's session.
   */
  async anonymousConsult(prompt, options = {}, provider = 'kimi') {
    await this._ensureConnected();

    const resolvedProvider = provider || 'kimi';
    const providerCfg = this._loadProviderConfig(resolvedProvider);
    const mode = options.mode || 'thinking';
    log.info(`[anonymousConsult] Starting anonymous ${resolvedProvider} consultation (mode=${mode})`);

    let ctx = null;
    let page = null;

    try {
      // Create a completely isolated incognito context
      ctx = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        locale: 'pt-BR',
      });
      page = await ctx.newPage();
      page._lunaProvider = resolvedProvider;

      // Navigate to provider
      const startUrl = providerCfg.baseUrl;
      log.info(`[anonymousConsult] Navigating to ${startUrl}...`);
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
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
      const inputSelector = getProviderInputSelector(providerCfg) || 'textarea, [contenteditable="true"]';
      const inputLocator = page.locator(inputSelector).first();
      await inputLocator.waitFor({ state: 'visible', timeout: 0 });
      // W7-T4: Lexical-safe fill — fill() desyncs the React/Lexical
      // EditorState (visible text, Enter becomes a no-op).
      await this._fillContentEditable(inputLocator, prompt);
      // Capture initial text BEFORE sending — critical for fast responses.
      // v10.18-fix: Use finite timeout — landing page has no markdown yet.
      const responseSelectors = getProviderResponseSelectors(providerCfg);
      const initialText = await page.locator(responseSelectors.container || '.markdown-container').last().innerText({ timeout: 2000 }).catch(() => '');

      await page.waitForTimeout(500);
      // W7-T4: verify-and-retry submit
      await this._submitWithVerification(page, inputLocator, prompt, { provider: resolvedProvider });
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
        const poll = await this._pollThinkingAndResponse(page, null);
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

      // Stream until complete — NO TIMEOUTS, wait forever for Kimi
      let lastTextChangeTime = Date.now();
      const streamStartTime = Date.now();

      while (!isComplete) {
        const poll = await this._pollThinkingAndResponse(page, null);

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
              const recheck = await this._pollThinkingAndResponse(page, null);
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

          // NO FALLBACK TIMEOUTS — wait forever for Kimi to finish
        if (++pollCount % 10 === 0) {
          log.info(`[anonymousConsult] Still processing... response=${lastResponse.length} chars`);
        }
        await new Promise(r => setTimeout(r, pollInterval));
      }

      // Final clean extraction
      let finalResponse = lastResponse;
      try {
        const extracted = await this._extractResponse(page, { userId });
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
  // W6-T9: exported for unit tests. _extractJsonToolCalls is a pure method
  // (verified: no `this` usage in its body), so a prototype-level wrapper is safe.
  extractResponseFromCompleteJson,
  _extractJsonToolCalls: (text) => KimiBridge.prototype._extractJsonToolCalls.call(null, text),
  // W6-T12: pure helper exported for unit tests.
  _shouldForceGenericComplete,
};
