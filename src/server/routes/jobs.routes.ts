// src/server/routes/jobs.routes.ts
// Routes Jobs Serveur : GET /api/jobs et flux temps réel SSE GET /api/jobs/stream.

import { Hono, type MiddlewareHandler } from 'hono';
import type { AppVariables } from '../middleware/auth.middleware';
import type { JobRepository } from '../repositories/job.repo';
import { mapJobRowToView, type BackgroundWorker } from '../workers/background-worker';

export function createJobsRoutes(deps: {
  jobRepo: JobRepository;
  worker: BackgroundWorker;
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

        // Snapshot initial des jobs récents
        const snapshot = deps.jobRepo.listJobsForUser(auth.userId, auth.libraryId, 20).map(mapJobRowToView);
        sendEvent('snapshot', { jobs: snapshot });

        // Abonnement temps réel filtré par utilisateur / foyer
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

  return router;
}
