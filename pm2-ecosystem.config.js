module.exports = {
  apps: [
    {
      name: 'luna-server',
      script: './backend/luna-server.js',
      cwd: '/home/jhin/NEXO_DASHBOARD_PRO',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'nexo-dashboard',
      script: './backend/server.js',
      cwd: '/home/jhin/NEXO_DASHBOARD_PRO',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'telegram-bot',
      script: './agents/telegram-luna-adapter.cjs',
      cwd: '/home/jhin/NEXO_DASHBOARD_PRO',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
