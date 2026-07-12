// wave2-bridge.test.cjs — Wave 2 Fix A regression test
// Run: node --test packages/kernel/tests/wave2-bridge.test.cjs
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BRIDGE_PATH = path.join(__dirname, '..', 'kimi-bridge.cjs');

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
