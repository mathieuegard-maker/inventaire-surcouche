// src/server/routes/series.routes.ts
// Routes Séries : GET /:seriesId, POST /:seriesId/expand, POST /attach, POST /:seriesId/exclude.

import { Hono, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { attachSeriesSchema, excludeFromSeriesSchema } from '../../shared/schemas';
import type { AppVariables } from '../middleware/auth.middleware';
import type { SeriesManagementService } from '../services/series-management.service';

export function createSeriesRoutes(deps: {
  seriesManagementService: SeriesManagementService;
  requireAuth: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const router = new Hono<{ Variables: AppVariables }>();
  router.use('*', deps.requireAuth);

  router.post('/attach', zValidator('json', attachSeriesSchema), (c) => {
    const auth = c.get('auth')!;
    const body = c.req.valid('json');
    const result = deps.seriesManagementService.attachBooksToSeries({
      libraryId: auth.libraryId,
      userId: auth.userId,
      ...body
    });
    return c.json({ ok: true, ...result });
  });

  router.get('/:seriesId', (c) => {
    const auth = c.get('auth')!;
    const seriesId = c.req.param('seriesId');
    const detail = deps.seriesManagementService.getSeriesDetail(auth.libraryId, auth.userId, seriesId);
    return c.json({ ok: true, ...detail });
  });

  router.post('/:seriesId/expand', async (c) => {
    const auth = c.get('auth')!;
    const seriesId = c.req.param('seriesId');
    const outcome = await deps.seriesManagementService.expandSeriesNow(auth.libraryId, auth.userId, seriesId);
    return c.json({ ok: true, ...outcome });
  });

  router.post('/:seriesId/exclude', zValidator('json', excludeFromSeriesSchema), (c) => {
    const auth = c.get('auth')!;
    const seriesId = c.req.param('seriesId');
    const { bookIds } = c.req.valid('json');
    const result = deps.seriesManagementService.excludeBooksFromSeries(auth.libraryId, seriesId, bookIds);
    return c.json({ ok: true, ...result });
  });

  return router;
}
