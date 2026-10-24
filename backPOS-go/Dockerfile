# syntax=docker/dockerfile:1.7
# ============================================================================
# POS Surtifamiliar — Backend Go
# Imagen multi-stage: compila `cmd/api` y `cmd/migrate` con la misma versión
# de Go declarada en go.mod y produce un runtime liviano con pg_dump 16
# (misma versión mayor que la base PostgreSQL de producción) para que el
# respaldo manual del AdminHandler funcione dentro del contenedor.
# ============================================================================

# ----------------------------------------------------------------------------
# Stage 1 — builder
# ----------------------------------------------------------------------------
FROM golang:1.25-bookworm AS builder

WORKDIR /src

# Primero las dependencias para aprovechar la caché de capas.
COPY go.mod go.sum ./
RUN go mod download

# Luego todo el código fuente. El `.dockerignore` filtra basura.
COPY . .

# Las migraciones están embebidas (//go:embed sql/*.sql en migrations/catalog.go),
# así que NO hay que copiarlas aparte al runtime; viajan dentro del binario.
# CGO_ENABLED=0 produce binarios estáticos; -trimpath y -ldflags adelgazan.
RUN set -eux; \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
        go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/api; \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
        go build -trimpath -ldflags="-s -w" -o /out/migrate ./cmd/migrate

# ----------------------------------------------------------------------------
# Stage 2 — runtime
# ----------------------------------------------------------------------------
# Debian slim nos permite instalar postgresql-client-16 desde el repositorio
# oficial PGDG, de modo que `pg_dump` dentro del contenedor coincida con la
# versión mayor del servicio `db` (postgres:16-alpine).
FROM debian:bookworm-slim

ARG TARGETARCH=amd64

# Dependencias mínimas:
#   - ca-certificates: TLS hacia Anthropic, Telegram, SMTP.
#   - tzdata: zona horaria America/Bogota para cron y logs.
#   - curl: HEALTHCHECK HTTP a /api/health.
#   - gnupg/wget: instalar la llave y repo PGDG oficial.
#   - postgresql-client-16: pg_dump/pg_restore con misma mayor que db.
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        tzdata \
        curl \
        gnupg \
        wget; \
    install -d /usr/share/postgresql-common/pgdg; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-client-16; \
    apt-get purge -y --auto-remove gnupg wget; \
    rm -rf /var/lib/apt/lists/*

ENV TZ=America/Bogota \
    PATH="/app:${PATH}"

# Usuario sin privilegios.
RUN set -eux; \
    groupadd --system --gid 10001 pos; \
    useradd --system --uid 10001 --gid pos --home-dir /app --shell /usr/sbin/nologin pos

WORKDIR /app

# Binarios producidos en el builder.
COPY --from=builder --chown=pos:pos /out/server  /app/server
COPY --from=builder --chown=pos:pos /out/migrate /app/migrate

# Directorios de datos operativos escritos por el API:
#   - reportsd/   PDF de reportes manuales (notification_handler.go)
#   - backups/    respaldo manual pg_dump (admin_handler.go)
#   - logs/       logs opcionales redirigidos por el operador
# El contenedor NO sirve ./out: el frontend lo sirve otro contenedor.
RUN set -eux; \
    mkdir -p /app/reportsd /app/backups /app/logs; \
    chown -R pos:pos /app

USER pos:pos

EXPOSE 3000

# El healthcheck consulta la ruta pública introducida en el sprint anterior:
# /api/health devuelve 200 cuando la BD responde al Ping. No usar /health
# (ruta duplicada) ni / (podría caer en el fallback SPA y mentir).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS --max-time 4 http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["/app/server"]
