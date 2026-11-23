// src/server/routes/index.ts
// Routeur API unique V2 monté sous /api/* (zéro /api/gateway).

import { Hono } from 'hono';
import type { ServerConfig } from '../config';
import type { AuthService } from '../services/auth.service';
import type { CoverService } from '../services/cover.service';
import type { IngestionService } from '../services/acquisition/ingestion.service';
import type { JobRepository } from '../repositories/job.repo';
import type { BackgroundWorker } from '../workers/background-worker';
import type { SyncService } from '../services/sync.service';
import type { LibraryService } from '../services/library.service';
import type { LoanService } from '../services/loan.service';
import { createRequireAuthMiddleware, type AppVariables } from '../middleware/auth.middleware';
import { createAuthRoutes } from './auth.routes';
import { createProfileRoutes } from './profile.routes';
import { createCoversRoutes } from './covers.routes';
import { createBooksRoutes } from './books.routes';
import { createJobsRoutes } from './jobs.routes';
import { createSyncRoutes } from './sync.routes';
import { createLibraryRoutes } from './library.routes';
import { createLoansRoutes } from './loans.routes';

export interface ApiRouterDeps {
  config: ServerConfig;
  authService: AuthService;
  coverService: CoverService;
  ingestionService: IngestionService;
  syncService: SyncService;
  libraryService: LibraryService;
  loanService: LoanService;
  jobRepo: JobRepository;
  worker: BackgroundWorker;
  startedAt: number;
}

export function createApiRouter(deps: ApiRouterDeps) {
  const api = new Hono<{ Variables: AppVariables }>();
  const requireAuth = createRequireAuthMiddleware(deps.authService);

  api.get('/health', (c) =>
    c.json({
      ok: true,
      version: '2.0.0',
      mode: 'self-hosted-sqlite',
      uptimeSec: Math.floor((Date.now() - deps.startedAt) / 1000)
    })
  );

  api.route('/auth', createAuthRoutes(deps.authService, deps.config));
  api.route('/me', createProfileRoutes(deps.authService));
  api.route('/covers', createCoversRoutes({ coverService: deps.coverService, requireAuth }));
  api.route('/books', createBooksRoutes({ ingestionService: deps.ingestionService, requireAuth }));
  api.route('/jobs', createJobsRoutes({ jobRepo: deps.jobRepo, worker: deps.worker, requireAuth }));
  api.route('/sync', createSyncRoutes({ syncService: deps.syncService, requireAuth }));
  api.route('/library', createLibraryRoutes({ libraryService: deps.libraryService, requireAuth }));
  api.route('/loans', createLoansRoutes({ loanService: deps.loanService, requireAuth }));

  return api;
}
