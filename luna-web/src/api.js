import { connectionStatus, isStreaming } from './stores.js';

// ============================================================
// Auth Helpers
// ============================================================

function getToken() {
  return localStorage.getItem('luna_token');
}

function authHeaders(contentType = true) {
  const h = {};
  const token = getToken();
  if (token) h['Authorization'] = `Bearer ${token}`;
  if (contentType) h['Content-Type'] = 'application/json';
  return h;
}

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
    // v5.5-fix: On first activation, record current history length so we don't
    // replay the ENTIRE history. lastMessageCount starts at 0, so slice(0) emits all.
    const initialCount = this.lastMessageCount;
    this.fallbackTimer = setInterval(async () => {
      if (this.isIntentionallyClosed || this.gracefulClose || this.eventSource) return;
      try {
        const res = await fetch(`/api/chat/session/${encodeURIComponent(sessionId)}/messages`, {
          headers: authHeaders(false)
        });
        const data = await res.json();
        if (data.ok && data.messages) {
          // v5.5-fix: First activation — skip existing history, only track new messages
          if (this.lastMessageCount === 0 && initialCount === 0) {
            this.lastMessageCount = data.messages.length;
            return;
          }
          const newMessages = data.messages.slice(this.lastMessageCount);
          for (const msg of newMessages) {
            if (this.onEventCallback) {
              this.onEventCallback({
                type: msg.type || 'response_delta',
                role: msg.role,
                text: msg.content,
                fullResponse: msg.content,
                source: 'fallback',
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

    const token = getToken();
    const url = `/api/chat/stream?sessionId=${encodeURIComponent(sessionId)}${token ? '&token=' + encodeURIComponent(token) : ''}`;
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

export async function sendMessage(message, sessionId, mode = 'instant', files = [], messageId = null) {
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
  const body = { message, sessionId, mode, files: filePayload };
  if (messageId) body.messageId = messageId;

  // v9.2-fix: Retry with exponential backoff — prevents "Unexpected end of JSON input"
  // when the backend service crashes or restarts mid-request.
  const maxRetries = 3;
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      return await res.json();
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries - 1) {
        const delay = 1000 * Math.pow(2, attempt) + Math.random() * 500;
        console.log(`[sendMessage] Retry ${attempt + 1}/${maxRetries - 1} in ${Math.round(delay)}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

export async function cancelStream(sessionId) {
  isStreaming.set(false);
  await fetch('/api/chat/cancel', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ sessionId })
  });
}

export async function fetchSessions() {
  try {
    const res = await fetch('/api/chat/sessions', { headers: authHeaders(false) });
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
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
  return res.json();
}

export async function exportSessions(sessionIds, format = 'json') {
  const res = await fetch('/api/chat/export', {
    method: 'POST',
    headers: authHeaders(),
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
        headers: authHeaders(),
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
    headers: authHeaders(),
    body: JSON.stringify({ userId })
  });
  return res.json();
}

export async function fetchSessionMessages(sessionId) {
  try {
    const res = await fetch(`/api/chat/session/${encodeURIComponent(sessionId)}/messages`, {
      headers: authHeaders(false)
    });
    return res.json();
  } catch {
    return { ok: false, messages: [] };
  }
}

export async function fetchConfig() {
  try {
    const res = await fetch('/api/config', { headers: authHeaders(false) });
    return res.json();
  } catch {
    return {};
  }
}

export async function saveConfig(config) {
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: authHeaders(),
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
    if (res.status === 401) {
      // Token expired or invalid — clear it and force re-login
      localStorage.removeItem('luna_token');
      return null;
    }
    const data = await res.json();
    if (data.ok && data.user) return data.user;
    return null;
  } catch {
    // Backend offline — dev fallback only when unreachable
    return { id: 'dev', name: 'Dev User', email: 'dev@local', role: 'admin' };
  }
}

// Global 401 handler: intercept fetch responses and clear expired tokens
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  const res = await originalFetch.apply(this, args);
  if (res.status === 401) {
    const token = localStorage.getItem('luna_token');
    if (token) {
      // Only clear if we actually had a token (not a public endpoint 401)
      const url = typeof args[0] === 'string' ? args[0] : args[0].url;
      if (url && !url.includes('/api/auth/login')) {
        localStorage.removeItem('luna_token');
        // Reload to force login screen when token is rejected
        if (!window.__luna401handled) {
          window.__luna401handled = true;
          setTimeout(() => { window.__luna401handled = false; }, 5000);
          window.location.reload();
        }
      }
    }
  }
  return res;
};

// ============================================================
// Plan Mode API
// ============================================================

export async function startPlanMode(message, sessionId) {
  const res = await fetch('/api/plan', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ message, sessionId })
  });
  return res.json();
}

export async function approvePlan(sessionId) {
  const res = await fetch('/api/plan/approve', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ sessionId })
  });
  return res.json();
}

export async function rejectPlan(sessionId) {
  const res = await fetch('/api/plan/reject', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ sessionId })
  });
  return res.json();
}

export async function submitRevision(sessionId, revisedPlan) {
  const res = await fetch('/api/plan/revise', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ sessionId, revisedPlan })
  });
  return res.json();
}

// ============================================================
// System Commands API
// ============================================================

export async function systemRestart() {
  const res = await fetch('/api/system/restart', { method: 'POST', headers: authHeaders(false) });
  return res.json();
}

export async function systemStop() {
  const res = await fetch('/api/system/stop', { method: 'POST', headers: authHeaders(false) });
  return res.json();
}

export async function systemStart() {
  const res = await fetch('/api/system/start', { method: 'POST', headers: authHeaders(false) });
  return res.json();
}

export async function systemStatus() {
  const res = await fetch('/api/system/status', { headers: authHeaders(false) });
  return res.json();
}

export async function fetchPersonas() {
  try {
    const res = await fetch('/api/personas', { headers: authHeaders(false) });
    return res.json();
  } catch {
    return { ok: false, personas: [] };
  }
}

export async function setSessionPersona(sessionId, persona) {
  const res = await fetch('/api/chat/session', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ action: 'setPersona', sessionId, persona })
  });
  return res.json();
}

export async function systemHealth() {
  const res = await fetch('/api/system/health', { headers: authHeaders(false) });
  return res.json();
}

export async function systemLogs(lines = 50) {
  const res = await fetch(`/api/system/logs?lines=${lines}`, { headers: authHeaders(false) });
  return res.json();
}

export async function testConnection(type, token) {
  const res = await fetch('/api/system/test-connection', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ type, token }),
  });
  return res.json();
}

export async function executeLunaTool(tool, params = {}) {
  const res = await fetch('/api/luna/execute', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ tool, params }),
  });
  return res.json();
}

export async function downloadSelfHost() {
  const res = await fetch('/api/selfhost/download', { method: 'POST', headers: authHeaders(false) });
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
