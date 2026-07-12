'use strict';

/**
 * Wave 1 Fix B1: dedup key for soul events forwarded by luna-chat-routes.
 *
 * action_* events carry no text content, so a content-based key collapses
 * repeated calls of the same tool within a turn (the 2nd call is dropped).
 * For those event types the key uses the per-invocation toolInstanceId
 * (falling back to the event id); all other events keep the original
 * content-based dedup.
 */
const ACTION_EVENT_TYPES = new Set(['action_start', 'action_end', 'action_progress']);

function makeEventDedupKey(ev, content) {
  if (ACTION_EVENT_TYPES.has(ev.type)) {
    return `${ev.type}:${ev.tool || ''}:${ev.toolInstanceId || ev.id || ''}`;
  }
  return `${ev.type}:${String(content || '').slice(0, 200)}:${ev.tool || ''}`;
}

module.exports = { makeEventDedupKey, ACTION_EVENT_TYPES };
