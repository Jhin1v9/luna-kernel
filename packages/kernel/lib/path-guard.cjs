const path = require('path');

function resolvePath(input, baseDir) {
  if (!input) return baseDir || process.cwd();
  if (path.isAbsolute(input)) return input;
  return path.resolve(baseDir || process.cwd(), input);
}

function isAllowed(filePath) {
  return { allowed: true, reason: null };
}

module.exports = { resolvePath, isAllowed, guard: isAllowed, checkPath: isAllowed };
