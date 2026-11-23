// src/server/routes/reading.routes.ts
// Routes Lecture individuelle : PUT /api/reading/:bookId (strictement scopé user_id).

import { Hono, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { readingStateUpsertSchema } from '../../shared/schemas';
import type { AppVariables } from '../middleware/auth.middleware';
import type { ReadingService } from '../services/reading.service';

export function createReadingRoutes(deps: {
  readingService: ReadingService;
  requireAuth: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const router = new Hono<{ Variables: AppVariables }>();
  router.use('*', deps.requireAuth);

  router.put('/:bookId', zValidator('json', readingStateUpsertSchema), (c) => {
    const auth = c.get('auth')!;
    const bookId = c.req.param('bookId');
    const body = c.req.valid('json');
    const readingState = deps.readingService.saveReadingState({
      userId: auth.userId,
      bookId,
      status: body.status,
      rating: body.rating,
      notes: body.notes
    });
    return c.json({ ok: true, readingState });
  });

  return router;
}
