// wave3-guard-tools.test.cjs — Wave 3 regression tests
// Fix A: readFile binary detection + 2MB byte cap (lib/text-file.cjs + luna-tools.cjs)
// Run: node --test packages/kernel/tests/wave3-guard-tools.test.cjs
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { looksBinary } = require('../lib/text-file.cjs');
const { readFile } = require('../luna-tools.cjs');

// ── Fix A1: looksBinary (pure unit tests) ────────────────────────────────────

test('A1: looksBinary returns false for plain text', () => {
  assert.strictEqual(looksBinary(Buffer.from('hello world\nfoo\tbar\r\nlinha com acentuação é í\n')), false);
});

test('A1: looksBinary returns true when the buffer contains a NUL byte', () => {
  assert.strictEqual(looksBinary(Buffer.from([0x68, 0x69, 0x00, 0x6f, 0x6b])), true);
});

test('A1: looksBinary returns true when >30% of the sample is control chars', () => {
  const buf = Buffer.alloc(100, 0x61); // 'a'
  for (let i = 0; i < 40; i++) buf[i] = 0x01; // 40% control chars
  assert.strictEqual(looksBinary(buf), true);
});

test('A1: looksBinary returns false for an empty buffer', () => {
  assert.strictEqual(looksBinary(Buffer.alloc(0)), false);
  assert.strictEqual(looksBinary(null), false);
});

// ── Fix A2: readFile integration (tmp-dir fixtures) ──────────────────────────

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-wave3-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('A2: readFile caps files over 2MB (truncatedBytes, no full read)', () => {
  withTmpDir((dir) => {
    const file = path.join(dir, 'big.log');
    // ~3MB of text: 30000 lines × (100 chars + \n)
    const line = 'x'.repeat(100) + '\n';
    fs.writeFileSync(file, line.repeat(30000));
    const fileSize = fs.statSync(file).size;
    assert.ok(fileSize > 2 * 1024 * 1024, `fixture must exceed 2MB (got ${fileSize})`);

    const result = readFile(file);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.truncatedBytes, true, 'truncatedBytes must be true for files over the cap');
    assert.ok(result.content.length < fileSize, 'returned content must be smaller than the file (no full read)');
    assert.ok(result.note && result.note.includes('line_offset'), 'note must tell Kimi to page with line_offset');
  });
});

test('A2: readFile rejects a binary file and points to readMediaFile', () => {
  withTmpDir((dir) => {
    const file = path.join(dir, 'img.png');
    // PNG signature + IHDR chunk header (contains NUL bytes)
    fs.writeFileSync(file, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10,
    ]));

    const result = readFile(file);
    assert.strictEqual(result.success, false, 'binary file must not be utf8-decoded');
    assert.ok(result.error.includes('readMediaFile'), `error must mention readMediaFile (got: ${result.error})`);
  });
});

test('A2: readFile on a small text file keeps the numbered output unchanged', () => {
  withTmpDir((dir) => {
    const file = path.join(dir, 'small.txt');
    fs.writeFileSync(file, 'hello\nworld\n', 'utf8');

    const result = readFile(file);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.truncatedBytes, undefined);
    assert.strictEqual(result.totalLines, 3);
    assert.strictEqual(result.linesRead, 3);
    assert.strictEqual(result.content, '   1 │ hello\n   2 │ world\n   3 │ ');
  });
});
