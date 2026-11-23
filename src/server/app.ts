// src/server/app.ts
// Fabrique d'application Hono injectable et 100 % testable sur SQLite :memory:.

import { Hono } from 'hono';
import type { DatabaseAdapter } from './db/database.adapter';
import type { ServerConfig } from './config';
import { createResendConnector, type MailSender } from './connectors/resend.connector';
import { createBibliographicConnectors, type BibliographicConnectors } from './connectors';
import { UserRepository } from './repositories/user.repo';
import { LibraryRepository } from './repositories/library.repo';
import { CatalogRepository } from './repositories/catalog.repo';
import { JobRepository } from './repositories/job.repo';
import { LogRepository } from './repositories/log.repo';
import { LoanRepository } from './repositories/loan.repo';
import { ReadingRepository } from './repositories/reading.repo';
import { AuthService } from './services/auth.service';
import { CoverService } from './services/cover.service';
import { CollectionGuardService } from './services/acquisition/collection-guard.service';
import { ComparisonTableService } from './services/acquisition/comparison-table.service';
import { SeriesGraphService } from './services/acquisition/series-graph.service';
import { IngestionService } from './services/acquisition/ingestion.service';
import { LoanService } from './services/loan.service';
import { LibraryService } from './services/library.service';
import { SyncService } from './services/sync.service';
import { BackgroundWorker } from './workers/background-worker';
import { createApiRouter } from './routes';
import { handleServerError } from './middleware/error.middleware';

export interface CreateAppOptions {
  db: DatabaseAdapter;
  config: ServerConfig;
  mailSender?: MailSender;
  connectors?: BibliographicConnectors;
  coverFetchImpl?: typeof fetch;
}

export function createApp(options: CreateAppOptions) {
  const startedAt = Date.now();
  const app = new Hono();

  app.onError(handleServerError);

  // En-têtes de sécurité & Permissions Caméra PWA
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    if (c.req.header('x-forwarded-proto') === 'https' || options.config.nodeEnv === 'production') {
      c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  });

  // Repositories SQL standard
  const userRepo = new UserRepository(options.db);
  const libraryRepo = new LibraryRepository(options.db);
  const catalogRepo = new CatalogRepository(options.db);
  const jobRepo = new JobRepository(options.db);
  const logRepo = new LogRepository(options.db);
  const loanRepo = new LoanRepository(options.db);
  const readingRepo = new ReadingRepository(options.db);

  // Connecteurs isolés
  const mailSender =
    options.mailSender ?? createResendConnector(options.config.resendApiKey, options.config.mailFrom);
  const connectors = options.connectors ?? createBibliographicConnectors({ jobRepo });

  // Services métier
  const authService = new AuthService({
    db: options.db,
    userRepo,
    libraryRepo,
    config: options.config,
    mailSender
  });

  const coverService = new CoverService({
    coversDir: options.config.coversDir,
    catalogRepo,
    libraryRepo,
    fetchImpl: options.coverFetchImpl
  });

  const collectionGuard = new CollectionGuardService({ bnf: connectors.bnf });
  const comparisonService = new ComparisonTableService({ connectors, collectionGuard });
  const seriesGraphService = new SeriesGraphService({ catalogRepo, connectors, coverService });

  const worker = new BackgroundWorker({ jobRepo, logRepo });

  const ingestionService = new IngestionService({
    catalogRepo,
    libraryRepo,
    jobRepo,
    logRepo,
    comparisonService,
    seriesGraphService,
    coverService,
    onJobEnqueued: () => worker.nudge()
  });

  const loanService = new LoanService({ loanRepo, libraryRepo });
  const libraryService = new LibraryService({
    db: options.db,
    catalogRepo,
    libraryRepo,
    loanRepo,
    readingRepo,
    ingestionService,
    loanService
  });
  const syncService = new SyncService({
    libraryRepo,
    loanRepo,
    readingRepo,
    ingestionService,
    libraryService
  });

  // Enregistrement des handlers du worker continu
  worker.registerHandler('series_expand', async ({ payload, reportProgress }) => {
    const seriesId = typeof payload.seriesId === 'string' ? payload.seriesId : '';
    if (!seriesId) {
      return { result: { addedCount: 0, totalVolumes: 0 }, total: 1 };
    }
    reportProgress(0, 1);
    const report = await seriesGraphService.expandSeriesByGraph(seriesId);
    return { result: report, total: 1 };
  });

  worker.registerHandler('book_enrich', async ({ payload }) => {
    const isbn13 = typeof payload.isbn13 === 'string' ? payload.isbn13 : '';
    const userId = typeof payload.userId === 'string' ? payload.userId : '';
    const libraryId = typeof payload.libraryId === 'string' ? payload.libraryId : '';
    if (!isbn13) {
      return { result: { enriched: false }, total: 1 };
    }
    const res = await ingestionService.resolveIsbns({
      rawIsbns: [isbn13],
      channel: 'manual_isbn',
      action: 'preview',
      userId,
      libraryId,
      forceRefresh: true
    });
    return { result: res, total: 1 };
  });

  const api = createApiRouter({
    config: options.config,
    authService,
    coverService,
    ingestionService,
    syncService,
    libraryService,
    loanService,
    jobRepo,
    worker,
    startedAt
  });

  app.route('/api', api);

  // Alias santé racine pour Docker healthcheck
  app.get('/health', (c) =>
    c.json({
      ok: true,
      version: '2.0.0',
      mode: 'self-hosted-sqlite',
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000)
    })
  );

  return {
    app,
    repos: { userRepo, libraryRepo, catalogRepo, jobRepo, logRepo, loanRepo, readingRepo },
    services: {
      authService,
      coverService,
      collectionGuard,
      comparisonService,
      seriesGraphService,
      ingestionService,
      loanService,
      libraryService,
      syncService
    },
    worker
  };
}
