#!/bin/bash
# ============================================================
# Luna Kernel v4.0 — Installer
# NEXO DIGITAL S.L. — Private Use Only
# ============================================================

set -e

REPO_URL="https://github.com/Jhin1v9/luna-kernel"
INSTALL_DIR="${HOME}/.luna-kernel"
NODE_MIN_VERSION=20

echo "🌙 Luna Kernel v4.0 Installer"
echo "=============================="

# Check Node.js version
echo ""
echo "📦 Checking Node.js..."
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js v${NODE_MIN_VERSION}+ first."
    echo "   Visit: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//;s/\..*//')
if [ "$NODE_VERSION" -lt "$NODE_MIN_VERSION" ]; then
    echo "❌ Node.js v${NODE_VERSION} found, but v${NODE_MIN_VERSION}+ is required."
    exit 1
fi
echo "✅ Node.js $(node -v)"

# Check git
echo ""
echo "📦 Checking Git..."
if ! command -v git &> /dev/null; then
    echo "❌ Git not found. Please install Git first."
    exit 1
fi
echo "✅ Git $(git --version | awk '{print $3}')"

# Clone or update
echo ""
echo "📥 Installing Luna Kernel to ${INSTALL_DIR}..."
if [ -d "$INSTALL_DIR" ]; then
    echo "   Directory exists. Updating..."
    cd "$INSTALL_DIR"
    git pull origin main
else
    echo "   Cloning repository..."
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install 2>&1 | tail -5

# Check Chrome/Playwright
echo ""
echo "🔍 Checking Chrome..."
if command -v google-chrome &> /dev/null; then
    echo "✅ Chrome found"
elif command -v chromium-browser &> /dev/null; then
    echo "✅ Chromium found"
elif command -v chromium &> /dev/null; then
    echo "✅ Chromium found"
else
    echo "⚠️  Chrome/Chromium not found. You'll need it for Kimi Web bridge."
    echo "   Install: sudo apt-get install google-chrome-stable"
fi

# Create env template
echo ""
echo "📝 Creating environment template..."
if [ ! -f ".env" ]; then
    cat > .env << 'ENVEOF'
# Luna Kernel Environment
# Fill in your tokens and run: source .env

# Telegram Bot Token (get from @BotFather)
TELEGRAM_BOT_TOKEN=your_token_here

# Kimi Web credentials (if using browser auth)
# KIMI_USERNAME=
# KIMI_PASSWORD=

# Internal API token for dashboard
INTERNAL_API_TOKEN=your_api_token_here
ENVOF
    echo "✅ .env template created. Please edit it with your tokens."
else
    echo "✅ .env already exists."
fi

echo ""
echo "=============================="
echo "🌙 Luna Kernel v4.0 installed!"
echo "=============================="
echo ""
echo "Next steps:"
echo "  1. cd ${INSTALL_DIR}"
echo "  2. nano .env  # Add your tokens"
echo "  3. node telegram-luna-adapter.cjs  # Start the bot"
echo ""
echo "Or use PM2:"
echo "  pm2 start telegram-luna-adapter.cjs --name luna-kernel"
echo ""
