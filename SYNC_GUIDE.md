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
4. Opcional: Jhin recebe notificação no Telegram quando o push é feito

---

## ✅ Passo a passo

### 1. No PC do Jhin (você) — já configurado ✅

Commits e pushes já funcionam. Os hooks `post-push` foram criados nos dois repos.

**Para ativar notificação no Telegram (opcional):**
```bash
export TELEGRAM_BOT_TOKEN="SEU_BOT_TOKEN"
export TELEGRAM_CHAT_ID="SEU_CHAT_ID"
```

Adicione no `~/.bashrc` ou `~/.zshrc` para persistir.

---

### 2. No PC do Pai e do Nonoke

#### 2.1 Clone os repos (se ainda não tiver)

```bash
# Luna Kernel
git clone https://github.com/Jhin1v9/luna-kernel.git ~/.luna-kernel

# NexoDashboard (se usar o dashboard)
git clone https://github.com/Jhin1v9/NexoDashboard.git ~/NEXO_DASHBOARD_PRO
```

> Se os repos forem privados, configure SSH keys ou use token de acesso pessoal.

#### 2.2 Instale o script de auto-sync

O arquivo `luna-sync.sh` já está versionado no `luna-kernel`. Basta criar o link ou copiar:

```bash
cp ~/.luna-kernel/luna-sync.sh ~/luna-sync.sh
chmod +x ~/luna-sync.sh
```

**Edite o script se os diretórios forem diferentes no PC do pai/nonoke:**
```bash
LUNA_KERNEL_DIR="${HOME}/.luna-kernel"
NEXO_DASHBOARD_DIR="${HOME}/NEXO_DASHBOARD_PRO"
```

#### 2.3 Configure o cron (auto-pull a cada 5 minutos)

```bash
crontab -e
```

Adicione esta linha:
```cron
*/5 * * * * /home/<usuario>/luna-sync.sh >> /tmp/luna-sync.log 2>&1
```

> Troque `<usuario>` pelo nome de usuário real (ex: `pai`, `nonoke`).

#### 2.4 Teste manualmente

```bash
~/luna-sync.sh
```

Verifique o log:
```bash
tail -20 /tmp/luna-sync.log
```

---

### 3. Primeira sincronização

Quando o Jhin fizer o próximo push:

1. Em até 5 minutos, o PC do pai e do nonoke detectarão a mudança
2. Farão `git pull` automaticamente
3. Rebuildarão o frontend (`npm run build` no `luna-web`)
4. Reiniciarão o `luna-server` via PM2

---

## 🔧 Solução de problemas

### "git pull falhou — merge conflicts"

Se alguém editar localmente e der push, pode haver conflito. O script NÃO resolve conflitos automaticamente (para segurança). Nesse caso:

```bash
cd ~/.luna-kernel
git stash        # guarda mudanças locais
git pull origin main
git stash pop    # recupera mudanças locais (se necessário)
```

**Regra de ouro:** Só o Jhin (você) deve fazer push. Pai e Nonoke devem ser apenas consumidores (pull only).

### "PM2 não encontrado"

Instale PM2 globalmente:
```bash
npm install -g pm2
```

### "Build do frontend falhou"

Verifique se as dependências estão instaladas:
```bash
cd ~/.luna-kernel/luna-web
npm install
npm run build
```

---

## 📋 Resumo dos comandos para Jhin (você)

```bash
# Commit e push (faça isso normalmente)
cd ~/.luna-kernel
git add -A && git commit -m "feat: ..." && git push origin main

cd ~/NEXO_DASHBOARD_PRO
git add -A && git commit -m "feat: ..." && git push origin main

# Verificar se os outros PCs estão atualizados
curl -s https://api.github.com/repos/Jhin1v9/luna-kernel/commits/main | jq -r '.sha'
curl -s https://api.github.com/repos/Jhin1v9/NexoDashboard/commits/main | jq -r '.sha'
```

---

## 🎯 Opções avançadas

### Webhook em vez de cron
Se os PCs tiverem IP público, é possível configurar um webhook no GitHub que dispara o pull instantaneamente. Mas para redes caseiras, o cron a cada 5 minutos é mais simples e seguro.

### Notificação por Discord
No lugar do Telegram, edite o `post-push` hook para usar Discord webhooks.

### Atualização instantânea via SSH
Se todos os PCs estiverem na mesma rede (ou com VPN), o Jhin pode fazer `ssh` para os outros PCs e rodar o sync manualmente:
```bash
ssh pai@ip "~/luna-sync.sh"
ssh nonoke@ip "~/luna-sync.sh"
```
