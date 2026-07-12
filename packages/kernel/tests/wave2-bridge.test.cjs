// wave2-bridge.test.cjs — Wave 2 regression tests (Fix A, Fix B, Fix C)
// Run: node --test packages/kernel/tests/wave2-bridge.test.cjs
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BRIDGE_PATH = path.join(__dirname, '..', 'kimi-bridge.cjs');
const INJECTED_PATH = path.join(__dirname, '..', 'luna-extension', 'injected.js');
const OBSERVER_PATH = path.join(__dirname, '..', 'kimi-dom-observer.js');

/**
 * Extract the Kimi `textContent` selector string from a SELECTORS definition:
 * the `textContent:` line that follows the Kimi-branch marker `.segment-assistant`
 * (or, in the observer, the single SELECTORS object which is Kimi-only).
 */
function extractKimiTextContentLine(src, fileLabel) {
  const lines = src.split('\n');
  const matches = lines.filter(l => l.includes('textContent:') && l.includes('.segment-text'));
  assert.strictEqual(matches.length, 1, `${fileLabel}: exactly one Kimi textContent line expected (found ${matches.length})`);
  return matches[0];
}

/**
 * Locate the body of `pollWithTimeout` defined inside `_pollThinkingAndResponse`
 * and return its source slice. Robust to line-number drift: searches for the
 * `pollWithTimeout` token that appears AFTER `_pollThinkingAndResponse`, then
 * brace-matches from the opening `{` of the arrow function.
 */
function extractPollWithTimeoutBody(src) {
  const methodIdx = src.indexOf('_pollThinkingAndResponse');
  assert.notStrictEqual(methodIdx, -1, '_pollThinkingAndResponse must exist in kimi-bridge.cjs');

  const pollIdx = src.indexOf('pollWithTimeout', methodIdx);
  assert.notStrictEqual(pollIdx, -1, 'pollWithTimeout must exist inside _pollThinkingAndResponse');

  const openBrace = src.indexOf('{', pollIdx);
  assert.notStrictEqual(openBrace, -1, 'pollWithTimeout arrow body must open with {');

  let depth = 0;
  for (let i = openBrace; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(openBrace, i + 1);
    }
  }
  assert.fail('pollWithTimeout body braces never balanced');
}

test('A1: session declaration is hoisted above the generic-provider block in pollWithTimeout', () => {
  const src = fs.readFileSync(BRIDGE_PATH, 'utf8');
  const body = extractPollWithTimeoutBody(src);

  const decl = 'const session = userId ? this.userSessions.get(userId) : null;';
  const genericBlock = "if (provider !== 'kimi')";

  const declIdx = body.indexOf(decl);
  assert.notStrictEqual(declIdx, -1, 'session declaration must exist in pollWithTimeout');

  // Exactly ONE declaration — the inner one inside the generic block must be gone,
  // otherwise the hoisted one would be shadowed (or a redeclaration SyntaxError).
  const occurrences = body.split(decl).length - 1;
  assert.strictEqual(occurrences, 1, `session declaration must appear exactly once in pollWithTimeout (found ${occurrences})`);

  const genericIdx = body.indexOf(genericBlock);
  assert.notStrictEqual(genericIdx, -1, "generic-provider block `if (provider !== 'kimi')` must exist");

  assert.ok(
    declIdx < genericIdx,
    'session declaration must appear BEFORE the generic-provider block so the shared empty-extraction tail can use it for the Kimi provider'
  );
});

test('A1b: empty-extraction tail references the hoisted session (empty-wait branch is reachable)', () => {
  const src = fs.readFileSync(BRIDGE_PATH, 'utf8');
  const body = extractPollWithTimeoutBody(src);

  assert.ok(
    body.includes("source: 'empty-wait'"),
    'empty-wait branch must exist in pollWithTimeout'
  );
  assert.ok(
    body.includes('session._lastEmptyLayersLogAt'),
    'empty-extraction tail must reference session._lastEmptyLayersLogAt'
  );

  // The tail must sit AFTER the generic-provider block — i.e. the session it
  // references can only be the hoisted declaration.
  const genericIdx = body.indexOf("if (provider !== 'kimi')");
  const tailIdx = body.indexOf('session._lastEmptyLayersLogAt');
  assert.ok(tailIdx > genericIdx, 'empty-extraction tail must follow the generic-provider block');
});

// ── Fix B: parent .markdown-container removed from Kimi textContent selectors ──

for (const [label, filePath] of [
  ['injected.js', INJECTED_PATH],
  ['kimi-dom-observer.js', OBSERVER_PATH],
]) {
  test(`B1: ${label} Kimi textContent selector excludes parent .markdown-container, keeps leaf .segment-text`, () => {
    const src = fs.readFileSync(filePath, 'utf8');
    const line = extractKimiTextContentLine(src, label);

    assert.ok(
      !line.includes('.markdown-container'),
      `${label}: textContent must NOT contain .markdown-container (parent of leaf text nodes — caused doubled paragraphs). Line: ${line.trim()}`
    );
    assert.ok(
      line.includes('.segment-text'),
      `${label}: textContent must still contain leaf selector .segment-text. Line: ${line.trim()}`
    );
    assert.ok(
      line.includes('.message-content'),
      `${label}: textContent must still contain leaf selector .message-content. Line: ${line.trim()}`
    );
  });
}

test('B1b: DeepSeek textContent selector is intentionally left unchanged pending live-DOM verification', () => {
  const src = fs.readFileSync(INJECTED_PATH, 'utf8');
  const dsLine = src.split('\n').find(l => l.includes("textContent: '.ds-markdown"));
  assert.ok(dsLine, 'injected.js: DeepSeek textContent line must still exist');
  assert.ok(
    dsLine.includes('.ds-markdown, .message-content'),
    'DeepSeek selector must be unchanged (only a comment documents the unverified nesting assumption)'
  );
});

// ── Fix C: extension event buffers filtered by tab URL (cross-user theft) ──

const { KimiBridge } = require(BRIDGE_PATH);

// _consumeExtensionEvents only reads global.__lunaExtensionEventBuffers and
// the module-scoped logger — no `this` state is touched, so a bare {} is a
// sufficient fake receiver.
const consume = (url) => KimiBridge.prototype._consumeExtensionEvents.call({}, url);

function seedBuffers(entries) {
  // entries: Array<[extSessionId, events[]]>
  global.__lunaExtensionEventBuffers = new Map(entries);
}

function streamStateEvent(urlFields, response) {
  return { eventType: 'stream_state', data: { response, thinking: '' }, ...urlFields };
}

test.afterEach(() => {
  delete global.__lunaExtensionEventBuffers;
});

test('C1a: two buffers — consuming for URL A returns only A\u2019s events, B\u2019s buffer untouched', () => {
  const urlA = 'https://kimi.com/chat/thread-a';
  const urlB = 'https://kimi.com/chat/thread-b';
  seedBuffers([
    ['ext-A', [streamStateEvent({ url: urlA, tabUrl: urlA }, 'A text')]],
    ['ext-B', [streamStateEvent({ url: urlB, tabUrl: urlB }, 'B text')]],
  ]);

  const events = consume(urlA);

  assert.strictEqual(events.length, 1, 'exactly one event consumed');
  assert.strictEqual(events[0].type, 'state_change');
  assert.strictEqual(events[0].response, 'A text');

  const buffers = global.__lunaExtensionEventBuffers;
  assert.ok(!buffers.has('ext-A') || buffers.get('ext-A').length === 0, 'A buffer emptied or deleted');
  assert.deepStrictEqual(
    buffers.get('ext-B'),
    [streamStateEvent({ url: urlB, tabUrl: urlB }, 'B text')],
    'B buffer must be UNTOUCHED'
  );
});

test('C1b: tracking query string (?utm=...) still matches the same thread', () => {
  const clean = 'https://kimi.com/chat/thread-x';
  const dirty = 'https://kimi.com/chat/thread-x?utm_source=telegram&ref=abc#frag';
  seedBuffers([
    ['ext-1', [streamStateEvent({ url: dirty, tabUrl: dirty + '/' }, 'tracked')]],
  ]);

  const events = consume(clean);

  assert.strictEqual(events.length, 1, 'event with tracking params must be consumed for the same thread');
  assert.strictEqual(events[0].response, 'tracked');
});

test('C1c: no-url events + two buffers → none consumed (ownership unknown)', () => {
  seedBuffers([
    ['ext-1', [streamStateEvent({}, 'orphan-1')]],
    ['ext-2', [streamStateEvent({}, 'orphan-2')]],
  ]);

  const events = consume('https://kimi.com/chat/anything');

  assert.strictEqual(events.length, 0, 'no-url events must NOT be consumed when multiple buffers exist');
  assert.strictEqual(global.__lunaExtensionEventBuffers.get('ext-1').length, 1, 'buffer 1 untouched');
  assert.strictEqual(global.__lunaExtensionEventBuffers.get('ext-2').length, 1, 'buffer 2 untouched');
});

test('C1d: no-url events + exactly one buffer → consumed (single-user dev preserved)', () => {
  seedBuffers([
    ['ext-1', [streamStateEvent({}, 'orphan')]],
  ]);

  const events = consume('https://kimi.com/chat/anything');

  assert.strictEqual(events.length, 1, 'no-url events must be consumed when only one buffer exists');
  assert.strictEqual(events[0].response, 'orphan');
  assert.ok(
    !global.__lunaExtensionEventBuffers.has('ext-1') || global.__lunaExtensionEventBuffers.get('ext-1').length === 0,
    'single buffer emptied or deleted after consumption'
  );
});

// C2: pin the handler-side event shape the filter depends on. If
// luna-extension-handler.cjs ever renames/moves `url`/`tabUrl`, the bridge
// filter silently treats every event as no-url — this test must fail first.
test('C2: handler buffers events with top-level url/tabUrl (shape contract)', () => {
  const handlerSrc = fs.readFileSync(
    require('node:path').join(__dirname, '../../../apps/dashboard/luna-extension-handler.cjs'),
    'utf8'
  );
  assert.ok(
    /_bufferEvent\(sessionId,\s*\{\s*eventType,\s*data,\s*timestamp,\s*url,\s*tabId,\s*tabUrl\s*\}\)/.test(handlerSrc),
    'handler must buffer events with flat top-level url/tabUrl — the bridge filter reads raw.tabUrl || raw.url'
  );
});

// ── Fix D: DOM poller bounded to stream + premature completion guard ──

const { isPrematureCompletion } = require(path.join(__dirname, '..', 'lib', 'stream-completion-guard.cjs'));

test('D3a: isPrematureCompletion — empty state (nothing streamed yet) is premature', () => {
  assert.strictEqual(isPrematureCompletion({ lastResponse: '', lastThinking: '' }), true);
  assert.strictEqual(isPrematureCompletion({ lastResponse: undefined, lastThinking: undefined }), true);
  assert.strictEqual(isPrematureCompletion({ lastResponse: null, lastThinking: null }), true);
});

test('D3b: isPrematureCompletion — any response text seen → not premature', () => {
  assert.strictEqual(isPrematureCompletion({ lastResponse: 'Hello', lastThinking: '' }), false);
  assert.strictEqual(isPrematureCompletion({ lastResponse: 'Hello', lastThinking: 'hmm' }), false);
});

test('D3c: isPrematureCompletion — any thinking text seen → not premature', () => {
  assert.strictEqual(isPrematureCompletion({ lastResponse: '', lastThinking: 'reasoning...' }), false);
});

/**
 * Extract the `finally` block of sendMessageStream (the stream-end cleanup).
 * Brace-matches from the `finally {` that follows the method signature.
 */
function extractSendMessageStreamFinally(src) {
  const methodIdx = src.indexOf('async *sendMessageStream(');
  assert.notStrictEqual(methodIdx, -1, 'sendMessageStream must exist in kimi-bridge.cjs');

  const finallyIdx = src.indexOf('} finally {', methodIdx);
  assert.notStrictEqual(finallyIdx, -1, 'sendMessageStream must have a finally block');

  const openBrace = src.indexOf('{', finallyIdx);
  let depth = 0;
  for (let i = openBrace; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(openBrace, i + 1);
    }
  }
  assert.fail('sendMessageStream finally block braces never balanced');
}

test('D1: sendMessageStream finally stops the DOM poller BEFORE clearing processing', () => {
  const src = fs.readFileSync(BRIDGE_PATH, 'utf8');
  const finallyBody = extractSendMessageStreamFinally(src);

  const stopIdx = finallyBody.indexOf('_stopDomPoller');
  assert.notStrictEqual(stopIdx, -1, 'finally must call _stopDomPoller (poller is now bounded to the active stream)');

  const processingIdx = finallyBody.indexOf('processing = false');
  assert.notStrictEqual(processingIdx, -1, 'finally must still clear session.processing');

  assert.ok(
    stopIdx < processingIdx,
    '_stopDomPoller must run BEFORE session.processing = false so the poller stops while the turn is still marked active'
  );

  assert.ok(
    !finallyBody.includes('NÃO paramos o DOM poller'),
    'v7.0 keep-poller-running comment must be gone — the poller no longer survives the stream'
  );
});
