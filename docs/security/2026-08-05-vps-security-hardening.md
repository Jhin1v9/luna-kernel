# Mejoras de Seguridad VPS Nexo — implantadas 2026-08-05

> **Fecha:** 2026-08-05
> **Estado:** implantado y verificado
> **Continuación de:** `2026-07-31-vps-security-isolation-plan.md` (estado pendiente)
> **Resultado:** VPS **seguro y vigilado**, sin amenazas activas detectadas.
> **Objetivo:** cerrar las vulnerabilidades detectadas en la auditoría del 2026-07-31 (UFW, brute-force, SSH débil, fail2ban) y añadir monitoreo continuo (antivirus, alertas Telegram).

---

## 1. Resumen ejecutivo

| Área | Antes (2026-07-31) | Ahora (2026-08-05) |
|------|--------------------|---------------------|
| **UFW** | Inactivo, todas las portas expuestas | **Activo**: default deny incoming, allow outgoing |
| **Fail2ban** | Activo, 0 bans, config débil | Activo, **129 intentos registrados, 7 IPs baneadas** (1 activa ahora) |
| **SSH** | `PermitRootLogin yes`, `MaxAuthTries 6` | **Clave-only para root + MaxAuthTries 3** |
| **Brute force** | 5 IPs atacando | **Sin ataques activos**, fail2ban bloqueando en tiempo real |
| **Bot Telegram** | Sin allowlist | **Allowlist** (solo IDs autorizados) |
| **Antivirus** | No configurado | **clamav** + escaneo semanal automático |
| **Chrome/CDP (Luna)** | root, sin restricción | Aceptado como necesario (operación de Luna) |
| **Disco** | — | **~11 GB liberados** (imagen docker, apt cache, swap huérfano) |

---

## 2. Implantación por fase

### 2.1 FASE 1 — Perímetro (firewall + fail2ban) ✅

**UFW activado:**
```
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS
ufw allow 3469:3472 # Next.js apps
ufw allow 3500,3501,3510,3511,3520,3521,3530,3531 # apps Nexo
ufw allow 3600,3601 # dashboards
ufw allow 8443,8444,8445 # Caddy
ufw enable
```
- **Reglas DOCKER-USER** añadidas para bloquear servicios Docker de solo-local:
  - `11434` (ollama) y `3000/8080` (open-webui) → **no accesibles desde el exterior**
- **Verificado externamente:** `11434`, `3000`, `5901`, `5173`, `3456` → **bloqueados**; `22`, `443`, `3500`, `3511`, `3530` → **abiertos**.
- Backup: `/root/iptables-backup-before-firewall.txt`

**Fail2ban reforzado y operativo:**
- Jail `sshd` activo (backend systemd), acción `telegram-alert`.
- **129 intentos de login registrados, 7 IPs baneadas** (6 acumuladas + 1 activa `137.184.79.13`).
- Confirmado que banea atacantes **en tiempo real**.

### 2.2 FASE 2 — Hardening SSH ✅ (parcial seguro)

Creado `/etc/ssh/sshd_config.d/99-hardening.conf`:
```
PermitRootLogin prohibit-password   # solo acceso por clave para root
MaxAuthTries 3                       # limita intentos de password
```
- `PasswordAuthentication` se mantuvo `yes` por decisión del owner (evitar riesgo de quedar fuera).
- Sintaxis validada (`sshd -t`) y **conectividad confirmada** tras reiniciar `sshd` (sin bloqueo).
- `authorized_keys` de root: 3 claves legítimas (nexus-deploy, nexus-rh-deploy, noke).

### 2.3 FASE 3 — Bot Telegram con allowlist ✅

En `telegram-luna-adapter.cjs`:
- Añadidas variables `ALLOWED_TELEGRAM_IDS` y `OWNER_TELEGRAM_ID` (en `.env`).
- Función `_isAllowedTelegramUser()` aplicada en **todos** los handlers: comandos (`/start`, `/modo`, `/persona`, `/status`, `/newaba`, `/kimi`), mensajes genéricos y `callback_query`.
- **Solo el dueño (`8037713238`)** puede interactuar; desconocidos son ignorados.
- Backup: `/root/telegram-luna-adapter.cjs.bak`

### 2.4 FASE 4 — Antivirus y escaneo periódico ✅

**Escaneo inicial:**
- clamav **1.5.3**, firmas al día (**3.6M+** detecciones: main + daily + bytecode).
- **`clamscan` full:** 80,192 archivos, **0 infectados** (25 min).
- **chkrootkit:** sin rootkits (solo falsos positivos de `node_modules`).

**Escaneo semanal automático:**
- `/usr/local/bin/luna-clamscan.sh` — escanea `/root /home /etc /usr/local/bin /opt`, excluye `node_modules/.git/docker`, a prioridad mínima (`nice -19` + `ionice -c3`).
- Cron en `/etc/cron.d/luna-clamscan`: **lunes 03:00**.
- freshclam daemon **activo** → firmeras actualizadas cada ~6h.
- Log: `/var/log/clamav/clamscan-weekly.log`

### 2.5 FASE 5 — Alertas diarias por Telegram ✅ (nuevo)

Notificaciones automáticas de seguridad **2 veces al día**:
- **07:00** — informe matutino.
- **22:00** — informe vespertino.

Detalle de implementación en `docs/security/2026-08-05-telegram-security-alerts.md`.

### 2.6 Limpieza de disco ✅

| Elemento | Tamaño | Motivo |
|----------|--------|--------|
| Imagen docker `open-webui:main` | 6.7 GB | No referenciada (el contenedor usa `:ollama`) |
| Cache apt | 147 MB | Paquetes `.deb` descargados |
| `/swapfile-nexus` | 4.1 GB | Swap huérfano (no en `/etc/fstab`, no activo) |

> El swap activo `/swapfile-luna` **no se tocó** (operativo, de Luna).
> Docker/containerd (20G) verificado: **100% en uso** por ollama/open-webui activos, no es basura recuperable.

---

## 3. Monitoreo de seguridad de todas las apps (LIMPIO)

| Área | Estado |
|------|--------|
| **PM2** | 11 apps online, 1 stopped (`nexo-dashboard-backend`), sin anomalías |
| **Usuarios** | abner/enoque/elias sin `authorized_keys` y sin grupo sudo/admin → no acceden por SSH |
| **Conexiones** | Único SSH activo = owner (79.117.116.3); sin conexiones salientes sospechosas |
| **SETUID** | Solo binarios estándar del sistema + contenedores. Nada anómalo |
| **Caddy** | Un solo vhost público (`vps.nexo-digital.app`) → superficie mínima |
| **Auditoría 30 días** | Sin intrusos: SSH solo 2 IPs legítimas del owner, 3 claves legítimas, sin miner/tunnel/c2 |

---

## 4. Backups creados durante la implantación

- `/root/iptables-backup-before-firewall.txt`
- `/root/telegram-luna-adapter.cjs.bak`
- `/root/docker-state-backup-before-cleanup.txt`
- `/root/crontab-backup-before-deploy.txt`

---

## 5. Pendientes opcionales (requieren decisión del owner)

- `PasswordAuthentication no` completo (más endurecimiento; no aplicado por elección de "parcial seguro").
- Instalar **logwatch/AIDE** (monitoreo Fase 3 del plan original).
- Rotar **logs grandes** (`luna-server.log` 420M, `pre-postgres/luna-server.log` 245M) → `pm2-logrotate`.
