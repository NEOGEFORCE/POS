# ── Stage 1: Install dependencies ───────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# ── Stage 2: Build ──────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The API URL at build time must point to the Docker-internal backend
# At runtime, the Next.js rewrite in next.config.ts will proxy /api/* to the backend
ARG BACKEND_URL=http://backend:3000
ENV BACKEND_URL=${BACKEND_URL}
ENV NEXT_PUBLIC_API_URL=/api

RUN npm run build

# ── Stage 3: Runtime ────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create a non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy only the necessary build output
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
