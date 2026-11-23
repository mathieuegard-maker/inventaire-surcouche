// src/server/routes/books.routes.ts
// Routes Livres & Acquisition : resolve-isbn, manual, GET /:bookId, GET /:bookId/covers.

import { Hono, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  manualBookCreateSchema,
  replaceBookSchema,
  resolveIsbnSchema,
  retryPhotoItemBnfSchema
} from '../../shared/schemas';
import type { AppVariables } from '../middleware/auth.middleware';
import type { IngestionService } from '../services/acquisition/ingestion.service';
import type { LibraryService } from '../services/library.service';
import type { PhotoAiService } from '../services/photo-ai.service';

export function createBooksRoutes(deps: {
  ingestionService: IngestionService;
  libraryService: LibraryService;
  photoAiService?: PhotoAiService;
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

  router.post('/manual', zValidator('json', manualBookCreateSchema), (c) => {
    const auth = c.get('auth')!;
    const body = c.req.valid('json');
    const outcome = deps.libraryService.createManualBook({
      libraryId: auth.libraryId,
      userId: auth.userId,
      ...body
    });
    return c.json({ ok: true, ...outcome }, 201);
  });

  router.post('/lookup', zValidator('json', retryPhotoItemBnfSchema), async (c) => {
    const hints = c.req.valid('json');
    const options = deps.photoAiService ? await deps.photoAiService.searchBookCandidates(hints) : [];
    return c.json({ ok: true, options });
  });

  router.post('/:bookId/replace', zValidator('json', replaceBookSchema), async (c) => {
    const auth = c.get('auth')!;
    const bookId = c.req.param('bookId');
    const body = c.req.valid('json');
    const outcome = await deps.libraryService.replaceBookInLibrary({
      libraryId: auth.libraryId,
      userId: auth.userId,
      oldBookId: bookId,
      targetIsbn13: body.targetIsbn13
    });
    return c.json({ ok: true, ...outcome });
  });

  router.get('/:bookId/covers', async (c) => {
    const auth = c.get('auth')!;
    const bookId = c.req.param('bookId');
    const includeExternal = c.req.query('external') === '1' || c.req.query('external') === 'true';
    const covers = await deps.libraryService.listBookCoverCandidates(auth.libraryId, bookId, includeExternal);
    return c.json({ ok: true, covers });
  });

  router.get('/:bookId', (c) => {
    const auth = c.get('auth')!;
    const bookId = c.req.param('bookId');
    const detail = deps.libraryService.getBookDetail(auth.libraryId, auth.userId, bookId);
    return c.json({ ok: true, ...detail });
  });

  return router;
}
