'use strict';

const crypto = require('crypto');

/**
 * W6-T6 / W10-T1: stable cross-source dedup key for phantom-prone DOM events
 * (action_detected / response_detected) in _enqueueDomEvent.
 *
 * The key must ONLY use fields that EVERY detection source provides. The
 * Chrome extension never sends `code` while the network interceptor does, so
 * hashing `code` made the SAME logical tool call produce different keys per
 * source — the second detection slipped past dedup and, if the first was
 * still running (the soul's action cache is only written at completion), the
 * tool executed TWICE.
 */
function makeDomEventDedupKey(event) {
  return event.type + ':' + crypto.createHash('sha256')
    .update(JSON.stringify({ t: event.type, a: event.action, r: event.response }))
    .digest('hex').slice(0, 16);
}

module.exports = { makeDomEventDedupKey };
