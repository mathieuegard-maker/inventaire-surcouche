// src/server/routes/index.ts
// Routeur API unique V2 monté sous /api/* (zéro /api/gateway).

import { Hono } from 'hono';
import { APP_VERSION } from '../../shared/version';
import type { ServerConfig } from '../config';
import type { AuthService } from '../services/auth.service';
import type { CoverService } from '../services/cover.service';
import type { IngestionService } from '../services/acquisition/ingestion.service';
import type { JobRepository } from '../repositories/job.repo';
import type { BackgroundWorker } from '../workers/background-worker';
import type { SyncService } from '../services/sync.service';
import type { LibraryService } from '../services/library.service';
import type { LoanService } from '../services/loan.service';
import type { ReadingService } from '../services/reading.service';
import type { PhotoAiService } from '../services/photo-ai.service';
import type { SearchService } from '../services/search.service';
import type { SeriesManagementService } from '../services/series-management.service';
import type { SeriesCoverEditionService } from '../services/series-cover-edition.service';
import type { NotificationService } from '../services/notification.service';
import type { SocialService } from '../services/social.service';
import type { StatsExportService } from '../services/stats-export.service';
import type { CollectionImportService } from '../services/collection-import.service';
import type { AdminService } from '../services/admin.service';
import {
  createRequireAdminMiddleware,
  createRequireAuthMiddleware,
  type AppVariables
} from '../middleware/auth.middleware';
import { createAuthRoutes } from './auth.routes';
import { createProfileRoutes } from './profile.routes';
import { createCoversRoutes } from './covers.routes';
import { createBooksRoutes } from './books.routes';
import { createJobsRoutes } from './jobs.routes';
import { createSyncRoutes } from './sync.routes';
import { createLibraryRoutes } from './library.routes';
import { createLoansRoutes } from './loans.routes';
import { createReadingRoutes } from './reading.routes';
import { createSearchRoutes } from './search.routes';
import { createSeriesRoutes } from './series.routes';
import { createAuthorsRoutes } from './authors.routes';
import { createNotificationsRoutes, createReleasesRoutes } from './notifications.routes';
import { createSocialRoutes } from './social.routes';
import { createStatsRoutes } from './stats.routes';
import { createAdminRoutes } from './admin.routes';

export interface ApiRouterDeps {
  config: ServerConfig;
  authService: AuthService;
  coverService: CoverService;
  ingestionService: IngestionService;
  syncService: SyncService;
  libraryService: LibraryService;
  loanService: LoanService;
  readingService: ReadingService;
  photoAiService: PhotoAiService;
  searchService: SearchService;
  seriesManagementService: SeriesManagementService;
  seriesCoverEditionService: SeriesCoverEditionService;
  notificationService: NotificationService;
  socialService: SocialService;
  statsExportService: StatsExportService;
  collectionImportService: CollectionImportService;
  adminService: AdminService;
  jobRepo: JobRepository;
  worker: BackgroundWorker;
  startedAt: number;
}

export function createApiRouter(deps: ApiRouterDeps) {
  const api = new Hono<{ Variables: AppVariables }>();
  const requireAuth = createRequireAuthMiddleware(deps.authService);
  const requireAdmin = createRequireAdminMiddleware(deps.authService);

  api.get('/health', (c) =>
    c.json({
      ok: true,
      version: APP_VERSION,
      mode: 'self-hosted-sqlite',
      uptimeSec: Math.floor((Date.now() - deps.startedAt) / 1000)
    })
  );

  api.route('/auth', createAuthRoutes(deps.authService, deps.config));
  api.route('/me', createProfileRoutes(deps.authService, deps.statsExportService, deps.collectionImportService));
  api.route('/covers', createCoversRoutes({ coverService: deps.coverService, requireAuth }));
  api.route(
    '/books',
    createBooksRoutes({
      ingestionService: deps.ingestionService,
      libraryService: deps.libraryService,
      photoAiService: deps.photoAiService,
      requireAuth
    })
  );
  api.route('/jobs', createJobsRoutes({ jobRepo: deps.jobRepo, worker: deps.worker, photoAiService: deps.photoAiService, requireAuth }));
  api.route('/search', createSearchRoutes({ searchService: deps.searchService, requireAuth }));
  api.route('/sync', createSyncRoutes({ syncService: deps.syncService, requireAuth }));
  api.route('/library', createLibraryRoutes({ libraryService: deps.libraryService, requireAuth }));
  api.route('/loans', createLoansRoutes({ loanService: deps.loanService, requireAuth }));
  api.route('/reading', createReadingRoutes({ readingService: deps.readingService, requireAuth }));
  api.route(
    '/series',
    createSeriesRoutes({
      seriesManagementService: deps.seriesManagementService,
      seriesCoverEditionService: deps.seriesCoverEditionService,
      requireAuth
    })
  );
  api.route('/authors', createAuthorsRoutes({ seriesManagementService: deps.seriesManagementService, requireAuth }));
  api.route('/releases', createReleasesRoutes({ notificationService: deps.notificationService, requireAuth }));
  api.route('/notifications', createNotificationsRoutes({ notificationService: deps.notificationService, requireAuth }));
  api.route('/social', createSocialRoutes({ socialService: deps.socialService, authService: deps.authService, requireAuth }));
  api.route('/stats', createStatsRoutes({ statsExportService: deps.statsExportService, requireAuth }));
  api.route('/admin', createAdminRoutes({ adminService: deps.adminService, requireAuth, requireAdmin }));

  return api;
}
