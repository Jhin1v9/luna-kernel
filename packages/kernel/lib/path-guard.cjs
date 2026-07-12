'use strict';
const fs = require('fs');
const path = require('path');

// realpath of the nearest existing ancestor + re-join the non-existing tail.
function realpathLoose(p) {
  const resolved = path.resolve(p);
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  return path.join(realpathLoose(parent), path.basename(resolved));
}

function isInside(child, root) {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Returns { ok: true, resolved } or { ok: false, reason }.
// allowedRoots: pre-realpathed absolute dirs (workspace, LUNA_TMP_DIR, os.tmpdir()).
function checkPathWithinRoots(rawPath, allowedRoots) {
  if (!rawPath || typeof rawPath !== 'string') return { ok: false, reason: 'path vazio' };
  const expanded = rawPath.startsWith('~/') ? path.join(require('os').homedir(), rawPath.slice(2)) : rawPath;
  const real = realpathLoose(expanded);
  for (const root of allowedRoots) {
    if (isInside(real, root)) return { ok: true, resolved: real };
  }
  return { ok: false, reason: `"${rawPath}" (real: ${real}) está fora dos diretórios permitidos`, resolved: real };
}

// All param keys that carry a filesystem path across the 123-tool surface.
const PATH_PARAM_KEYS = ['path', 'filePath', 'file', 'source', 'from', 'destination', 'to', 'dirPath'];

module.exports = { realpathLoose, isInside, checkPathWithinRoots, PATH_PARAM_KEYS };
