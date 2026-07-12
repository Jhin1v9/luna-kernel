// wave1-soul.test.cjs — Wave 1 Fix A regression tests
// Run: node --test packages/kernel/tests/wave1-soul.test.cjs
'use strict';

// Point LUNA_KERNEL_DIR at this repo's packages/kernel BEFORE requiring any
// luna module, so the real config/master prompt are loaded (luna-config reads
// env at require time).
const path = require('node:path');
const KERNEL_DIR = path.join(__dirname, '..');
process.env.LUNA_KERNEL_DIR = KERNEL_DIR;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');

const lunaConfig = require('../config/luna-config.js');
const { buildSystemPrompt, parseKimiResponse, parseTagResponse } = require('../luna-soul.cjs');

test('A1: buildSystemPrompt injects master prompt JSON examples and persona', () => {
  const masterPath = lunaConfig.PATHS.masterPrompt;
  const master = fs.readFileSync(masterPath, 'utf8');

  // Exact JSON example line from the master prompt (tool examples section).
  const markerLine = master
    .split('\n')
    .find(l => l.includes('{"tool": "readFile", "params": {"path": "{{WORKSPACE}}/arquivo.txt"}}'));
  assert.ok(markerLine, 'marker line must exist in LUNA_MASTER_PROMPT.md');

  // buildSystemPrompt interpolates {{WORKSPACE}} with the workspace path.
  // Unknown user → fallback workspace = LUNA_HOME.
  const workspace = process.env.LUNA_HOME || path.join(os.homedir(), '.luna');
  const expected = markerLine.replace('{{WORKSPACE}}', workspace);

  const personaMarker = 'WAVE1-PERSONA-MARKER';
  const out = buildSystemPrompt({
    masterPrompt: master,
    personaContent: personaMarker,
    userId: 'wave1-test-user',
  });

  assert.ok(
    out.includes(expected),
    'system prompt must include the exact JSON example line from the master prompt'
  );
  assert.ok(
    out.includes(personaMarker),
    'system prompt must include persona content'
  );
});

test('A1b: 20k cap never truncates the master prompt tail (BOTTOM EXAMPLES)', () => {
  const master = fs.readFileSync(lunaConfig.PATHS.masterPrompt, 'utf8');
  const bottomMarker = '[JSON FORMAT — BOTTOM EXAMPLES';
  assert.ok(master.includes(bottomMarker), 'master prompt must contain the bottom examples marker');

  // Worst case: every section at its max size. Pre-master content alone
  // exceeds 20k, so a naive whole-string slice would drop the master tail.
  const out = buildSystemPrompt({
    masterPrompt: master,
    personaContent: 'P'.repeat(5000),
    memoryContext: 'M'.repeat(5000),
    agentsMd: 'A'.repeat(5000),
    brainContext: 'B'.repeat(12000),
    userId: 'wave1-test-user',
  });

  assert.ok(
    out.includes(bottomMarker),
    'master prompt tail must survive the 20k cap even with max-size sections'
  );
  assert.ok(
    out.endsWith(master.slice(-50)),
    'master prompt must be the LAST thing in the system prompt'
  );
});

test('A2: followUp and toolLoop templates contain JSON format examples', () => {
  const cfg = JSON.parse(fs.readFileSync(lunaConfig.PATHS.promptConfig, 'utf8'));
  for (const key of ['followUp', 'toolLoop']) {
    const tpl = cfg.prompts[key];
    assert.ok(typeof tpl === 'string' && tpl.length > 0, `${key} template must exist`);
    assert.ok(tpl.includes('"params"'), `${key} must contain "params"`);
    assert.ok(tpl.includes('{"tool"'), `${key} must contain {"tool" example`);
  }
});

// A3: the phantom-tool guard in processMessageStream fires only when CHAT came
// from a VALID {"response": ...} JSON wrapper. The guard itself lives inside the
// stream generator (not unit-testable without heavy mocks), but its validity
// oracle is replicated here verbatim: parseKimiResponse must return a plain
// object with a string `response` field (jsonrepair can turn plain text into an
// array, which must NOT count as a wrapper).
function isValidResponseWrapper(text) {
  const obj = parseKimiResponse(text);
  return obj !== null && typeof obj === 'object' && !Array.isArray(obj) && typeof obj.response === 'string';
}

test('A3: wrapper oracle distinguishes valid JSON response from plain-text fallback', () => {
  // Valid fenced wrapper → oracle true → guard ignores DOM actions
  const fenced = '```json\n{"response": "Claro! 🌙"}\n```';
  assert.strictEqual(isValidResponseWrapper(fenced), true, 'fenced wrapper must be valid');
  assert.strictEqual(parseTagResponse(fenced).mode, 'CHAT');

  // Valid bare wrapper → oracle true → guard ignores DOM actions
  assert.strictEqual(isValidResponseWrapper('{"response": "Sem cercas."}'), true, 'bare wrapper must be valid');

  // Plain text (fallback CHAT path) → oracle false → guard must NOT fire,
  // DOM tool results stay legit and are fed back to Kimi
  const plain = 'Aqui está o resultado da sua busca, sem JSON nenhum.';
  assert.strictEqual(parseTagResponse(plain).mode, 'CHAT', 'plain text falls back to CHAT');
  assert.strictEqual(isValidResponseWrapper(plain), false, 'plain text must NOT be a valid wrapper');
});

// W6-T2: _waitPromisesWithDrain must be bounded — a tool promise that never
// settles (stuck CDP call, blocking computer-use) must not hang the turn
// forever. After the drain timeout, each pending tool is force-resolved with
// a visible action_end failure and the generator returns.
test('W6-T2: _waitPromisesWithDrain force-resolves hung tools after the drain timeout', { timeout: 5000 }, async () => {
  const { LunaSoul } = require('../luna-soul.cjs');
  const soul = new LunaSoul({});
  soul._drainTimeoutMs = 300; // test override so the suite stays fast
  const eventBus = { queue: [], push(ev) { this.queue.push(ev); } };
  const never = new Promise(() => {});
  // Pending collection is an array of bare Promise objects (the real shape:
  // domActionPromises / result.pendingPromises). Push sites annotate them
  // with _toolName / _domResult so the timeout event can name the tool.
  const domResult = { tool: 'stuckTool', result: null };
  never._toolName = 'stuckTool';
  never._domResult = domResult;
  const pending = [never];
  const events = [];
  for await (const ev of soul._waitPromisesWithDrain(pending, eventBus, 'sess-t2')) events.push(ev);
  assert.ok(events.some(e => e.type === 'action_end' && /expirou|timeout|timed out/i.test(JSON.stringify(e))),
    'a hung tool must end with a visible action_end failure, got: ' + JSON.stringify(events));
  assert.ok(domResult.result && domResult.result.success === false,
    'domResult must be filled with the failure payload for downstream loop-back, got: ' + JSON.stringify(domResult.result));
});

// W6-T4: turn-termination guarantees in processMessageStream.
// Source-assertion tests: the generator itself needs a live bridge to run,
// so we pin the terminal-event structure directly on the source.
const SOUL = path.join(__dirname, '..', 'luna-soul.cjs');
const sliceAround = (s, needle, span) => {
  const i = s.indexOf(needle);
  return i === -1 ? '' : s.slice(Math.max(0, i - span / 2), i + span / 2);
};

test('W6-T4: MAX_LOOPS is a finite literal and exhaustion emits done', () => {
  const src = fs.readFileSync(SOUL, 'utf8');
  assert.ok(/MAX_LOOPS\s*=\s*50\b/.test(src), 'MAX_LOOPS must be a real ceiling (50)');
  assert.ok(!src.includes('MAX_LOOPS = Number.MAX_SAFE_INTEGER'), 'unbounded ceiling must be gone');
  const tail = sliceAround(src, 'Limite de iterações atingido', 900);
  assert.ok(tail.includes("type: 'done'"), 'loop exhaustion must yield done');
});

test('W6-T4: retry-exhaustion error is followed by done', () => {
  const src = fs.readFileSync(SOUL, 'utf8');
  // Anchor on login_required (sibling branch of the error yield) with a tight
  // window so a *later* unrelated done cannot satisfy the assertion.
  const window = sliceAround(src, 'login_required', 1200);
  const errIdx = window.indexOf("type: 'error'");
  assert.ok(errIdx !== -1, 'error yield must exist');
  assert.ok(window.slice(errIdx).includes("type: 'done'"), 'error emission must be followed by done');
});

test('W6-T4: _buildContext calls inside the stream catch are guarded', () => {
  const src = fs.readFileSync(SOUL, 'utf8');
  // Guard 1: crash-recovery autocontinue rebuild (anchor just before it).
  // Match `this._buildContext` (the call), not bare `_buildContext` (appears in comments).
  const streamErrWindow = sliceAround(src, 'Stream error:', 2500);
  const bcIdx = streamErrWindow.indexOf('this._buildContext');
  assert.ok(bcIdx !== -1, '_buildContext call must exist near the Stream error anchor — anchor drifted?');
  assert.ok(/try\s*\{/.test(streamErrWindow.slice(Math.max(0, bcIdx - 300), bcIdx)),
    '_buildContext in crash-recovery scope must be try-guarded');
  // Guard 2: STREAM_CANCELLED branch rebuild (~40 lines after the first occurrence).
  const cancelWindow = sliceAround(src, 'STREAM_CANCELLED', 8000);
  const cancelBcIdx = cancelWindow.indexOf('this._buildContext');
  assert.ok(cancelBcIdx !== -1, '_buildContext must exist in the STREAM_CANCELLED branch — anchor drifted?');
  assert.ok(/try\s*\{/.test(cancelWindow.slice(Math.max(0, cancelBcIdx - 300), cancelBcIdx)),
    '_buildContext in the STREAM_CANCELLED branch must be try-guarded');
});

// W6-T5: the executed-action cache must be loop-proof — one replay per real
// execution, failures never cached, and a bounded FIFO size. Without this,
// a duplicate tool action replays the cached result forever (Kimi re-sends →
// replay → re-sends → replay...) and stale failures echo back as fresh errors.
test('W6-T5a: cached action results are fed back at most once', () => {
  const { LunaSoul } = require('../luna-soul.cjs');
  const soul = new LunaSoul({});
  const result = { success: true, output: 'ok' };
  soul._markActionExecuted('sess-t5a', 'hash-1', result);
  const first = soul._getRecentActionResult('sess-t5a', 'hash-1');
  assert.strictEqual(first, result, 'first duplicate read must replay the cached result');
  const second = soul._getRecentActionResult('sess-t5a', 'hash-1');
  assert.strictEqual(second, null, 'second read of the same hash must NOT replay (already fed back)');
});

test('W6-T5b: failures are never cached for replay', () => {
  const { LunaSoul } = require('../luna-soul.cjs');
  const soul = new LunaSoul({});
  soul._markActionExecuted('sess-t5b', 'hash-f', { success: false, error: 'boom' });
  assert.strictEqual(soul._getRecentActionResult('sess-t5b', 'hash-f'), null,
    'a failed action must not be cached — it re-executes instead of replaying a stale error');
});

test('W6-T5c: action cache is size-bounded (FIFO eviction)', () => {
  const { LunaSoul, ACTION_CACHE_MAX } = require('../luna-soul.cjs');
  assert.ok(Number.isInteger(ACTION_CACHE_MAX) && ACTION_CACHE_MAX > 0,
    'ACTION_CACHE_MAX must be exported as a positive integer');
  const soul = new LunaSoul({});
  // Insert ACTION_CACHE_MAX + 1 distinct hashes into one session.
  for (let i = 0; i <= ACTION_CACHE_MAX; i++) {
    soul._markActionExecuted('sess-t5c', `hash-${i}`, { success: true, i });
  }
  const sessionCache = soul._executedActionCache.get('sess-t5c');
  assert.strictEqual(sessionCache.size, ACTION_CACHE_MAX, 'cache must be capped at ACTION_CACHE_MAX');
  assert.strictEqual(soul._getRecentActionResult('sess-t5c', 'hash-0'), null,
    'the oldest entry must be evicted FIFO');
  const last = soul._getRecentActionResult('sess-t5c', `hash-${ACTION_CACHE_MAX}`);
  assert.ok(last && last.i === ACTION_CACHE_MAX, 'the newest entry must still be present');
});
