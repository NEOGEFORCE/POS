# Docker — pos-frontend

Imagen nginx:alpine que sirve el export estático de Next.js 15 (`output: 'export'`)
y hace proxy inverso de `/api/*` al backend. Diseñada para orquestarse desde el
`docker-compose.yml` del repo `pos-backend` (ambos repos clonados lado a lado
en el servidor, carpetas hermanas).

## Build standalone

Desde la raíz de `pos-frontend` (esta carpeta):

```bash
docker build \
  --build-arg NEXT_PUBLIC_API_URL=/api \
  --build-arg NEXT_PUBLIC_SCALE_WS_URL=ws://localhost:9876 \
  --build-arg NEXT_PUBLIC_POS_BRIDGE_WS_URL=ws://localhost:9876 \
  --build-arg NEXT_PUBLIC_TELEGRAM_BOT_NAME=POSProBot \
  -t pos-frontend:local .
```

El `Dockerfile` corre `npx next build` (NO `npm run build`, cuyo `postbuild`
usa PowerShell y copia a `../backPOS-go/out` — eso explota fuera del equipo
de desarrollo del autor y ensucia un repo que no es el nuestro).

## Build args

| Variable                             | Default                 | Qué controla |
|--------------------------------------|-------------------------|--------------|
| `NEXT_PUBLIC_API_URL`                | `""` → cae a `/api`     | Prefijo del backend que usan los fetch. Dejarlo vacío lo deja relativo a nginx (recomendado). |
| `NEXT_PUBLIC_SCALE_WS_URL`           | `ws://localhost:9876`   | WebSocket de la balanza (bridge local en PC de caja). |
| `NEXT_PUBLIC_POS_BRIDGE_WS_URL`      | `ws://localhost:9876`   | WebSocket del bridge POS (impresora/cajón). Mismo host:puerto que la balanza. |
| `NEXT_PUBLIC_TELEGRAM_BOT_NAME`      | `POSProBot`             | Handle del bot que abre el dashboard. |

> El puente de balanza/impresora corre en el **PC de caja**, no en el servidor.
> Por eso los defaults son `localhost` — cada caja los resuelve contra su propio
> loopback.

## Variables de runtime

| Variable            | Default                 | Qué controla |
|---------------------|-------------------------|--------------|
| `BACKEND_UPSTREAM`  | `http://backend:3000`   | URL completa del backend al que nginx hace `proxy_pass` para `/api/`. |

El entrypoint oficial de nginx corre `envsubst` sobre
`docker/default.conf.template` y resuelve `${BACKEND_UPSTREAM}` a build-time
del contenedor. nginx la resuelve una sola vez al arrancar — si el backend
cambia de IP, hay que recrear el contenedor.

## Run standalone (sin compose)

```bash
docker run --rm -d \
  -p 80:80 \
  -e BACKEND_UPSTREAM=http://host.docker.internal:3000 \
  --name pos-frontend \
  pos-frontend:local
```

Comprobaciones rápidas:

```bash
curl -I http://localhost/           # 200 (index.html del shell)
curl -I http://localhost/sales/new  # 200 (sales/new.html del export)
curl -I http://localhost/healthz    # 200 "ok"
```

## Orquestado desde pos-backend

El `docker-compose.yml` del repo backend (en la carpeta hermana `pos-backend/`)
declara el servicio `frontend` así:

```yaml
services:
  backend:
    build: .
    # ...

  frontend:
    build:
      context: ../pos-frontend
      args:
        NEXT_PUBLIC_API_URL: /api
        NEXT_PUBLIC_SCALE_WS_URL: ws://localhost:9876
        NEXT_PUBLIC_POS_BRIDGE_WS_URL: ws://localhost:9876
        NEXT_PUBLIC_TELEGRAM_BOT_NAME: POSProBot
    environment:
      BACKEND_UPSTREAM: http://backend:3000
    ports:
      - "80:80"
    depends_on:
      - backend
```

El `BACKEND_UPSTREAM=http://backend:3000` hace que nginx resuelva el nombre
de servicio `backend` por el DNS interno de Docker: no hace falta IP fija.

## Apuntar a otro backend

Si el backend corre en otro host (ej. una VM externa), ajusta la variable:

```bash
docker run --rm -d \
  -p 80:80 \
  -e BACKEND_UPSTREAM=http://10.0.5.12:3000 \
  pos-frontend:local
```

O desde compose:

```yaml
frontend:
  environment:
    BACKEND_UPSTREAM: https://api.pos.example.com
```

## Qué sirve nginx

- `/` y rutas limpias (`/sales/new`, `/inventory/orders`, …) → export estático
  resuelto con `try_files $uri $uri.html $uri/ /index.html`.
- `/_next/static/*` → cache inmutable 1 año.
- `*.png|jpg|svg|woff2|…` → cache 30 días.
- `/sw.js`, `/manifest.json`, `index.html` → sin cache (revalidación obligada).
- `/api/*` → proxy a `${BACKEND_UPSTREAM}` con buffering apagado para los
  canales SSE (`/api/pos/pagos-qr/stream`, `/api/pos/pagos-qr/caja-stream`,
  dashboard events del `GlobalSyncProvider`), `read_timeout 1h` y
  `client_max_body_size 25m` para el OCR de facturas (el backend corta a 14 MB).
- `/healthz` → 200 "ok" para healthchecks externos (el HEALTHCHECK del Dockerfile
  pide `/` directamente para no depender de rutas custom).

## Notas de dominio

- El `.env.local` y `.env.production` de desarrollo **no** se copian al
  contexto (están en `.dockerignore`). Todo lo configurable pasa por
  build args o env de runtime.
- El fallback de `src/lib/constants.ts` que apunta a `http://<hostname>:3000/api`
  **sólo** se activa cuando `window.location.port === '9002'` (dev server de
  Next). En Docker el frontend corre en `:80`, nunca cae a esa rama.
- La CSP se dejó deliberadamente laxa para no romper WS a `localhost:9876`,
  blob/data URIs de QR, apertura de Telegram en nueva pestaña, ni el
  renderizado de PDFs con jspdf. Si en el futuro se endurece: `connect-src 'self' ws://localhost:9876 ws: wss:`
  mínimo, y permitir `img-src 'self' data: blob:`.
