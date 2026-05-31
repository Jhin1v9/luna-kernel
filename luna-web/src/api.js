import { connectionStatus, isStreaming } from './stores.js';

export class SSEManager {
  constructor() {
    this.eventSource = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.baseDelay = 1000;
    this.maxDelay = 15000;
    this.isIntentionallyClosed = false;
    this.gracefulClose = false;
    this.statusDebounceTimer = null;
    this.lastStatus = null;
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

  connect(sessionId, onEvent) {
    this.isIntentionallyClosed = false;
    this.gracefulClose = false;
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
      this._setStatus('disconnected');
      if (!this.isIntentionallyClosed && !this.gracefulClose && this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = Math.min(this.baseDelay * Math.pow(2, this.reconnectAttempts), this.maxDelay);
        this.reconnectAttempts++;
        console.log(`[SSE] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        setTimeout(() => this.connect(sessionId, onEvent), delay);
      } else if (this.gracefulClose) {
        console.log('[SSE] Graceful close — no reconnect needed.');
      } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this._setStatus('error');
      }
    };
  }

  disconnect() {
    this.isIntentionallyClosed = true;
    this.gracefulClose = true;
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
