// src/server/routes/books.routes.ts
// Routes Acquisition & Livres : POST /api/books/resolve-isbn (Étage 1 -> 2 -> 3).

import { Hono, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { resolveIsbnSchema } from '../../shared/schemas';
import type { AppVariables } from '../middleware/auth.middleware';
import type { IngestionService } from '../services/acquisition/ingestion.service';

export function createBooksRoutes(deps: {
  ingestionService: IngestionService;
  requireAuth: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const router = new Hono<{ Variables: AppVariables }>();

  router.use('*', deps.requireAuth);

  router.post('/resolve-isbn', zValidator('json', resolveIsbnSchema), async (c) => {
    const auth = c.get('auth')!;
    const body = c.req.valid('json');
    const outcome = await deps.ingestionService.resolveIsbns({
      rawIsbns: body.isbns,
      channel: body.channel,
      action: body.action,
      userId: auth.userId,
      libraryId: auth.libraryId
    });
    return c.json({ ok: true, ...outcome });
  });

  return router;
}
