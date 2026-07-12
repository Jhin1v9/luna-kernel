// wave4-frontend.test.cjs — Wave 4 regression tests (frontend hygiene)
// T1: production debug logs removed from ChatArea.svelte
// T2: OrbBackground resize listener removed in onDestroy
// T3: processedEventIds eviction trims to 80% (lib/evictSet.js)
// T4: markdown render/highlight debounced (lib/debounce.js + AssistantMessage.svelte)
// T5: 401 handler shows login screen instead of page reload (lib/authGuard.js + api.js)
// T6: SSEManager — cancellable reconnect timer + lastMessageCount reset on session switch (api.js)
// T7: tool timer registry — 60s timeout marks stuck tools failed; clearAll on reconnect (lib/toolTimers.js)
// T8: /api/chat/ack caller + batcher (lib/ackBatcher.js + api.js + ChatArea.svelte)
// T9: action_progress chunk forwarded end-to-end (lib/progress-event.cjs + luna-soul.cjs + luna-chat-routes.js)
// Run: node --test packages/kernel/tests/wave4-frontend.test.cjs
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..');
const CHAT_AREA = path.join(REPO, 'packages/kernel/luna-web/src/components/ChatArea.svelte');
const ORB_BG = path.join(REPO, 'packages/kernel/luna-web/src/components/OrbBackground.svelte');
const ASSISTANT_MSG = path.join(REPO, 'packages/kernel/luna-web/src/components/AssistantMessage.svelte');
const API_JS = path.join(REPO, 'packages/kernel/luna-web/src/api.js');
const SOUL = path.join(REPO, 'packages/kernel/luna-soul.cjs');
const CHAT_ROUTES = path.join(REPO, 'apps/dashboard/luna-chat-routes.js');

// ── T1: production debug logs removed ────────────────────────────────────────

test('T1: ChatArea has no per-send stack-trace or branch-dump logs', () => {
  const src = fs.readFileSync(CHAT_AREA, 'utf8');
  assert.ok(!src.includes('new Error().stack'), 'stack-trace debug log must be gone');
  assert.ok(!src.includes('[handleSend] START'), 'handleSend START dump must be gone');
  assert.ok(!src.includes('[handleSend] branches'), 'handleSend branches dump must be gone');
});

test('T1: ChatArea has no per-event [SSE] / [done] debug logs', () => {
  const src = fs.readFileSync(CHAT_AREA, 'utf8');
  assert.ok(!src.includes("'[SSE]', event.type"), 'per-event [SSE] log must be gone');
  assert.ok(!src.includes("'[SSE] Deduplicated:'"), 'dedup log must be gone');
  assert.ok(!src.includes("'[SSE] Delaying response event"), 'delayed-event log must be gone');
  assert.ok(!src.includes("'[SSE] Ignoring stale event"), 'stale-event log must be gone');
  assert.ok(!src.includes("'[done] finalResponse length:'"), 'done content dump must be gone');
  assert.ok(!src.includes('[DEBUG-LUNA]'), 'DEBUG-LUNA log must be gone');
});

// ── T2: OrbBackground resize listener cleanup ────────────────────────────────

test('T2: OrbBackground registers a NAMED resize handler and removes it in onDestroy', () => {
  const src = fs.readFileSync(ORB_BG, 'utf8');
  assert.ok(!src.includes("addEventListener('resize', () =>"), 'anonymous resize listener must be gone');
  assert.ok(src.includes("addEventListener('resize', handleResize)"), 'named handler must be registered');
  assert.ok(src.includes("removeEventListener('resize', handleResize)"), 'handler must be removed in onDestroy');
});

// ── T3: set eviction policy ──────────────────────────────────────────────────

const { evictOldestEntries } = require('../luna-web/src/lib/evictSet.js');

test('T3: eviction trims an over-cap set down to 80%, oldest first', () => {
  const s = new Set();
  for (let i = 0; i < 5001; i++) s.add('ev-' + i);
  const removed = evictOldestEntries(s, 5000);
  assert.strictEqual(s.size, 4000, 'must trim to 80% of the cap, not delete a single entry');
  assert.strictEqual(removed, 1001);
  assert.ok(!s.has('ev-0') && !s.has('ev-1000'), 'oldest entries must be evicted');
  assert.ok(s.has('ev-1001') && s.has('ev-5000'), 'newest entries must survive');
});

test('T3: eviction is a no-op at or below the cap', () => {
  const s = new Set(['a', 'b', 'c']);
  assert.strictEqual(evictOldestEntries(s, 5000), 0);
  assert.strictEqual(s.size, 3);
  const t = new Set();
  for (let i = 0; i < 5000; i++) t.add(i);
  assert.strictEqual(evictOldestEntries(t, 5000), 0, 'exactly at cap: no eviction');
  assert.strictEqual(t.size, 5000);
});

test('T3: ChatArea uses evictOldestEntries for processedEventIds', () => {
  const src = fs.readFileSync(CHAT_AREA, 'utf8');
  assert.ok(src.includes('evictOldestEntries(processedEventIds, 5000)'), 'component must call the shared helper');
});

// ── T4: debounced scheduler + marked config hygiene ──────────────────────────

const { createDebouncedScheduler } = require('../luna-web/src/lib/debounce.js');

function fakeTimer() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeoutFn: (cb, ms) => { const id = ++seq; pending.set(id, { cb, ms }); return id; },
    clearTimeoutFn: (id) => pending.delete(id),
    fireNext: () => { const [id, t] = pending.entries().next().value; pending.delete(id); t.cb(); },
    pendingCount: () => pending.size,
  };
}

test('T4: scheduler coalesces bursts into one trailing call', () => {
  const t = fakeTimer();
  let calls = 0;
  const s = createDebouncedScheduler(() => calls++, 120, t);
  s.schedule(); s.schedule(); s.schedule();
  assert.strictEqual(t.pendingCount(), 1, 'only one timer may be armed during a burst');
  assert.strictEqual(calls, 0);
  t.fireNext();
  assert.strictEqual(calls, 1, 'burst collapses into a single call');
});

test('T4: immediate schedule flushes pending work synchronously', () => {
  const t = fakeTimer();
  let calls = 0;
  const s = createDebouncedScheduler(() => calls++, 120, t);
  s.schedule();
  s.schedule(true);
  assert.strictEqual(calls, 1, 'immediate run executes now');
  assert.strictEqual(t.pendingCount(), 0, 'pending timer cancelled by the immediate run');
});

test('T4: cancel drops a pending run', () => {
  const t = fakeTimer();
  let calls = 0;
  const s = createDebouncedScheduler(() => calls++, 120, t);
  s.schedule();
  s.cancel();
  assert.strictEqual(t.pendingCount(), 0);
  assert.strictEqual(calls, 0);
});

test('T4: scheduler re-arms cleanly after a fired run', () => {
  const t = fakeTimer();
  let calls = 0;
  const s = createDebouncedScheduler(() => calls++, 120, t);
  s.schedule();
  t.fireNext();
  assert.strictEqual(calls, 1);
  s.schedule();
  assert.strictEqual(t.pendingCount(), 1, 'can arm again after firing');
  t.fireNext();
  assert.strictEqual(calls, 2);
});

test('T4: AssistantMessage uses a module-scope Marked instance, not per-instance marked.use', () => {
  const src = fs.readFileSync(ASSISTANT_MSG, 'utf8');
  assert.ok(!src.includes('marked.use('), 'per-instance global marked.use() must be gone');
  assert.ok(src.includes('<script context="module">'), 'renderer config must move to module scope');
  assert.ok(src.includes('createDebouncedScheduler'), 'render must go through the debounced scheduler');
});

// ── T5: 401 logout decision ──────────────────────────────────────────────────

const { shouldForceLogout } = require('../luna-web/src/lib/authGuard.js');

test('T5: 401 with a token on an authed endpoint forces logout', () => {
  assert.strictEqual(shouldForceLogout({ status: 401, url: '/api/chat/sessions', hasToken: true }), true);
});

test('T5: no token, login endpoint, or non-401 never force logout', () => {
  assert.strictEqual(shouldForceLogout({ status: 401, url: '/api/chat/sessions', hasToken: false }), false);
  assert.strictEqual(shouldForceLogout({ status: 401, url: '/api/auth/login', hasToken: true }), false);
  assert.strictEqual(shouldForceLogout({ status: 200, url: '/api/chat/sessions', hasToken: true }), false);
  assert.strictEqual(shouldForceLogout({ status: 403, url: '/api/chat/sessions', hasToken: true }), false);
});

test('T5: api.js 401 handler clears the session reactively instead of reloading', () => {
  const src = fs.readFileSync(API_JS, 'utf8');
  assert.ok(!src.includes('window.location.reload'), 'page reload on 401 must be gone');
  assert.ok(!src.includes('__luna401handled'), 'reload debounce flag must be gone');
  assert.ok(src.includes('shouldForceLogout'), 'decision must go through the pure helper');
  assert.ok(src.includes('user.set(null)'), 'must show the login screen via the user store');
});
