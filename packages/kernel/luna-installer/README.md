# 🌙 Luna Installer — Setup & Sync Scripts

Pasta com todos os scripts necessários para instalar e manter atualizado o ecossistema Luna (Kernel + Dashboard + Telegram Bot) em qualquer máquina.

## 📁 Arquivos

| Arquivo | Descrição |
|---------|-----------|
| `install.sh` | **Instalador unificado com wizard interativo.** Clona repos, instala deps, configura `.env`, builda frontend, sobe PM2 e instala cron. |
| `sync.sh` | **Script de auto-sync.** Roda via cron a cada 5 minutos. Faz `git pull`, rebuilda frontend e reinicia PM2 quando há mudanças. |
| `pm2-ecosystem.template.js` | **Template do PM2.** Define `luna-server`, `nexo-dashboard` e `telegram-bot`. O `install.sh` gera o `.js` final a partir deste template. |
| `SYNC_GUIDE.md` | **Guia completo** de instalação, sincronização entre PCs e troubleshooting. |

## 🚀 Instalação rápida

> ⚠️ O repo `luna-kernel` é **privado**. Clone com suas credenciais GitHub primeiro.

```bash
# 1. Clone o repo (SSH ou HTTPS com token)
git clone https://github.com/Jhin1v9/luna-kernel.git ~/.luna-kernel

# 2. Execute o instalador
bash ~/.luna-kernel/luna-installer/install.sh
```

O wizard vai perguntar:
- 🔑 Token do bot Telegram
- 🌐 Caminho do Chrome
- 🐛 Modo debug (true/false)
- ⏱️ Timeout Kimi

Depois faz tudo sozinho: instala Node deps, builda, sobe PM2 e configura cron.

## 🔄 Sincronização automática

Após a instalação, o cron roda `sync.sh` a cada 5 minutos:

```bash
# Sync manual (quando quiser forçar)
~/luna-sync.sh

# Ver log
tail -f /tmp/luna-sync.log
```

## 🖥️ Comandos úteis

```bash
pm2 list
pm2 logs telegram-bot --lines 50
pm2 logs luna-server --lines 50
pm2 logs nexo-dashboard --lines 50
```

## 📱 Telegram

- Bot: `@lunanexobot`
- Comandos: `/kimi on`, `/kimi off`, `/status`
- Default: respostas desligadas. Use `/kimi on` para ativar.
