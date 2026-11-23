// src/server/routes/library.routes.ts
// Routes Espace Foyer : POST /api/library/books/batch-status & POST /api/library/books/batch-genres.

import { Hono, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { batchGenresSchema, batchStatusSchema } from '../../shared/schemas';
import type { AppVariables } from '../middleware/auth.middleware';
import type { LibraryService } from '../services/library.service';

export function createLibraryRoutes(deps: {
  libraryService: LibraryService;
  requireAuth: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const router = new Hono<{ Variables: AppVariables }>();
  router.use('*', deps.requireAuth);

  router.post('/books/batch-status', zValidator('json', batchStatusSchema), (c) => {
    const auth = c.get('auth')!;
    const body = c.req.valid('json');
    const result = deps.libraryService.applyBatchStatus({
      libraryId: auth.libraryId,
      userId: auth.userId,
      bookIds: body.bookIds,
      status: body.status,
      lentDecisions: body.lentDecisions
    });
    return c.json({ ok: true, ...result });
  });

  router.post('/books/batch-genres', zValidator('json', batchGenresSchema), (c) => {
    const auth = c.get('auth')!;
    const body = c.req.valid('json');
    const result = deps.libraryService.applyBatchGenres({
      libraryId: auth.libraryId,
      bookIds: body.bookIds,
      genres: body.genres
    });
    return c.json({ ok: true, ...result });
  });

  return router;
}
