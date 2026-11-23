// src/server/app.ts
// Fabrique d'application Hono injectable et 100 % testable sur SQLite :memory:.

import { Hono } from 'hono';
import type { DatabaseAdapter } from './db/database.adapter';
import type { ServerConfig } from './config';
import { createResendConnector, type MailSender } from './connectors/resend.connector';
import { createBibliographicConnectors, type BibliographicConnectors } from './connectors';
import { createGeminiConnector, type GeminiConnector } from './connectors/gemini.connector';
import { createWebPushConnector, type WebPushSender } from './connectors/webpush.connector';
import { UserRepository } from './repositories/user.repo';
import { LibraryRepository } from './repositories/library.repo';
import { CatalogRepository } from './repositories/catalog.repo';
import { JobRepository } from './repositories/job.repo';
import { LogRepository } from './repositories/log.repo';
import { LoanRepository } from './repositories/loan.repo';
import { ReadingRepository } from './repositories/reading.repo';
import { NotificationRepository } from './repositories/notification.repo';
import { SocialRepository } from './repositories/social.repo';
import { AuthService } from './services/auth.service';
import { CoverService } from './services/cover.service';
import { CollectionGuardService } from './services/acquisition/collection-guard.service';
import { ComparisonTableService } from './services/acquisition/comparison-table.service';
import { SeriesGraphService } from './services/acquisition/series-graph.service';
import { IngestionService } from './services/acquisition/ingestion.service';
import { LoanService } from './services/loan.service';
import { LibraryService } from './services/library.service';
import { SyncService } from './services/sync.service';
import { ReadingService } from './services/reading.service';
import { PhotoAiService } from './services/photo-ai.service';
import { SearchService } from './services/search.service';
import { SeriesManagementService } from './services/series-management.service';
import { NotificationService } from './services/notification.service';
import { SocialService } from './services/social.service';
import { StatsExportService } from './services/stats-export.service';
import { AdminService } from './services/admin.service';
import { BackgroundWorker } from './workers/background-worker';
import { CronScheduler } from './workers/cron-scheduler';
import { createApiRouter } from './routes';
import { handleServerError } from './middleware/error.middleware';

export interface CreateAppOptions {
  db: DatabaseAdapter;
  config: ServerConfig;
  mailSender?: MailSender;
  webPushSender?: WebPushSender;
  connectors?: BibliographicConnectors;
  geminiConnector?: GeminiConnector;
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
  const notifRepo = new NotificationRepository(options.db);
  const socialRepo = new SocialRepository(options.db);

  // Connecteurs isolés
  const mailSender =
    options.mailSender ?? createResendConnector(options.config.resendApiKey, options.config.mailFrom);
  const webPushSender =
    options.webPushSender ??
    createWebPushConnector({
      vapidPublicKey: options.config.vapidPublicKey,
      vapidPrivateJwk: options.config.vapidPrivateJwk,
      vapidSubject: options.config.vapidSubject
    });
  const connectors = options.connectors ?? createBibliographicConnectors({ jobRepo });
  const gemini = options.geminiConnector ?? createGeminiConnector(options.config.geminiApiKey);

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
  const readingService = new ReadingService({ readingRepo });
  const libraryService = new LibraryService({
    db: options.db,
    catalogRepo,
    libraryRepo,
    loanRepo,
    readingRepo,
    jobRepo,
    ingestionService,
    comparisonService,
    seriesGraphService,
    coverService,
    loanService,
    onJobEnqueued: () => worker.nudge()
  });
  const syncService = new SyncService({
    catalogRepo,
    libraryRepo,
    loanRepo,
    readingRepo,
    ingestionService,
    libraryService
  });

  const photoAiService = new PhotoAiService({
    config: options.config,
    gemini,
    connectors,
    userRepo,
    catalogRepo,
    libraryRepo,
    jobRepo,
    coverService,
    ingestionService,
    libraryService,
    onJobChanged: (row) => worker.notifyJobRow(row)
  });

  const searchService = new SearchService({
    catalogRepo,
    libraryRepo,
    connectors,
    ingestionService
  });

  const seriesManagementService = new SeriesManagementService({
    db: options.db,
    catalogRepo,
    libraryRepo,
    loanRepo,
    readingRepo,
    ingestionService,
    seriesGraphService
  });

  const notificationService = new NotificationService({
    config: options.config,
    notifRepo,
    catalogRepo,
    libraryRepo,
    ingestionService,
    seriesGraphService,
    mailSender,
    webPushSender
  });

  const cronScheduler = new CronScheduler({
    config: options.config,
    jobRepo,
    logRepo,
    notifRepo,
    notificationService,
    coverService
  });

  const socialService = new SocialService({
    db: options.db,
    socialRepo,
    libraryRepo,
    catalogRepo,
    loanRepo,
    ingestionService
  });

  const statsExportService = new StatsExportService({ libraryService });

  const adminService = new AdminService({
    db: options.db,
    catalogRepo,
    userRepo,
    logRepo,
    coverService,
    cronScheduler
  });

  // Enregistrement des handlers du worker continu
  worker.registerHandler('photo_ocr', async (ctx) => {
    return photoAiService.executePhotoOcrJob(ctx);
  });
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
    readingService,
    photoAiService,
    searchService,
    seriesManagementService,
    notificationService,
    socialService,
    statsExportService,
    adminService,
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
    repos: { userRepo, libraryRepo, catalogRepo, jobRepo, logRepo, loanRepo, readingRepo, notifRepo, socialRepo },
    services: {
      authService,
      coverService,
      collectionGuard,
      comparisonService,
      seriesGraphService,
      ingestionService,
      loanService,
      libraryService,
      syncService,
      readingService,
      photoAiService,
      searchService,
      seriesManagementService,
      notificationService,
      socialService,
      statsExportService,
      adminService
    },
    worker,
    cronScheduler
  };
}
