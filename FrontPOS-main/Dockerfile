# syntax=docker/dockerfile:1.7
# =============================================================================
# pos-frontend — Dockerfile multi-stage
# =============================================================================
# El frontend es Next.js 15 con `output: 'export'` → el build produce un árbol
# estático en /app/out. En producción nginx:alpine sirve ese árbol y hace
# proxy_pass para /api/ al backend definido por BACKEND_UPSTREAM.
#
# Build:
#   docker build \
#     --build-arg NEXT_PUBLIC_API_URL=/api \
#     --build-arg NEXT_PUBLIC_SCALE_WS_URL=ws://localhost:9876 \
#     --build-arg NEXT_PUBLIC_POS_BRIDGE_WS_URL=ws://localhost:9876 \
#     --build-arg NEXT_PUBLIC_TELEGRAM_BOT_NAME=POSProBot \
#     -t pos-frontend:local .
#
# Run:
#   docker run --rm -p 8080:80 -e BACKEND_UPSTREAM=http://host.docker.internal:3000 pos-frontend:local
#
# El puente de balanza/impresora (ws://localhost:9876) corre en el PC de caja,
# NO en el servidor. Esos valores se dejan como ws://localhost:9876 para que
# cada caja los resuelva contra su propio host.
# =============================================================================

# -----------------------------------------------------------------------------
# Etapa 1 — Dependencias (cache fino para npm ci)
# -----------------------------------------------------------------------------
# Node 20 LTS: @types/node ^20 y eslint-config-next 15.5.24 (requiere >=18.18).
# Alpine mantiene la imagen chica y es suficiente para next build en export.
FROM node:20-alpine AS deps
WORKDIR /app

# libc6-compat: algunos paquetes nativos (p.ej. puppeteer en devDeps aunque no
# los usamos en build) resuelven mejor en Alpine con este shim.
RUN apk add --no-cache libc6-compat

# Copiamos sólo los manifests para aprovechar el cache de capa cuando el
# código cambia pero las deps no.
COPY package.json package-lock.json ./

# `npm ci` respeta la versión exacta del lockfile y falla si están
# desincronizados. --no-audit / --no-fund reducen ruido.
RUN npm ci --no-audit --no-fund

# -----------------------------------------------------------------------------
# Etapa 2 — Build estático
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Build args — todas las NEXT_PUBLIC_* se inlinean en el bundle en build time.
# Si no se pasan, caen a defaults seguros: '/api' relativo (nginx hará el
# proxy) y ws://localhost:9876 para los bridges locales de hardware.
ARG NEXT_PUBLIC_API_URL=""
ARG NEXT_PUBLIC_SCALE_WS_URL="ws://localhost:9876"
ARG NEXT_PUBLIC_POS_BRIDGE_WS_URL="ws://localhost:9876"
ARG NEXT_PUBLIC_TELEGRAM_BOT_NAME="POSProBot"

# Exponemos como env para que Next las lea durante `next build`.
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_SCALE_WS_URL=${NEXT_PUBLIC_SCALE_WS_URL} \
    NEXT_PUBLIC_POS_BRIDGE_WS_URL=${NEXT_PUBLIC_POS_BRIDGE_WS_URL} \
    NEXT_PUBLIC_TELEGRAM_BOT_NAME=${NEXT_PUBLIC_TELEGRAM_BOT_NAME} \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# IMPORTANTE: usamos `npx next build`, NO `npm run build`.
# `npm run build` dispara su hook `postbuild` que copia out/ hacia
# ../backPOS-go/out con PowerShell — eso explota fuera de Windows y
# ensucia un repo que no es el nuestro. `next build` con output:'export'
# ya deja todo en /app/out.
RUN npx --no-install next build

# -----------------------------------------------------------------------------
# Etapa 3 — Runtime nginx
# -----------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# Usuario `nginx` ya existe en la imagen oficial (uid 101). Vamos a hacer que
# el worker corra como ese usuario; el master sigue siendo root dentro del
# contenedor porque sólo así nginx puede bind-ear a :80. En orquestador real
# se puede añadir `--user` + puerto 8080 si hay un ingress que termina 80.

# Config fija (server block con proxy a backend + headers)
COPY nginx.conf /etc/nginx/nginx.conf
COPY docker/default.conf.template /etc/nginx/templates/default.conf.template

# Artefactos estáticos del export
COPY --from=builder /app/out /usr/share/nginx/html

# Permisos: la imagen oficial espera que /var/cache/nginx y /var/run sean
# escribibles por el worker. Los defaults ya cubren eso; no tocamos nada
# especial salvo asegurar que el html es legible.
RUN chmod -R a+r /usr/share/nginx/html

# Puerto expuesto
EXPOSE 80

# Healthcheck: pedimos la raíz y esperamos 200. Si nginx no responde el
# orquestador puede recrearlo.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

# La imagen oficial de nginx ya trae un entrypoint que corre envsubst sobre
# todo lo que esté en /etc/nginx/templates/ y lo deposita en /etc/nginx/conf.d.
# De ahí leemos ${BACKEND_UPSTREAM} con default `http://backend:3000`.
ENV BACKEND_UPSTREAM="http://backend:3000"

CMD ["nginx", "-g", "daemon off;"]
