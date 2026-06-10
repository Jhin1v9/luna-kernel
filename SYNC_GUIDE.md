# 🔄 Sincronização Automática entre PCs (Jhin, Pai, Nonoke)

## Visão Geral

```
┌─────────────┐     push      ┌─────────────┐     pull      ┌─────────────┐
│   PC JHIN   │ ────────────> │   GITHUB    │ <──────────── │  PC PAI     │
│   (master)  │               │  (central)  │               │ (auto-pull) │
└─────────────┘               └─────────────┘               └─────────────┘
                                    ^
                                    │ pull
                              ┌─────────────┐
                              │  PC NONOKE  │
                              │ (auto-pull) │
                              └─────────────┘
```

## Como funciona

1. **Jhin (você)** faz commit + push normalmente para GitHub
2. **Pai e Nonoke** rodam um script (`luna-sync.sh`) a cada 5 minutos via cron
3. O script detecta se há nova versão no GitHub, faz `git pull`, rebuilda o frontend e reinicia o serviço
4. Logs rotacionados automaticamente para evitar falsos positivos de erros antigos

---

## 🚀 Instalação em uma máquina nova (Pai / Nonoke / Jhin)

O repositório `luna-kernel` é **privado**. Por isso, o instalador precisa ser
executado localmente após clonar com suas credenciais do GitHub (SSH ou token).

**Recomendado:**

```bash
# 1. Clone o luna-kernel usando sua credencial GitHub
git clone https://github.com/Jhin1v9/luna-kernel.git ~/.luna-kernel
# ou, se usar SSH: git clone git@github.com:Jhin1v9/luna-kernel.git ~/.luna-kernel

# 2. Execute o instalador unificado localmente
bash ~/.luna-kernel/install/lunawebdownload
```

O instalador faz tudo automaticamente:

1. ✅ Verifica pré-requisitos (`git`, `node >= 18`, `npm`, `pm2`)
2. ✅ Clona (ou atualiza) os dois repositórios:
   - `~/.luna-kernel` (Luna Kernel + frontend)
   - `~/NEXO_DASHBOARD_PRO` (Dashboard + backend + Telegram adapter)
3. ✅ Roda wizard interativo para configurar:
   - `TELEGRAM_BOT_TOKEN`
   - `LUNA_CHROME_PATH`
   - `LUNA_DEBUG`
   - `KIMI_TIMEOUT`, `KIMI_MAX_PAGES`
   - `INTERNAL_API_TOKEN` (gerado automaticamente)
4. ✅ Instala todas as dependências Node
5. ✅ Builda o `luna-web`
6. ✅ Cria/links `.env` nos locais corretos
7. ✅ Configura PM2 com `pm2-ecosystem.config.js`
8. ✅ Instala cron de auto-sync a cada 5 minutos
9. ✅ Rotaciona logs antigos do PM2

Depois da instalação, o bot já está pronto para uso. Envie `/kimi on` no Telegram e converse.

---

## ✅ Passo a passo manual (se preferir não usar o instalador)

### 1. Clone os repos

```bash
git clone https://github.com/Jhin1v9/luna-kernel.git ~/.luna-kernel
git clone https://github.com/Jhin1v9/NexoDashboard.git ~/NEXO_DASHBOARD_PRO
```

### 2. Configure o `.env`

O arquivo fonte da verdade é:

```
~/.luna-kernel/.env
```

Exemplo mínimo:

```bash
TELEGRAM_BOT_TOKEN=seu_token_aqui
LUNA_CHROME_PATH=/usr/bin/google-chrome
LUNA_DEBUG=false
KIMI_TIMEOUT=99999
KIMI_MAX_PAGES=7
KIMI_PERSISTENT_MODE=true
INTERNAL_API_TOKEN=<jwt_gerado>
```

Crie links simbólicos para o dashboard também enxergar:

```bash
ln -sf ~/.luna-kernel/.env ~/NEXO_DASHBOARD_PRO/.env
ln -sf ~/.luna-kernel/.env ~/NEXO_DASHBOARD_PRO/backend/.env
```

### 3. Instale dependências e build

```bash
cd ~/.luna-kernel && npm install
cd luna-web && npm install && npm run build

cd ~/NEXO_DASHBOARD_PRO && npm install
cd backend && npm install
cd ../frontend && npm install --legacy-peer-deps && npm run build
rm -rf ../backend/public && cp -r dist ../backend/public
```

### 4. Inicie com PM2

```bash
pm2 start ~/.luna-kernel/pm2-ecosystem.config.js
pm2 save
```

### 5. Configure o cron

```bash
cp ~/.luna-kernel/luna-sync.sh ~/luna-sync.sh
chmod +x ~/luna-sync.sh
crontab -e
```

Adicione:

```cron
*/5 * * * * /home/<usuario>/luna-sync.sh >> /tmp/luna-sync.log 2>&1
```

---

## 🧰 Comandos úteis

```bash
# Logs
pm2 logs telegram-bot --lines 50
pm2 logs luna-server --lines 50
pm2 logs nexo-dashboard --lines 50
tail -f /tmp/luna-sync.log

# Status
pm2 list
pm2 monit

# Sync manual
~/luna-sync.sh

# Commit e push (Jhin)
cd ~/.luna-kernel && git add -A && git commit -m "feat: ..." && git push origin main
cd ~/NEXO_DASHBOARD_PRO && git add -A && git commit -m "feat: ..." && git push origin main

# Verificar último commit no GitHub
curl -s https://api.github.com/repos/Jhin1v9/luna-kernel/commits/main | jq -r '.sha'
curl -s https://api.github.com/repos/Jhin1v9/NexoDashboard/commits/main | jq -r '.sha'
```

---

## 🔧 Solução de problemas

### "git pull falhou — merge conflicts"

```bash
cd ~/.luna-kernel
git stash
git pull origin main
git stash pop
```

**Regra de ouro:** Só o Jhin deve fazer push. Pai e Nonoke são pull-only.

### "409 Conflict" no Telegram

Isso significa que mais de uma instância do bot está fazendo polling. O instalador garante que só o PM2 `telegram-bot` tenha polling ativo. Se acontecer:

```bash
pm2 delete telegram-bot
pm2 start ~/.luna-kernel/pm2-ecosystem.config.js
```

E remova processos orfaos:

```bash
ps aux | grep telegram-luna-adapter
kill <pid>
```

### "Luna offline" no Telegram

Verifique se o `luna-server` está rodando:

```bash
pm2 logs luna-server --lines 30
curl http://localhost:3458/api/health
```

---

## 🎯 Opções avançadas

### Webhook em vez de cron
Para redes com IP público, configure um webhook no GitHub.

### Atualização instantânea via SSH
```bash
ssh pai@ip "~/luna-sync.sh"
ssh nonoke@ip "~/luna-sync.sh"
```
