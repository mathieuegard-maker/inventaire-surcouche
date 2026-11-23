// src/server/index.ts
// Point d'entrée serveur Node.js + Hono auto-hébergé (Debian / Docker).

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs';
import path from 'node:path';
import { loadServerConfig } from './config';
import { SqliteDatabaseAdapter } from './db/sqlite.adapter';
import { applySqlMigrations } from './db/migrator';
import { createApp } from './app';

const config = loadServerConfig();
fs.mkdirSync(config.coversDir, { recursive: true });

const db = new SqliteDatabaseAdapter(config.dbPath);
const migrationReport = applySqlMigrations(db, config.migrationsDir);
console.info(
  `[SERVER V2] SQLite prêt (${config.dbPath}) — migrations appliquées: ${migrationReport.applied.length}, déjà présentes: ${migrationReport.skipped}`
);

const { app, worker } = createApp({ db, config });
worker.start();

// En-têtes stricts PWA (ne jamais mettre /sw.js ou /sw-push.js en cache)
const staticRootRel = path.relative(process.cwd(), config.staticDir) || '.';

app.use('/assets/*', async (c, next) => {
  await next();
  if (c.res.status === 200) {
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
  }
});

for (const noCachePath of ['/', '/index.html', '/sw.js', '/sw-push.js']) {
  app.use(noCachePath, async (c, next) => {
    await next();
    if (c.res.status === 200) {
      c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  });
}

app.use('/manifest.webmanifest', async (c, next) => {
  await next();
  if (c.res.status === 200) {
    c.header('Content-Type', 'application/manifest+json; charset=utf-8');
    c.header('Cache-Control', 'no-cache');
  }
});

app.use('/*', serveStatic({ root: staticRootRel }));

const indexHtmlPath = path.join(config.staticDir, 'index.html');
app.get('*', (c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Route API introuvable.' } }, 404);
  }
  if (fs.existsSync(indexHtmlPath)) {
    const html = fs.readFileSync(indexHtmlPath, 'utf-8');
    c.header('Cache-Control', 'no-cache');
    return c.html(html);
  }
  return c.text('Frontend build (dist/index.html) introuvable. Exécutez npm run build.', 503);
});

const server = serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port
  },
  (info) => {
    console.info(`[SERVER V2] Biblio Collection V2 en écoute sur http://${info.address}:${info.port}`);
  }
);

const shutdown = () => {
  console.info('[SERVER V2] Arrêt gracieux...');
  worker.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
