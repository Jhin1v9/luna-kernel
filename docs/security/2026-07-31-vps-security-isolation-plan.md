# Plan de seguridad VPS Nexo — aislamiento por aplicación

> **Fecha:** 2026-07-31  
> **Estado:** documentado, pendiente de implantación  
> **Restricción del owner:** no se pueden denegar/cerrar los puertos públicos actuales (siguen expuestos por Caddy).  
> **Objetivo principal:** protegerse ante brute-force y, sobre todo, **aislar cada aplicación** para que un compromiso de una app no comprometa las demás.

---

## 1. Contexto y restricciones

### 1.1 Qué NO vamos a hacer (por decisión del owner)

- No cerrar puertos públicos que hoy usa el negocio (3470–3472, 3500–3501, 3600–3601, 8443–8445, 3510–3531, 80/443, 22, etc.).
- No “apagar internet” a los servicios.
- No romper Luna (Chrome/CDP/VNC) como primer paso.

### 1.2 Qué SÍ queremos

1. **Endurecer el perímetro** sin quitar puertos (UFW allowlist = solo lo necesario, fail2ban, SSH por clave).
2. **Aislar apps entre sí** (usuario Linux distinto, filesystem, env secrets, DB roles, red interna).
3. **Limitar blast radius**: si hackean workspace-cliente, no deben poder tocar dashboard backend, Luna, Postgres root, ni otras apps.
4. **Observabilidad**: detectar y reaccionar por app.

### 1.3 Estado real auditado (2026-07-31)

| Área | Estado |
|------|--------|
| UFW | **Inactivo** |
| Fail2ban | Activo (jail `sshd`), `maxretry=5`, `bantime=3600`, acción `telegram-alert`, **0 bans** |
| SSH | `PermitRootLogin yes`; hay 3 claves en `authorized_keys`; password auth conflictivo entre cloud-init configs |
| Brute force | ~58 failed passwords en auth.log (IPs ES/RO/AWS/GCP/VN) |
| Apps Next (13471/13472/etc.) | Bien: escuchan en **127.0.0.1** (solo Caddy expone) |
| Dashboard backend | 127.0.0.1:13500 |
| Postgres | 127.0.0.1:5432 |
| Riesgos extra | VNC 5900/5901, websockify 18445, Ollama 11434, node 3000/3001/5173/13710, Luna 3458 en `0.0.0.0`/`*` |
| Procesos | Casi todo corre como **root** (PM2 root, Chrome root) |

### 1.4 IPs — cuidado al banear

| IP | Notas |
|----|-------|
| `79.116.30.132` | Apareció como `SSH_CLIENT` legítimo del owner en sesiones recientes → **NO banear** sin confirmar |
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
5. Abuso de VNC/noVNC/Ollama si quedan abiertos sin auth fuerte.

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
│  - TLS, rate-limit por host/ruta         │
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

### 3.2 Mapa de apps (inventario operativo)

| App | Puerto interno | Puerto(s) público(s) Caddy | Usuario Linux propuesto | DB role propuesto |
|-----|----------------|----------------------------|-------------------------|-------------------|
| workspace-nexo | 127.0.0.1:13471 | 3471 | `app-ws-nexo` | `role_ws_nexo` |
| workspace-cliente | 127.0.0.1:13472 | 3472 | `app-ws-cliente` | `role_ws_cliente` |
| nexo-dashboard-backend | 127.0.0.1:13500 | 3500, 3501 | `app-dashboard` | `role_dashboard` |
| luna-server | 127.0.0.1:3458 | 3600, 3601 | `app-luna` | `role_luna` (o JSON only) |
| nexo-lp / store / nexus… | 127.0.0.1:xxxx | 3510–3531, etc. | `app-<name>` | `role_<name>` |
| Caddy | 80/443 + puertos app | — | `caddy` (ya no root si posible) | — |
| Postgres | 127.0.0.1:5432 | **nunca público** | `postgres` | — |
| Chrome/CDP Luna | 127.0.0.1:9222 | no público | `app-luna` (fase posterior) | — |
| VNC/noVNC | 5901 / 18445 | 8445 (si se mantiene) | `app-vnc` + auth fuerte | — |

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
# + cualquier otro puerto público documentado en Caddyfile
```

**Efecto:** no reduce la superficie de las apps web, pero:

- Cierra basura no documentada.
- Genera logs UFW.
- Evita que un proceso nuevo abra un puerto y quede expuesto sin querer.

> Nota: si el owner exige que *literalmente* no se toque ningún puerto, UFW allowlist = espejo exacto del Caddyfile actual. Eso sigue siendo útil.

### Capa 1 — SSH y brute force

- Fail2ban reforzado: `maxretry=3`, `bantime=7200`, `findtime=300`.
- Mantener acción Telegram si ya funciona.
- Ban selectivo de scanners (nunca la IP del owner ni la VPS).
- SSH: preferir solo clave (`PasswordAuthentication no`) **después** de validar login por clave en sesión paralela.
- `PermitRootLogin prohibit-password` (root solo con clave).
- Opcional: `AllowUsers` / usuario `deploy` para admin humano.

### Capa 2 — Edge (Caddy) por aplicación

Aunque el puerto esté abierto, cada site en Caddy debe tener:

1. **Rate limit** por IP en rutas sensibles:
   - `/api/auth/*`, `/login`, `/api/admin/*`
2. **Headers de seguridad** (HSTS si HTTPS, `X-Content-Type-Options`, `X-Frame-Options`, etc.).
3. **Logs separados** por sitio:
   - `/var/log/caddy/ws-nexo.log`
   - `/var/log/caddy/ws-cliente.log`
   - `/var/log/caddy/dashboard.log`
   - `/var/log/caddy/luna.log`
4. **Timeouts** y límites de body.
5. Opcional: **basic auth** o IP allowlist solo en rutas admin internas (si aplica).

Ejemplo de intención (pseudo-Caddy):

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

1. Crear usuario del sistema sin login shell interactivo (o shell restringido):
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
2. `GRANT` mínimo por schema/tabla.
3. Activar **Row Level Security** en tablas multi-tenant donde aplique (`Organization`, `Request`, `CreditTransaction`, etc.).
4. Cada app usa **solo** su `DATABASE_URL` con su role.
5. Rotar el password del superuser `nexo` y dejarlo solo para migraciones/admin.

### Capa 5 — Secretos y tokens

- Inventario de secrets: `NEXTAUTH_SECRET`, `DASHBOARD_API_KEY`, `INTERNAL_API_TOKEN`, cookies Kimi, SMTP, Telegram, etc.
- **Un token distinto por dirección de confianza:**
  - `DASHBOARD_API_KEY` que usa workspace-nexo ≠ token genérico compartido en claro en docs.
- Rotar `nexo-digital-2026` y cualquier secret que haya aparecido en chats/logs.
- No commitear secrets; no dejarlos en informes públicos.
- Luna: `chrome-profile` y `cookies/` solo legibles por `app-luna`.

### Capa 6 — Detección y respuesta

| Herramienta | Uso |
|-------------|-----|
| fail2ban sshd | Brute force SSH |
| fail2ban (filtros Caddy) | 401/403 masivos por app |
| Caddy access logs | Forense por sitio |
| PM2 logs por app | Errores de runtime |
| UFW logging | Intentos a puertos no allowlisted |
| Telegram alert (ya existe en fail2ban) | Extender a jail web |
| (Fase posterior) auditd / AIDE | Integridad de binarios y configs |

---

## 5. Fases de implantación (orden recomendado)

### FASE 0 — Preparación (sin downtime)

- [ ] Exportar inventario Caddyfile → lista exacta de puertos públicos (allowlist UFW).
- [ ] Confirmar IP(s) del owner/equipo (allowlist mental para no auto-ban).
- [ ] Backup: `pg_dump`, copia de `/root/nexo-workspace-src`, configs Caddy, ecosystem PM2.
- [ ] Documentar mapa app → puerto → path → secrets.
- [ ] Crear checklist de rollback.

### FASE 1 — Perímetro sin quitar puertos de negocio (bajo riesgo)

- [ ] Activar UFW con allowlist = puertos actuales de Caddy + 22.
- [ ] Reforzar fail2ban sshd (3 intentos / 2h ban).
- [ ] Ban selectivo de IPs scanners (no owner, no VPS).
- [ ] Verificar acceso SSH, dashboards, Luna, workspaces.
- [ ] (Opcional) fail2ban filter para auth fallida en Caddy.

**Criterio de éxito:** UFW active; fail2ban banea scanners; todo el negocio sigue accesible por los mismos puertos.

### FASE 2 — Hardening SSH (medio riesgo — sesión paralela obligatoria)

- [ ] Abrir **segunda** sesión SSH por clave y verificar que funciona.
- [ ] `PasswordAuthentication no`
- [ ] `PermitRootLogin prohibit-password`
- [ ] `MaxAuthTries 3`
- [ ] Reiniciar sshd y validar login nuevo antes de cerrar la sesión vieja.

**Criterio de éxito:** login solo con clave; password rechazado; no lockout.

### FASE 3 — Aislamiento de usuarios (alto impacto, planificado)

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

### FASE 4 — Aislamiento de base de datos

- [ ] Crear roles Postgres por app.
- [ ] Grants mínimos + tests de acceso denegado cruzado.
- [ ] Actualizar `DATABASE_URL` por app.
- [ ] Migraciones solo con role admin de migraciones.
- [ ] (Avanzado) RLS multi-tenant.

### FASE 5 — Hardening Caddy por app

- [ ] Rate limit auth/admin.
- [ ] Logs por sitio.
- [ ] Headers seguridad.
- [ ] Revisar que no se exponga debug/stack traces.

### FASE 6 — Luna / Chrome / VNC (delicado)

- [ ] Chrome y CDP solo `127.0.0.1`.
- [ ] VNC/noVNC: auth fuerte + considerar túnel SSH en lugar de exposición ancha (si el negocio lo permite **sin cerrar el puerto**, al menos auth).
- [ ] Usuario `app-luna` dueño de `chrome-profile` y cookies.
- [ ] Ollama bind `127.0.0.1` si no necesita acceso público directo (el puerto público Caddy puede seguir si hay proxy; si Ollama está en 0.0.0.0:11434, al menos no es “cerrar Caddy”, es no exponer el backend crudo — **negociar con owner**).

> Si el owner insiste en que Ollama/VNC sigan públicamente alcanzables en el mismo puerto, entonces la mitigación es **auth + rate limit + aislamiento de user**, no deny del puerto.

### FASE 7 — Observabilidad continua

- [ ] logwatch diario (opcional).
- [ ] AIDE semanal (opcional).
- [ ] Runbook de incidente: revocar tokens, rotar secrets, aislar app comprometida (`systemctl stop`, revocar DB role).

---

## 6. Tests de validación de aislamiento

Después de FASE 3–4, ejecutar:

```bash
# 1) Lectura cruzada de secrets (debe fallar)
sudo -u app-ws-cliente cat /var/nexo/ws-nexo/.env
# expect: Permission denied

# 2) DB cruzada (debe fallar)
psql "postgresql://role_ws_cliente:...@127.0.0.1/nexo_dashboard" \
  -c 'SELECT * FROM "SystemLog" LIMIT 1;'
# expect: permission denied (si SystemLog es solo admin)

# 3) Puerto interno no accesible desde fuera (si UFW allowlist no lo incluye)
# Desde máquina externa: nc -vz vps.nexo-digital.app 13471 → fail
# Desde público solo Caddy 3471 → ok

# 4) Compromiso simulado: proceso como app-ws-cliente no lista /root
sudo -u app-ws-cliente ls /root
# expect: Permission denied
```

---

## 7. Runbook si una app es hackeada

1. **Contener:** `systemctl stop nexo-ws-cliente` (o pm2 stop de ese user).
2. **Revocar:** rotar `.env` secrets de ESA app + tokens que esa app conocía.
3. **DB:** `REVOKE` / cambiar password del role de esa app; revisar queries sospechosas en logs Postgres.
4. **Forense:** logs Caddy de ese sitio + logs app + `last`/`auth.log` si hubo pivot.
5. **No asumir** que otras apps están limpias hasta verificar que no compartían el mismo secret/user/DB role.
6. **Rebuild** desde git limpio; no “arreglar in-place” el binario comprometido.

Con aislamiento bien hecho, el paso 5 suele limitar el daño a **una** app.

---

## 8. Decisiones abiertas (preguntar al owner antes de codificar)

1. ¿UFW allowlist espejo de Caddyfile está OK? (no cierra puertos de negocio, solo basura)
2. ¿SSH solo por clave en la misma ventana de mantenimiento?
3. ¿Orden de migración de users: cliente → nexo → dashboard → luna?
4. ¿VNC/noVNC deben seguir públicos con auth, o preferís túnel SSH manteniendo el puerto “abierto” pero inutilizable sin credencial?
5. ¿Ollama debe ser público o solo interno?
6. ¿Presupuesto de downtime? (FASE 3 puede hacerse app por app con minutos de corte)

---

## 9. Prompt de continuación (copiar/pegar en la siguiente sesión)

```
Contexto: VPS Nexo (root@187.124.45.250). Plan de seguridad documentado en:
docs/security/2026-07-31-vps-security-isolation-plan.md

Restricciones del owner:
- NO denegar/cerrar los puertos públicos de negocio actuales.
- SÍ proteger y aislar cada aplicación para que un hack de una no afecte a las demás.
- No romper Luna (Chrome/CDP/VNC) sin plan dedicado.

Estado auditado 2026-07-31:
- UFW inactive
- fail2ban sshd activo pero débil/sin bans
- Casi todo PM2/Chrome como root
- Apps Next ya en 127.0.0.1 detrás de Caddy (bien)
- Postgres compartido con un solo user amplio (mal para aislamiento)
- VNC/Ollama/dev ports en 0.0.0.0 (riesgo)

Objetivo de esta sesión:
Ejecutar FASE <N> del plan (empezar por FASE 0+1 si no se ha hecho).
Validar con health checks de: SSH, :3471, :3472, :3500/:3501, :3600, Luna chat.
Documentar cambios en .brain/status.md y este doc (checkboxes).

No banear IPs del owner (verificar SSH_CLIENT) ni 187.124.45.250.
No desactivar password SSH sin sesión paralela por clave verificada.
```

---

## 10. Resumen ejecutivo

| Prioridad | Acción | ¿Cierra puertos de negocio? | Reduce blast radius |
|-----------|--------|------------------------------|---------------------|
| P0 | UFW allowlist = puertos actuales | No | Bajo (evita extras) |
| P0 | Fail2ban + bans selectivos | No | Bajo–medio (SSH) |
| P0 | Secrets distintos + rotación tokens expuestos | No | Medio |
| P1 | Usuario Linux + systemd/PM2 por app | No | **Alto** |
| P1 | Roles Postgres por app (+ RLS) | No | **Alto** |
| P1 | Rate-limit + logs Caddy por app | No | Medio |
| P2 | SSH solo clave | No | Medio |
| P2 | Luna/Chrome/VNC isolation | No* | Alto |
| P3 | AIDE/auditd/logwatch | No | Detección |

\* Puede requerir rebind a localhost de backends crudos sin quitar el puerto Caddy público.

**Conclusión:** con la restricción de no cerrar puertos, la inversión correcta es **aislamiento por identidad (OS user + DB role + secrets + Caddy rate-limit)**, no solo firewall. El firewall sigue siendo útil como allowlist y logging, no como “esconder” las apps.
