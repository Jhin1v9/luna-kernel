// Luna Extension — Background Service Worker (MV3)
// v8.1: Message router between content scripts and Luna server via HTTP polling
// Eliminates offscreen document lifecycle issues by using fetch + polling

const LUNA_SERVER_URL = 'http://localhost:3458';
const PROVIDER_URL_PATTERNS = [
  'https://www.kimi.ai/*',
  'https://kimi.ai/*',
  'https://www.kimi.moonshot.cn/*',
  'https://kimi.moonshot.cn/*',
  'https://chat.deepseek.com/*',
  'https://deepseek.com/*'
];

// ── State ──
let sessionId = null;
let isForwarding = true;
let isRegistering = false; // v10.7-fix: Prevent concurrent registration

// v13.0-fix: alarme keepalive REMOVIDO de proposito — Chrome clampa alarme em
// 30s e o MV3 mata o SW aos ~30s sem eventos (corrida que perde as vezes).
// Keep-alive raiz = heartbeat Port vindo do content script (onConnect abaixo):
// enquanto uma pagina provider vive, HB chega a cada 15s e o SW nunca dorme.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'luna-poll') {
    pollServer();
  }
});

// ── Content Script Injection ──
async function injectContentScriptIntoTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
      world: 'ISOLATED'
    });
    console.log(`[Luna BG] Content script injected into tab ${tabId}`);
  } catch (e) {
    console.warn(`[Luna BG] Failed to inject into tab ${tabId}:`, e.message);
  }
}

async function reinjectAllProviderTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: PROVIDER_URL_PATTERNS });
    for (const tab of tabs) {
      if (tab.id) await injectContentScriptIntoTab(tab.id);
    }
    console.log(`[Luna BG] Reinjected ${tabs.length} provider tab(s)`);
  } catch (e) {
    console.warn('[Luna BG] Failed to query tabs:', e.message);
  }
}

// ── Server Communication ──
async function registerSession() {
  // v10.7-fix: Prevent concurrent registration and reuse existing session
  if (isRegistering) return false;
  if (sessionId) return true; // Already registered

  // Try to restore session from storage
  try {
    const stored = await chrome.storage.session.get('lunaSessionId');
    if (stored.lunaSessionId) {
      sessionId = stored.lunaSessionId;
      console.log('[Luna BG] Restored session:', sessionId);
      // v13.3-poll-on-restore: o early return original deixava a extensao
      // SEM poll quando a sessao vinha do storage — lastPing congelava, o
      // cleanup(120s) matava a sessao e o kernel via '0 sessoes conectadas'
      // ate o proximo reload. Agora o poll inicia tambem no caminho de restore.
      if (!globalThis.__lunaPollInterval) {
        globalThis.__lunaPollInterval = setInterval(pollServer, 3000);
        pollServer();
      }
      return true;
    }
  } catch (e) {}

  isRegistering = true;
  try {
    sessionId = 'ext-' + Date.now();
    const res = await fetch(`${LUNA_SERVER_URL}/ext/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, type: 'extension' })
    });
    if (res.ok) {
      console.log('[Luna BG] Session registered:', sessionId);
      // Persist sessionId to storage
      try {
        await chrome.storage.session.set({ lunaSessionId: sessionId });
      } catch (e) {}
      // v12.0-fix (2026-10-19): Chrome clampa alarmes MV3 em 30s — o "poll de
      // 6s" era 30s na real. Polling real a cada 3s via setInterval; o alarme
      // keepalive mantem o SW vivo e o handler 'luna-poll' continua OK.
      if (!globalThis.__lunaPollInterval) {
        globalThis.__lunaPollInterval = setInterval(pollServer, 3000);
        pollServer();
      }
      return true;
    }
  } catch (e) {
    console.warn('[Luna BG] Failed to register session:', e.message);
  } finally {
    isRegistering = false;
  }
  return false;
}

async function sendEventToServer(payload) {
  try {
    const res = await fetch(`${LUNA_SERVER_URL}/ext/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        ...payload,
        timestamp: Date.now()
      })
    });
    return res.ok;
  } catch (e) {
    console.warn('[Luna BG] Failed to send event:', e.message);
    return false;
  }
}

async function pollServer() {
  if (!sessionId) return;
  try {
    const res = await fetch(`${LUNA_SERVER_URL}/ext/poll?sessionId=${sessionId}`, {
      method: 'GET'
    });
    if (res.ok) {
      const data = await res.json();
      if (data.messages && data.messages.length > 0) {
        for (const msg of data.messages) {
          routeToTab(msg);
        }
      }
    }
  } catch (e) {
    // Server may be down — ignore
  }
}

// ── Heartbeat keep-alive (v13.0-fix) ──
// O content script abre uma Port e manda {type:"luna:hb"} a cada 15s. Cada
// mensagem na Port e um EVENTO pro SW => idle timer zera => SW vivo enquanto
// a pagina vive. Sem pagina: nenhuma Port => SW dorme natural (~30s).
const lunaHeartbeatPorts = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'luna-heartbeat') return;
  lunaHeartbeatPorts.add(port);
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === "luna:hb") port.__lastHb = Date.now();
  });
  port.onDisconnect.addListener(() => { lunaHeartbeatPorts.delete(port); });
});

// ── Message Routing ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle messages from content scripts (single events or batches)
  if (message.type?.startsWith('luna_')) {
    const tab = sender.tab || { id: sender.tab?.id, url: sender.url };
    handleContentMessage(message, tab)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // Keep message channel open for async response
  }

  return false;
});

async function handleContentMessage(message, tab) {
  // v11.6-fix: explode batches into individual server events while preserving tab context.
  const events = (message.type === 'luna_event_batch' && Array.isArray(message.events))
    ? message.events
    : [message];

  for (const ev of events) {
    const payload = {
      type: ev.type || ev.eventType,
      eventType: ev.eventType || ev.type,
      data: ev.data,
      timestamp: ev.timestamp,
      url: ev.url || message.url,
      tabId: tab.id,
      tabUrl: tab.url,
      version: message.version || ev.version
    };

    if (!sessionId) {
      await registerSession();
    }

    if (sessionId) {
      await sendEventToServer(payload);
    }
  }
}

async function routeToTab(payload) {
  if (!payload.tabId) {
    // v12.0-fix: drop silencioso era invisivel no debug
    console.warn('[Luna BG] routeToTab: mensagem SEM tabId — drop:', payload.type);
    return;
  }
  try {
    await chrome.tabs.sendMessage(payload.tabId, {
      type: 'luna_server_response',
      payload
    });
  } catch (e) {
    // Tab may be closed or content script not loaded
  }
}

// ── Tab Management ──
chrome.tabs.onRemoved.addListener((tabId) => {
  if (sessionId) {
    sendEventToServer({ type: 'luna_tab_closed', tabId }).catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && isProviderUrl(tab.url)) {
    injectContentScriptIntoTab(tabId).catch(() => {});
  }
});

function isProviderUrl(url) {
  return PROVIDER_URL_PATTERNS.some(pattern => {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(url);
  });
}

// ── Startup ──
chrome.runtime.onStartup.addListener(() => {
  console.log('[Luna BG] onStartup fired');
  reinjectAllProviderTabs();
  registerSession();
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Luna BG] onInstalled fired');
  reinjectAllProviderTabs();
  registerSession();
});

// Register on load
registerSession();
// v10.7-fix: Also reinject into all existing provider tabs on SW load.
// This handles the case where the extension was loaded after the tab was already open.
reinjectAllProviderTabs();

console.log('[Luna BG] Service Worker loaded v13.3 (heartbeat Port + poll-on-restore)');
