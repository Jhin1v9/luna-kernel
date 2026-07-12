// wave5-tool-registry.test.cjs — Wave 5 regression tests (tool registry, modularization Phase 0+1)
// T1/P0: characterization net — pins CURRENT guard schema behavior (accept/reject matrix for all 12
//        schemas + alias normalization + fail-open + checksum drift). Three CARVE-OUT blocks pin
//        current buggy behavior and are flipped in Task 5 (P0-2 → 5a, P0-3 → 5c, P0-11 → 5b).
// T2: tool registry completeness + schema-shape validity (lib/tool-registry.cjs)
// T3: guard consumes schemas from the registry (zero behavior change — this net is the proof)
// T4: frontend metadata codegen — drift test + behavior-equivalence + ToolCard switch
// T5: three reconciled schema bugs (writeFile pathMustNotContain, checksum filePath alias,
//     replaceInFile oldStr/newStr)
// Run: node --test packages/kernel/tests/wave5-tool-registry.test.cjs
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..');
const GUARD = path.join(REPO, 'packages/kernel/luna-tool-guard.cjs');
const TOOL_CARD = path.join(REPO, 'packages/kernel/luna-web/src/components/ToolCard.svelte');

const { ToolGuard, validateToolCall } = require('../luna-tool-guard.cjs');

function rejects(tool, params, re) {
  assert.throws(() => validateToolCall(tool, params), re, `${tool} must reject ${JSON.stringify(params)}`);
}

// ── P0: per-schema accept/reject matrix (12 schemas, current definitions) ────
// Wave 3 H1 already pins: fail-open warn-once, writeFile filePath/file aliases
// (required + absolute + pathMustNotContain on the alias value). Not repeated here.

test('P0-1: readFile — path required (string), numeric offsets, pathMustExist NOT enforced', () => {
  assert.strictEqual(validateToolCall('readFile', { path: '/etc/hostname' }), true);
  assert.strictEqual(validateToolCall('readFile', { path: '/definitely/not/there-luna-p0' }), true,
    'pathMustExist is declared in the schema but NOT enforced by validateToolCall — pin it');
  assert.strictEqual(validateToolCall('readFile', { path: '/etc/hostname', line_offset: 10, n_lines: 5 }), true);
  rejects('readFile', {}, /campo obrigatório "path"/);
  rejects('readFile', { path: 42 }, /"path" deve ser string/);
  rejects('readFile', { path: '/etc/hostname', line_offset: '10' }, /"line_offset" deve ser number/);
});

test('P0-2: writeFile — path+content required, absolute enforced, .. and ~ rejected [CARVE-OUT 5a]', () => {
  assert.strictEqual(validateToolCall('writeFile', { path: '/abs/x', content: 'c' }), true);
  rejects('writeFile', { path: '/abs/x' }, /campo obrigatório "content"/);
  rejects('writeFile', { path: 'rel/x', content: 'c' }, /deve ser absoluto/);
  rejects('writeFile', { path: '/abs/x', content: 42 }, /"content" deve ser string/);
  // CARVE-OUT (Task 5a): CURRENT behavior — pathMustNotContain: ['..','~'] rejects the raw
  // strings even though the soul realpath guard handles them correctly. Task 5a flips these
  // two rejects to strictEqual(..., true).
  rejects('writeFile', { path: '/abs/../sibling', content: 'c' }, /contém padrão proibido/);
  rejects('writeFile', { path: '/abs/~user/x', content: 'c' }, /contém padrão proibido/);
});

test('P0-3: replaceInFile — path/old/new required + absolute; oldStr/newStr rejected [CARVE-OUT 5c]', () => {
  assert.strictEqual(validateToolCall('replaceInFile', { path: '/abs/x', old: 'a', new: 'b' }), true);
  rejects('replaceInFile', { path: '/abs/x', new: 'b' }, /campo obrigatório "old"/);
  rejects('replaceInFile', { path: 'rel', old: 'a', new: 'b' }, /deve ser absoluto/);
  // CARVE-OUT (Task 5c): CURRENT behavior — the dispatch accepts p.old||p.oldStr /
  // p.new||p.newStr (luna-soul.cjs:4291) but the schema requires old/new literally.
  rejects('replaceInFile', { path: '/abs/x', oldStr: 'a', newStr: 'b' }, /campo obrigatório "old"/);
});

test('P0-4: appendFile/deleteFile — required fields only; relative paths ALLOWED (no absolute constraint)', () => {
  assert.strictEqual(validateToolCall('appendFile', { path: 'rel/x', content: 'c' }), true,
    'appendFile schema has no pathMustBeAbsolute');
  rejects('appendFile', { path: '/abs/x' }, /campo obrigatório "content"/);
  assert.strictEqual(validateToolCall('deleteFile', { path: 'rel/x' }), true,
    'deleteFile schema has no pathMustBeAbsolute');
  rejects('deleteFile', {}, /campo obrigatório "path"/);
});

test('P0-5: executeShell — command required (string), the four forbidden patterns enforced', () => {
  assert.strictEqual(validateToolCall('executeShell', { command: 'npm test' }), true);
  assert.strictEqual(validateToolCall('executeShell', { command: 'rm -rf ./build' }), true,
    'the forbidden pattern requires an absolute target (/…) — relative rm -rf passes today');
  rejects('executeShell', {}, /campo obrigatório "command"/);
  rejects('executeShell', { command: 42 }, /"command" deve ser string/);
  rejects('executeShell', { command: 'rm -rf /' }, /comando proibido/);
  rejects('executeShell', { command: '  rm -rf /tmp/x' }, /comando proibido/);
  rejects('executeShell', { command: 'mkfs.ext4 /dev/sda1' }, /comando proibido/);
  rejects('executeShell', { command: 'dd if=/dev/zero of=/dev/sda' }, /comando proibido/);
  rejects('executeShell', { command: ':(){ :|:& };:' }, /comando proibido/);
});

test('P0-6: ipython/browser/computer — Kimi-native schemas (soul validates ipython AS executeShell)', () => {
  assert.strictEqual(validateToolCall('ipython', { code: 'print(1)' }), true);
  rejects('ipython', {}, /campo obrigatório "code"/);
  assert.strictEqual(validateToolCall('browser', { url: 'https://example.com' }), true);
  rejects('browser', {}, /campo obrigatório "url"/);
  assert.strictEqual(validateToolCall('computer', { action: 'click', x: 10, y: 20, text: 'hi' }), true);
  rejects('computer', {}, /campo obrigatório "action"/);
  rejects('computer', { action: 'click', x: '10' }, /"x" deve ser number/);
});

test('P0-7: glob/grep/validateProject — required fields, grep optional string types, validateProject absolute', () => {
  assert.strictEqual(validateToolCall('glob', { pattern: '**/*.cjs' }), true);
  rejects('glob', {}, /campo obrigatório "pattern"/);
  assert.strictEqual(validateToolCall('grep', { pattern: 'foo', path: '/abs', type: 'ts' }), true);
  rejects('grep', {}, /campo obrigatório "pattern"/);
  rejects('grep', { pattern: 'foo', path: 42 }, /"path" deve ser string/);
  assert.strictEqual(validateToolCall('validateProject', { path: '/abs/proj' }), true);
  rejects('validateProject', { path: 'rel/proj' }, /deve ser absoluto/);
  rejects('validateProject', {}, /campo obrigatório "path"/);
});

test('P0-8: path alias normalization extends to every schema with required path (appendFile filePath/file)', () => {
  assert.strictEqual(validateToolCall('appendFile', { filePath: '/abs/x', content: 'c' }), true);
  assert.strictEqual(validateToolCall('appendFile', { file: '/abs/x', content: 'c' }), true);
});

test('P0-9: fail-open default — unlisted tools accept arbitrary params (warn-once itself is wave3 H1)', () => {
  validateToolCall._warned.delete('dashboardListTasks');
  assert.strictEqual(validateToolCall('dashboardListTasks', { anything: 42, goes: null }), true);
  validateToolCall._warned.delete('dashboardListTasks');
});

test('P0-10: checksum drift IS detected when params.path is used (positive control)', async () => {
  const guard = new ToolGuard(os.tmpdir());
  const target = path.join(os.tmpdir(), `luna-p0-drift-ok-${process.pid}.txt`);
  fs.writeFileSync(target, 'v1');
  try {
    const toolFn = async () => ({ success: true }); // stubbed: no real write
    await guard.execute('writeFile', { path: target, content: 'a' }, toolFn);
    fs.writeFileSync(target, 'v2-external'); // simulate external modification
    // different content → different idempotency key → no skip → drift check runs
    await assert.rejects(() => guard.execute('writeFile', { path: target, content: 'b' }, toolFn), /Drift detectado/);
  } finally {
    try { fs.unlinkSync(target); } catch {}
  }
});

test('P0-11: checksum drift verify/record reads params.path ONLY — filePath alias bypasses it TODAY [CARVE-OUT 5b]', async () => {
  const guard = new ToolGuard(os.tmpdir());
  const target = path.join(os.tmpdir(), `luna-p0-drift-alias-${process.pid}.txt`);
  fs.writeFileSync(target, 'v1');
  try {
    const toolFn = async () => ({ success: true });
    await guard.execute('writeFile', { filePath: target, content: 'a' }, toolFn);
    fs.writeFileSync(target, 'v2-external');
    // CURRENT (buggy): verify(params.path === undefined) finds no entry → ok:true → no FILE_DRIFT.
    // Task 5b flips this to assert.rejects(..., /Drift detectado/).
    const res = await guard.execute('writeFile', { filePath: target, content: 'b' }, toolFn);
    assert.strictEqual(res.success, true, 'current behavior: drift via the filePath alias is NOT detected');
  } finally {
    try { fs.unlinkSync(target); } catch {}
  }
});

// Review follow-up (Task 1): wrong-type pins for every schema field left unpinned,
// so the Task 3 migration proof can't pass with a silently dropped `types` entry.
test('P0-12: wrong-type rejects pinned for every remaining schema field', () => {
  rejects('readFile', { path: '/etc/hostname', n_lines: '5' }, /"n_lines" deve ser number/);
  rejects('writeFile', { path: 42, content: 'c' }, /"path" deve ser string/);
  rejects('replaceInFile', { path: 42, old: 'a', new: 'b' }, /"path" deve ser string/);
  rejects('replaceInFile', { path: '/abs/x', old: 42, new: 'b' }, /"old" deve ser string/);
  rejects('replaceInFile', { path: '/abs/x', old: 'a', new: 42 }, /"new" deve ser string/);
  rejects('appendFile', { path: 42, content: 'c' }, /"path" deve ser string/);
  rejects('appendFile', { path: '/abs/x', content: 42 }, /"content" deve ser string/);
  rejects('deleteFile', { path: 42 }, /"path" deve ser string/);
  rejects('ipython', { code: 42 }, /"code" deve ser string/);
  rejects('browser', { url: 42 }, /"url" deve ser string/);
  rejects('computer', { action: 42 }, /"action" deve ser string/);
  rejects('computer', { action: 'click', y: '20' }, /"y" deve ser number/);
  rejects('computer', { action: 'click', text: 42 }, /"text" deve ser string/);
  rejects('glob', { pattern: 42 }, /"pattern" deve ser string/);
  rejects('grep', { pattern: 42 }, /"pattern" deve ser string/);
  rejects('grep', { pattern: 'foo', type: 42 }, /"type" deve ser string/);
  rejects('validateProject', { path: 42 }, /"path" deve ser string/);
});

// ── T2: registry completeness + schema-shape validity ────────────────────────

test('T2: registry covers every luna-tools export + the 3 soul-only dispatched tools', () => {
  const { TOOL_REGISTRY } = require('../lib/tool-registry.cjs');
  const toolNames = Object.keys(require('../luna-tools.cjs'));
  // Dispatched by luna-soul.cjs outside the export map (:4579-4586, :4526-4578):
  const SOUL_ONLY = ['dashboardCommandRouter', 'ipython', 'computer'];
  for (const name of [...toolNames, ...SOUL_ONLY]) {
    assert.ok(TOOL_REGISTRY[name], `registry entry missing for dispatched tool "${name}"`);
  }
  assert.strictEqual(
    Object.keys(TOOL_REGISTRY).length,
    toolNames.length + SOUL_ONLY.length,
    'registry must contain EXACTLY the dispatched tools — adding a tool means adding a registry entry'
  );
});

test('T2: every registry entry has a valid shape (schema vocabulary + meta slots)', () => {
  const { TOOL_REGISTRY } = require('../lib/tool-registry.cjs');
  const SCHEMA_KEYS = new Set(['required', 'types', 'pathMustExist', 'pathMustBeAbsolute', 'pathMustNotContain', 'forbiddenPatterns']);
  const TYPE_VALUES = new Set(['string', 'number', 'boolean', 'object']);
  for (const [name, entry] of Object.entries(TOOL_REGISTRY)) {
    assert.ok(entry.meta && 'icon' in entry.meta && 'color' in entry.meta && 'label' in entry.meta,
      `${name}: meta must carry the icon/color/label slots`);
    if (entry.aliasOf) assert.strictEqual(typeof entry.aliasOf, 'string', `${name}: aliasOf must be a string`);
    if (!entry.schema) continue;
    for (const key of Object.keys(entry.schema)) {
      assert.ok(SCHEMA_KEYS.has(key), `${name}: unknown schema key "${key}" (validateToolCall would ignore it)`);
    }
    assert.ok(Array.isArray(entry.schema.required), `${name}: schema.required must be an array`);
    for (const [field, type] of Object.entries(entry.schema.types || {})) {
      assert.ok(TYPE_VALUES.has(type), `${name}: bad type "${type}" for field "${field}"`);
    }
    for (const re of entry.schema.forbiddenPatterns || []) {
      assert.ok(re instanceof RegExp, `${name}: forbiddenPatterns entries must be RegExp (got ${typeof re})`);
    }
  }
});

test('T2: registry schemas are identical to the pre-migration guard TOOL_SCHEMAS (verbatim move)', () => {
  const { buildToolSchemas } = require('../lib/tool-registry.cjs');
  const { TOOL_SCHEMAS } = require('../luna-tool-guard.cjs');
  const fromRegistry = buildToolSchemas();
  assert.deepStrictEqual(Object.keys(fromRegistry).sort(), Object.keys(TOOL_SCHEMAS).sort(),
    'registry must carry exactly the 12 current schemas');
  for (const name of Object.keys(TOOL_SCHEMAS)) {
    assert.deepStrictEqual(fromRegistry[name], TOOL_SCHEMAS[name], `${name}: schema must be a verbatim move`);
  }
});

test('T2: registry meta is a superset of the 18 harvested ToolCard entries', () => {
  const { TOOL_REGISTRY } = require('../lib/tool-registry.cjs');
  const HARVESTED = {
    writeFile: ['📄', '#3b82f6'], readFile: ['👁', '#22c55e'], executeShell: ['⚡', '#a855f7'],
    searchWeb: ['🌐', '#f97316'], searchFiles: ['🔍', '#f97316'], gitStatus: ['🌿', '#6b7280'],
    gitDiff: ['📊', '#6b7280'], gitLog: ['📜', '#6b7280'], gitCommit: ['💾', '#6b7280'],
    dashboardCreateTask: ['📋', '#ec4899'], dashboardListTasks: ['📋', '#ec4899'],
    dashboardCreateLead: ['👤', '#ec4899'], dashboardListLeads: ['👥', '#ec4899'],
    dashboardGetFinanceSummary: ['💰', '#ec4899'], replaceInFile: ['✏️', '#06b6d4'],
    ipython: ['🐍', '#f59e0b'], web_search: ['🌐', '#f97316'], browser: ['🌍', '#3b82f6'],
  };
  for (const [name, [icon, color]] of Object.entries(HARVESTED)) {
    assert.strictEqual(TOOL_REGISTRY[name]?.meta?.icon, icon, `${name}: icon must match ToolCard`);
    assert.strictEqual(TOOL_REGISTRY[name]?.meta?.color, color, `${name}: color must match ToolCard`);
  }
});
