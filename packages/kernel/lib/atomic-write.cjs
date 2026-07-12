'use strict';
const fs = require('fs');
const path = require('path');
// Write to a sibling temp file then rename — rename(2) is atomic on POSIX
// within the same directory, so readers never see a half-written file.
function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.luna-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}
module.exports = { atomicWriteFileSync };
