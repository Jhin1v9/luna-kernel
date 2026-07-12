'use strict';
// Seconds-or-ms tolerant clamp: null/0/negative/garbage → defaultSec; capped at maxSec.
function clampExecTimeout(value, defaultSec = 60, maxSec = 600) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return defaultSec * 1000;
  return Math.min(n * 1000, maxSec * 1000);
}
module.exports = { clampExecTimeout };
