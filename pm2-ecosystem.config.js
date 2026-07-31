const path = require('path');
const os = require('os');

// Root do monorepo — detecta automaticamente
const ROOT = __dirname;

// Detecta se é Windows e ajusta PATH
const IS_WINDOWS = process.platform === 'win32';
const SYSTEM_PATH = IS_WINDOWS 
  ? process.env.PATH || process.env.Path || ''
  : '/home/noke/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

// Home do usuário (cross-platform)
const HOME = os.homedir();

module.exports = {
  apps: [
    {
      name: 'luna-server',
      script: path.join(ROOT, 'apps', 'dashboard', 'luna-server.js'),
      cwd: path.join(ROOT, 'apps', 'dashboard'),
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PATH: SYSTEM_PATH,
        LUNA_HOME: path.join(HOME, '.luna'),
        LUNA_KERNEL_DIR: path.join(ROOT, 'packages', 'kernel'),
        LUNA_DIR: path.join(ROOT, 'packages', 'kernel'),
        NEXO_DIR: path.join(ROOT, 'apps', 'dashboard'),
      },
      max_restarts: 50,
      min_uptime: '10s',
      restart_delay: 3000,
      kill_timeout: 8000,
      listen_timeout: 15000,
      vizion: false,
      exp_backoff_restart_delay: 100,
    },
    {
      name: 'nexo-dashboard',
      script: path.join(ROOT, 'apps', 'dashboard', 'server.js'),
      cwd: path.join(ROOT, 'apps', 'dashboard'),
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PATH: SYSTEM_PATH,
        LUNA_HOME: path.join(HOME, '.luna'),
        LUNA_KERNEL_DIR: path.join(ROOT, 'packages', 'kernel'),
        LUNA_DIR: path.join(ROOT, 'packages', 'kernel'),
        NEXO_DIR: path.join(ROOT, 'apps', 'dashboard'),
      },
      max_restarts: 50,
      min_uptime: '10s',
      restart_delay: 3000,
      kill_timeout: 8000,
      listen_timeout: 15000,
      vizion: false,
      exp_backoff_restart_delay: 100,
    },
    {
      name: 'luna-vite',
      script: 'npm',
      args: 'run dev',
      cwd: path.join(ROOT, 'apps', 'dashboard'),
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'development',
        PATH: SYSTEM_PATH,
        PORT: 5173,
      },
      max_restarts: 50,
      min_uptime: '15s',
      restart_delay: 5000,
      kill_timeout: 10000,
      listen_timeout: 20000,
      vizion: false,
      exp_backoff_restart_delay: 100,
      wait_ready: false,
    },
    {
      name: 'luna-health-watchdog',
      script: path.join(ROOT, 'packages', 'kernel', 'luna-health-watchdog.js'),
      cwd: path.join(ROOT, 'packages', 'kernel'),
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        PATH: SYSTEM_PATH,
      },
      max_restarts: 50,
      min_uptime: '10s',
      restart_delay: 3000,
      kill_timeout: 5000,
      vizion: false,
      exp_backoff_restart_delay: 100,
    },
    {
      name: 'luna-telegram-adapter',
      script: path.join(ROOT, 'packages', 'kernel', 'telegram-luna-adapter.cjs'),
      cwd: path.join(ROOT, 'packages', 'kernel'),
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PATH: SYSTEM_PATH,
        NODE_OPTIONS: '--dns-result-order=ipv4first',
        LUNA_HOME: path.join(HOME, '.luna'),
        LUNA_KERNEL_DIR: path.join(ROOT, 'packages', 'kernel'),
        LUNA_DIR: path.join(ROOT, 'packages', 'kernel'),
        NEXO_DIR: path.join(ROOT, 'apps', 'dashboard'),
        DASHBOARD_API_URL: 'https://vps.nexo-digital.app:3501/api',
      },
      max_restarts: 50,
      min_uptime: '10s',
      restart_delay: 5000,
      kill_timeout: 8000,
      listen_timeout: 15000,
      vizion: false,
      exp_backoff_restart_delay: 100,
    },
  ],
};