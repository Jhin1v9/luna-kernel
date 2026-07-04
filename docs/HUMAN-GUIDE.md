# 🧑‍🚀 Guia Humano da Luna

Como ligar, usar e desligar a Luna sem precisar decorar comandos.

---

## O que é o quê

| Nome | O que faz | Onde acessar |
|---|---|---|
| **Luna Web** | Chat com a Luna (interface principal) | http://localhost:3458 |
| **Vite Dev** | Frontend em modo desenvolvedor | https://localhost:5173 |
| **Nexo Dashboard** | Dashboard legado da NEXO | http://localhost:3456 |
| **Telegram Bot** | Bot @lunanexobot | — |

---

## Como ligar

### Modo fácil (atalhos no terminal)

Abra um terminal e digite:

```bash
luna
```

Isso liga todos os serviços (Luna, Dashboard, Vite, Telegram, watchdog) e abre automaticamente:
- http://localhost:3458 (Luna Web)
- https://localhost:5173 (Vite Dev)

Se quiser ir direto para o dashboard legado:

```bash
dashboard
```

Isso liga tudo e abre http://localhost:3456.

> 💡 Você pode usar `luna` ou `dashboard` à vontade. Se os serviços já estiverem ligados, eles são reiniciados; se estiverem desligados, são ligados.

---

## Como desligar

```bash
pm2 stop all
```

Para desligar e remover da lista salva:

```bash
pm2 delete all
```

---

## Como ver se está tudo bem

```bash
pm2 status
```

Todos os processos devem estar `online`:

```
luna-server
nexo-dashboard
telegram-bot
luna-vite
luna-health-watchdog
```

---

## Como ver logs

```bash
# Todas as logs ao vivo
pm2 logs

# Só da Luna
pm2 logs luna-server

# Só do Dashboard
pm2 logs nexo-dashboard

# Últimas 50 linhas
pm2 logs luna-server --lines 50
```

---

## Como atualizar depois de um `git pull`

```bash
cd /home/jhin/.luna-kernel/.worktrees/monorepo-migration
corepack pnpm install
corepack pnpm build
pm2 restart all
pm2 save
```

Ou use o endpoint interno (se estiver logado na Luna Web):

```bash
curl -X POST http://localhost:3458/api/system/update \
  -H "Authorization: Bearer SEU_TOKEN"
```

---

## Comandos úteis

```bash
# Reiniciar só a Luna
pm2 restart luna-server

# Reiniciar só o dashboard
pm2 restart nexo-dashboard

# Ver uso de CPU/memória
pm2 monit

# Salvar lista atual para ligar automaticamente no boot
pm2 save
pm2 startup   # seguir as instruções que aparecerem
```

---

## Problemas comuns

### "Porta 3458 já em uso"

Algum processo antigo ainda está rodando. Mate:

```bash
kill -9 $(lsof -ti:3458)
pm2 restart luna-server
```

### "MODULE_NOT_FOUND" ou erro de nativo (sharp)

```bash
cd /home/jhin/.luna-kernel/.worktrees/monorepo-migration
corepack pnpm install
corepack pnpm rebuild sharp
pm2 restart all
```

### Luna não conecta no Kimi

Verifique se o Chrome isolado está aberto e logado:

```bash
# Chrome do Luna roda em segundo plano; veja as abas em:
http://localhost:9222/json
```

Se aparecer tela de login no Kimi, faça login manualmente na aba do Luna.

---

## Estrutura rápida

```
/home/jhin/.luna-kernel/.worktrees/monorepo-migration/
├── apps/dashboard/        # backend do dashboard + luna-server.js
├── packages/kernel/       # cérebro da Luna + bridge Kimi
├── packages/kernel/luna-web/  # interface web
├── pm2-ecosystem.config.js    # configuração dos processos
└── README.md
```

---

## Atalhos criados

| Comando | O que faz |
|---|---|
| `luna` | Liga tudo e abre Luna Web + Vite |
| `dashboard` | Liga tudo e abre Nexo Dashboard |

Os scripts estão em `~/.local/bin/`. Se algum dia der "comando não encontrado", verifique se `~/.local/bin` está no `PATH`:

```bash
echo $PATH
```
