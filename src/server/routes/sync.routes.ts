// src/server/routes/sync.routes.ts
// Routes de synchronisation hors-ligne : POST /api/sync/push (outbox prioritaire) et GET /api/sync/pull?since=...

import { Hono, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { syncPushSchema } from '../../shared/schemas';
import type { AppVariables } from '../middleware/auth.middleware';
import type { SyncService } from '../services/sync.service';

export function createSyncRoutes(deps: {
  syncService: SyncService;
  requireAuth: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const router = new Hono<{ Variables: AppVariables }>();
  router.use('*', deps.requireAuth);

  router.post('/push', zValidator('json', syncPushSchema), async (c) => {
    const auth = c.get('auth')!;
    const { operations } = c.req.valid('json');
    const outcome = await deps.syncService.pushOutbox({
      libraryId: auth.libraryId,
      userId: auth.userId,
      operations
    });
    return c.json({ ok: true, ...outcome });
  });

  router.get('/pull', (c) => {
    const auth = c.get('auth')!;
    const since = c.req.query('since')?.trim() || undefined;
    const payload = deps.syncService.pullDelta({
      libraryId: auth.libraryId,
      userId: auth.userId,
      since
    });
    return c.json({ ok: true, ...payload });
  });

  return router;
}
