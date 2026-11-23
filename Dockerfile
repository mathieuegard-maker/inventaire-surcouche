# Stage 1 : Build du front-end PWA (Vite) + compilation des modules natifs (better-sqlite3, sharp) sur Debian Bookworm
FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev && npm install --no-save tsx

# Stage 2 : Image runtime Debian légère V2 (sans outils de compilation)
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    STATIC_DIR=/app/dist \
    MIGRATIONS_DIR=/app/migrations \
    CRON_ENABLED=true \
    CRON_NIGHTLY_HOUR=2

RUN mkdir -p /data/covers

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/src/server ./src/server
COPY --from=builder /app/src/shared ./src/shared

RUN chown -R node:node /app /data

EXPOSE 3000
VOLUME ["/data"]

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["./node_modules/.bin/tsx", "src/server/index.ts"]
