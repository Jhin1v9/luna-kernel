// wave1-chat-routes.test.cjs — Wave 1 Fix B regression tests
// Run: node --test apps/dashboard/tests/wave1-chat-routes.test.cjs
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { makeEventDedupKey } = require('../lib/chat-event-dedup.cjs');

const CHAT_ROUTES = path.join(__dirname, '..', 'luna-chat-routes.js');

// B1/B4: two action_start events with the same tool but different
// toolInstanceId must both survive dedup (distinct keys). Previously the key
// was type:content(=''):tool, so the 2nd call of the same tool was dropped.
test('B1: repeated action_start for the same tool survives dedup', () => {
  const emitted = new Set();
  const events = [
    { type: 'action_start', tool: 'readFile', toolInstanceId: 'inst-1' },
    { type: 'action_start', tool: 'readFile', toolInstanceId: 'inst-2' },
    { type: 'action_end', tool: 'readFile', toolInstanceId: 'inst-1' },
    { type: 'action_end', tool: 'readFile', toolInstanceId: 'inst-2' },
    { type: 'action_progress', tool: 'readFile', toolInstanceId: 'inst-1' },
  ];

  const survivors = events.filter(ev => {
    const key = makeEventDedupKey(ev, '');
    if (emitted.has(key)) return false;
    emitted.add(key);
    return true;
  });

  assert.strictEqual(survivors.length, events.length, 'every distinct tool instance must survive dedup');
});

// B1: when the soul omits toolInstanceId, the key falls back to ev.id so
// repeated invocations still don't collapse into one another.
test('B1: action events fall back to ev.id when toolInstanceId is missing', () => {
  const k1 = makeEventDedupKey({ type: 'action_start', tool: 'readFile', id: 'ev-1' }, '');
  const k2 = makeEventDedupKey({ type: 'action_start', tool: 'readFile', id: 'ev-2' }, '');
  assert.notStrictEqual(k1, k2, 'fallback to ev.id must keep instances distinct');
});

// B4: two identical text events must still dedupe (unchanged behavior).
test('B4: identical text events still dedupe', () => {
  const emitted = new Set();
  const ev = { type: 'response_delta', tool: undefined };
  const content = 'Aqui está o resultado da sua busca.';

  const k1 = makeEventDedupKey(ev, content);
  emitted.add(k1);
  const k2 = makeEventDedupKey(ev, content);

  assert.strictEqual(k1, k2, 'identical text events must produce the same key');
  assert.strictEqual(emitted.has(k2), true, 'second identical text event must be deduped');
});

// B4: different text content must NOT dedupe (sanity on the content-based key).
test('B4: different text content does not dedupe', () => {
  const k1 = makeEventDedupKey({ type: 'response_delta' }, 'primeira parte');
  const k2 = makeEventDedupKey({ type: 'response_delta' }, 'segunda parte');
  assert.notStrictEqual(k1, k2);
});

// B1 degenerate case: an action event with NEITHER toolInstanceId NOR id
// collapses to type:tool: — repeated same-tool calls dedupe away. The soul
// always emits toolInstanceId on action_* (luna-soul.cjs:2496,2513,2937), so
// this is unreachable today; this test locks in the documented terminal
// behavior of the fallback chain.
test('B1: action event without toolInstanceId or id collapses (documented)', () => {
  const k1 = makeEventDedupKey({ type: 'action_start', tool: 'readFile' }, '');
  const k2 = makeEventDedupKey({ type: 'action_start', tool: 'readFile' }, '');
  assert.strictEqual(k1, k2, 'without any instance id the key degenerates to type:tool:');
});

// W6-T8: transport-side single-writer persistence + done dedup.
// (i) The persist loop must never store response_detected separately — the
//     assistant event from _handleChat and the final done carry the text;
//     response_delta covers live streaming.
// (ii) done events go through makeEventDedupKey like everything else (the
//      ev.type !== 'done' exemption is gone — two identical dones collapse);
//      action_progress stays exempt because its chunks are an ordered stream.
test('W6-T8b: persist loop skips response_detected and dedupes done', () => {
  const src = fs.readFileSync(CHAT_ROUTES, 'utf8');

  // (i) Anchor on the persist-loop addMessageToSession (the one storing
  // ev.type), then look 3000 chars back where the event whitelist sits.
  const anchor = 'addMessageToSession(session.id, {';
  let idx = -1;
  let from = 0;
  while ((from = src.indexOf(anchor, from)) !== -1) {
    if (src.slice(from, from + 400).includes('type: ev.type')) { idx = from; break; }
    from += anchor.length;
  }
  assert.notStrictEqual(idx, -1, 'persist-loop addMessageToSession anchor must exist');
  const before = src.slice(Math.max(0, idx - 3000), idx);
  assert.ok(before.includes('for await'), 'window must cover the persist loop — anchor drifted?');
  assert.ok(!before.includes("'response_detected'"),
    'persist loop must not persist response_detected separately');

  // (ii) done is content-deduped: no ev.type !== 'done' exemption near the
  // makeEventDedupKey call site; the action_progress exemption must remain.
  const keyIdx = src.indexOf('makeEventDedupKey(ev, content)');
  assert.notStrictEqual(keyIdx, -1, 'makeEventDedupKey call site must exist');
  const around = src.slice(Math.max(0, keyIdx - 400), keyIdx + 400);
  assert.ok(!/ev\.type !== 'done'/.test(around), 'done must be content-deduped (exemption removed)');
  assert.ok(around.includes("ev.type !== 'action_progress'"), 'action_progress exemption must remain');

  // (iii) W6-T8 review follow-up: the finally block must only delete the stream
  // meta when it still owns it — otherwise POST#1's finally can delete POST#2's
  // meta and let a third POST run concurrently against the closed gate.
  const delIdx = src.indexOf('activeStreams.delete(finalSessionId)');
  assert.notStrictEqual(delIdx, -1, 'activeStreams.delete(finalSessionId) must exist');
  const delAround = src.slice(Math.max(0, delIdx - 300), delIdx);
  assert.ok(/activeStreams\.get\(finalSessionId\)\s*===\s*myStreamMeta/.test(delAround),
    'stream-meta delete must be ownership-guarded');
});

// ── Wave 7 Task 2 (b): SSE serializers must forward plan/planPath ───────────
// Both eventData whitelists (ledger replay + live polling) dropped msg.plan /
// msg.planPath, so plan_display reached the browser without content and the
// card always rendered "(plano vazio)".
test('W7-T2b: both SSE serializers copy plan/planPath into eventData', () => {
  const src = fs.readFileSync(CHAT_ROUTES, 'utf8');

  for (const anchor of ['for (const msg of missedEvents)', 'for (const msg of newMessages)']) {
    const idx = src.indexOf(anchor);
    assert.notStrictEqual(idx, -1, `SSE loop anchor must exist: ${anchor}`);
    const window = src.slice(idx, idx + 1400);
    assert.ok(window.includes('const eventData = {'),
      `window after ${anchor} must cover the eventData serializer — anchor drifted?`);
    assert.ok(window.includes('eventData.plan = msg.plan'),
      `serializer after ${anchor} must copy msg.plan`);
    assert.ok(window.includes('eventData.planPath = msg.planPath'),
      `serializer after ${anchor} must copy msg.planPath`);
  }

  // Exactly two copy sites (replay + live) — no more, no less.
  const count = (src.match(/eventData\.plan = msg\.plan/g) || []).length;
  assert.strictEqual(count, 2, 'plan copy must exist in exactly the two serializers');
});

// ── Wave 7 Task 2 (a): /api/plan shares the same Kimi chat ──────────────────
// userId 'web-plan-<id>' made the bridge navigate Kimi to a DIFFERENT chat, so
// approving the plan returned to the old chat without context. Plan mode must
// reuse 'web-<id>' — only the prompt changes.
test('W7-T2a: /api/plan builds web-<id> userId (same chat), never web-plan-', () => {
  const src = fs.readFileSync(CHAT_ROUTES, 'utf8');
  const start = src.indexOf("router.post('/api/plan',");
  const end = src.indexOf("router.post('/api/plan/approve'", start);
  assert.notStrictEqual(start, -1, '/api/plan route must exist');
  assert.notStrictEqual(end, -1, '/api/plan/approve route must exist (window anchor)');
  const route = src.slice(start, end);
  assert.ok(!route.includes('web-plan'),
    '/api/plan must not build a web-plan- userId (separate Kimi chat bug)');
  assert.ok(route.includes("userId: 'web-' + session.id"),
    '/api/plan must reuse the same web-<id> userId as normal chat');
});
