#!/usr/bin/env node
/**
 * Luna + NEXO Health Watchdog
 *
 * Monitors luna-server health and auto-recovers from stuck states:
 *   - Checks luna-server HTTP health + /api/system/status every 30s.
 *   - If luna-soul is not "ready" or kimi-bridge is not "connected",
 *     restarts luna-server via PM2.
 *   - If Chrome/CDP (kimi) has too many duplicate "new_chat" tabs,
 *     closes the duplicates (leaves 1) via the CDP /json/close endpoint.
 *   - Detects a frozen web stream in luna-server's log (same session stuck
 *     at the same thinking/response for > STUCK_MS) and restarts luna-server.
 *   - Falls back to raw port reachability checks.
 */

const http = require('http');
const { execSync } = require('child_process');

const LUNA_PORT = parseInt(process.env.LUNA_PORT, 10) || 3458;
const CDP_PORT = parseInt(process.env.CHROME_CDP_PORT, 10) || 9222;
const CHECK_INTERVAL_MS = 30000;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_DUP_PAGES = 3;
const LUNA_OUT_LOG = process.env.LUNA_OUT_LOG || '/root/nexo-projects-abner/logs/luna-server-out.log';
const STUCK_MS = parseInt(process.env.STUCK_STREAM_MS, 10) || 180000; // 3 min frozen = stuck

function requestJson(port, path) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function getCdpJson() {
  return requestJson(CDP_PORT, '/json');
}

function closeCdpTarget(targetId) {
  return requestJson(CDP_PORT, `/json/close/${targetId}`);
}

function restartProcess(name) {
  try {
    // cwd:'/' avoids "getcwd() failed: ENOENT" crashes when the process cwd is gone
    execSync(`pm2 restart ${name}`, { stdio: 'pipe', cwd: '/' });
    return true;
  } catch (e) {
    console.error(`[${new Date().toISOString()}] ⚠️ Failed to restart ${name}: ${e.message}`);
    return false;
  }
}

async function cleanupDuplicateKimiTabs() {
  const pages = await getCdpJson();
  if (!Array.isArray(pages)) return null;
  const pageList = pages.filter((p) => p.type === 'page');
  const newChat = pageList.filter((p) => (p.url || '').includes('new_chat'));
  if (newChat.length > MAX_DUP_PAGES) {
    console.error(`[${new Date().toISOString()}] ⚠️ ${newChat.length} duplicate Kimi tabs — closing ${newChat.length - 1}`);
    for (const tab of newChat.slice(1)) {
      try {
        await closeCdpTarget(tab.id);
      } catch (e) {
        /* ignore */
      }
    }
    return newChat.length;
  }
  return pageList.length;
}

async function checkLunaStatus() {
  const status = await requestJson(LUNA_PORT, '/api/system/status');
  if (!status || !status.ok) return null;
  return status.status || {};
}

// Detect a frozen stream: same session at same thinking/response for > STUCK_MS
const STUCK_TAIL_LINES = 300;

function detectStuckStream() {
  try {
    // Read only the last N lines (the log can be hundreds of MB; never read it whole)
    const out = execSync(`tail -n ${STUCK_TAIL_LINES} "${LUNA_OUT_LOG}"`, { stdio: ['pipe', 'pipe', 'pipe'], cwd: '/' }).toString();
    const lines = out.split('\n').filter((l) => l.includes('Stream state:'));
    if (lines.length < 2) return null;
    const last = lines[lines.length - 1];
    const m = last.match(/thinking=(\d+) response=(\d+) isStreaming=true \(session=([^)]+)\)/);
    if (!m) return null;
    const [, thinking, response, session] = m;
    // Find first occurrence with same frozen signature and compare timestamps
    let firstTs = null;
    const re = new RegExp(`thinking=${thinking} response=${response} isStreaming=true \\(session=${escapeRe(session)}\\)`);
    for (const l of lines) {
      if (re.test(l)) {
        firstTs = l.slice(0, 24);
        break;
      }
    }
    if (!firstTs) return null;
    // A frozen stream floods the log with the SAME thinking/response over and over.
    // Count consecutive lines with the identical frozen signature — if many, it's stuck.
    let count = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (re.test(lines[i])) count++;
      else break;
    }
    // ~10 state lines per second → >= 30 consecutive identical ≈ stuck for several seconds
    const STUCK_LINE_COUNT = 30;
    const frozenMs = Date.now() - new Date(firstTs.slice(0, 19).replace(' ', 'T') + 'Z').getTime();
    const stuck = count >= STUCK_LINE_COUNT || frozenMs > STUCK_MS;
    return stuck ? { session, thinking, response, frozenMs, count } : null;
  } catch {
    return null;
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runCheck() {
  const now = new Date().toISOString();
  let degraded = false;

  // 0) Detect frozen stream in luna-server log
  const stuck = detectStuckStream();
  if (stuck) {
    console.error(`[${now}] ❌ Frozen stream ${stuck.session} (thinking=${stuck.thinking} response=${stuck.response} for ${Math.round(stuck.frozenMs / 1000)}s) — restarting luna-server`);
    restartProcess('luna-server');
    degraded = true;
  }

  // 1) Rich status check via /api/system/status
  const st = await checkLunaStatus();
  if (st) {
    const soulReady = st['luna-soul']?.ready === true;
    const bridgeConnected = st['kimi-bridge']?.status === 'connected';
    const pages = st['kimi-bridge']?.pages ?? 0;

    if (!soulReady || !bridgeConnected) {
      console.error(`[${now}] ❌ Luna degraded (soulReady=${soulReady}, bridge=${st['kimi-bridge']?.status}) — restarting luna-server`);
      restartProcess('luna-server');
      degraded = true;
    } else {
      console.log(`[${now}] ✅ luna-soul ready, kimi-bridge connected (pages=${pages})`);
    }
  } else {
    // 2) Fallback: raw HTTP health
    const health = await requestJson(LUNA_PORT, '/health');
    if (health && health.status === 'ok') {
      console.log(`[${now}] ✅ luna-server:${LUNA_PORT} healthy`);
    } else {
      console.error(`[${now}] ❌ luna-server:${LUNA_PORT} not responding — restarting`);
      restartProcess('luna-server');
      degraded = true;
    }
  }

  // 3) Always check for duplicate Kimi tabs (they cause stuck streams)
  if (!degraded) {
    const pageCount = await cleanupDuplicateKimiTabs();
    if (pageCount && pageCount > MAX_DUP_PAGES) {
      console.error(`[${now}] ⚠️ Closed duplicate Kimi tabs (pages left: 1)`);
    }
  }
}

async function main() {
  console.log(`[${new Date().toISOString()}] Luna/NEXO health watchdog started (luna=:${LUNA_PORT}, cdp=:${CDP_PORT})`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await runCheck();
    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error('Watchdog crashed:', err);
  process.exit(1);
});
