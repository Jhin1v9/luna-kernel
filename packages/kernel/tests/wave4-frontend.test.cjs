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
