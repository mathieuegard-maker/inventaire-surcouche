// src/server/routes/jobs.routes.ts
// Routes Jobs Serveur : GET /api/jobs, GET /api/jobs/stream (SSE), et les 6 endpoints Photo IA 100 % serveur.

import { Hono, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  commitPhotoJobSchema,
  createPhotoJobSchema,
  retryPhotoItemBnfSchema,
  updatePhotoJobItemSchema
} from '../../shared/schemas';
import type { AppVariables } from '../middleware/auth.middleware';
import type { JobRepository } from '../repositories/job.repo';
import type { PhotoAiService } from '../services/photo-ai.service';
import { mapJobRowToView, type BackgroundWorker } from '../workers/background-worker';

export function createJobsRoutes(deps: {
  jobRepo: JobRepository;
  worker: BackgroundWorker;
  photoAiService: PhotoAiService;
  requireAuth: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const router = new Hono<{ Variables: AppVariables }>();

  router.use('*', deps.requireAuth);

  router.get('/', (c) => {
    const auth = c.get('auth')!;
    const rows = deps.jobRepo.listJobsForUser(auth.userId, auth.libraryId, 30);
    return c.json({
      ok: true,
      jobs: rows.map(mapJobRowToView)
    });
  });

  router.get('/stream', (c) => {
    const auth = c.get('auth')!;
    const encoder = new TextEncoder();

    let unsubscribe: (() => void) | null = null;
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const sendEvent = (eventName: string, data: unknown) => {
          try {
            controller.enqueue(encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            cleanup();
          }
        };

        const snapshot = deps.jobRepo.listJobsForUser(auth.userId, auth.libraryId, 20).map(mapJobRowToView);
        sendEvent('snapshot', { jobs: snapshot });

        unsubscribe = deps.worker.subscribe((evt) => {
          if (evt.userId === auth.userId || evt.libraryId === auth.libraryId) {
            sendEvent('job', evt.job);
          }
        });

        keepAliveTimer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            cleanup();
          }
        }, 25000);
      },
      cancel() {
        cleanup();
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      }
    });
  });

  // ==================== PHOTO IA 100 % SERVEUR ====================

  router.get('/photo/history', (c) => {
    const auth = c.get('auth')!;
    const jobs = deps.photoAiService.listPhotoHistory({
      userId: auth.userId,
      libraryId: auth.libraryId,
      retentionDays: 30
    });
    return c.json({ ok: true, retentionDays: 30, jobs });
  });

  router.post('/photo', zValidator('json', createPhotoJobSchema), async (c) => {
    const auth = c.get('auth')!;
    const body = c.req.valid('json');
    const created = await deps.photoAiService.createPhotoJob({
      userId: auth.userId,
      libraryId: auth.libraryId,
      isAdmin: auth.isAdmin,
      mode: body.mode,
      imageDataUrl: body.imageDataUrl,
      mimeType: body.mimeType,
      notifyOnComplete: body.notifyOnComplete
    });
    deps.worker.nudge();
    return c.json({ ok: true, ...created }, 201);
  });

  router.get('/photo/:jobId/items/:itemId/covers', async (c) => {
    const auth = c.get('auth')!;
    const jobId = c.req.param('jobId');
    const itemId = c.req.param('itemId');
    const isbn13 = c.req.query('isbn13') || undefined;
    const refreshExternal = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true';
    const outcome = await deps.photoAiService.listItemCoverOptions({
      userId: auth.userId,
      libraryId: auth.libraryId,
      jobId,
      itemId,
      isbn13,
      refreshExternal
    });
    return c.json({ ok: true, ...outcome });
  });

  router.patch('/photo/:jobId/items/:itemId', zValidator('json', updatePhotoJobItemSchema), (c) => {
    const auth = c.get('auth')!;
    const jobId = c.req.param('jobId');
    const itemId = c.req.param('itemId');
    const patch = c.req.valid('json');
    const job = deps.photoAiService.updateItemArbitration({
      userId: auth.userId,
      libraryId: auth.libraryId,
      jobId,
      itemId,
      patch
    });
    return c.json({ ok: true, job });
  });

  router.post('/photo/:jobId/items/:itemId/retry-bnf', zValidator('json', retryPhotoItemBnfSchema), async (c) => {
    const auth = c.get('auth')!;
    const jobId = c.req.param('jobId');
    const itemId = c.req.param('itemId');
    const hints = c.req.valid('json');
    const outcome = await deps.photoAiService.retryItemBnf({
      userId: auth.userId,
      libraryId: auth.libraryId,
      jobId,
      itemId,
      hints
    });
    return c.json({ ok: true, ...outcome });
  });

  router.post('/photo/:jobId/retry-failed', async (c) => {
    const auth = c.get('auth')!;
    const jobId = c.req.param('jobId');
    const job = await deps.photoAiService.retryFailedItems({
      userId: auth.userId,
      libraryId: auth.libraryId,
      jobId
    });
    return c.json({ ok: true, job });
  });

  router.post('/photo/:jobId/retry-ocr', (c) => {
    const auth = c.get('auth')!;
    const jobId = c.req.param('jobId');
    const job = deps.photoAiService.retryOcrJob({
      userId: auth.userId,
      libraryId: auth.libraryId,
      jobId
    });
    deps.worker.nudge();
    return c.json({ ok: true, job });
  });

  router.post('/photo/:jobId/commit', zValidator('json', commitPhotoJobSchema), async (c) => {
    const auth = c.get('auth')!;
    const jobId = c.req.param('jobId');
    const body = c.req.valid('json');
    const outcome = await deps.photoAiService.commitJobItems({
      userId: auth.userId,
      libraryId: auth.libraryId,
      jobId,
      targetStatus: body.targetStatus,
      itemIds: body.itemIds,
      async: body.async,
      archiveAfterCommit: body.archiveAfterCommit
    });
    if (outcome.queued) {
      deps.worker.nudge();
    }
    return c.json({ ok: true, ...outcome });
  });

  router.post('/photo/:jobId/archive', (c) => {
    const auth = c.get('auth')!;
    const jobId = c.req.param('jobId');
    const job = deps.photoAiService.archivePhotoJob({
      userId: auth.userId,
      libraryId: auth.libraryId,
      jobId
    });
    return c.json({ ok: true, job });
  });

  router.delete('/photo/:jobId', (c) => {
    const auth = c.get('auth')!;
    const jobId = c.req.param('jobId');
    deps.photoAiService.deletePhotoJob({
      userId: auth.userId,
      libraryId: auth.libraryId,
      jobId
    });
    return c.json({ ok: true });
  });

  return router;
}
