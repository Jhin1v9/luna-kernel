#!/bin/bash
# ============================================================
# Luna Kernel v5.0 — Installer
# NEXO DIGITAL S.L. — Private Use Only
# ============================================================

set -e

REPO_URL="https://github.com/Jhin1v9/luna-kernel"
INSTALL_DIR="${HOME}/.luna-kernel"
NODE_MIN_VERSION=20

echo ""
echo "🌙 ╔══════════════════════════════════════════════════╗"
echo "🌙 ║   Luna Kernel v5.0 Installer                    ║"
echo "🌙 ║   NEXO DIGITAL S.L. — Private Use Only         ║"
echo "🌙 ╚══════════════════════════════════════════════════╝"
echo ""

# Check Node.js version
echo "📦 Verificando Node.js..."
if ! command -v node &> /dev/null; then
    echo "❌ Node.js não encontrado. Instale o Node.js v${NODE_MIN_VERSION}+ primeiro."
    echo "   👉 https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//;s/\..*//')
if [ "$NODE_VERSION" -lt "$NODE_MIN_VERSION" ]; then
    echo "❌ Node.js v${NODE_VERSION} encontrado, mas v${NODE_MIN_VERSION}+ é obrigatório."
    exit 1
fi
echo "✅ Node.js $(node -v)"

# Check git
echo ""
echo "📦 Verificando Git..."
if ! command -v git &> /dev/null; then
    echo "❌ Git não encontrado. Instale o Git primeiro:"
    echo "   sudo apt-get install git"
    exit 1
fi
echo "✅ Git $(git --version | awk '{print $3}')"

# Clone or update
echo ""
echo "📥 Instalando Luna Kernel em ${INSTALL_DIR}..."
if [ -d "$INSTALL_DIR" ]; then
    echo "   Diretório existe. Atualizando..."
    cd "$INSTALL_DIR"
    git pull origin main
else
    echo "   Clonando repositório..."
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# Install dependencies
echo ""
echo "📦 Instalando dependências..."
npm install 2>&1 | tail -5

# Check Chrome/Playwright
echo ""
echo "🔍 Verificando Chrome/Chromium..."
CHROME_FOUND=false
if command -v google-chrome &> /dev/null; then
    echo "✅ Google Chrome encontrado"
    CHROME_FOUND=true
elif command -v chromium-browser &> /dev/null; then
    echo "✅ Chromium Browser encontrado"
    CHROME_FOUND=true
elif command -v chromium &> /dev/null; then
    echo "✅ Chromium encontrado"
    CHROME_FOUND=true
fi

if [ "$CHROME_FOUND" = false ]; then
    echo "⚠️  Chrome/Chromium NÃO encontrado."
    echo "   A Luna precisa do Chrome para o Kimi Web Bridge."
    echo "   Instale: sudo apt-get install google-chrome-stable"
fi

# Create env template
echo ""
echo "📝 Criando template de ambiente..."
if [ ! -f ".env" ]; then
    cat > .env << 'ENVEOF'
# ============================================================
# Luna Kernel v5.0 — Environment Configuration
# NEXO DIGITAL S.L.
# ============================================================

# ── REQUIRED ──

# Telegram Bot Token (get from @BotFather: https://t.me/BotFather)
# Create a bot, copy the token, paste here
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here

# Internal API Token for NEXO Dashboard
# Used for dashboardCreateTask, dashboardListTasks, etc.
INTERNAL_API_TOKEN=your_dashboard_api_token_here

# JWT Secret for web sessions
JWT_SECRET=your_jwt_secret_here_min_32_chars

# ── OPTIONAL (have defaults) ──

# Kimi Bridge Settings
KIMI_TIMEOUT=120000
KIMI_MAX_PAGES=5
KIMI_IDLE_TIMEOUT=600000
KIMI_COOLDOWN_MS=5000
KIMI_MAX_TYPE_LENGTH=500
KIMI_LOG_MAX_MB=10

# Context Auto-Compaction
LUNA_COMPACT_THRESHOLD=24
LUNA_COMPACT_TOKEN_THRESHOLD=120000

# Chrome Path (auto-detected if not set)
# LUNA_CHROME_PATH=/usr/bin/google-chrome

# Debug Mode
# LUNA_DEBUG=true

# Web Server Port
LUNA_CONFIG_PORT=3458
ENVEOF
    echo "✅ .env template criado. Preencha com seus tokens!"
else
    echo "✅ .env já existe. Mantido o atual."
fi

# Done
echo ""
echo "🌙 ╔══════════════════════════════════════════════════╗"
echo "🌙 ║   Luna Kernel v5.0 instalada!                  ║"
echo "🌙 ╚══════════════════════════════════════════════════╝"
echo ""
echo "📋 Próximos passos:"
echo ""
echo "   1️⃣  cd ${INSTALL_DIR}"
echo ""
echo "   2️⃣  Configure o .env:"
echo "       nano .env"
echo ""
echo "   3️⃣  Inicie a Luna (escolha um canal):"
echo ""
echo "       🌐 WEB INTERFACE (recomendado):"
echo "       node config-server.cjs"
echo "       → Abra: http://localhost:3458"
echo ""
echo "       💬 TELEGRAM BOT:"
echo "       node telegram-luna-adapter.cjs"
echo ""
echo "       💻 CLI (terminal):"
echo "       node luna-cli.cjs"
echo ""
echo "   💡  Ou use PM2 (background):"
echo "       pm2 start config-server.cjs --name luna-web"
echo "       pm2 start telegram-luna-adapter.cjs --name luna-telegram"
echo "       pm2 save"
echo ""
echo "🤖 Bot do Telegram: @lunanexobot"
echo "   → Adicione ao seu grupo para começar"
echo ""
