import { writable, derived } from 'svelte/store';

export const sessions = writable([]);
export const currentSessionId = writable(null);
export const isStreaming = writable(false);
export const currentMode = writable('thinking');
export const messages = writable([]);
export const lunaConfig = writable({});
export const connectionStatus = writable('connected');

export const currentSession = derived(
  [sessions, currentSessionId],
  ([$sessions, $id]) => $sessions.find(s => s.id === $id)
);
