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
