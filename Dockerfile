# Stage 1 : Build du front-end PWA (Vite) + compilation des modules natifs (better-sqlite3) sur Debian Bookworm
FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

# Stage 2 : Image runtime Debian légère (sans outils de compilation)
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    STATIC_DIR=/app/dist \
    MIGRATIONS_DIR=/app/migrations \
    CRON_ENABLED=true \
    CRON_INTERVAL_MINUTES=60

RUN mkdir -p /data/covers

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/server ./server
COPY --from=builder /app/src/core ./src/core
COPY --from=builder /app/src/state ./src/state

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npx", "tsx", "server/index.ts"]
