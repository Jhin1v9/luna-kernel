#!/bin/bash
# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  🌐 Luna Proxy Setup — Acesso externo ao Dashboard/Luna Web               ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

set -euo pipefail

B=$(tput bold 2>/dev/null || true)
R=$(tput setaf 1 2>/dev/null || true)
G=$(tput setaf 2 2>/dev/null || true)
Y=$(tput setaf 3 2>/dev/null || true)
C=$(tput setaf 6 2>/dev/null || true)
N=$(tput sgr0 2>/dev/null || true)

info()  { echo "${C}${B}[PROXY]${N} $*"; }
ok()    { echo "${G}${B}[OK]${N}   $*"; }
warn()  { echo "${Y}${B}[WARN]${N}  $*"; }
err()   { echo "${R}${B}[ERR]${N}   $*" >&2; }
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

cat <<'BANNER'

    🌐  LUNA PROXY SETUP
    ━━━━━━━━━━━━━━━━━━━━
    Configure acesso externo à Luna

BANNER

LOCAL_IP=$(hostname -I | awk '{print $1}')
PUBLIC_IP=$(curl -s ipinfo.io/ip 2>/dev/null || curl -s ifconfig.me 2>/dev/null || echo "desconhecido")
DUCKDNS="luna-app.duckdns.org"

echo "  IP local:    ${B}${LOCAL_IP}${N}"
echo "  IP público:  ${B}${PUBLIC_IP}${N}"
echo "  DuckDNS:     ${B}${DUCKDNS}${N}"
echo "  Luna server: ${B}http://localhost:3458${N}"
echo ""

echo "${B}── Opções de acesso externo ──${N}"
echo ""
echo "  ${B}1)${N} Port Forwarding no roteador (mais simples)"
echo "     → Redireciona porta 3458 externa → ${LOCAL_IP}:3458"
echo "     → Acesse: https://${DUCKDNS}:3458"
echo ""
echo "  ${B}2)${N} Cloudflare Tunnel (recomendado — SSL automático)"
echo "     → Túnel seguro, sem abrir portas no roteador"
echo "     → Acesse: https://seu-dominio.com"
echo "     → Requer conta Cloudflare (gratuita)"
echo ""
echo "  ${B}3)${N} ngrok (testes rápidos)"
echo "     → Túnel temporário, bom para testar"
echo "     → Acesse: URL aleatória do ngrok"
echo ""

CHOICE=$(ask "Escolha (1, 2 ou 3)" "1")

case "$CHOICE" in
  1)
    echo ""
    echo "${B}── Port Forwarding ──${N}"
    echo ""
    echo "Você precisa acessar o painel do seu roteador e criar uma regra:"
    echo ""
    echo "  ${B}Tipo:${N}     Port Forwarding / Virtual Servers / NAT"
    echo "  ${B}Porta ext:${N} 3458 (TCP)"
    echo "  ${B}IP interno:${N} ${LOCAL_IP}"
    echo "  ${B}Porta int:${N} 3458 (TCP)"
    echo ""
    echo "Passos comuns:"
    echo "  1. Abra o navegador em http://192.168.1.1 ou http://192.168.0.1"
    echo "  2. Login com usuário/senha do roteador (geralmente atrás do aparelho)"
    echo "  3. Procure por 'Port Forwarding', 'NAT', 'Virtual Server'"
    echo "  4. Adicione a regra acima"
    echo "  5. Salve e reinicie o roteador se necessário"
    echo ""
    echo "Depois de configurar, teste:"
    echo "  ${B}https://${DUCKDNS}:3458${N}"
    echo ""
    echo "${Y}⚠️  Aviso:${N} Isso expõe a Luna diretamente à internet."
    echo "   Para maior segurança, use a Opção 2 (Cloudflare Tunnel)."
    echo ""
    ;;

  2)
    echo ""
    echo "${B}── Cloudflare Tunnel ──${N}"
    echo ""
    
    if ! command -v cloudflared >/dev/null 2>&1; then
      warn "cloudflared não encontrado. Instalando..."
      curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared 2>/dev/null && chmod +x ~/.local/bin/cloudflared || die "Falha ao baixar cloudflared"
    fi
    ok "cloudflared $(cloudflared version 2>/dev/null | head -1)"

    # Verifica se já está autenticado
    if ! cloudflared tunnel list >/dev/null 2>&1; then
      echo ""
      warn "Você precisa fazer login na conta Cloudflare."
      echo ""
      echo "${B}Passos:${N}"
      echo "  1. Rode: ${B}cloudflared login${N}"
      echo "  2. Um link será exibido — abra no navegador e autorize"
      echo "  3. Depois, execute este script novamente"
      echo ""
      exit 0
    fi

    ok "Autenticado no Cloudflare"
    
    TUNNEL_NAME=$(ask "Nome do tunnel" "luna-dashboard")
    
    echo ""
    info "Criando tunnel '${TUNNEL_NAME}'..."
    TUNNEL_OUTPUT=$(cloudflared tunnel create "$TUNNEL_NAME" 2>&1) || die "Falha ao criar tunnel: $TUNNEL_OUTPUT"
    TUNNEL_ID=$(echo "$TUNNEL_OUTPUT" | grep -oP 'id [a-f0-9-]+' | awk '{print $2}' || echo "")
    
    if [ -z "$TUNNEL_ID" ]; then
      die "Não foi possível obter o ID do tunnel"
    fi
    ok "Tunnel criado: ${TUNNEL_ID}"

    # Cria config.yml
    CONFIG_DIR="${HOME}/.cloudflared"
    mkdir -p "$CONFIG_DIR"
    
    cat > "${CONFIG_DIR}/config-luna.yml" <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CONFIG_DIR}/${TUNNEL_ID}.json

ingress:
  - hostname: ${DUCKDNS}
    service: http://localhost:3458
    originRequest:
      noTLSVerify: true
  - service: http_status:404
EOF

    info "Configuração salva em ${CONFIG_DIR}/config-luna.yml"
    
    # Rota o DNS
    echo ""
    info "Configurando DNS..."
    cloudflared tunnel route dns "$TUNNEL_NAME" "$DUCKDNS" 2>/dev/null || warn "Falha ao configurar DNS. Faça manualmente no painel Cloudflare."
    
    # Inicia o tunnel
    echo ""
    info "Iniciando tunnel..."
    echo ""
    echo "${G}${B}✅ Tunnel pronto!${N}"
    echo ""
    echo "  Acesse: ${B}https://${DUCKDNS}${N}"
    echo ""
    echo "Para manter o tunnel rodando permanentemente, execute:"
    echo "  ${B}cloudflared tunnel run ${TUNNEL_NAME}${N}"
    echo ""
    echo "Ou adicione ao PM2:"
    echo "  ${B}pm2 start 'cloudflared tunnel run ${TUNNEL_NAME}' --name cloudflare-tunnel${N}"
    echo ""
    ;;

  3)
    echo ""
    echo "${B}── ngrok ──${N}"
    echo ""
    
    if ! command -v ngrok >/dev/null 2>&1; then
      warn "ngrok não encontrado. Instalando..."
      curl -fsSL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz -o /tmp/ngrok.tgz 2>/dev/null && \
        tar -xzf /tmp/ngrok.tgz -C ~/.local/bin/ 2>/dev/null || die "Falha ao instalar ngrok"
    fi
    ok "ngrok instalado"
    
    echo ""
    echo "Iniciando túnel para localhost:3458..."
    echo "${Y}(Ctrl+C para parar)${N}"
    echo ""
    ngrok http 3458
    ;;

  *)
    die "Opção inválida: $CHOICE"
    ;;
esac
