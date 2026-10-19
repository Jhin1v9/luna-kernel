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
const fs = require('fs');

// ── Base Paths ──
// Environment variables allow the same code to run on any PC (home, dad's,
// VPS) without recompiling. Set LUNA_HOME once and every runtime/data dir is
// derived from it.
const HOME_DIR = os.homedir();
const LUNA_HOME = process.env.LUNA_HOME || path.join(HOME_DIR, '.luna');
const LUNA_KERNEL_DIR = process.env.LUNA_KERNEL_DIR || path.join(LUNA_HOME, 'kernel');
const LUNA_DIR = process.env.LUNA_DIR || LUNA_HOME;
const NEXO_DIR = process.env.NEXO_DIR || path.join(LUNA_HOME, 'dashboard');

/**
 * Ensure a directory exists (admin-style helper). Creates missing parents.
 * Never throws: returns true on success, false on failure.
 */
function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }
    return true;
  } catch (err) {
    console.error(`[LunaPaths] Failed to create directory ${dir}: ${err.message}`);
    return false;
  }
}

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
  lunaHome: LUNA_HOME,
  lunaKernel: LUNA_KERNEL_DIR,
  luna: LUNA_DIR,
  nexo: NEXO_DIR,
  tmp: path.join(LUNA_HOME, '.luna-tmp'),
  logs: path.join(LUNA_HOME, 'logs'),
  plans: path.join(LUNA_KERNEL_DIR, 'plans'),
  workspaceBase: process.env.LUNA_WORKSPACE_BASE || path.join(LUNA_HOME, 'workspace'),
  lunaDist: path.join(LUNA_KERNEL_DIR, 'luna-web', 'dist'),
  dashboardPublic: path.join(NEXO_DIR, 'backend', 'public'),
  dashboardData: path.join(NEXO_DIR, 'backend', 'data'),
  sessions: path.join(LUNA_DIR, 'sessions'),
  personas: path.join(LUNA_DIR, 'personas'),
  skills: path.join(LUNA_DIR, 'skills'),
  memories: path.join(LUNA_DIR, 'memories'),
  artifacts: path.join(LUNA_HOME, 'ARTIFACTS'),
  env: path.join(LUNA_HOME, '.env'),
  runtime: path.join(LUNA_HOME, '.luna-runtime.json'),
  promptConfig: path.join(LUNA_KERNEL_DIR, 'config', 'luna-prompt-config.json'),
  masterPrompt: path.join(LUNA_KERNEL_DIR, 'LUNA_MASTER_PROMPT.md'),
};

// ── Prompt Config Bootstrap (v14.4-fix 2026-10-19) ──
// O REPO eh a fonte da verdade: packages/kernel/config/luna-prompt-config.json
// No boot: runtime (~/.luna/kernel/config/) inexistente → copia do template.
// Runtime com _templateVersion menor que o template → backup + sync.
// Assim PC novo / reinstalacao nasce com o config correto, zero manual.
const PROMPT_CONFIG_TEMPLATE = path.join(__dirname, 'luna-prompt-config.json');
function ensurePromptConfig() {
  try {
    if (!fs.existsSync(PROMPT_CONFIG_TEMPLATE)) return false;
    let tpl = null;
    try { tpl = JSON.parse(fs.readFileSync(PROMPT_CONFIG_TEMPLATE, 'utf8')); } catch { return false; }
    const dest = PATHS.promptConfig;
    if (!fs.existsSync(dest)) {
      const dir = path.dirname(dest);
      try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {}
      fs.copyFileSync(PROMPT_CONFIG_TEMPLATE, dest);
      console.log('[LunaConfig] prompt-config criado do template do repo (install novo)');
      return true;
    }
    const tplV = parseFloat(tpl._templateVersion || 0);
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(dest, 'utf8')); } catch { return false; }
    const curV = parseFloat(cur._templateVersion || 0);
    if (tplV > curV) {
      const bak = dest + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      try { fs.copyFileSync(dest, bak); } catch {}
      fs.copyFileSync(PROMPT_CONFIG_TEMPLATE, dest);
      console.log('[LunaConfig] prompt-config sincronizado: v' + curV + ' -> v' + tplV + ' (backup: ' + path.basename(bak) + ')');
    }
    return true;
  } catch (err) {
    console.warn('[LunaConfig] ensurePromptConfig: ' + err.message);
    return false;
  }
}
ensurePromptConfig();

// ── Kimi Bridge ──
const KIMI = {
  maxPages: parseInt(process.env.KIMI_MAX_PAGES, 10) || 5,
  maxTextTypeLength: parseInt(process.env.KIMI_MAX_TYPE_LENGTH, 10) || 500,
  logMaxSizeMB: parseInt(process.env.KIMI_LOG_MAX_MB, 10) || 10,
  persistentMode: process.env.KIMI_PERSISTENT_MODE === 'true' || process.env.KIMI_PERSISTENT_MODE === '1',
  cdpPorts: [9222, 9223, 9224, 9225],
  modeUrls: {
    instant: 'https://www.kimi.ai',
    thinking: 'https://www.kimi.ai',
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

// ── Path Guard ──
const PATH_GUARD_CONFIG_FILE = path.join(LUNA_HOME, 'path-guard.json');

function loadPathGuardConfig() {
  try {
    if (fs.existsSync(PATH_GUARD_CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(PATH_GUARD_CONFIG_FILE, 'utf-8'));
      // v10.43: env var LUNA_ADMIN_MODE overrides adminMode flag
      if (process.env.LUNA_ADMIN_MODE === 'true' || process.env.LUNA_ADMIN_MODE === '1') {
        cfg.adminMode = true;
      }
      return cfg;
    }
  } catch {}
  const adminMode = process.env.LUNA_ADMIN_MODE === 'true' || process.env.LUNA_ADMIN_MODE === '1';
  return {
    enabled: !adminMode,
    adminMode,
    allowHomeDir: true,
    customPaths: []
  };
}

function savePathGuardConfig(config) {
  try {
    ensureDir(path.dirname(PATH_GUARD_CONFIG_FILE));
    fs.writeFileSync(PATH_GUARD_CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (err) {
    console.error(`[PathGuard] Failed to save config: ${err.message}`);
    return false;
  }
}

const PATH_GUARD = {
  configFile: PATH_GUARD_CONFIG_FILE,
  load: loadPathGuardConfig,
  save: savePathGuardConfig,
};

module.exports = {
  HOME_DIR,
  LUNA_HOME,
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
  PATH_GUARD,
  ensureDir,
};
