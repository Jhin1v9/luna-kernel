#!/bin/bash
# Luna Auto-Sync Script
# Roda em cada máquina (pai, nonoke) para manter atualizado com GitHub
# Recomendado: cron a cada 5 minutos: */5 * * * * /home/<user>/.luna-kernel/luna-sync.sh

set -e

LOG_FILE="/tmp/luna-sync.log"
LUNA_KERNEL_DIR="${HOME}/.luna-kernel"
NEXO_DASHBOARD_DIR="${HOME}/NEXO_DASHBOARD_PRO"
DATE=$(date '+%Y-%m-%d %H:%M:%S')

echo "[$DATE] Luna sync started" >> "$LOG_FILE"

# Função para fazer pull e reiniciar se necessário
sync_repo() {
  local repo_dir="$1"
  local repo_name="$2"
  local has_changes=0

  if [ ! -d "$repo_dir/.git" ]; then
    echo "[$DATE] SKIP: $repo_name não é um repo git em $repo_dir" >> "$LOG_FILE"
    return
  fi

  cd "$repo_dir"

  # Fetch silencioso
  if ! git fetch origin main --quiet 2>/dev/null; then
    echo "[$DATE] ERRO: falha no fetch de $repo_name" >> "$LOG_FILE"
    return
  fi

  # Verificar se há mudanças
  local local_hash=$(git rev-parse HEAD)
  local remote_hash=$(git rev-parse origin/main)

  if [ "$local_hash" != "$remote_hash" ]; then
    echo "[$DATE] UPDATE: $repo_name tem mudanças ($local_hash -> $remote_hash)" >> "$LOG_FILE"
    git pull origin main --quiet
    has_changes=1
  else
    echo "[$DATE] OK: $repo_name está atualizado" >> "$LOG_FILE"
  fi

  # Se for luna-kernel e houver mudanças no frontend, rebuild
  if [ "$has_changes" -eq 1 ] && [ "$repo_name" == "luna-kernel" ]; then
    if [ -d "$repo_dir/luna-web" ]; then
      echo "[$DATE] BUILD: Rebuildando frontend..." >> "$LOG_FILE"
      cd "$repo_dir/luna-web"
      npm run build >> "$LOG_FILE" 2>&1 || echo "[$DATE] WARN: build falhou, tentando continuar" >> "$LOG_FILE"
    fi
  fi

  # Se houver mudanças, reiniciar o luna-server
  if [ "$has_changes" -eq 1 ]; then
    if command -v pm2 &> /dev/null; then
      echo "[$DATE] RESTART: Reiniciando luna-server via PM2..." >> "$LOG_FILE"
      pm2 restart luna-server >> "$LOG_FILE" 2>&1 || echo "[$DATE] WARN: pm2 restart falhou" >> "$LOG_FILE"
    else
      echo "[$DATE] WARN: PM2 não encontrado, reinicie manualmente" >> "$LOG_FILE"
    fi
  fi
}

# Sincronizar ambos os repos
sync_repo "$LUNA_KERNEL_DIR" "luna-kernel"
sync_repo "$NEXO_DASHBOARD_DIR" "nexo-dashboard"

echo "[$DATE] Luna sync finished" >> "$LOG_FILE"
echo "---" >> "$LOG_FILE"
