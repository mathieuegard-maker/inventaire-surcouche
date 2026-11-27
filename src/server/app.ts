// src/server/app.ts
// Fabrique d'application Hono injectable et 100 % testable sur SQLite :memory:.

import crypto from 'node:crypto';
import path from 'node:path';
import { Hono } from 'hono';
import { APP_VERSION } from '../shared/version';
import type { DatabaseAdapter } from './db/database.adapter';
import type { ServerConfig } from './config';
import { createResendConnector, type MailSender } from './connectors/resend.connector';
import {
  createBibliographicConnectors,
  PriorityRateLimiter,
  type BibliographicConnectors
} from './connectors';
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
import { AdminRepository } from './repositories/admin.repo';
import { AuthService } from './services/auth.service';
import { CoverService } from './services/cover.service';
import { CollectionGuardService } from './services/acquisition/collection-guard.service';
import { BookIdentifierService } from './services/acquisition/book-identifier.service';
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
import { SeriesCoverEditionService } from './services/series-cover-edition.service';
import { NotificationService } from './services/notification.service';
import { SocialService } from './services/social.service';
import { StatsExportService } from './services/stats-export.service';
import { CollectionImportService } from './services/collection-import.service';
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
  const adminRepo = new AdminRepository(options.db);

  // Ordonnanceur réseau prioritaire partagé (HIGH interactif > LOW tâches de fond)
  const rateLimiter = new PriorityRateLimiter({
    bypassTiming: options.config.nodeEnv === 'test' || Boolean(options.coverFetchImpl)
  });

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
  const connectors = options.connectors ?? createBibliographicConnectors({ jobRepo, rateLimiter });
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
    fetchImpl: options.coverFetchImpl,
    rateLimiter
  });

  const collectionGuard = new CollectionGuardService({ bnf: connectors.bnf });
  const bookIdentifier = new BookIdentifierService({ connectors });
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
    bookIdentifier,
    connectors,
    onJobEnqueued: () => worker.nudge(),
    onJobChanged: (row) => worker.notifyJobRow(row)
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
    connectors,
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
    bookIdentifier,
    onJobChanged: (row) => worker.notifyJobRow(row),
    onNotifyUser: async ({ userId, title, body, url }) => {
      await notificationService.sendDirectPushToUser(userId, { title, body, url });
    }
  });

  const searchService = new SearchService({
    catalogRepo,
    libraryRepo,
    connectors,
    ingestionService,
    bookIdentifier
  });

  const seriesManagementService = new SeriesManagementService({
    db: options.db,
    catalogRepo,
    libraryRepo,
    loanRepo,
    readingRepo,
    ingestionService,
    seriesGraphService,
    connectors,
    jobRepo,
    onJobEnqueued: () => worker.nudge(),
    onJobChanged: (row) => worker.notifyJobRow(row)
  });

  const seriesCoverEditionService = new SeriesCoverEditionService({
    db: options.db,
    catalogRepo,
    libraryRepo,
    jobRepo,
    coverService,
    ingestionService,
    bookIdentifier,
    connectors,
    onJobEnqueued: () => worker.nudge(),
    onJobChanged: (row) => worker.notifyJobRow(row)
  });

  const cronScheduler = new CronScheduler({
    config: options.config,
    jobRepo,
    logRepo,
    notifRepo,
    notificationService,
    coverService,
    catalogRepo,
    onJobEnqueued: () => worker.nudge()
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

  const collectionImportService = new CollectionImportService({
    jobRepo,
    ingestionService,
    photoAiService,
    libraryService,
    readingService,
    onJobEnqueued: () => worker.nudge(),
    onJobChanged: (row) => worker.notifyJobRow(row)
  });

  const adminService = new AdminService({
    db: options.db,
    adminRepo,
    catalogRepo,
    libraryRepo,
    readingRepo,
    userRepo,
    logRepo,
    coverService,
    cronScheduler,
    reportsDir: path.resolve(path.dirname(options.config.coversDir), 'benchmark-reports'),
    onCatalogReset: () => worker.cancelActiveJobs()
  });

  // Enregistrement des handlers du worker continu
  worker.registerHandler('photo_ocr', async (ctx) => {
    return photoAiService.executePhotoOcrJob(ctx);
  });
  worker.registerHandler('photo_commit', async (ctx) => {
    return photoAiService.executePhotoCommitJob(ctx);
  });
  worker.registerHandler('collection_import', async (ctx) => {
    return collectionImportService.executeCollectionImportJob(ctx);
  });
  worker.registerAfterComplete('collection_import', async (completedJob) => {
    await adminService.autoGradeWithPendingGroundTruth(completedJob.id);
  });
  // Purge légère au démarrage si external_cache dépasse le plafond
  jobRepo.pruneExternalCache(new Date().toISOString(), 6000);
  worker.registerHandler('series_expand', async ({ job, payload, reportProgress, isCancelled }) => {
    const seriesId = typeof payload.seriesId === 'string' ? payload.seriesId : '';
    if (!seriesId) {
      return { result: { addedCount: 0, totalVolumes: 0, incompleteVolumeCount: 0 }, total: 1 };
    }
    reportProgress(0, 1);
    const report = await seriesGraphService.expandSeriesByGraph(seriesId, { isCancelled });

    // Phases 3B + 3C en tâche de fond dédiée dès que la série comporte des tomes sans ISBN ou sans couverture
    if (!isCancelled() && report.incompleteVolumeCount > 0) {
      const existingEnrich = jobRepo.findActiveJobByTypeAndPayloadKey('series_enrich_volumes', seriesId);
      if (!existingEnrich) {
        const created = jobRepo.createJob({
          id: `job_${crypto.randomBytes(6).toString('hex')}`,
          type: 'series_enrich_volumes',
          userId: job.user_id,
          libraryId: job.library_id,
          payload: { seriesId },
          progressTotal: report.incompleteVolumeCount,
          now: new Date().toISOString()
        });
        worker.notifyJobRow(created);
        worker.nudge();
      }
    }

    return { result: report, total: 1 };
  });

  worker.registerHandler('series_enrich_volumes', async ({ job, payload, reportProgress, isCancelled }) => {
    const seriesId = typeof payload.seriesId === 'string' ? payload.seriesId : '';
    if (!seriesId) {
      return {
        result: { processed: 0, enrichedByIsbn: 0, coversAdded: 0, stillMissingIsbn: 0, rateLimitedCount: 0 },
        total: 1
      };
    }
    const report = await ingestionService.enrichIncompleteSeriesVolumes(
      seriesId,
      (done, total) => {
        reportProgress(done, total);
      },
      isCancelled
    );

    // Zéro couverture oubliée : si iTunes a appliqué un rate-limit temporaire (HTTP 429/403),
    // reprogramme automatiquement une passe différée (+75 s, max 2 relances).
    const retryAttempt = typeof payload.retryAttempt === 'number' ? payload.retryAttempt : 0;
    if (!isCancelled() && report.rateLimitedCount > 0 && retryAttempt < 2) {
      const now = new Date();
      const runAfter = new Date(now.getTime() + 75_000).toISOString();
      const retryJob = jobRepo.createJob({
        id: `job_${crypto.randomBytes(6).toString('hex')}`,
        type: 'series_enrich_volumes',
        userId: job.user_id,
        libraryId: job.library_id,
        payload: {
          seriesId,
          retryAttempt: retryAttempt + 1,
          runAfter
        },
        progressTotal: report.rateLimitedCount,
        now: now.toISOString()
      });
      worker.notifyJobRow(retryJob);
    }

    return { result: report, total: Math.max(1, report.processed) };
  });

  worker.registerHandler('series_apply_edition_covers', async ({ job, payload, reportProgress }) => {
    const seriesId = typeof payload.seriesId === 'string' ? payload.seriesId : '';
    const libraryId = typeof payload.libraryId === 'string' ? payload.libraryId : (job.library_id ?? '');
    const targetBookIds = Array.isArray(payload.targetBookIds)
      ? payload.targetBookIds.filter((x): x is string => typeof x === 'string')
      : [];
    const targetEdition =
      payload.targetEdition && typeof payload.targetEdition === 'object'
        ? (payload.targetEdition as {
            isbn13?: string | null;
            publisher?: string | null;
            collectionName?: string | null;
            isbnPrefix?: string | null;
            lineageKey?: string | null;
            label?: string | null;
          })
        : {};
    if (!seriesId || !libraryId || targetBookIds.length === 0) {
      return {
        result: { seriesId, editionLabel: '', processed: 0, updatedCount: 0, stillMissingCount: 0 },
        total: 1
      };
    }
    const report = await seriesCoverEditionService.executeApplyEditionCoversJob({
      seriesId,
      libraryId,
      targetBookIds,
      targetEdition,
      onProgress: (done, total) => reportProgress(done, total)
    });
    return { result: report, total: Math.max(1, report.processed) };
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
    seriesCoverEditionService,
    notificationService,
    socialService,
    statsExportService,
    collectionImportService,
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
      version: APP_VERSION,
      mode: 'self-hosted-sqlite',
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000)
    })
  );

  return {
    app,
    repos: { userRepo, libraryRepo, catalogRepo, jobRepo, logRepo, loanRepo, readingRepo, notifRepo, socialRepo, adminRepo },
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
      seriesCoverEditionService,
      notificationService,
      socialService,
      statsExportService,
      collectionImportService,
      adminService
    },
    worker,
    cronScheduler
  };
}
