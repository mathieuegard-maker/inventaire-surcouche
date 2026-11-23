// src/server/routes/authors.routes.ts
// Route Profil Auteur : GET /api/authors/:name.

import { Hono, type MiddlewareHandler } from 'hono';
import type { AppVariables } from '../middleware/auth.middleware';
import type { SeriesManagementService } from '../services/series-management.service';

export function createAuthorsRoutes(deps: {
  seriesManagementService: SeriesManagementService;
  requireAuth: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const router = new Hono<{ Variables: AppVariables }>();
  router.use('*', deps.requireAuth);

  router.get('/:name', async (c) => {
    const auth = c.get('auth')!;
    const name = decodeURIComponent(c.req.param('name'));
    const detail = await deps.seriesManagementService.getAuthorDetail(auth.libraryId, auth.userId, name);
    return c.json({ ok: true, ...detail });
  });

  return router;
}
