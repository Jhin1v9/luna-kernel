import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import fs from 'fs';
import path from 'path';
import http from 'http';

/**
 * Auto-discover the Luna backend port.
 * 1. Reads .luna-runtime.json written by config-server.cjs
 * 2. Falls back to common ports if not found
 */
function discoverBackendPort() {
  // Try reading runtime config from known locations
  const candidates = [
    path.resolve(__dirname, '..', '..', 'NEXO_DASHBOARD_PRO', 'agents', '.luna-runtime.json'),
    path.resolve(__dirname, '..', '..', '.luna-runtime.json'),
    path.resolve(__dirname, '..', '.luna-runtime.json'),
    path.resolve(__dirname, '.luna-runtime.json'),
  ];

  for (const file of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.apiPort) {
        console.log(`[vite] Backend discovered via ${file} → port ${data.apiPort}`);
        return data.apiPort;
      }
    } catch { /* ignore */ }
  }

  // Static fallback: try well-known ports in order
  const fallbackPorts = [3458, 3000, 8080, 5000, 3456];
  console.log(`[vite] No runtime config found. Trying fallback ports: ${fallbackPorts.join(', ')}`);
  return fallbackPorts[0];
}

const BACKEND_PORT = process.env.LUNA_CONFIG_PORT || 3458;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    host: true,
    allowedHosts: ['.trycloudflare.com', '.loca.lt', '.duckdns.org', 'localhost', '127.0.0.1'],
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
        // Auto-retry on connection refused — helpful when backend is still starting
        configure: (proxy) => {
          proxy.on('error', (err, req, res) => {
            console.warn(`[vite] Proxy error to ${BACKEND_URL}${req.url}: ${err.message}`);
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Backend unavailable', port: BACKEND_PORT }));
            }
          });
          // Disable SSE buffering so events arrive in real time
          proxy.on('proxyRes', (proxyRes, req, res) => {
            proxyRes.headers['x-accel-buffering'] = 'no';
          });
        }
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
});
