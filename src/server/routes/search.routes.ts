// src/server/routes/search.routes.ts
// Route de recherche catalogue exhaustive : POST /api/search/catalog.

import { Hono, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { catalogSearchSchema } from '../../shared/schemas';
import type { AppVariables } from '../middleware/auth.middleware';
import type { SearchService } from '../services/search.service';

export function createSearchRoutes(deps: {
  searchService: SearchService;
  requireAuth: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const router = new Hono<{ Variables: AppVariables }>();
  router.use('*', deps.requireAuth);

  router.post('/catalog', zValidator('json', catalogSearchSchema), async (c) => {
    const auth = c.get('auth')!;
    const criteria = c.req.valid('json');
    const result = await deps.searchService.searchCatalog({
      libraryId: auth.libraryId,
      userId: auth.userId,
      ...criteria
    });
    return c.json({ ok: true, ...result });
  });

  return router;
}
