#!/bin/bash
# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Luna Installer Deploy — Gera pacote zip para envio                       ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KERNEL_DIR="$(dirname "$SCRIPT_DIR")"
VERSION=$(date '+%Y%m%d-%H%M%S')
OUTPUT="/tmp/luna-installer-${VERSION}.zip"

echo "🌙  Empacotando Luna Installer..."
cd "$KERNEL_DIR"

# Gera zip excluindo arquivos desnecessários
zip -r "$OUTPUT" luna-installer \
  -x "*/.git/*" \
  -x "*/node_modules/*" \
  -x "*/.env" \
  -x "*/.env.*" \
  -x "*.log" \
  -x "*.old.*" \
  -x "*/backup*" \
  -x "*/data/*" \
  -x "*/sessions/*"

echo ""
echo "✅ Pacote gerado: $OUTPUT"
echo ""
echo "📦 Conteúdo do pacote:"
unzip -l "$OUTPUT" | tail -n +4 | head -n -2
echo ""
echo "💡 Para enviar pelo WhatsApp/Telegram, anexe este arquivo."
echo "💡 Para subir no GitHub, faça commit da pasta luna-installer."
