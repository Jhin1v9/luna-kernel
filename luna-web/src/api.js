import { connectionStatus, isStreaming } from './stores.js';

export class SSEManager {
  constructor() {
    this.eventSource = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = Infinity; // v5.2: Never give up
    this.baseDelay = 1000;
    this.maxDelay = 30000;
    this.isIntentionallyClosed = false;
    this.gracefulClose = false;
    this.statusDebounceTimer = null;
    this.lastStatus = null;
    this.currentSessionId = null;
    this.onEventCallback = null;
    this.fallbackTimer = null;
    this.lastMessageCount = 0;
  }

  _setStatus(status) {
    if (this.statusDebounceTimer) clearTimeout(this.statusDebounceTimer);
    if (status === 'disconnected' && this.lastStatus === 'connected') {
      this.statusDebounceTimer = setTimeout(() => {
        connectionStatus.set(status);
        this.lastStatus = status;
      }, 400);
    } else {
      connectionStatus.set(status);
      this.lastStatus = status;
    }
  }

  // v5.2: Fallback polling when SSE is down
  _startFallbackPolling(sessionId) {
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = setInterval(async () => {
      if (this.isIntentionallyClosed || this.gracefulClose || this.eventSource) return;
      try {
        const res = await fetch(`/api/chat/session/${encodeURIComponent(sessionId)}/messages`);
        const data = await res.json();
        if (data.ok && data.messages) {
          const newMessages = data.messages.slice(this.lastMessageCount);
          for (const msg of newMessages) {
            if (this.onEventCallback) {
              this.onEventCallback({
                type: msg.type || 'response_delta',
                role: msg.role,
                text: msg.content,
                fullResponse: msg.content,
                timestamp: msg.timestamp,
              });
            }
          }
          this.lastMessageCount = data.messages.length;
        }
      } catch (e) {
        // Silently fail — fallback is best-effort
      }
    }, 2000);
  }

  _stopFallbackPolling() {
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  connect(sessionId, onEvent) {
    this.onEventCallback = onEvent;
    // v4.1-fix: Prevent duplicate connections for same session
    if (this.eventSource && this.currentSessionId === sessionId) {
      console.log(`[SSE] Already connected to session ${sessionId}, skipping`);
      return;
    }
    // Disconnect any existing connection before creating new one
    if (this.eventSource) {
      console.log('[SSE] Disconnecting existing connection before reconnect');
      this.disconnect();
    }
    this.currentSessionId = sessionId;
    this.isIntentionallyClosed = false;
    this.gracefulClose = false;
    this.reconnectAttempts = 0;
    this._stopFallbackPolling();

    const url = `/api/chat/stream?sessionId=${encodeURIComponent(sessionId)}`;
    this.eventSource = new EventSource(url);

    this.eventSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        onEvent(event);
        this.reconnectAttempts = 0;
        this._setStatus('connected');
        if (event.type === 'done' || event.type === 'error') {
          this.gracefulClose = true;
        }
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };

    this.eventSource.onopen = () => {
      this.reconnectAttempts = 0;
      this._setStatus('connected');
    };

    this.eventSource.onerror = () => {
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
      if (!this.isIntentionallyClosed && !this.gracefulClose) {
        this._setStatus('reconnecting');
        // v5.2: Start fallback polling immediately
        this._startFallbackPolling(sessionId);
        const delay = Math.min(this.baseDelay * Math.pow(2, this.reconnectAttempts) + Math.random() * 1000, this.maxDelay);
        this.reconnectAttempts++;
        console.log(`[SSE] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        setTimeout(() => this.connect(sessionId, onEvent), delay);
      } else if (this.gracefulClose) {
        this._setStatus('disconnected');
        console.log('[SSE] Graceful close — no reconnect needed.');
        this._stopFallbackPolling();
      }
    };
  }

  disconnect() {
    this.isIntentionallyClosed = true;
    this.gracefulClose = true;
    this.currentSessionId = null;
    this.onEventCallback = null;
    this._stopFallbackPolling();
    if (this.statusDebounceTimer) clearTimeout(this.statusDebounceTimer);
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this._setStatus('disconnected');
  }
}

export async function sendMessage(message, sessionId, mode = 'thinking', files = []) {
  let filePayload = [];
  if (files && files.length > 0) {
    filePayload = await Promise.all(
      files.map(async (file) => {
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(file);
        });
        return {
          name: file.name,
          type: file.type,
          size: file.size,
          data: dataUrl,
        };
      })
    );
  }
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId, mode, files: filePayload })
  });
  return res.json();
}

export async function cancelStream(sessionId) {
  isStreaming.set(false);
  await fetch('/api/chat/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  });
}

export async function fetchSessions() {
  try {
    const res = await fetch('/api/chat/sessions');
    return res.json();
  } catch {
    return { ok: true, sessions: [] };
  }
}

export async function sessionAction(action, sessionId, title) {
  const body = { action, sessionId };
  if (title !== undefined) body.title = title;
  const res = await fetch('/api/chat/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

export async function exportSessions(sessionIds, format = 'json') {
  const res = await fetch('/api/chat/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionIds, format })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Erro ao exportar' }));
    throw new Error(err.error || 'Erro ao exportar');
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : `luna-export.${format === 'markdown' ? 'md' : format}`;
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
  return { ok: true };
}

// ============================================================
// Heartbeat — keep agent page alive (persistent mode)
// ============================================================
let heartbeatTimer = null;

export function startHeartbeat(userId = 'web-default', intervalMs = 30000) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(async () => {
    try {
      await fetch('/api/system/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });
    } catch (e) {
      // Silently fail — heartbeat is best-effort
    }
  }, intervalMs);
}

export function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export async function turnOffAgent(userId = 'web-default') {
  stopHeartbeat();
  const res = await fetch('/api/system/turnoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId })
  });
  return res.json();
}

export async function fetchSessionMessages(sessionId) {
  try {
    const res = await fetch(`/api/chat/session/${encodeURIComponent(sessionId)}/messages`);
    return res.json();
  } catch {
    return { ok: false, messages: [] };
  }
}

export async function fetchConfig() {
  try {
    const res = await fetch('/api/config');
    return res.json();
  } catch {
    return {};
  }
}

export async function saveConfig(config) {
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
  return res.json();
}

export async function login(username, password) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  return res.json();
}

export async function logout() {
  localStorage.removeItem('luna_token');
}

export async function fetchMe() {
  const token = localStorage.getItem('luna_token');
  if (!token) return null;
  try {
    const res = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.ok && data.user) return data.user;
    // Dev fallback: mock user when backend returns error/unauthorized
    return { id: 'dev', name: 'Dev User', email: 'dev@local', role: 'admin' };
  } catch {
    // Dev fallback: mock user when backend is unavailable
    return { id: 'dev', name: 'Dev User', email: 'dev@local', role: 'admin' };
  }
}

// ============================================================
// Plan Mode API
// ============================================================

export async function startPlanMode(message, sessionId) {
  const res = await fetch('/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId })
  });
  return res.json();
}

export async function approvePlan(sessionId) {
  const res = await fetch('/api/plan/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  });
  return res.json();
}

export async function rejectPlan(sessionId) {
  const res = await fetch('/api/plan/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  });
  return res.json();
}

export async function submitRevision(sessionId, revisedPlan) {
  const res = await fetch('/api/plan/revise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, revisedPlan })
  });
  return res.json();
}

// ============================================================
// System Commands API
// ============================================================

export async function systemRestart() {
  const res = await fetch('/api/system/restart', { method: 'POST' });
  return res.json();
}

export async function systemStop() {
  const res = await fetch('/api/system/stop', { method: 'POST' });
  return res.json();
}

export async function systemStart() {
  const res = await fetch('/api/system/start', { method: 'POST' });
  return res.json();
}

export async function systemStatus() {
  const res = await fetch('/api/system/status');
  return res.json();
}

export async function fetchPersonas() {
  try {
    const res = await fetch('/api/personas');
    return res.json();
  } catch {
    return { ok: false, personas: [] };
  }
}

export async function setSessionPersona(sessionId, persona) {
  const res = await fetch('/api/chat/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'setPersona', sessionId, persona })
  });
  return res.json();
}

export async function systemHealth() {
  const res = await fetch('/api/system/health');
  return res.json();
}

export async function systemLogs(lines = 50) {
  const res = await fetch(`/api/system/logs?lines=${lines}`);
  return res.json();
}

export async function testConnection(type, token) {
  const res = await fetch('/api/system/test-connection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, token }),
  });
  return res.json();
}

export async function executeLunaTool(tool, params = {}) {
  const res = await fetch('/api/luna/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, params }),
  });
  return res.json();
}

export async function downloadSelfHost() {
  const res = await fetch('/api/selfhost/download', { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Erro desconhecido' }));
    throw new Error(err.error || 'Erro ao baixar pacote');
  }
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'luna-selfhost.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
  return { ok: true };
}
