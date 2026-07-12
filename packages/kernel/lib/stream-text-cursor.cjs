'use strict';
// Per-source cumulative-text cursor with cross-source divergence guard.
// Each producer (chrome_extension, dom-structure poll, dom_observer) gets
// its own cursor; deltas are only emitted when the incoming full text is
// consistent with everything already committed to the frontend.
function createResponseCursor() {
  const bySource = new Map(); // source -> last full text seen from that source
  let committed = '';         // text already emitted downstream

  return {
    // Returns { emit: string|null, diverged: boolean }
    next(source, full) {
      if (!full) return { emit: null, diverged: false };
      const key = source || 'unknown';
      const prev = bySource.get(key) || '';
      if (full === prev) return { emit: null, diverged: false };
      // Source shrank/reset (DOM rebuild): move the cursor, emit nothing.
      if (!full.startsWith(prev)) {
        bySource.set(key, full);
        return { emit: null, diverged: false };
      }
      bySource.set(key, full);
      // Cross-source consistency: committed text (trimEnd-tolerant) must be
      // a prefix of this full text, otherwise the producers disagree and
      // emitting would duplicate/corrupt. Swallow and flag.
      const committedTrim = committed.replace(/\s+$/, '');
      if (committed && !full.startsWith(committed) && !full.startsWith(committedTrim)) {
        return { emit: null, diverged: true };
      }
      const base = full.startsWith(committed) ? committed : committedTrim;
      const delta = full.slice(base.length);
      if (!delta) return { emit: null, diverged: false };
      committed += delta;
      return { emit: delta, diverged: false };
    },
    get committed() { return committed; },
  };
}
module.exports = { createResponseCursor };
