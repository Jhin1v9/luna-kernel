/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Luna Config v5.2 — Single Source of Truth
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Centralized configuration for all Luna services.
 * All modules should import from here instead of using hardcoded values.
 * Environment variables override these defaults.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const path = require('path');
const os = require('os');

// ── Base Paths ──
const HOME_DIR = os.homedir();
const LUNA_KERNEL_DIR = path.join(HOME_DIR, '.luna-kernel');
const LUNA_DIR = path.join(HOME_DIR, '.luna');
const NEXO_DIR = path.join(HOME_DIR, 'NEXO_DASHBOARD_PRO');

// ── Ports ──
const PORTS = {
  luna: parseInt(process.env.LUNA_PORT, 10) || 3458,
  dashboard: parseInt(process.env.DASHBOARD_PORT, 10) || 3456,
  caddyHttp: parseInt(process.env.CADDY_HTTP_PORT, 10) || 8080,
  caddyHttps: parseInt(process.env.CADDY_HTTPS_PORT, 10) || 5173,
};

// ── URLs ──
const URLS = {
  dashboard: process.env.DASHBOARD_URL || `http://localhost:${PORTS.dashboard}`,
  luna: process.env.LUNA_URL || `http://localhost:${PORTS.luna}`,
  public: process.env.PUBLIC_URL || `https://luna-app.duckdns.org:${PORTS.caddyHttps}`,
};

// ── Timeouts ──
const TIMEOUTS = {
  kimi: parseInt(process.env.KIMI_TIMEOUT, 10) || 120000,
  kimiIdle: parseInt(process.env.KIMI_IDLE_TIMEOUT, 10) || 10 * 60 * 1000,
  kimiCooldown: parseInt(process.env.KIMI_COOLDOWN_MS, 10) || 5000,
  sseReconnectBase: 1000,
  sseReconnectMax: 30000,
  heartbeatInterval: 30000,
  dbRetryBase: 1000,
  dbRetryMax: 5000,
  orphanStreamCleanup: 10 * 60 * 1000,
};

// ── Paths ──
const PATHS = {
  lunaDist: path.join(LUNA_KERNEL_DIR, 'luna-web', 'dist'),
  dashboardPublic: path.join(NEXO_DIR, 'backend', 'public'),
  dashboardData: path.join(NEXO_DIR, 'backend', 'data'),
  sessions: path.join(LUNA_DIR, 'sessions'),
  personas: path.join(LUNA_DIR, 'personas'),
  skills: path.join(LUNA_DIR, 'skills'),
  memories: path.join(LUNA_DIR, 'memories'),
  artifacts: path.join(LUNA_KERNEL_DIR, '..', 'ARTIFACTS'),
  env: path.join(LUNA_KERNEL_DIR, '.env'),
  runtime: path.join(LUNA_KERNEL_DIR, '.luna-runtime.json'),
};

// ── Kimi Bridge ──
const KIMI = {
  maxPages: parseInt(process.env.KIMI_MAX_PAGES, 10) || 5,
  maxTextTypeLength: parseInt(process.env.KIMI_MAX_TYPE_LENGTH, 10) || 500,
  logMaxSizeMB: parseInt(process.env.KIMI_LOG_MAX_MB, 10) || 10,
  persistentMode: process.env.KIMI_PERSISTENT_MODE === 'true' || process.env.KIMI_PERSISTENT_MODE === '1',
  cdpPorts: [9222, 9223, 9224, 9225],
  modeUrls: {
    instant: 'https://www.kimi.com/?chat_enter_method=new_chat',
    thinking: 'https://www.kimi.com/?chat_enter_method=new_chat',
    agent: 'https://www.kimi.com/agent',
    swarm: 'https://www.kimi.com/agent-swarm',
  },
};

// ── Auth ──
const AUTH = {
  jwtSecret: process.env.JWT_SECRET || 'nexo-test-secret-2026',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  serviceToken: process.env.INTERNAL_API_TOKEN,
};

// ── Database ──
const DB = {
  url: process.env.DATABASE_URL,
  poolSize: parseInt(process.env.DB_POOL_SIZE, 10) || 20,
  cacheTTL: {
    stats: 30,
    sessions: 10,
    leads: 60,
    tasks: 60,
    finance: 30,
    voting: 30,
  },
};

// ── Feature Flags ──
const FEATURES = {
  enableCache: process.env.ENABLE_CACHE !== 'false',
  enablePersonas: process.env.ENABLE_PERSONAS !== 'false',
  enableTelegramSync: process.env.ENABLE_TELEGRAM_SYNC === 'true',
  enableDebug: process.env.LUNA_DEBUG === 'true',
};

module.exports = {
  HOME_DIR,
  LUNA_KERNEL_DIR,
  LUNA_DIR,
  NEXO_DIR,
  PORTS,
  URLS,
  TIMEOUTS,
  PATHS,
  KIMI,
  AUTH,
  DB,
  FEATURES,
};
