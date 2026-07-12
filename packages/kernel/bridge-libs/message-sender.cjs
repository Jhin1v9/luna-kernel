const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================
// CONFIG fallback (mirrors kimi-bridge.cjs module-level constants)
// ============================================================
let config;
try {
  config = require('../config/luna-config');
} catch {
  config = null;
}

const KIMI_MODE_URLS = config?.KIMI?.modeUrls || {
  instant: 'https://www.kimi.com/?chat_enter_method=new_chat&lang=en',
  thinking: 'https://www.kimi.com/?chat_enter_method=new_chat&lang=en',
};

const MAX_TEXT_TYPE_LENGTH = parseInt(process.env.KIMI_MAX_TYPE_LENGTH, 10)
  || config?.KIMI?.maxTextTypeLength
  || 500;

const ARTIFACTS_DIR = config?.PATHS?.artifacts
  || path.join(__dirname, '..', 'ARTIFACTS');

// ============================================================
// UTILS
// ============================================================
function hashUserId(userId) {
  return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 8);
}

function looksLikeJsonStart(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trimStart();
  return t.startsWith('{') && (t.includes('"response"') || t.includes('"tool"') || t.includes('"script"'));
}

function isJsonComplete(text) {
  if (!text) return false;
  let depth = 0;
  let inString = false;
  let escape = false;
  let foundFirstBrace = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (!inString) {
      if (c === '{') { depth++; foundFirstBrace = true; }
      else if (c === '}') depth--;
    }
  }
  return foundFirstBrace && depth === 0;
}

function extractResponseFromCompleteJson(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed.response !== undefined && typeof parsed.response === 'string') {
      return { type: 'response', text: parsed.response };
    }
    if (parsed.tool !== undefined) {
      return { type: 'tool', tool: parsed.tool, params: parsed.params || {} };
    }
    if (parsed.script !== undefined) {
      return { type: 'script', script: parsed.script };
    }
  } catch {}
  try {
    const respMatch = text.match(/"response"\s*:\s*"([\s\S]*?)"\s*[,}]/);
    if (respMatch) {
      return { type: 'response', text: respMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') };
    }
  } catch {}
  return null;
}

// ============================================================
// MessageSender — unified sendMessage / sendImage / sendMessageStream
// ============================================================
class MessageSender {
  constructor(bridge, log) {
    this.bridge = bridge;
    this.log = log;
  }

  /**
   * Shared pre-send + send logic used by all three public methods.
   *
   * @param {Page} page         — Playwright page (already obtained by caller)
   * @param {string} userId
   * @param {object} payload    — { type: 'text', text } | { type: 'image', imagePath, text? }
   * @param {object} options
   * @returns {object}          — { actualMode, preSendSnapshot, preSendAssistantCount, targetAssistantIndex, initialText, session }
   */
  async _sendPayload(page, userId, payload, options = {}) {
    const session = this.bridge.userSessions.get(userId);

    // Reset legacy stream interceptor
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

    // Wait for any ongoing processing
    if (session?.processing) {
      this.log.warn(`User ${hashUserId(userId)} is already processing — queueing`);
      while (session?.processing) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    if (session) {
      session.processing = true;
      session.lastActivity = Date.now();
    }

    // Reset network interceptor (harmless to call even if not used by caller)
    const interceptor = await this.bridge._getOrCreateInterceptor(userId);
    if (interceptor) interceptor.reset();

    await this.bridge._verifySession(page);

    // Handle newChat option
    if (options.newChat) {
      await page.goto('https://www.kimi.com/?chat_enter_method=new_chat&lang=en', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      if (session) {
        session.chatUrl = page.url();
        this.bridge._saveChatUrl(userId, session.chatUrl);
      }
    }

    // URL mismatch check
    const currentUrl = page.url();
    if (session?.chatUrl && !currentUrl.includes(session.chatUrl.split('?')[0].split('/').pop())) {
      this.log.info(`URL mismatch: current=${currentUrl}, expected=${session.chatUrl} — navigating to correct chat`);
      await page.goto(session.chatUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
      await page.waitForTimeout(1500);
    }

    // Set mode if specified
    if (options.mode) {
      await this.bridge.setMode(userId, options.mode);
    }

    const actualMode = await this.bridge._detectActualMode(page) || session?.mode || 'instant';

    const inputLocator = page.locator('textarea, [contenteditable="true"]').first();
    const inputCount = await inputLocator.count();
    if (inputCount === 0) {
      throw new Error('Input field not found on Kimi Web');
    }

    await page.bringToFront();

    let initialText = '';
    let preSendSnapshot = [];
    let preSendAssistantCount = 0;
    let targetAssistantIndex = -1;

    // ── IMAGE PATH ──
    if (payload.type === 'image') {
      this.log.info(`User ${hashUserId(userId)} sending image (text=${payload.text ? 'yes' : 'no'}, mode=${actualMode})`);

      const toolkitBtn = page.locator('.toolkit-trigger-btn').first();
      const hasToolkit = await toolkitBtn.count() > 0;
      if (hasToolkit) {
        await toolkitBtn.click();
        await page.waitForTimeout(500);
      }

      const fileInput = page.locator('.hidden-input, input[type="file"]').first();
      await fileInput.setInputFiles(payload.imagePath);
      this.log.info(`File input populated via native input: ${payload.imagePath}`);

      await page.evaluate(() => {
        const input = document.querySelector('.hidden-input') || document.querySelector('input[type="file"]');
        if (input) {
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });

      // Wait for Kimi UI to process the thumbnail/preview
      await page.waitForTimeout(2000);

      // Optional accompanying text
      if (payload.text && payload.text.trim()) {
        await inputLocator.fill('');
        await page.waitForTimeout(300);
        if (payload.text.length <= MAX_TEXT_TYPE_LENGTH) {
          await inputLocator.type(payload.text, { delay: 50 });
        } else {
          await inputLocator.fill(payload.text);
        }
        await page.waitForTimeout(500);
      }
    }
    // ── TEXT PATH ──
    else {
      const text = payload.text;
      this.log.info(`User ${hashUserId(userId)} sending message (len=${text.length}, mode=${actualMode}, url=${page.url()})`);

      const captureTimeout = options.initialTextCaptureTimeout ?? 0;
      initialText = await page.locator('.markdown-container .markdown').last().innerText({ timeout: captureTimeout }).catch(() => '');

      await inputLocator.fill('');
      await page.waitForTimeout(300);

      if (text.length <= MAX_TEXT_TYPE_LENGTH) {
        await inputLocator.type(text, { delay: 50 });
      } else {
        this.log.info(`Text too long (${text.length} chars), using fill instead of type`);
        await inputLocator.fill(text);
      }
      await page.waitForTimeout(500 + Math.floor(Math.random() * 1000));

      preSendSnapshot = await this.bridge._capturePreSendSnapshot(page);
      preSendAssistantCount = preSendSnapshot.length;
    }

    // Press Enter to send
    await inputLocator.press('Enter');
    this.log.info(`Payload sent for user ${hashUserId(userId)}`);

    // Detect new assistant (text payloads only — image relies on simpler extraction)
    if (payload.type === 'text') {
      let newAssistantWaitCount = 0;
      while (targetAssistantIndex < 0 && newAssistantWaitCount < 100) { // 10 s max
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
            this.log.info(`[_sendPayload] New assistant detected at index ${targetAssistantIndex}, textLen=${newAssistant.textLength}`);
          }
        }
        await new Promise(r => setTimeout(r, 100));
        newAssistantWaitCount++;
      }
    }

    return { actualMode, preSendSnapshot, preSendAssistantCount, targetAssistantIndex, initialText, session };
  }

  /**
   * Send a plain-text message.
   */
  async sendMessage(userId, text, options = {}) {
    if (!text || !text.trim()) {
      throw new Error('Message text is required');
    }

    this.bridge._checkCooldown(userId);
    const page = await this.bridge._getOrCreateUserPage(userId);

    const { actualMode, preSendSnapshot, targetAssistantIndex, initialText, session } =
      await this._sendPayload(page, userId, { type: 'text', text }, options);

    try {
      const lastText = await this.bridge._waitForResponse(
        page, actualMode, options.onPartialResponse || null, initialText, targetAssistantIndex
      );

      // PRIMARY extraction: snapshot diff
      let response = '';
      try {
        const extracted = await this.bridge._extractResponseDiff(page, preSendSnapshot);
        if (extracted && extracted.trim().length > 0) {
          response = extracted.trim();
          this.log.info(`[sendMessage] _extractResponseDiff success: ${response.length} chars`);
        }
      } catch (e) {
        this.log.warn(`[sendMessage] _extractResponseDiff failed: ${e.message}`);
      }

      // Fallback: old extraction strategy
      if (!response) {
        const extractOptions = targetAssistantIndex >= 0
          ? { preferAssistantIndex: targetAssistantIndex, userId }
          : { userId };
        response = await this.bridge._extractResponse(page, extractOptions);
      }

      // CRITICAL: _extractResponse can return incomplete text
      if (lastText && lastText.length > 0) {
        const ratio = response.length > 0 ? response.length / lastText.length : 0;
        if (ratio < 0.5 && lastText.length > response.length) {
          this.log.warn(`sendMessage: extraction incomplete (${response.length} vs polled ${lastText.length}), using polled text as fallback`);
          response = lastText;
        }
      }

      session.chatUrl = page.url();
      this.bridge._saveChatUrl(userId, session.chatUrl);

      this.log.success(`Response ready for user ${hashUserId(userId)} (len=${response.length})`);
      return { response, chatUrl: session.chatUrl, mode: session.mode };
    } catch (err) {
      try { await page.locator('textarea, [contenteditable="true"]').first().fill(''); } catch {}
      throw err;
    } finally {
      session.processing = false;
      session.lastActivity = Date.now();
    }
  }

  /**
   * Send an image (with optional text).
   */
  async sendImage(userId, imageBase64, text = '', options = {}) {
    if (!imageBase64 || !imageBase64.trim()) {
      throw new Error('Image base64 is required');
    }

    this.bridge._checkCooldown(userId);

    const tmpDir = path.join(ARTIFACTS_DIR, 'tmp-uploads');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `kimi-upload-${hashUserId(userId)}-${Date.now()}.png`);
    const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    fs.writeFileSync(tmpFile, buffer);
    this.log.info(`Image saved to temp file: ${tmpFile} (${buffer.length} bytes)`);

    const page = await this.bridge._getOrCreateUserPage(userId);
    let result;
    let session;

    try {
      const ctx = await this._sendPayload(page, userId, { type: 'image', imagePath: tmpFile, text }, options);
      session = ctx.session;
      const { actualMode } = ctx;

      const lastText = await this.bridge._waitForResponse(page, actualMode, options.onPartialResponse || null);
      let response = await this.bridge._extractResponse(page, { userId });

      if (lastText && lastText.length > 0) {
        const ratio = response.length > 0 ? response.length / lastText.length : 0;
        if (ratio < 0.5 && lastText.length > response.length) {
          this.log.warn(`sendImage: _extractResponse incomplete (${response.length} vs polled ${lastText.length}), using polled text as fallback`);
          response = lastText;
        }
      }

      session.chatUrl = page.url();
      this.bridge._saveChatUrl(userId, session.chatUrl);

      this.log.success(`Response ready for user ${hashUserId(userId)} (len=${response.length})`);
      result = { response, chatUrl: session.chatUrl, mode: session.mode };
    } catch (err) {
      try { await page.locator('textarea, [contenteditable="true"]').first().fill(''); } catch {}
      throw err;
    } finally {
      if (session) {
        session.processing = false;
        session.lastActivity = Date.now();
      }
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    return result;
  }

  /**
   * Stream a text message as an async generator.
   */
  async *sendMessageStream(userId, text, options = {}) {
    this.log.info(`[DEBUG-LUNA] sendMessageStream started for user ${hashUserId(userId)}`);
    if (!text || !text.trim()) {
      throw new Error('Message text is required');
    }

    const session = this.bridge.userSessions.get(userId);
    if (session) {
      session._completionState = null;
      session.softCancelRequested = false;
    }

    this.bridge._checkCooldown(userId);
    const page = await this.bridge._getOrCreateUserPage(userId);

    // Network interceptor reset (must happen BEFORE _sendPayload for stream)
    const interceptor = await this.bridge._getOrCreateInterceptor(userId);
    if (interceptor) interceptor.reset();

    if (session?.processing) {
      this.log.warn(`[DEBUG-LUNA] User ${hashUserId(userId)} already processing — waiting for drain (no timeout)`);
      while (session?.processing) {
        await new Promise(r => setTimeout(r, 500));
      }
      this.log.warn(`[DEBUG-LUNA] Previous drain complete for user ${hashUserId(userId)}`);
    }

    if (session) {
      session.processing = true;
      session.lastActivity = Date.now();
    }
    this.bridge.cancelledStreams.delete(userId);
    this.bridge.streamStopFlags.delete(userId);

    // v6.1-fix: Inject text file contents directly into the prompt
    let streamText = text;
    if (options.files && options.files.length > 0) {
      for (const file of options.files) {
        if (file.name && file.name.endsWith('.txt') && file.data && file.data.includes('base64')) {
          try {
            const base64Match = file.data.match(/^data:.*?;base64,(.+)$/);
            if (!base64Match) {
              this.log.warn(`[sendMessageStream] Data URI does not contain valid base64: ${file.name}`);
              continue;
            }
            const decoded = Buffer.from(base64Match[1], 'base64').toString('utf8');
            const placeholderRegex = /\[(?:Arquivo anexado|Anexo|File attached):\s*[^\]]+\]/i;
            if (placeholderRegex.test(streamText)) {
              streamText = streamText.replace(placeholderRegex, decoded);
              this.log.info(`[sendMessageStream] Injected ${decoded.length} chars from ${file.name} into prompt`);
            } else {
              streamText = streamText + '\n\n---\n' + decoded;
              this.log.info(`[sendMessageStream] Appended ${decoded.length} chars from ${file.name} to prompt`);
            }
            file._injected = true;
          } catch (e) {
            this.log.error(`[sendMessageStream] Failed to decode ${file.name}: ${e.message}`);
          }
        }
      }
      options.files = options.files.filter(f => !f._injected);
    }

    const { actualMode, preSendSnapshot, preSendAssistantCount, targetAssistantIndex, initialText } =
      await this._sendPayload(page, userId, { type: 'text', text: streamText }, {
        ...options,
        initialTextCaptureTimeout: 2000, // v9.6-fix: real timeout so home-screen doesn't hang
      });

    await page.waitForTimeout(600);

    // v7.0: Initialize per-message event queue and start DOM poller
    const queueId = `q-${Date.now()}`;
    this.bridge.domEventQueues.set(userId, { events: [], lastReadIndex: 0, createdAt: Date.now(), queueId });
    const queue = this.bridge.domEventQueues.get(userId);
    this.bridge._startDomPoller(userId);

    let lastThinking = '';
    let lastResponse = '';
    let lastCanSteer = false;
    let isComplete = false;
    let stopConsuming = false;
    let pollCount = 0;
    let textHasChanged = false;

    let jsonAccumulator = '';
    let isAccumulatingJson = false;

    const emittedActionCodes = new Set();
    const emittedResponseHashes = new Set();
    const emittedJsonActionHashes = new Set();
    let domActionsCount = 0;

    this.bridge.streamStopFlags.set(userId, () => { stopConsuming = true; });

    try {
      // Phase 0: Wait for first text change via queue events
      while (!textHasChanged && !stopConsuming) {
        while (queue.lastReadIndex < queue.events.length) {
          const ev = queue.events[queue.lastReadIndex++];
          if (ev.type === 'state_change') {
            const combined = (ev.thinking || '') + (ev.response || '');
            if (combined !== initialText && combined.length > 0) {
              textHasChanged = true;
              lastThinking = ev.thinking || '';
              lastResponse = ev.response || '';
              break;
            }
            if (ev.isGenerating && pollCount > 3) {
              textHasChanged = true;
              break;
            }
          }
        }
        if (++pollCount % 5 === 0) {
          yield { type: 'waiting', message: 'Aguardando resposta do Kimi...' };
        }
        await new Promise(r => setTimeout(r, 500));
      }

      // Phase 1: Consume events from queue until completion or cancel
      const SOFT_CANCEL_DRAIN_TIMEOUT = 24 * 60 * 60 * 1000; // 24 h — wait forever for drain
      let softCancelDrainStart = null;

      while (!isComplete) {
        // HARD cancel check
        if (stopConsuming) {
          this.log.warn(`[sendMessageStream] Hard cancel signaled for user ${hashUserId(userId)} — draining pending actions`);
          while (queue.lastReadIndex < queue.events.length) {
            const ev = queue.events[queue.lastReadIndex++];
            if (ev.type === 'action_detected') {
              const dedupKey = this.bridge._dedupKeyForAction(ev);
              if (!emittedActionCodes.has(dedupKey)) {
                emittedActionCodes.add(dedupKey);
                domActionsCount++;
                yield { type: 'action_detected', action: ev.action, source: ev.source, code: ev.code, kimiResult: ev.kimiResult, kimiImages: ev.kimiImages };
              }
            }
          }
          throw new Error('STREAM_CANCELLED');
        }

        // SOFT cancel check
        if (session?.softCancelRequested) {
          if (!softCancelDrainStart) {
            softCancelDrainStart = Date.now();
            this.log.info(`[sendMessageStream] Soft-cancel drain started for user ${hashUserId(userId)}`);
          }
          const hasNewEvents = queue.lastReadIndex < queue.events.length;
          const lastStateEvent = queue.events.slice().reverse().find(e => e.type === 'state_change');
          const kimiStillGenerating = lastStateEvent?.isGenerating ?? true;
          const drainElapsed = Date.now() - softCancelDrainStart;

          if (!hasNewEvents && !kimiStillGenerating) {
            this.log.info(`[sendMessageStream] Soft-cancel drain complete — no new events and Kimi stopped. Exiting gracefully.`);
            isComplete = true;
            break;
          }
          if (drainElapsed > SOFT_CANCEL_DRAIN_TIMEOUT) {
            this.log.warn(`[sendMessageStream] Soft-cancel drain timeout (${SOFT_CANCEL_DRAIN_TIMEOUT}ms) — forcing exit`);
            isComplete = true;
            break;
          }
        }

        // Process all new events in queue
        while (queue.lastReadIndex < queue.events.length && !stopConsuming) {
          const ev = queue.events[queue.lastReadIndex++];

          switch (ev.type) {
            case 'state_change': {
              const t = ev.thinking || '';
              const r = ev.response || '';

              // Thinking deltas
              if (t && t !== lastThinking) {
                const delta = t.slice(lastThinking.length);
                if (delta) {
                  yield { type: 'thinking_delta', text: delta, fullThinking: t };
                } else if (t.length < lastThinking.length) {
                  this.log.info(`[stream] thinking DOM shrank ${lastThinking.length} -> ${t.length}, skipping repeat`);
                }
                lastThinking = t;
              }

              // Response deltas
              if (r && r !== lastResponse) {
                let delta = r.slice(lastResponse.length);
                if (delta) {
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
                        }
                      }
                    }
                  } else if (looksLikeJsonStart(delta)) {
                    isAccumulatingJson = true;
                    jsonAccumulator = delta;
                    if (isJsonComplete(jsonAccumulator)) {
                      const extracted = extractResponseFromCompleteJson(jsonAccumulator);
                      isAccumulatingJson = false;
                      jsonAccumulator = '';
                      if (extracted) {
                        if (extracted.type === 'response') {
                          yield { type: 'response_delta', text: extracted.text };
                        } else if (extracted.type === 'tool') {
                          yield { type: 'action_detected', action: { tool: extracted.tool, params: extracted.params }, source: 'json_buffer' };
                        }
                      }
                    }
                  } else {
                    yield { type: 'response_delta', text: delta };
                  }
                } else if (r.length < lastResponse.length) {
                  if (isAccumulatingJson) {
                    isAccumulatingJson = false;
                    jsonAccumulator = '';
                  }
                  const cleanR = extractResponseFromCompleteJson(r);
                  if (cleanR && cleanR.type === 'response') {
                    yield { type: 'response_delta', text: cleanR.text };
                  }
                }
                lastResponse = r;
              }

              // Steer availability
              if (ev.canSteer !== lastCanSteer) {
                yield { type: 'can_steer', value: ev.canSteer };
                lastCanSteer = ev.canSteer;
              }

              this.log.info(`[stream] queue poll: thinking=${t.length} response=${r.length} source=${ev.source || 'unknown'} canSteer=${ev.canSteer} isGen=${ev.isGenerating}`);
              break;
            }

            case 'action_detected': {
              const dedupKey = this.bridge._dedupKeyForAction(ev);
              if (!emittedActionCodes.has(dedupKey)) {
                emittedActionCodes.add(dedupKey);
                domActionsCount++;
                if (ev.source === 'dom_mirror') {
                  this.log.info(`[DOM MIRROR] Detected ${ev.action?.tool || 'unknown'} block`);
                } else {
                  this.log.info(`[JSON STREAM] Action detected: ${ev.action?.tool || 'unknown'}`);
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
                this.log.info(`[JSON STREAM] Response detected (${ev.response.length} chars)`);
                yield { type: 'response_detected', response: ev.response, source: ev.source };
              }
              break;
            }

            case 'context_limit': {
              this.log.warn(`[STREAM] Context limit event from queue: ${(ev.response || '').substring(0, 100)}`);
              yield { type: 'context_limit', response: ev.response || '', source: ev.source };
              isComplete = true;
              break;
            }

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
                const delta = r.slice(lastResponse.length);
                if (delta) {
                  yield { type: 'response_delta', text: delta };
                }
                lastResponse = r;
              }
              break;
            }

            case 'completion_candidate': {
              this.log.info(`[sendMessageStream] Completion candidate received (signals=${JSON.stringify(ev.signals)})`);
              isComplete = true;
              break;
            }
          }
        }

        if (isComplete) break;

        if (++pollCount % 10 === 0) {
          yield { type: 'waiting', message: 'Processando...' };
        }
        await new Promise(r => setTimeout(r, 100));
      }

      // ── Final extraction ──
      let finalResponse = '';
      let extractionSource = 'none';

      try {
        const extracted = await this.bridge._extractResponseDiff(page, preSendSnapshot);
        if (extracted && extracted.trim().length > 0) {
          finalResponse = extracted.trim();
          extractionSource = 'snapshot-diff';
          this.log.info(`[sendMessageStream] _extractResponseDiff success: ${finalResponse.length} chars`);
        }
      } catch (e) {
        this.log.warn(`[sendMessageStream] _extractResponseDiff failed: ${e.message}`);
      }

      if (!finalResponse) {
        try {
          const extractOptions = targetAssistantIndex >= 0
            ? { preferAssistantIndex: targetAssistantIndex, userId }
            : { userId };
          const extracted = await this.bridge._extractResponse(page, extractOptions);
          if (extracted && extracted.trim().length > 0) {
            finalResponse = extracted.trim();
            extractionSource = 'target-assistant';
            this.log.info(`[sendMessageStream] _extractResponse fallback success: ${finalResponse.length} chars (assistant ${targetAssistantIndex})`);
          }
        } catch (e) {
          this.log.warn(`_extractResponse fallback failed: ${e.message}`);
        }
      }

      const hasJsonOrCode = (txt) => txt && (txt.includes('"tool"') || txt.includes('"response"') || txt.includes('```'));
      const looksLikeThinking = (txt) => txt && txt.length < 100 && !txt.includes('{') && !txt.includes('```');

      if (finalResponse && lastResponse && hasJsonOrCode(lastResponse) && looksLikeThinking(finalResponse)) {
        this.log.warn(`[sendMessageStream] Extracted thinking-like text (${finalResponse.length} chars) but lastResponse has JSON/code (${lastResponse.length} chars). Using lastResponse.`);
        finalResponse = lastResponse;
        extractionSource = 'lastResponse-swap';
      }

      if (!finalResponse) {
        const sawResponseDuringStream = lastResponse && lastResponse.length > 0 && lastResponse !== initialText;
        if (sawResponseDuringStream) {
          finalResponse = lastResponse;
          extractionSource = 'lastResponse-fallback';
          this.log.info(`[sendMessageStream] Using lastResponse as fallback: ${finalResponse.length} chars`);
        } else if (lastThinking && lastThinking.length > 10) {
          finalResponse = lastThinking;
          extractionSource = 'lastThinking-fallback';
        }
      }

      this.log.info(`[sendMessageStream] finalResponse=${finalResponse.length} domActions=${domActionsCount}`);

      if (session) {
        session.chatUrl = page.url();
        this.bridge._saveChatUrl(userId, session.chatUrl);
      }

      const parsedText = this.bridge._extractParsedText(finalResponse);
      if (parsedText && parsedText !== finalResponse) {
        this.log.info(`[sendMessageStream] Parsed JSON response: ${finalResponse.length} -> ${parsedText.length} chars`);
        finalResponse = parsedText;
      }

      const lateActions = this.bridge._extractJsonToolCalls(finalResponse);
      for (const action of lateActions) {
        const actionHash = this.bridge._dedupKeyForAction({ action: { tool: action.tool, params: action.params } });
        if (!emittedActionCodes.has(actionHash)) {
          emittedActionCodes.add(actionHash);
          domActionsCount++;
          this.log.info(`[JSON STREAM] Late action detected in finalResponse: ${action.tool}`);
          yield { type: 'action_detected', action: { tool: action.tool, params: action.params }, source: 'json_block' };
        }
      }

      const isContextLimit = /getting too long|conversation.*too long|try starting a new session|context limit|token limit|聊得太长|发起一个新会话|会话太长/i.test(finalResponse);
      if (isContextLimit) {
        this.log.warn(`[sendMessageStream] Context limit detected`);
        yield { type: 'context_limit', response: finalResponse, thinking: lastThinking };
      } else {
        yield { type: 'done', response: finalResponse, thinking: lastThinking };
      }
      this.log.info(`[DEBUG-LUNA] sendMessageStream finished for user ${hashUserId(userId)}`);

    } catch (err) {
      if (err.message === 'STREAM_CANCELLED') {
        this.log.info(`[sendMessageStream] Stream cancelled gracefully for user ${hashUserId(userId)}`);
      } else {
        try { await page.locator('textarea, [contenteditable="true"]').first().fill(''); } catch {}
        throw err;
      }
    } finally {
      if (session) {
        session.processing = false;
        session.softCancelRequested = false;
        session.lastActivity = Date.now();
      }
      this.bridge.cancelledStreams.delete(userId);
      this.bridge.streamStopFlags.delete(userId);
      // v7.0: DOM poller keeps running independently
    }
  }
}

module.exports = { MessageSender };
