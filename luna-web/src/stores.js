import { writable, derived } from 'svelte/store';

export const sessions = writable([]);
export const selectedSessionIds = writable(new Set());
export const selectionMode = writable(false);

// Persistent session store — NO timeout, survives until user closes
function createPersistentSessionStore() {
  const STORAGE_KEY = 'luna_current_session';

  let initial = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      initial = data.id || null;
    }
  } catch (e) {
    console.warn('Session restore error:', e);
  }

  const store = writable(initial);

  store.subscribe(id => {
    try {
      if (id) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ id }));
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (e) {
      console.warn('Session persist error:', e);
    }
  });

  return store;
}

export const currentSessionId = createPersistentSessionStore();
export const isStreaming = writable(false);
export const currentMode = writable('instant');
export const messages = writable([]);
export const lunaConfig = writable({});
export const connectionStatus = writable('connected');
export const user = writable(null);
export const authToken = writable(localStorage.getItem('luna_token') || null);

// v9.1-fix: lunaStore for ChatHeader status indicators
export const lunaStore = derived(
  [connectionStatus, isStreaming],
  ([$connectionStatus, $isStreaming]) => ({
    isLoading: $isStreaming,
    isOnline: $connectionStatus === 'connected'
  })
);

export const currentSession = derived(
  [sessions, currentSessionId],
  ([$sessions, $id]) => $sessions.find(s => s.id === $id)
);

// Theme system: dynamic accent colors per mode
export const MODE_COLORS = {
  instant:  { primary: '#06b6d4', glow: 'rgba(6,182,212,0.3)',  border: 'rgba(6,182,212,0.15)',  name: 'Instant' },
  thinking: { primary: '#a855f7', glow: 'rgba(168,85,247,0.3)', border: 'rgba(168,85,247,0.15)', name: 'Thinking' },
  agent:    { primary: '#f59e0b', glow: 'rgba(245,158,11,0.3)', border: 'rgba(245,158,11,0.15)', name: 'Agent' },
  swarm:    { primary: '#4ade80', glow: 'rgba(74,222,128,0.3)', border: 'rgba(74,222,128,0.15)', name: 'Swarm' },
};

// ── Mascote Luna ──
export const mascotState = writable('sleep'); // sleep | idle | thinking | working
export const mascotMessage = writable(null); // Mensagem contextual temporária

export const PLAN_MODE_COLORS = {
  primary: '#c9a227',
  glow: 'rgba(201,162,39,0.3)',
  border: 'rgba(201,162,39,0.15)',
  bg: '#1a1a2e',
  surface: '#12121f',
  text: '#e2e8f0',
  accent: '#ffd700',
};

export const planModeState = writable({
  active: false,
  plan: null,
  planPath: null,
  status: 'idle',
  sessionId: null,
});

export const themeColors = derived(
  currentMode,
  ($mode) => MODE_COLORS[$mode] || MODE_COLORS.thinking
);

// Action event store for triggering starfield effects when tools/actions execute
export const actionEvent = writable(null);

// Voice state store
export const voiceState = writable({
  active: false,
  status: 'idle', // 'idle' | 'listening' | 'processing'
});

// Real-time audio frequency data (Uint8Array, 64 bins)
export const voiceAudioData = writable(new Uint8Array(64));

// v9.3: Active modal for rich slash command responses
export const activeModal = writable(null); // null | 'tasks' | 'leads' | 'finance' | 'voting' | 'ideas' | 'links' | 'emails' | 'whatsapp' | 'config'
