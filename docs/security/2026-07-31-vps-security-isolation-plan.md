# Plan de seguridad VPS Nexo — aislamiento por aplicación

> **Fecha:** 2026-07-31 (revisado 2026-08-01 con auditoría real en vivo)
> **Estado:** documentado, pendiente de implantación
> **Restricción del owner:** no se pueden denegar/cerrar los puertos públicos actuales (siguen expuestos por Caddy).
> **Objetivo principal:** protegerse ante brute-force y, sobre todo, **aislar cada aplicación** para que un compromiso de una app no comprometa las demás. **Logging operativo en todas las apps + SSH + cambios.**

---

## 1. Contexto y restricciones

### 1.1 Qué NO vamos a hacer (por decisión del owner)

- No cerrar puertos públicos que hoy usa el negocio (80/443, 3469–3472, 3500–3501, 3510–3531, 3600–3601, 8443–8445, 22, etc.).
- No “apagar internet” a los servicios.
- No romper Luna (Chrome/CDP/VNC) como primer paso.
- **No rotar el PAT/credenciales de este chat** — el token es temporal y caduca; ignorar.
- **Cuidado con el chat web de Luna** (vive en `luna-server`, puerto 3458, expuesto en 3501): no reiniciarlo sin plan. Los bugs de Luna (`SEND_NOT_CONFIRMED`, `GENERATION_NEVER_STARTED`) ya están resueltos (commits `df5bbc1`, `e6154bc`).

### 1.2 Qué SÍ queremos

1. **Endurecer el perímetro** sin quitar puertos (UFW allowlist = solo lo necesario, fail2ban, SSH por clave).
2. **Aislar apps entre sí** (usuario Linux distinto, filesystem, env secrets, DB roles, red interna).
3. **Limitar blast radius**: si hackean workspace-cliente, no deben poder tocar dashboard backend, Luna, Postgres root, ni otras apps.
4. **Observabilidad**: logs funcionando en TODAS las aplicaciones + accesos SSH + cambios del sistema (logrotate, Caddy por sitio, auditd, alertas).

### 1.3 Estado real auditado (verificado 2026-08-01 vía `ss`, `pm2 jlist`, Caddyfile)

| Área | Estado real |
|------|-------------|
| UFW | **Inactivo** |
| Fail2ban | Activo (jail `sshd`), `maxretry=5`, `bantime=3600`, acción `telegram-alert`, **0 bans** |
| SSH | `PermitRootLogin yes`; 3 claves en `authorized_keys`; password auth conflictivo |
| Brute force | ~58 failed passwords en auth.log (IPs ES/RO/AWS/GCP/VN) |
| Caddy | **v2.11.4** → `rate_limit` **nativo** (desde v2.9), sin plugin |
| Caddy logs | **1 `access.log` global (15MB), 0 bloques `log` por sitio** |
| PM2 logs | **848MB sin rotar** en `/root/nexo-projects-abner/logs/` (luna-server 477MB, nexo-lp 286MB); sin `pm2-logrotate`; logrotate del sistema no cubre node/caddy |
| auditd | **No instalado** (sin trazabilidad de cambios) |
| monarx-agent | **Activo** (Hostinger, logs rotados OK) |
| App internas | Bien: `nexus` 13469, `workspace-nexo` 13471, `workspace-cliente` 13472, `dash-be` 13500, `store` 13700 en 127.0.0.1 |
| **Exposición directa (0.0.0.0/`*` SIN Caddy)** | `5173` (VITE dev), `3000` (open-webui docker), `11434` (ollama docker), `3001` (nexus-backend), `5900/5901` (x11vnc), `18445` (websockify), `3458` (luna-server), `13510` (nexus-rh), `13710` (nexo-lp-server) |
| Procesos | Casi todo corre como **root** (12 apps PM2 root, Chrome root) |
| Postgres | 127.0.0.1:5432, `scram-sha-256`, user `nexo` con acceso amplio |

### 1.4 Hallazgo crítico #1 — Vite dev-server público (P0)

`nexus-frontend` corre un **VITE DEV SERVER** en `0.0.0.0:5173`. Los dev-servers expuestos son vector de RCE (middleware dev, sourcemaps). Acción: bind `127.0.0.1` si es solo desarrollo, o meterlo tras Caddy con auth. **NUNCA dejarlo en 0.0.0.0.**

### 1.5 Hallazgo crítico #2 — Caddy NO es el único edge

Estos puertos están expuestos directamente en `0.0.0.0`/`*`, sin proxy Caddy:
`5173`, `3000`, `3001`, `11434`, `5900`, `5901`, `18445`, `3458`, `13510`, `13710`.
La UFW allowlist (FASE 1) los bloquea **sin tocar ningún puerto de negocio**.

### 1.6 IPs — cuidado al banear

| IP | Notas |
|----|-------|
| `79.116.30.132` | Apareció como `SSH_CLIENT` legítimo del owner → **NO banear** sin confirmar |
| `187.124.45.250` | Es la propia VPS → **nunca banear** |
| `54.212.233.107`, `34.78.204.56`, `116.110.12.59` | Cloud scanners típicos → candidatos a ban |
| `83.50.152.241` | Brute force root; confirmar que no es IP del equipo antes de ban permanente |

---

## 2. Modelo de amenaza

### 2.1 Ataques esperados

1. Brute force SSH / credential stuffing.
2. Exploit de una app web (RCE, path traversal, SSRF, auth bypass).
3. Robo de token/API key de una app y reutilización contra otra.
4. Acceso lateral: desde proceso comprometido → leer `.env` de otras apps → Postgres → todo.
5. Abuso de VNC/noVNC/Ollama/dev-servers (vite) si quedan abiertos sin auth.

### 2.2 Blast radius actual (malo)

Hoy, si alguien logra RCE en **cualquier** proceso Node de PM2:

- Corre como **root** (o con los mismos privilegios del proceso PM2).
- Puede leer **todos** los `.env`, cookies de Kimi, `chrome-profile`, claves SSH, dump de Postgres.
- Puede reiniciar/matar **todas** las apps.
- Puede pivotar a la DB compartida `nexo_dashboard` con el mismo usuario `nexo`.

**Eso es el problema #1 a resolver**, más que “cerrar puertos”.

---

## 3. Arquitectura objetivo: aislamiento por aplicación

```
Internet
   │
   ▼
┌──────────────────────────────────────────┐
│  Caddy (único edge público)              │
│  - TLS, rate-limit por host/ruta (nativo)│
│  - headers de seguridad                  │
│  - access/error logs por sitio           │
└─────────────┬────────────────────────────┘
              │ reverse_proxy solo a 127.0.0.1
   ┌──────────┼──────────┬─────────────┬────────────┐
   ▼          ▼          ▼             ▼            ▼
 ws-nexo   ws-cliente  dash-be      luna-server   otros
 user:     user:       user:        user:         user:
 app-nexo  app-cli     app-dash     app-luna      app-X
   │          │          │             │
   └──────────┴──────────┴──────┬──────┘
                                ▼
                    Postgres (roles separados)
                    nexo_ws_nexo / nexo_ws_cli / nexo_dash / …
```

### 3.1 Principios

| Principio | Implementación |
|-----------|----------------|
| **Un proceso Linux por app** | `app-workspace-nexo`, `app-workspace-cliente`, `app-dashboard`, `app-luna`, `app-nexus`, … |
| **Un directorio home por app** | `/var/nexo/<app>/` con permisos `750` owner=app, group=app |
| **Secretos no compartidos** | Cada app solo lee su `.env`; no hay “super .env” legible por todos |
| **DB least privilege** | Rol Postgres por app: solo tablas/schemas que necesita; sin SUPERUSER |
| **Red interna mínima** | Apps escuchan solo `127.0.0.1`; Caddy es el único edge |
| **PM2 / systemd por usuario** | No un solo PM2 root para todo |
| **Sin lectura cruzada de código/datos** | `chmod` + opcionalmente `systemd ProtectSystem` / `PrivateTmp` |
| **Logging operativo** | rotación de logs en todas las apps + Caddy por sitio + auditd + alertas |

### 3.2 Mapa de apps — inventario operativo REAL (verificado 2026-08-01)

| App PM2 | Path | Puerto interno | Puerto público Caddy | Usuario Linux propuesto | DB role propuesto |
|---------|------|----------------|----------------------|-------------------------|-------------------|
| workspace-nexo | `/root/nexo-workspace-nexo` | 127.0.0.1:13471 | 3471 | `app-ws-nexo` | `role_ws_nexo` |
| workspace-cliente | `/root/nexo-workspace-cliente` | 127.0.0.1:13472 | 3472 | `app-ws-cliente` | `role_ws_cliente` |
| nexo-dashboard-backend | `/root/nexo-projects-abner/luna-kernel/apps/dashboard` | 127.0.0.1:13500 | 3500, 3501 | `app-dashboard` | `role_dashboard` |
| luna-server | `luna-kernel/apps/dashboard` | **\*:3458** → rebind 127.0.0.1 | 3600, 3601 | `app-luna` | `role_luna` (o JSON only) |
| luna-health-watchdog | `luna-kernel/packages/kernel` | — | — | `app-luna` | — |
| luna-telegram | `luna-kernel/packages/kernel` | — | — | `app-luna` | — |
| nexus | `/root/nexus` | 127.0.0.1:13469 | 3470 | `app-nexus` | `role_nexus` |
| nexus-frontend (**VITE DEV**) | `/root/nexo-projects-abner/nexus_RH/app` | **\*:5173** | (decidir) | `app-nexus-rh` | — |
| nexus-backend | `/root/nexo-projects-abner/nexus_RH/app/server` | **\*:3001** | 3531 | `app-nexus-rh` | `role_nexus_rh` |
| nexus-rh (serve) | `/root/nexo-projects-abner/nexus_RH/app` | **\*:13510** | 3510, 3511 | `app-nexus-rh` | — |
| nexo-lp-server | `/root/nexo-projects-abner/nexo-lp-creator` | **\*:13710** | 3530 | `app-nexo-lp` | `role_nexo_lp` |
| nexo-store | `/root/nexo-projects-abner/nexo-digital-store` | 127.0.0.1:13700 | 3520, 3521 | `app-nexo-store` | `role_nexo_store` |

Otros: **NexoDashboard** (`/root/nexo-projects-abner/NexoDashboard`) existe pero **no corre en PM2**.
**Caddy** público: 80, 443, 3469, 3470, 3471, 3472, 3500, 3501, 3510, 3511, 3520, 3521, 3530, 3531, 3600, 3601, 8443, 8444, 8445.
Docker: `open-webui` (3000), `ollama` (11434). VNC: `x11vnc` 5900/5901. noVNC: `websockify` 18445 (8445). ttyd: 18444 (8444).

---

## 4. Capas de defensa (sin quitar puertos públicos)

Como los puertos públicos **siguen abiertos**, la defensa se mueve a:

### Capa 0 — Perímetro “allowlist” (UFW)

UFW **activo**, pero **permitiendo** todos los puertos de negocio actuales:

```
default deny incoming
default allow outgoing
allow 22/tcp
allow 80,443/tcp
allow 3470:3472/tcp
allow 3500:3501/tcp
allow 3600:3601/tcp
allow 8443:8445/tcp
allow 3510:3511/tcp
allow 3520:3521/tcp
allow 3530:3531/tcp
# + 3469 (Caddy estático) si aplica
```

**Efecto inmediato:** los 10 puertos expuestos directamente (5173, 3000, 3001, 11434, 5900, 5901, 18445, 3458, 13510, 13710) dejan de ser alcanzables desde fuera **sin tocar ningún puerto de negocio**.

### Capa 1 — SSH y brute force

- Fail2ban reforzado: `maxretry=3`, `bantime=7200`, `findtime=300`.
- Mantener acción Telegram.
- Ban selectivo de scanners (nunca la IP del owner ni la VPS).
- SSH: preferir solo clave (`PasswordAuthentication no`) **después** de validar login por clave en sesión paralela.
- `PermitRootLogin prohibit-password` (root solo con clave).

### Capa 2 — Edge (Caddy) por aplicación

Caddy **v2.11.4** con `rate_limit` **nativo** (sin plugin). Cada site debe tener:

1. **Rate limit** por IP en rutas sensibles: `/api/auth/*`, `/login`, `/api/admin/*`
2. **Headers de seguridad** (HSTS, `X-Content-Type-Options`, `X-Frame-Options`).
3. **Logs separados** por sitio (`/var/log/caddy/<site>.log`) + logrotate.
4. **Timeouts** y límites de body.
5. Verificar el bloque **3469** (estático, sin `reverse_proxy`).

```caddy
vps.nexo-digital.app:3471 {
  log {
    output file /var/log/caddy/ws-nexo.log
  }
  @auth path /api/auth/* /login*
  rate_limit @auth {
    zone auth_ws_nexo
    key {remote_host}
    events 10
    window 1m
  }
  reverse_proxy 127.0.0.1:13471
}
```

### Capa 3 — Proceso / OS isolation (núcleo del plan)

Para **cada** app PM2:

1. Crear usuario del sistema sin login shell interactivo:
   ```bash
   useradd --system --home /var/nexo/ws-nexo --shell /usr/sbin/nologin app-ws-nexo
   ```
2. Mover/copiar runtime a `/var/nexo/<app>/` (o mantener path actual con `chown -R`).
3. `.env` con `chmod 600` y owner=app.
4. PM2 ecosystem **por usuario** o systemd unit:
   ```ini
   [Service]
   User=app-ws-nexo
   Group=app-ws-nexo
   WorkingDirectory=/var/nexo/ws-nexo
   EnvironmentFile=/var/nexo/ws-nexo/.env
   NoNewPrivileges=true
   PrivateTmp=true
   ProtectSystem=strict
   ProtectHome=true
   ReadWritePaths=/var/nexo/ws-nexo
   ```
5. Capacidades mínimas: sin `CAP_NET_RAW`, sin docker.sock montado, etc.
6. **app-luna es el más delicado:** `ReadWritePaths` debe incluir `chrome-profile`, `cookies/`, logs. Hacerlo el último.

**Resultado si hackean ws-cliente:** el atacante es `app-ws-cliente`, no puede leer `/var/nexo/ws-nexo/.env` ni cookies de Luna ni SSH keys de root.

### Capa 4 — Base de datos (aislamiento de datos)

Hoy: un solo user `nexo` con acceso amplio a `nexo_dashboard`.

Objetivo:

| Role | Privilegios |
|------|-------------|
| `role_ws_nexo` | CRUD en tablas admin de workspace-nexo; sin DROP DATABASE |
| `role_ws_cliente` | Solo filas/tablas del portal cliente (idealmente RLS por `organizationId`) |
| `role_dashboard` | Tablas de créditos/tickets del dashboard backend |
| `role_luna` | Solo lo que Luna necesite (o cero si usa JSON files) |

Pasos:

1. Crear roles con passwords distintos.
2. `GRANT` mínimo por schema/tabla; `REVOKE ALL ON SCHEMA public FROM public`.
3. Activar **Row Level Security** en tablas multi-tenant (`Organization`, `Request`, `CreditTransaction`, etc.).
4. Cada app usa **solo** su `DATABASE_URL` con su role.
5. Rotar el password del superuser `nexo` y dejarlo solo para migraciones/admin.

### Capa 5 — Secretos y tokens

- Inventario: `NEXTAUTH_SECRET`, `DASHBOARD_API_KEY`, `INTERNAL_API_TOKEN`, cookies Kimi, SMTP, Telegram, etc.
- **Un token distinto por dirección de confianza** (`DASHBOARD_API_KEY` de workspace-nexo ≠ token genérico en docs).
- Rotar `nexo-digital-2026` y cualquier secret que haya aparecido en chats/logs.
- **NO rotar el PAT de GitHub usado en este chat** (temporal, caduca; decisión del owner).
- No commitear secrets.
- Luna: `chrome-profile` y `cookies/` solo legibles por `app-luna`.

### Capa 6 — Logging operativo (requisito del owner: TODAS las apps + SSH + cambios)

| Qué | Herramienta | Estado |
|-----|-------------|--------|
| Rotación de logs PM2 (848MB sin rotar) | `/etc/logrotate.d/nexo-pm2` (copytruncate) o `pm2-logrotate` | **pendiente — crítico** |
| Logs de Caddy por sitio | `log { output file ... }` en cada site + logrotate | **pendiente** |
| Cambios del sistema (accesos/config/ejecución) | **auditd** (instalar + reglas) | **pendiente** |
| Accesos SSH | `/var/log/auth.log` + alerta Telegram de `Accepted` | auth.log OK, falta alerta |
| Logs de apps (nexus, nexus_RH, dashboard, luna, lp, store) | `/root/nexo-projects-abner/logs/`, `/root/nexus/logs/`, `nexus_RH/logs/` | existen, **sin rotar** |
| WAF/detección | monarx-agent (activo, rotado) | OK |
| Revisión semanal | script que resume logins SSH, cambios auditd, errores por app, 4xx/429 Caddy → Telegram | **pendiente** |

---

## 5. Fases de implantación (orden recomendado)

### FASE 0 — BACKUP (obligatorio — el backup se guarda FUERA de la VPS)

> La VPS no tiene espacio para backups (96G disco, 65G usados, 32G libres y los logs crecen ~centenares de MB/día).

**Tamaño real de los datos únicos** (excluyendo `node_modules`, `.git`, logs — todo eso se regenera o ya está en git):

| Dato | Tamaño |
|------|--------|
| Postgres (3 DBs: dashboard 7.5MB + 12MB + 7.3MB) | ~27 MB |
| `/root/.luna` (personas, chrome-profile, cookies) | 193 MB |
| `/root/nexo-projects-abner/.luna` (workspaces, 33) | 13 MB |
| `.env` de cada app + configs (`/etc/caddy`, `/etc/ssh`, `/etc/fail2ban`, ecosystem PM2) | <1 MB |
| **TOTAL** | **~250 MB** |

**Dónde guardarlo (destinos externos):**

1. **Cloudflare R2** (10 GB gratis, egress gratis) o **Backblaze B2** (10 GB gratis) — destino principal vía **restic** (cifrado AES-256, dedup, snapshots). ~250 MB cabe en el free tier indefinidamente.
2. **Snapshot de Hostinger** (panel) antes de cada fase de cambios — rollback rápido del disco completo.
3. **Telegram (bot `luna-telegram`)** — solo archivos críticos pequeños (`pg_dump` ~7–12 MB) como copia diaria extra.
4. **GitHub (repos privados)** — el código ya vive en git (luna-kernel, workspace-cliente, etc.). **Nunca** `.env`/cookies/chrome-profile a GitHub.

**Esquema restic propuesto** (`/root/backup/backup.sh` + cron):
- Diario: dump DB + `/root/.luna` + configs → repo cifrado en R2/B2.
- Semanal: código de las apps (excluyendo `node_modules`, `.git`, `logs/`).
- Retención: `keep-daily 7`, `keep-weekly 4`, `keep-monthly 6`.

**Checklist FASE 0:**
- [ ] Crear bucket R2 o B2 + credentials + probar `restic backup` y `restic restore`.
- [ ] `pg_dump` de las 3 DBs.
- [ ] Copia de `/root/.luna`, `.env` (cifrados), configs `/etc/caddy`, `/etc/ssh`, `/etc/fail2ban`, PM2 ecosystem.
- [ ] Documentar rollback por fase.

### FASE 0b — LOGGING (bajo riesgo, sin downtime)

- [ ] `/etc/logrotate.d/nexo-pm2` (copytruncate): `/root/nexo-projects-abner/logs/*.log`, `/root/nexus/logs/*`, `/root/nexo-projects-abner/nexus_RH/logs/*`, `/root/.pm2/logs/*`. daily, rotate 14, compress.
- [ ] Logs de Caddy por sitio + logrotate de `/var/log/caddy`.
- [ ] Instalar `auditd` + reglas: `-w /etc/ssh/sshd_config -p wa`, `-w /etc/caddy -p wa`, `-w /etc/fail2ban -p wa`, `-w /root/nexo-projects-abner -p wa -k luna` (+ `/var/nexo` tras FASE 5).
- [ ] Alerta Telegram de login SSH (`Accepted ... root`) vía cron + curl (token de luna-telegram).
- [ ] Script semanal de revisión de logs → Telegram.
- [ ] **Cuidado:** no reiniciar `luna-server` durante esta fase; su log ya va a `/root/nexo-projects-abner/logs/`, solo rotar.

### FASE 1 — Perímetro sin quitar puertos de negocio (bajo riesgo)

- [ ] Activar UFW con allowlist = puertos Caddy + 22 (ver Capa 0).
- [ ] Reforzar fail2ban sshd (3 intentos / 2h ban).
- [ ] Ban selectivo de IPs scanners (no owner, no VPS).
- [ ] Verificar acceso SSH, dashboards, Luna, workspaces.
- [ ] (Opcional) fail2ban filter para auth fallida en Caddy.

**Criterio de éxito:** UFW active; fail2ban banea scanners; todo el negocio sigue accesible por los mismos puertos; los 10 puertos directos (5173/3000/3001/11434/5900/5901/18445/3458/13510/13710) ya no se alcanzan desde fuera.

### FASE 2 — Hardening SSH (medio riesgo — sesión paralela obligatoria)

- [ ] Abrir **segunda** sesión SSH por clave y verificar que funciona.
- [ ] `PasswordAuthentication no`
- [ ] `PermitRootLogin prohibit-password`
- [ ] `MaxAuthTries 3`
- [ ] Reiniciar sshd y validar login nuevo antes de cerrar la sesión vieja.

**Criterio de éxito:** login solo con clave; password rechazado; no lockout.

### FASE 3 — REBIND backends a 127.0.0.1 (manteniendo Caddy proxy)

> El puerto público Caddy SIGUE; solo deja de exponerse el backend crudo. No es “cerrar puertos”.

- [ ] `luna-server` 3458 → 127.0.0.1 (verificar 3600/3601 después).
- [ ] `nexus-backend` 3001, `nexus-rh` 13510, `nexo-lp-server` 13710 → 127.0.0.1.
- [ ] `websockify` 18445, `x11vnc` 5900/5901 → 127.0.0.1 (si noVNC via Caddy 8445 cubre el caso de uso).
- [ ] `open-webui` 3000 y `ollama` 11434 (Docker): cambiar el port-mapping en el contenedor a `127.0.0.1:PORT:PORT`. Si deben quedar públicos, añadir site Caddy con auth.
- [ ] `nexus-frontend` 5173 (VITE DEV): bind 127.0.0.1 o tras Caddy con auth — **P0**, nunca 0.0.0.0.
- [ ] Verificar cada puerto público de negocio tras cada rebind (200 OK).

### FASE 4 — Aislamiento de usuarios (alto impacto, planificado)

Orden sugerido (de menos a más crítico):

1. `app-ws-cliente` (portal)
2. `app-ws-nexo` (admin)
3. `app-dashboard`
4. Resto nexus/lp/store
5. `app-luna` + Chrome (último: más delicado)

Por cada app:

- [ ] Crear user + home + permisos.
- [ ] Migrar unit PM2/systemd a ese user.
- [ ] Verificar health + login E2E.
- [ ] Confirmar que el user **no** puede leer `.env` de otra app (`sudo -u app-ws-cliente cat /var/nexo/ws-nexo/.env` → Permission denied).

### FASE 5 — Aislamiento de base de datos

- [ ] Crear roles Postgres por app.
- [ ] Grants mínimos + `REVOKE ALL ON SCHEMA public FROM public`.
- [ ] Actualizar `DATABASE_URL` por app.
- [ ] Migraciones solo con role admin de migraciones.
- [ ] (Avanzado) RLS multi-tenant.

### FASE 6 — Hardening Caddy por app

- [ ] Rate limit auth/admin (nativo v2.11.4).
- [ ] Logs por sitio (si no se hizo en FASE 0b).
- [ ] Headers seguridad.
- [ ] Revisar que no se exponga debug/stack traces.
- [ ] Verificar bloque estático 3469.

### FASE 7 — Luna / Chrome / VNC (delicado)

- [ ] Chrome y CDP solo `127.0.0.1` (ya está en 127.0.0.1:9222 ✅).
- [ ] VNC/noVNC: auth fuerte + considerar túnel SSH en lugar de exposición ancha (si el negocio lo permite **sin cerrar el puerto**, al menos auth).
- [ ] Usuario `app-luna` dueño de `chrome-profile` y cookies.
- [ ] Ollama bind `127.0.0.1` si no necesita acceso público directo — **negociar con owner**.
- [ ] **No tocar `luna-server`/`kimi-bridge.cjs` sin plan** (bugs ya resueltos).

> Si el owner insiste en que Ollama/VNC sigan públicamente alcanzables en el mismo puerto, la mitigación es **auth + rate limit + aislamiento de user**, no deny del puerto.

### FASE 8 — Observabilidad continua

- [ ] Revisión semanal de logs (FASE 0b) en producción.
- [ ] Runbook de incidente: revocar tokens, rotar secrets, aislar app comprometida (`systemctl stop`, revocar DB role).
- [ ] (Opcional) AIDE semanal para integridad de binarios.

---

## 6. Tests de validación de aislamiento

Después de FASE 3–5, ejecutar:

```bash
# 1) Lectura cruzada de secrets (debe fallar)
sudo -u app-ws-cliente cat /var/nexo/ws-nexo/.env
# expect: Permission denied

# 2) DB cruzada (debe fallar)
psql "postgresql://role_ws_cliente:...@127.0.0.1/nexo_dashboard" \
  -c 'SELECT * FROM "SystemLog" LIMIT 1;'
# expect: permission denied

# 3) Puerto directo no accesible desde fuera (tras UFW)
# Desde máquina externa: nc -vz vps.nexo-digital.app 5173 → fail
# Desde público solo Caddy 3471 → ok

# 4) Compromiso simulado: proceso como app-ws-cliente no lista /root
sudo -u app-ws-cliente ls /root
# expect: Permission denied

# 5) Rebind verificado: ss -tlnp | grep 3458 → 127.0.0.1
#    y https://vps.nexo-digital.app:3600 sigue respondiendo

# 6) Logging: los 3 archivos de logrotate rotan; audit.log recibe cambios;
#    alerta Telegram llega al hacer un login SSH.
```

---

## 7. Runbook si una app es hackeada

1. **Contener:** `systemctl stop nexo-ws-cliente` (o pm2 stop de ese user).
2. **Revocar:** rotar `.env` secrets de ESA app + tokens que esa app conocía.
3. **DB:** `REVOKE` / cambiar password del role de esa app; revisar queries sospechosas (`pg_stat_activity`).
4. **Forense:** logs Caddy de ese sitio + logs app + `last`/`auth.log` + `ausearch -k` si hubo pivot.
5. **No asumir** que otras apps están limpias hasta verificar que no compartían el mismo secret/user/DB role.
6. **Rebuild** desde git limpio; no “arreglar in-place” el binario comprometido.
7. **Restaurar** desde restic (R2/B2) si hace falta.

Con aislamiento bien hecho, el paso 5 suele limitar el daño a **una** app.

---

## 8. Decisiones abiertas (preguntar al owner antes de codificar)

1. ¿UFW allowlist espejo de Caddyfile está OK? (no cierra puertos de negocio, solo la basura directa)
2. ¿SSH solo por clave en la misma ventana de mantenimiento?
3. ¿Orden de migración de users: cliente → dashboard → nexus → luna?
4. ¿VNC/noVNC deben seguir públicos con auth, o túnel SSH manteniendo el puerto “abierto” pero inutilizable sin credencial?
5. ¿Ollama/open-webui deben ser públicos o solo internos?
6. ¿`nexus-frontend` (5173 vite dev) es negocio o dev? (recomendado: 127.0.0.1 o Caddy con auth)
7. ¿Destino de backup: **Cloudflare R2** (10GB free) o **Backblaze B2** (10GB free)?
8. ¿Presupuesto de downtime? (FASE 4 puede hacerse app por app con minutos de corte)

---

## 9. Prompt de continuación (copiar/pegar en la siguiente sesión)

```
Contexto: VPS Nexo (root@187.124.45.250). Plan de seguridad documentado en:
docs/security/2026-07-31-vps-security-isolation-plan.md

Restricciones del owner:
- NO denegar/cerrar los puertos públicos de negocio actuales.
- SÍ proteger y aislar cada aplicación para que un hack de una no afecte a las demás.
- No romper Luna (Chrome/CDP/VNC) sin plan dedicado.
- NO rotar el PAT/credenciales de este chat (temporales).
- Cuidado con el chat web de Luna (luna-server, 3501): no reiniciar sin plan.
- Logging funcionando en TODAS las apps + SSH + cambios (obligatorio).

Estado auditado 2026-08-01 (verificado en vivo):
- UFW inactive; fail2ban sshd débil/sin bans; Caddy v2.11.4 (rate_limit NATIVO)
- Caddy NO es el único edge: 5173, 3000, 3001, 11434, 5900, 5901, 18445,
  3458, 13510, 13710 expuestos directamente (0.0.0.0/*)
- nexus-frontend corre VITE DEV SERVER en 0.0.0.0:5173 (P0, RCE-prone)
- 848MB de logs PM2 sin rotar; auditd NO instalado; Caddy sin logs por sitio
- 12 apps PM2 como root; monarx-agent activo
- Datos únicos a respaldar ~250MB → destino externo R2/B2 (restic cifrado)

Objetivo de esta sesión:
Ejecutar FASE <N> del plan (empezar por FASE 0 backup + FASE 0b logging).
Validar con health checks de: SSH, :3471, :3472, :3500/:3501, :3600, Luna chat.
Documentar cambios en .brain/status.md y este doc (checkboxes).

No banear IPs del owner (verificar SSH_CLIENT) ni 187.124.45.250.
No desactivar password SSH sin sesión paralela por clave verificada.
```

---

## 10. Resumen ejecutivo

| Prioridad | Acción | ¿Cierra puertos de negocio? | Reduce blast radius |
|-----------|--------|------------------------------|---------------------|
| P0 | UFW allowlist = puertos Caddy (mata 10 exposiciones directas) | No | Medio |
| P0 | Vite dev-server 5173 (bind 127.0.0.1 o Caddy+auth) | No | **Alto** |
| P0 | Rebind de backends crudos a 127.0.0.1 (Caddy sigue) | No | **Alto** |
| P0 | **Backup externo restic → R2/B2** (FASE 0) | No | Recuperación |
| P0 | **Logging operativo** (rotación + Caddy por sitio + auditd + alertas) | No | Detección |
| P0 | Fail2ban + bans selectivos | No | Bajo–medio (SSH) |
| P0 | Secrets distintos + rotación de tokens expuestos (no el PAT temporal) | No | Medio |
| P1 | Usuario Linux + systemd/PM2 por app | No | **Alto** |
| P1 | Roles Postgres por app (+ RLS) | No | **Alto** |
| P1 | Rate-limit + logs Caddy por app | No | Medio |
| P2 | SSH solo clave | No | Medio |
| P2 | Luna/Chrome/VNC isolation | No* | Alto |

\* Puede requerir rebind a localhost de backends crudos sin quitar el puerto Caddy público.

**Conclusión:** con la restricción de no cerrar puertos, la inversión correcta es **aislamiento por identidad (OS user + DB role + secrets + Caddy rate-limit)** + **backup externo** + **logging operativo**, no solo firewall. El firewall (UFW allowlist) sigue siendo útil para matar la exposición directa de puertos que Caddy no cubre.
