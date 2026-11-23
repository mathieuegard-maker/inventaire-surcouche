// src/server/routes/library.routes.ts
// Routes Espace Foyer : batch-status, batch-genres, PATCH /books/:bookId (Couche 3) & DELETE /books/:bookId/overrides.

import { Hono, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { batchGenresSchema, batchStatusSchema, libraryBookOverridePatchSchema } from '../../shared/schemas';
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

  router.patch('/books/:bookId', zValidator('json', libraryBookOverridePatchSchema), (c) => {
    const auth = c.get('auth')!;
    const bookId = c.req.param('bookId');
    const patch = c.req.valid('json');
    const book = deps.libraryService.updateBookOverrides(auth.libraryId, auth.userId, bookId, patch);
    return c.json({ ok: true, book });
  });

  router.delete('/books/:bookId/overrides', (c) => {
    const auth = c.get('auth')!;
    const bookId = c.req.param('bookId');
    const book = deps.libraryService.resetBookOverrides(auth.libraryId, auth.userId, bookId);
    return c.json({ ok: true, book });
  });

  return router;
}
