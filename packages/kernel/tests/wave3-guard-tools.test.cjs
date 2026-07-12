// wave3-guard-tools.test.cjs — Wave 3 regression tests
// Fix A: readFile binary detection + 2MB byte cap (lib/text-file.cjs + luna-tools.cjs)
// Fix B: atomic writeFile via tmp+rename (lib/atomic-write.cjs + luna-tools.cjs + luna-soul.cjs)
// Fix C: IdempotencyStore TTL + mark-on-success + success:true on skip (luna-tool-guard.cjs)
// Run: node --test packages/kernel/tests/wave3-guard-tools.test.cjs
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { looksBinary } = require('../lib/text-file.cjs');
const { atomicWriteFileSync } = require('../lib/atomic-write.cjs');
const { readFile, writeFile, replaceInFile } = require('../luna-tools.cjs');
const { ToolGuard, IdempotencyStore } = require('../luna-tool-guard.cjs');

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
    assert.ok(
      result.note && result.note.includes('executeShell') && result.note.includes('NÃO é acessível'),
      'note must warn that the rest is unreachable via readFile and point to executeShell/grep'
    );
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

// ── Fix B: atomic writes (tmp + rename) ──────────────────────────────────────

function tmpLeftovers(dir) {
  return fs.readdirSync(dir).filter((name) => name.startsWith('.luna-tmp-'));
}

test('B1: atomicWriteFileSync creates a file with exact content and no tmp leftover', () => {
  withTmpDir((dir) => {
    const file = path.join(dir, 'out.txt');
    atomicWriteFileSync(file, 'conteúdo com acentuação\nsegunda linha\n');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'conteúdo com acentuação\nsegunda linha\n');
    assert.deepStrictEqual(tmpLeftovers(dir), [], 'no .luna-tmp-* files may be left behind');
  });
});

test('B1: atomicWriteFileSync overwrites an existing file atomically (full replace)', () => {
  withTmpDir((dir) => {
    const file = path.join(dir, 'out.txt');
    fs.writeFileSync(file, 'old content that is longer than the new one\n', 'utf8');
    atomicWriteFileSync(file, 'new\n');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new\n', 'content must be fully replaced, not partially overwritten');
    assert.deepStrictEqual(tmpLeftovers(dir), []);
  });
});

test('B1: atomicWriteFileSync writes Buffer content byte-exactly', () => {
  withTmpDir((dir) => {
    const file = path.join(dir, 'blob.bin');
    const buf = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7f]);
    atomicWriteFileSync(file, buf);
    assert.deepStrictEqual(fs.readFileSync(file), buf);
    assert.deepStrictEqual(tmpLeftovers(dir), []);
  });
});

test('B1: atomicWriteFileSync throws on failure and cleans up the tmp file', () => {
  withTmpDir((dir) => {
    const missing = path.join(dir, 'no-such-dir', 'out.txt');
    assert.throws(() => atomicWriteFileSync(missing, 'x'), 'must throw when the target dir does not exist');
    assert.deepStrictEqual(tmpLeftovers(dir), [], 'tmp file must be unlinked on the error path');
    assert.strictEqual(fs.existsSync(path.join(dir, 'no-such-dir')), false, 'target dir must not be created');
  });
});

test('B1: atomicWriteFileSync leaves no partial file when rename fails (rename error injection)', () => {
  withTmpDir((dir) => {
    const file = path.join(dir, 'target.txt');
    fs.writeFileSync(file, 'original\n', 'utf8');
    const originalRename = fs.renameSync;
    fs.renameSync = () => { throw new Error('injected rename failure'); };
    try {
      assert.throws(() => atomicWriteFileSync(file, 'corrupted\n'), /injected rename failure/);
    } finally {
      fs.renameSync = originalRename;
    }
    // The crash must NOT have touched the destination — readers see the old
    // complete file, never a half-written one.
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'original\n');
    assert.deepStrictEqual(tmpLeftovers(dir), [], 'tmp file must be cleaned up after the rename failure');
  });
});

test('B2: writeFile tool writes atomically (exact content, no tmp leftover)', () => {
  withTmpDir((dir) => {
    const file = path.join(dir, 'tool-out.txt');
    const result = writeFile(file, 'via writeFile tool\n');
    assert.strictEqual(result.success, true);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'via writeFile tool\n');
    assert.deepStrictEqual(tmpLeftovers(dir), []);
  });
});

test('B2: writeFile tool base64 branch writes exact bytes', () => {
  withTmpDir((dir) => {
    const file = path.join(dir, 'tool-blob.bin');
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
    const result = writeFile(file, buf.toString('base64'), { encoding: 'base64' });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(fs.readFileSync(file), buf);
    assert.deepStrictEqual(tmpLeftovers(dir), []);
  });
});

test('B2: replaceInFile tool writes atomically (exact content, no tmp leftover)', () => {
  withTmpDir((dir) => {
    const file = path.join(dir, 'tool-edit.txt');
    fs.writeFileSync(file, 'foo bar baz\n', 'utf8');
    const result = replaceInFile(file, 'bar', 'qux');
    assert.strictEqual(result.success, true);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'foo qux baz\n');
    assert.deepStrictEqual(tmpLeftovers(dir), []);
  });
});

test('B3: luna-tools.cjs no longer writes writeFile results directly', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'luna-tools.cjs'), 'utf8');
  assert.ok(!src.includes('fs.writeFileSync(resolved, finalContent)'), 'writeFile must use atomicWriteFileSync');
  assert.ok(!src.includes("fs.writeFileSync(resolved, content, 'utf8')"), 'replaceInFile must use atomicWriteFileSync');
});

test('B3: luna-soul.cjs auto-fix rewrite is atomic', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'luna-soul.cjs'), 'utf8');
  assert.ok(!src.includes('fs.writeFileSync(writtenPath'), 'soul auto-fix must not write directly');
  assert.ok(src.includes('atomicWriteFileSync(writtenPath'), 'soul auto-fix must use atomicWriteFileSync');
});

// B4: mode preservation — overwriting an executable file must keep its mode
// (tmp+rename replaces the inode; without chmod the mode would reset to
// 0o666 & ~umask and Luna's self-edited .sh files would lose +x).
test('B4: atomicWriteFileSync preserves the target file mode on overwrite', () => {
  const { atomicWriteFileSync } = require('../lib/atomic-write.cjs');
  withTmpDir(dir => {
    const target = path.join(dir, 'script.sh');
    fs.writeFileSync(target, '#!/bin/bash\necho old\n');
    fs.chmodSync(target, 0o755);

    atomicWriteFileSync(target, '#!/bin/bash\necho new\n');

    const mode = fs.statSync(target).mode & 0o777;
    assert.strictEqual(mode, 0o755, `mode must be preserved, got ${mode.toString(8)}`);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '#!/bin/bash\necho new\n');
  });
});

test('B4b: atomicWriteFileSync on a new file uses default mode', () => {
  const { atomicWriteFileSync } = require('../lib/atomic-write.cjs');
  withTmpDir(dir => {
    const target = path.join(dir, 'fresh.txt');
    atomicWriteFileSync(target, 'hello');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'hello');
    // Default mode = 0o666 & ~umask — just assert it exists and is a file.
    assert.ok(fs.statSync(target).isFile());
  });
});

// ── Fix C: IdempotencyStore TTL + mark-on-success + skip result shape ────────

const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

test('C1: IdempotencyStore expires entries after the TTL (injected clock)', () => {
  let now = 1000;
  const store = new IdempotencyStore(() => now);
  const key = store.generateKey('writeFile', { path: '/tmp/x', content: 'y' });

  assert.strictEqual(store.isProcessed(key), false, 'unseen key must not be processed');
  store.markProcessed(key);
  assert.strictEqual(store.isProcessed(key), true, 'just-marked key must be processed');

  now += IDEMPOTENCY_TTL_MS - 1; // advance < TTL
  assert.strictEqual(store.isProcessed(key), true, 'key within TTL must still be processed');

  now += 1; // advance to exactly TTL
  assert.strictEqual(store.isProcessed(key), false, 'key at/after TTL must be expired');
  assert.strictEqual(store.isProcessed(key), false, 'expired key must stay deleted');
});

test('C2: ToolGuard.execute does NOT mark a failed result — retry re-executes', async () => {
  const guard = new ToolGuard(process.cwd());
  let calls = 0;
  const toolFn = async () => { calls++; return { success: false, error: 'boom' }; };

  const first = await guard.execute('executeShell', { command: 'echo ok' }, toolFn);
  const second = await guard.execute('executeShell', { command: 'echo ok' }, toolFn);

  assert.strictEqual(calls, 2, 'failed toolFn must be executed BOTH times (no silent skip)');
  assert.strictEqual(first.skipped, undefined);
  assert.strictEqual(second.skipped, undefined, 'second call must NOT be idempotency-skipped');
  assert.strictEqual(second.success, false);
});

test('C3: ToolGuard.execute skips a duplicate SUCCESS with success:true on the skip result', async () => {
  const guard = new ToolGuard(process.cwd());
  let calls = 0;
  const toolFn = async () => { calls++; return { success: true, output: 'done' }; };

  const first = await guard.execute('executeShell', { command: 'echo ok' }, toolFn);
  const second = await guard.execute('executeShell', { command: 'echo ok' }, toolFn);

  assert.strictEqual(calls, 1, 'successful toolFn must execute only once');
  assert.strictEqual(first.success, true);
  assert.strictEqual(second.skipped, true, 'duplicate success must be idempotency-skipped');
  assert.strictEqual(second.success, true, 'skip result must carry success:true (a no-op success, not a failure)');
  assert.strictEqual(second.reason, 'already processed');
});

// C4: auto-commit gate must not fire for idempotency-skipped results —
// the skip path bypasses the checksum drift check, so committing there
// could commit externally-modified content (FILE_DRIFT bypass).
test('C4: soul auto-commit gate excludes skipped results (content assertion)', () => {
  const soulSrc = fs.readFileSync(require('node:path').join(__dirname, '../luna-soul.cjs'), 'utf8');
  const gateIdx = soulSrc.indexOf('Auto-commit git hook for file-modifying tools');
  assert.ok(gateIdx !== -1, 'auto-commit gate must exist');
  const window = soulSrc.slice(gateIdx, gateIdx + 500);
  assert.ok(
    window.includes('result.success && !result.skipped'),
    'auto-commit gate must exclude idempotency-skipped results'
  );
});
