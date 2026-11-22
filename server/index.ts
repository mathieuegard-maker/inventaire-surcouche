// server/index.ts
// Point d'entrée autonome Node.js + Hono pour auto-hébergement Debian / Docker (zéro dépendance Cloudflare).

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type { AppBackendEnv } from '../src/core/adapters/storage-db.interface';
import { handleGatewayRequest } from '../src/core/services/gateway-router.service';
import { handleV2ApiRequest } from '../src/core/services/v2-backend-router.service';
import { FsCoverBucketAdapter } from './adapters/fs-cover-bucket.adapter';
import { SqliteDatabaseAdapter } from './adapters/sqlite-db.adapter';
import { startSelfHostedScheduler } from './scheduler';
import { resumePendingPhotoScanJobs } from '../src/core/services/photo-scan-jobs.service';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const DB_PATH = path.resolve(process.env.SQLITE_DB_PATH || path.join(DATA_DIR, 'biblio.sqlite'));
const COVERS_DIR = path.resolve(process.env.COVERS_DIR || path.join(DATA_DIR, 'covers'));
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || './dist');
const MIGRATIONS_DIR = path.resolve(process.env.MIGRATIONS_DIR || './migrations');
const CRON_ENABLED = process.env.CRON_ENABLED !== 'false';
const CRON_INTERVAL_MINUTES = Number(process.env.CRON_INTERVAL_MINUTES || 60);

const dbAdapter = new SqliteDatabaseAdapter(DB_PATH);
const migrationReport = dbAdapter.applyMigrations(MIGRATIONS_DIR);
console.log(
  `[SERVER] SQLite prêt (${DB_PATH}) — migrations appliquées: ${migrationReport.applied.length}, déjà présentes: ${migrationReport.skipped}`
);

const coversBucket = new FsCoverBucketAdapter(COVERS_DIR);

const backendEnv: AppBackendEnv = {
  DB: dbAdapter,
  COVERS_BUCKET: coversBucket,
  JWT_SECRET: process.env.JWT_SECRET,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  MAIL_FROM: process.env.MAIL_FROM,
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_JWK: process.env.VAPID_PRIVATE_JWK,
  VAPID_SUBJECT: process.env.VAPID_SUBJECT,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY
};

const app = new Hono();
const startedAt = Date.now();

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  if (c.req.header('x-forwarded-proto') === 'https' || process.env.NODE_ENV === 'production') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
});

app.get('/health', (c) =>
  c.json({
    ok: true,
    mode: 'self-hosted-sqlite',
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000)
  })
);

app.all('/api/v2/*', async (c) => {
  return handleV2ApiRequest(c.req.raw, backendEnv);
});

app.all('/api/gateway', async (c) => {
  return handleGatewayRequest({
    request: c.req.raw,
    env: backendEnv,
    waitUntil: (promise) => {
      void promise.catch((err) => {
        console.warn('[GATEWAY waitUntil] Erreur asynchrone :', err);
      });
    }
  });
});

// Service des fichiers statiques de la PWA (build Vite `dist/`)
const staticRootRel = path.relative(process.cwd(), STATIC_DIR) || '.';

app.use('/assets/*', async (c, next) => {
  await next();
  if (c.res.status === 200) {
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
  }
});

app.use('/', async (c, next) => {
  await next();
  if (c.res.status === 200) {
    c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
});

app.use('/index.html', async (c, next) => {
  await next();
  if (c.res.status === 200) {
    c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
});

app.use('/sw.js', async (c, next) => {
  await next();
  if (c.res.status === 200) {
    c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
});

app.use('/sw-push.js', async (c, next) => {
  await next();
  if (c.res.status === 200) {
    c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
});

app.use('/manifest.webmanifest', async (c, next) => {
  await next();
  if (c.res.status === 200) {
    c.header('Content-Type', 'application/manifest+json; charset=utf-8');
    c.header('Cache-Control', 'no-cache');
  }
});

app.use('/*', serveStatic({ root: staticRootRel }));

// Fallback SPA Vue Router pour toutes les routes HTML non-API
const indexHtmlPath = path.join(STATIC_DIR, 'index.html');
app.get('*', (c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'Route API introuvable' }, 404);
  }
  if (fs.existsSync(indexHtmlPath)) {
    const html = fs.readFileSync(indexHtmlPath, 'utf-8');
    c.header('Cache-Control', 'no-cache');
    return c.html(html);
  }
  return c.text('Frontend build (dist/index.html) introuvable. Exécutez npm run build.', 503);
});

const scheduler = CRON_ENABLED
  ? startSelfHostedScheduler(backendEnv, {
      intervalMinutes: CRON_INTERVAL_MINUTES,
      initialDelaySeconds: 90
    })
  : null;

void resumePendingPhotoScanJobs(dbAdapter, backendEnv)
  .then((count) => {
    if (count > 0) {
      console.log(`[SERVER] Reprise automatique de ${count} lot(s) Photo IA en cours.`);
    }
  })
  .catch(() => {});

const server = serve(
  {
    fetch: app.fetch,
    hostname: HOST,
    port: PORT
  },
  (info) => {
    console.log(`[SERVER] Biblio Collection PWA auto-hébergée en écoute sur http://${info.address}:${info.port}`);
  }
);

const shutdown = (signal: string) => {
  console.log(`[SERVER] Signal ${signal} reçu — arrêt propre...`);
  scheduler?.stop();
  server.close(() => {
    dbAdapter.close();
    console.log('[SERVER] Arrêt terminé.');
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
