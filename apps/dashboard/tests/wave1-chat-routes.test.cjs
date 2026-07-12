// wave1-chat-routes.test.cjs — Wave 1 Fix B regression tests
// Run: node --test apps/dashboard/tests/wave1-chat-routes.test.cjs
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { makeEventDedupKey } = require('../lib/chat-event-dedup.cjs');

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
