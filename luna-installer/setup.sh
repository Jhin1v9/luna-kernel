#!/bin/bash
# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Luna Setup — Entrypoint principal                                        ║
# ║  Verifica pré-requisitos e delega para install.sh                         ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

set -euo pipefail

B=$(tput bold 2>/dev/null || true)
R=$(tput setaf 1 2>/dev/null || true)
G=$(tput setaf 2 2>/dev/null || true)
Y=$(tput setaf 3 2>/dev/null || true)
N=$(tput sgr0 2>/dev/null || true)

die() { echo "${R}${B}[ERR]${N} $*" >&2; exit 1; }
ok()  { echo "${G}${B}[OK]${N}  $*"; }
info(){ echo "${Y}${B}[INFO]${N} $*"; }

echo ""
echo "${B}🌙  LUNA WEB + DASHBOARD + TELEGRAM  —  Setup${N}"
echo ""

# Verifica pré-requisitos
info "Verificando pré-requisitos..."

for cmd in git node npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    die "Comando obrigatório não encontrado: $cmd. Instale antes de continuar."
  fi
done

NODE_VER=$(node --version | sed 's/v//;s/\..*//')
if [ "$NODE_VER" -lt 18 ]; then
  die "Node.js >= 18 é obrigatório. Versão encontrada: $(node --version)"
fi

if ! command -v pm2 >/dev/null 2>&1; then
  info "PM2 não encontrado. Instalando globalmente..."
  npm install -g pm2 || die "Falha ao instalar PM2"
fi

ok "Pré-requisitos OK (Node $(node --version), npm $(npm --version))"

# Verifica se os repos já estão clonados
KERNEL_DIR="${HOME}/.luna-kernel"
DASH_DIR="${HOME}/NEXO_DASHBOARD_PRO"

if [ ! -d "$KERNEL_DIR/.git" ]; then
  die "Repo luna-kernel não encontrado em $KERNEL_DIR\nClone primeiro: git clone https://github.com/Jhin1v9/luna-kernel.git ~/.luna-kernel"
fi

if [ ! -d "$DASH_DIR/.git" ]; then
  die "Repo NexoDashboard não encontrado em $DASH_DIR\nClone primeiro: git clone https://github.com/Jhin1v9/NexoDashboard.git ~/NEXO_DASHBOARD_PRO"
fi

ok "Repos encontrados"

# Delega para o instalador principal
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
info "Iniciando instalador..."
bash "$SCRIPT_DIR/install.sh"
