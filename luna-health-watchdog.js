#!/usr/bin/env node
/**
 * Luna + NEXO Health Watchdog
 *
 * Monitors the critical ports every 30s and restarts the corresponding
 * PM2 process if a service becomes unreachable. This is a safety net on
 * top of PM2's built-in autorestart.
 *
 * Monitored services:
 *   - luna-server      : 3458
 *   - luna-vite        : 5173
 *   - nexo-dashboard   : 3456
 *   - nexo-lp-server   : 3460
 *   - nexo-lp-web      : 5174
 */

const http = require('http');
const { execSync } = require('child_process');

const SERVICES = [
  { name: 'luna-server', port: 3458, protocol: 'http' },
  { name: 'luna-vite', port: 5173, protocol: 'https', rejectUnauthorized: false },
  { name: 'nexo-dashboard', port: 3456, protocol: 'http' },
  { name: 'nexo-lp-server', port: 3460, protocol: 'http' },
  { name: 'nexo-lp-web', port: 5174, protocol: 'http' },
];

const CHECK_INTERVAL_MS = 30000;
const REQUEST_TIMEOUT_MS = 10000;

function checkService(service) {
  return new Promise((resolve) => {
    const options = {
      hostname: '127.0.0.1',
      port: service.port,
      path: '/',
      method: 'GET',
      timeout: REQUEST_TIMEOUT_MS,
      rejectUnauthorized: service.rejectUnauthorized === false ? false : true,
    };

    const lib = service.protocol === 'https' ? require('https') : http;
    const req = lib.request(options, (res) => {
      const ok = res.statusCode >= 100 && res.statusCode < 600; // any response means alive
      resolve(ok);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.on('error', () => {
      resolve(false);
    });

    req.end();
  });
}

async function runCheck() {
  const now = new Date().toISOString();
  for (const service of SERVICES) {
    const alive = await checkService(service);
    if (alive) {
      console.log(`[${now}] ✅ ${service.name}:${service.port} is reachable`);
    } else {
      console.error(`[${now}] ❌ ${service.name}:${service.port} is NOT reachable — restarting via PM2`);
      try {
        execSync(`pm2 restart ${service.name}`, { stdio: 'inherit' });
      } catch (err) {
        console.error(`[${now}] ⚠️ Failed to restart ${service.name}: ${err.message}`);
      }
    }
  }
}

async function main() {
  console.log(`[${new Date().toISOString()}] Luna/NEXO health watchdog started`);
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
