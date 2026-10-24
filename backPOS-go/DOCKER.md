# Despliegue Docker — POS Surtifamiliar (backend)

Este repo (`pos-backend`, contenido de `backPOS-go/`) contiene su propio `Dockerfile`
y el `docker-compose.yml` del sistema completo. El frontend vive en un repo
hermano (`pos-frontend`, contenido de `FrontPOS-main/`); el compose lo
referencia con una ruta relativa.

> ⚠️ **Importante.** Esta imagen levanta API + PostgreSQL. **No aplica migraciones
> automáticamente**: el servicio `migrate` corre bajo el perfil `tools` y hay que
> invocarlo explícitamente dentro de una ventana controlada con respaldo previo.
> El binario `server.exe` existente en producción (en `\\DESKTOP-VK2U90S\...`) NO
> se toca desde aquí.

---

## 1. Requisitos

- Docker 29.x y `docker compose` v5+ en el host destino.
- Red interna del servidor con acceso saliente HTTPS (Anthropic, Telegram, SMTP).
- Clonar los dos repos lado a lado:

```text
/opt/pos/
├── pos-backend/     # este repo (contiene docker-compose.yml, Dockerfile, .env.example)
└── pos-frontend/    # repo hermano con su propio Dockerfile
```

Si prefieres otra ruta para el frontend, exporta `FRONTEND_CONTEXT` en el `.env`.

---

## 2. Primer arranque

```bash
cd /opt/pos/pos-backend
cp .env.example .env
# Editar .env: definir DB_PASSWORD/POSTGRES_PASSWORD, SECRET_KEY, tokens Telegram, etc.

docker compose up -d --build
```

El primer `up` ejecuta este orden:

1. `db` arranca y espera `pg_isready`.
2. `backend` arranca contra `db`. **Si el esquema está vacío o hay migraciones
   pendientes, el API aborta** con el mensaje `Database schema is not ready`.
   Esto es intencional: la aplicación nunca mutará el esquema por su cuenta.
3. `frontend` arranca cuando `backend` reporta healthy en `/api/health`.

Para dejar la base lista en una instalación nueva, ver §4.

Para verificar que todo está arriba:

```bash
docker compose ps
docker compose exec backend curl -fsS http://127.0.0.1:3000/api/health
```

---

## 3. Variables de entorno

Todas las variables leídas por el código están documentadas por grupos en
`.env.example`. Las obligatorias para arrancar son:

| Variable            | Uso                                          |
|---------------------|----------------------------------------------|
| `DB_PASSWORD`       | Backend → PostgreSQL                         |
| `POSTGRES_PASSWORD` | Contenedor `db`. **Debe igualar `DB_PASSWORD`** |
| `SECRET_KEY`        | Firma JWT (`openssl rand -hex 32`)           |

Secretos sensibles (Telegram, Anthropic, Bold) pueden quedar vacíos; los
módulos afectados devuelven errores controlados pero no bloquean el arranque.

> `.env` nunca debe commitearse ni copiarse entre entornos. Mantén un archivo
> por servidor y respáldalo fuera del repo.

---

## 4. Migraciones

El esquema vive en `migrations/sql/` embebido en el binario (`//go:embed`). El
runner tiene dos comandos:

```bash
# Lectura — seguro en cualquier momento.
docker compose run --rm migrate /app/migrate status

# Mutación — requiere confirmación explícita.
docker compose run --rm migrate /app/migrate up --confirm
# Opcional: --timeout=30m para scripts largos.
```

### Ventana recomendada

1. **Respaldo** verificable de la base (ver §5).
2. `docker compose stop backend` para evitar escrituras concurrentes.
3. `docker compose run --rm migrate /app/migrate status` → ver pendientes.
4. `docker compose run --rm migrate /app/migrate up --confirm`.
5. `docker compose run --rm migrate /app/migrate status` → confirmar APLICADA en todas.
6. `docker compose start backend` y verificar `/api/health`.

> Nunca editar un archivo SQL ya aplicado: el checksum en `schema_migrations`
> hará abortar el arranque. Si hay error, crear una migración consecutiva.

---

## 5. Respaldo y restauración de PostgreSQL

El contenedor `db` publica el usuario `${POSTGRES_USER}` sobre la base
`${POSTGRES_DB}`. `pg_dump 16` también está instalado dentro del contenedor
`backend` para que el endpoint admin de respaldo manual (`/api/admin/backup`)
funcione sin configurar `PG_DUMP_PATH`.

### Respaldo (recomendado)

```bash
# Dump en formato custom (restaurable con pg_restore)
docker compose exec -T db \
  pg_dump -U "${POSTGRES_USER:-pos}" -d "${POSTGRES_DB:-sistemapos}" -Fc \
  > "respaldo_$(date +%Y%m%d_%H%M%S).dump"
```

Verifica el archivo antes de considerarlo válido:

```bash
docker compose exec -T db pg_restore --list < respaldo_*.dump | head
```

### Restauración

```bash
# 1. Detener backend para evitar escrituras concurrentes.
docker compose stop backend

# 2. Volcar el dump.
docker compose exec -T db \
  pg_restore -U "${POSTGRES_USER:-pos}" -d "${POSTGRES_DB:-sistemapos}" \
  --clean --if-exists --no-owner --no-acl \
  < respaldo_YYYYmmdd_HHMMSS.dump

# 3. Reinicia el API.
docker compose start backend
```

### Importar el respaldo actual de producción

Si tienes un dump reciente del PC de la tienda (p.ej. generado por
`respaldar_base_datos.ps1`), colócalo junto al compose y hazlo visible al
contenedor:

```bash
# Opción A — pipe directo (archivo .dump en formato custom)
docker compose exec -T db \
  pg_restore -U "${POSTGRES_USER:-pos}" -d "${POSTGRES_DB:-sistemapos}" \
  --clean --if-exists --no-owner --no-acl \
  < produccion_YYYYmmdd.dump

# Opción B — montar el directorio y correr dentro del contenedor
docker compose cp produccion_YYYYmmdd.dump db:/tmp/dump.custom
docker compose exec db \
  pg_restore -U "${POSTGRES_USER:-pos}" -d "${POSTGRES_DB:-sistemapos}" \
  --clean --if-exists --no-owner --no-acl /tmp/dump.custom
docker compose exec db rm -f /tmp/dump.custom
```

Tras restaurar, correr `migrate status` y aplicar las pendientes como en §4.

---

## 6. scale-bridge (impresora, balanza y cajón de dinero)

El `scale-bridge` sigue viviendo en el PC de caja **fuera de Docker**: expone
WebSockets locales para hablar con la balanza serial, la impresora térmica y
el cajón USB. El backend del POS no lo necesita.

En el frontend se debe compilar con dos variables apuntando a ese bridge
local:

```text
NEXT_PUBLIC_SCALE_WS_URL=ws://localhost:9876
NEXT_PUBLIC_POS_BRIDGE_WS_URL=ws://localhost:9876
```

Si el PC de caja NO es el mismo host que corre Docker, usar la IP LAN del PC
de caja en lugar de `localhost`. Esto se configura durante el build del
frontend (ver su propio README).

---

## 7. Operación diaria

```bash
# Ver estado y logs
docker compose ps
docker compose logs -f backend
docker compose logs -f db

# Reiniciar sólo el API después de un deploy
docker compose up -d --build backend

# Reiniciar sólo el frontend tras un cambio del repo pos-frontend
docker compose up -d --build frontend

# Entrar al contenedor backend
docker compose exec backend sh
```

---

## 8. Red y exposición

- `db` **no publica puertos al host**: solo se accede desde dentro de la red
  interna `pos-net`. Para operar la base externamente, usar un túnel SSH.
- `backend` **no publica puertos** por defecto. El frontend lo alcanza por el
  nombre de servicio `backend:3000`. Si necesitas pegarle directo, descomenta
  el bloque `ports:` del compose.
- `frontend` publica `${HTTP_PORT:-80}` al host. Nginx del frontend hace
  `proxy_pass /api/ → http://backend:3000/api/`.

### HTTPS en producción

Si el servicio sale a internet, poner un reverse proxy TLS delante
(**Caddy**, **Traefik** o Nginx con certbot) terminando en 443 y haciendo
proxy al puerto HTTP del frontend. Nunca publicar el puerto de la base.
Mantener `BOLD_BRIDGE_TOKEN`, `SECRET_KEY` y `ANTHROPIC_API_KEY` fuera de
logs y de capturas.

---

## 9. Volúmenes persistentes

| Volumen                  | Monta en                | Qué guarda                                 |
|--------------------------|-------------------------|---------------------------------------------|
| `pos_pgdata`             | `db:/var/lib/postgresql/data` | Datos PostgreSQL                        |
| `pos_backend_reportsd`   | `backend:/app/reportsd` | PDF generados manualmente                   |
| `pos_backend_backups`    | `backend:/app/backups`  | Carpeta libre para backups desde el host    |
| `pos_backend_logs`       | `backend:/app/logs`     | Logs opcionales redirigidos por el operador |

Nunca borrar `pos_pgdata` sin un respaldo verificado. `docker compose down -v`
borra TODOS los volúmenes nombrados — reservarlo exclusivamente para entornos
de prueba.

---

## 10. Problemas conocidos

- **El API aborta con `Database schema is not ready`.** Hay migraciones
  pendientes. Correr `docker compose run --rm migrate /app/migrate status` y
  aplicarlas tras respaldo.
- **El respaldo manual del admin falla con "pg_dump no encontrado".** El
  binario viene empaquetado en `/usr/bin/pg_dump` dentro del contenedor; no
  debería faltar. Si cambiaron la imagen, asegurarse de que la línea
  `postgresql-client-16` siga en el Dockerfile.
- **`frontend` no arranca con `no such service: backend` o similar.** El
  frontend depende del healthcheck de `backend`. Verificar que `/api/health`
  responde 200 desde dentro del contenedor:
  `docker compose exec backend curl -fsS http://127.0.0.1:3000/api/health`.
