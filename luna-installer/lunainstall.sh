#!/bin/bash
# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  🌙 LUNA INSTALLER — Wizard Completo (v1.0)                               ║
# ║  Um arquivo só. Baixa, instala e configura tudo automaticamente.          ║
# ║                                                                           ║
# ║  Como usar:                                                               ║
# ║    1. Salve este arquivo como "lunainstall.sh"                            ║
# ║    2. chmod +x lunainstall.sh && bash lunainstall.sh                      ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

set -euo pipefail

B=$(tput bold 2>/dev/null || true)
R=$(tput setaf 1 2>/dev/null || true)
G=$(tput setaf 2 2>/dev/null || true)
Y=$(tput setaf 3 2>/dev/null || true)
C=$(tput setaf 6 2>/dev/null || true)
N=$(tput sgr0 2>/dev/null || true)

info()  { echo "${C}${B}[LUNA]${N} $*"; }
ok()    { echo "${G}${B}[OK]${N}  $*"; }
warn()  { echo "${Y}${B}[WARN]${N} $*"; }
err()   { echo "${R}${B}[ERR]${N} $*" >&2; }
die()   { err "$*"; exit 1; }
ask() {
  local prompt="$1" default="${2:-}"
  local value
  if [ -n "$default" ]; then
    read -rp "${prompt} [${default}]: " value
    echo "${value:-$default}"
  else
    read -rp "${prompt}: " value
    echo "$value"
  fi
}
ask_secret() {
  local prompt="$1" value
  read -rsp "${prompt}: " value; echo ""
  echo "$value"
}

cat <<'BANNER'

    🌙  LUNA  WEB  +  DASHBOARD  +  TELEGRAM
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    Wizard de instalação completo

BANNER

# ── 1. PRÉ-REQUISITOS ──
info "Verificando pré-requisitos..."
for cmd in git node npm curl; do
  command -v "$cmd" >/dev/null 2>&1 || die "Falta: $cmd. Instale antes de continuar."
done
NODE_VER=$(node --version | sed 's/v//;s/\..*//')
[ "$NODE_VER" -ge 18 ] || die "Node.js >= 18 obrigatório. Versão: $(node --version)"
ok "Node $(node --version), npm $(npm --version)"

if ! command -v pm2 >/dev/null 2>&1; then
  warn "PM2 não encontrado. Instalando..."
  npm install -g pm2 || die "Falha ao instalar PM2"
fi
ok "PM2 OK"

# ── 2. CREDENCIAIS GITHUB ──
echo ""
echo "${B}── Acesso ao GitHub ──${N}"
echo "O repositório luna-kernel é privado. Informe como acessar:"
echo ""
echo "  1) Token de acesso pessoal (HTTPS)"
echo "  2) Chave SSH já configurada"
echo ""
GH_METHOD=$(ask "Método (1 ou 2)" "1")

if [ "$GH_METHOD" = "1" ]; then
  GH_USER=$(ask "Usuário GitHub" "Jhin1v9")
  GH_TOKEN=$(ask_secret "Token de acesso pessoal")
  [ -z "$GH_TOKEN" ] && die "Token é obrigatório"
  REPO_KERNEL="https://${GH_USER}:${GH_TOKEN}@github.com/Jhin1v9/luna-kernel.git"
  REPO_DASH="https://${GH_USER}:${GH_TOKEN}@github.com/Jhin1v9/NexoDashboard.git"
else
  REPO_KERNEL="git@github.com:Jhin1v9/luna-kernel.git"
  REPO_DASH="git@github.com:Jhin1v9/NexoDashboard.git"
fi

# ── 3. CLONE DOS REPOS ──
echo ""
info "Baixando repositórios..."
KERNEL_DIR="${HOME}/.luna-kernel"
DASH_DIR="${HOME}/NEXO_DASHBOARD_PRO"

if [ -d "$KERNEL_DIR/.git" ]; then
  info "Atualizando luna-kernel..."
  cd "$KERNEL_DIR" && git pull --quiet || warn "pull falhou, tentando continuar..."
else
  info "Clonando luna-kernel (pode demorar)..."
  git clone "$REPO_KERNEL" "$KERNEL_DIR" || die "Falha ao clonar luna-kernel"
fi

if [ -d "$DASH_DIR/.git" ]; then
  info "Atualizando NexoDashboard..."
  cd "$DASH_DIR" && git pull --quiet || warn "pull falhou, tentando continuar..."
else
  info "Clonando NexoDashboard..."
  git clone "$REPO_DASH" "$DASH_DIR" || die "Falha ao clonar NexoDashboard"
fi
ok "Repos prontos"

# ── 4. WIZARD DE CONFIGURAÇÃO ──
echo ""
echo "${B}── Configuração ──${N}"
echo "Preencha as informações abaixo:"
echo ""

TG_TOKEN=""
while [ -z "$TG_TOKEN" ]; do
  TG_TOKEN=$(ask_secret "🔑 Token do bot Telegram (@BotFather)")
  [ -z "$TG_TOKEN" ] && warn "Token obrigatório"
done

CHROME_PATH=$(ask "🌐 Caminho do Google Chrome" "/usr/bin/google-chrome")
LUNA_DEBUG=$(ask "🐛 Modo debug (true/false)" "false")
KIMI_TIMEOUT=$(ask "⏱️  Timeout Kimi (ms)" "99999")
KIMI_MAX_PAGES=$(ask "📄 Kimi max páginas" "7")

# Gera INTERNAL_API_TOKEN se não existir
API_TOKEN=""
if command -v node >/dev/null 2>&1; then
  API_TOKEN=$(node -e "
const jwt = require('jsonwebtoken');
const secret = require('crypto').randomBytes(32).toString('hex');
console.log(jwt.sign({ id: 'service', name: 'Service Bot', role: 'admin' }, secret, { expiresIn: '10y' }));
" 2>/dev/null || echo "")
fi

# ── 5. CRIA .ENV ──
ENV_FILE="${KERNEL_DIR}/.env"
mkdir -p "$(dirname "$ENV_FILE")"
[ -f "$ENV_FILE" ] && cp "$ENV_FILE" "${ENV_FILE}.backup.$(date +%s)"

cat > "$ENV_FILE" <<EOF
# Gerado pelo Luna Installer em $(date -Iseconds)
TELEGRAM_BOT_TOKEN=${TG_TOKEN}
LUNA_CHROME_PATH=${CHROME_PATH}
LUNA_DEBUG=${LUNA_DEBUG}
KIMI_TIMEOUT=${KIMI_TIMEOUT}
KIMI_MAX_PAGES=${KIMI_MAX_PAGES}
KIMI_PERSISTENT_MODE=true
EOF

[ -n "$API_TOKEN" ] && echo "INTERNAL_API_TOKEN=${API_TOKEN}" >> "$ENV_FILE"
chmod 600 "$ENV_FILE"
ok ".env criado em ${ENV_FILE}"

# Symlinks para dashboard
ln -sf "$ENV_FILE" "${DASH_DIR}/.env"
ln -sf "$ENV_FILE" "${DASH_DIR}/backend/.env"
ok "Links .env criados"

# ── 6. INSTALA DEPENDÊNCIAS ──
echo ""
info "Instalando dependências Node... (pode demorar vários minutos)"
LOG="/tmp/luna-install-deps.log"

cd "$KERNEL_DIR" && npm install >> "$LOG" 2>&1 || die "Falha em luna-kernel"
cd "$DASH_DIR" && npm install >> "$LOG" 2>&1 || die "Falha em dashboard raiz"
cd "$DASH_DIR/backend" && npm install >> "$LOG" 2>&1 || die "Falha em backend"
cd "$DASH_DIR/frontend" && npm install --legacy-peer-deps >> "$LOG" 2>&1 || die "Falha em frontend"
ok "Dependências instaladas"

# ── 7. BUILD ──
info "Buildando luna-web..."
cd "$KERNEL_DIR/luna-web"
npm install >> "$LOG" 2>&1 || true
npm run build >> "$LOG" 2>&1 || die "Falha ao buildar luna-web"
ok "luna-web buildado"

# ── 8. PM2 ──
echo ""
info "Configurando PM2..."

ECO_FILE="${KERNEL_DIR}/pm2-ecosystem.config.js"
ECO_TEMPLATE="${KERNEL_DIR}/luna-installer/pm2-ecosystem.template.js"

if [ ! -f "$ECO_TEMPLATE" ]; then
  # Fallback: usa o template que veio com este script
  warn "Template não encontrado no repo. Usando fallback..."
  cat > "$ECO_FILE" <<'ECOEOF'
module.exports = {
  apps: [
    {
      name: 'luna-server',
      script: './backend/luna-server.js',
      cwd: '{{HOME}}/NEXO_DASHBOARD_PRO',
      instances: 1, autorestart: true, watch: false, max_memory_restart: '1G',
      env: { NODE_ENV: 'production' },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
    {
      name: 'nexo-dashboard',
      script: './backend/server.js',
      cwd: '{{HOME}}/NEXO_DASHBOARD_PRO',
      instances: 1, autorestart: true, watch: false, max_memory_restart: '1G',
      env: { NODE_ENV: 'production' },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
    {
      name: 'telegram-bot',
      script: './agents/telegram-luna-adapter.cjs',
      cwd: '{{HOME}}/NEXO_DASHBOARD_PRO',
      instances: 1, autorestart: true, watch: false, max_memory_restart: '512M',
      env: { NODE_ENV: 'production' },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};
ECOEOF
  sed -i "s|{{HOME}}|${HOME}|g" "$ECO_FILE"
else
  sed -e "s|{{HOME}}|${HOME}|g" -e "s|{{NEXO_DASHBOARD_DIR}}|${DASH_DIR}|g" "$ECO_TEMPLATE" > "$ECO_FILE"
fi

# Rotaciona logs antigos
for app in luna-server nexo-dashboard telegram-bot; do
  for suf in out error; do
    f="${HOME}/.pm2/logs/${app}-${suf}.log"
    [ -f "$f" ] && mv "$f" "${f}.old.$(date +%s)" 2>/dev/null || true
  done
done

pm2 delete luna-server nexo-dashboard telegram-bot 2>/dev/null || true
pm2 start "$ECO_FILE"
pm2 save
ok "PM2 configurado"

# ── 9. CRON AUTO-SYNC ──
echo ""
info "Configurando auto-sync..."
SYNC_SRC="${KERNEL_DIR}/luna-installer/sync.sh"
SYNC_DST="${HOME}/luna-sync.sh"

if [ -f "$SYNC_SRC" ]; then
  cp "$SYNC_SRC" "$SYNC_DST"
  chmod +x "$SYNC_DST"
  sed -i "s|/home/[^/]*|${HOME}|g" "$SYNC_DST"
  CRON_LINE="*/5 * * * * ${SYNC_DST} >> /tmp/luna-sync.log 2>&1"
  if ! crontab -l 2>/dev/null | grep -qF "$SYNC_DST"; then
    (crontab -l 2>/dev/null || true; echo "$CRON_LINE") | crontab -
    ok "Cron configurado (a cada 5 min)"
  else
    ok "Cron já existente"
  fi
else
  warn "sync.sh não encontrado. Auto-sync não configurado."
fi

# ── 10. RESUMO ──
echo ""
echo "${G}${B}════════════════════════════════════════════════════════════════${N}"
echo "${G}${B}  🌙 Luna instalada e rodando!${N}"
echo "${G}${B}════════════════════════════════════════════════════════════════${N}"
echo ""
pm2 list | tail -n +4 | head -8 || true
echo ""
echo "  ${B}Próximos passos:${N}"
echo "    1. Envie /kimi on para @lunanexobot no Telegram"
echo "    2. Mande uma mensagem de teste"
echo ""
echo "  ${B}Comandos úteis:${N}"
echo "    pm2 logs telegram-bot --lines 50"
echo "    pm2 logs luna-server --lines 50"
echo "    ~/luna-sync.sh        # sync manual"
echo ""
echo "  ${B}Arquivos:${N}"
echo "    Env:  ${ENV_FILE}"
echo "    PM2:  ${ECO_FILE}"
echo "    Sync: ${SYNC_DST}"
echo ""
