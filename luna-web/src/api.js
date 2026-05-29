import { connectionStatus, isStreaming } from './stores.js';

export class SSEManager {
  constructor() {
    this.eventSource = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.baseDelay = 1000;
    this.maxDelay = 30000;
    this.isIntentionallyClosed = false;
  }

  connect(sessionId, onEvent) {
    this.isIntentionallyClosed = false;
    const url = `/api/chat/stream?sessionId=${encodeURIComponent(sessionId)}`;
    this.eventSource = new EventSource(url);

    this.eventSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        onEvent(event);
        this.reconnectAttempts = 0;
        connectionStatus.set('connected');
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };

    this.eventSource.onopen = () => {
      this.reconnectAttempts = 0;
      connectionStatus.set('connected');
    };

    this.eventSource.onerror = () => {
      this.eventSource.close();
      connectionStatus.set('disconnected');
      if (!this.isIntentionallyClosed && this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = Math.min(
          this.baseDelay * Math.pow(2, this.reconnectAttempts),
          this.maxDelay
        );
        this.reconnectAttempts++;
        setTimeout(() => this.connect(sessionId, onEvent), delay);
      } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        connectionStatus.set('error');
      }
    };
  }

  disconnect() {
    this.isIntentionallyClosed = true;
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }
}

export async function sendMessage(message, sessionId, mode = 'thinking') {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId, mode })
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
  const res = await fetch('/api/chat/sessions');
  return res.json();
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
