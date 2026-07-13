'use strict';
// Wave 8 (v10.1 real): build/install/long commands get a 300s shell budget
// regardless of the visible flag. Matched case-insensitively against the whole
// command string, so chained commands (`cd x && npm install`) count too.
const BUILD_COMMAND_RE = /(?:npm|pnpm|yarn|bun)\s+install|(?:npm|pnpm|yarn|bun)\s+run\s+build|apt(?:-get)?\s+install|pip3?\s+install|docker\s+build|cargo\s+build|\bmake\b|\bgradle\b|\bmvn\b/i;

function isBuildLikeCommand(command) {
  return BUILD_COMMAND_RE.test(String(command || ''));
}

// Precedence (unchanged from v10.1): build-like → 300s wins even over an
// explicit opts.timeout; everything else → opts.timeout || 60.
function resolveShellTimeout(command, opts = {}) {
  return isBuildLikeCommand(command) ? 300 : (opts.timeout || 60);
}

module.exports = { isBuildLikeCommand, resolveShellTimeout };
