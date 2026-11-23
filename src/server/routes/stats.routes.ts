// src/server/routes/stats.routes.ts
// Route Statistiques : GET /api/stats?periodDays=30|90|365|all.

import { Hono, type MiddlewareHandler } from 'hono';
import type { AppVariables } from '../middleware/auth.middleware';
import type { StatsExportService } from '../services/stats-export.service';

export function createStatsRoutes(deps: {
  statsExportService: StatsExportService;
  requireAuth: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const router = new Hono<{ Variables: AppVariables }>();
  router.use('*', deps.requireAuth);

  router.get('/', (c) => {
    const auth = c.get('auth')!;
    const rawPeriod = c.req.query('periodDays');
    const periodDays =
      rawPeriod && rawPeriod !== 'all' && /^\d+$/.test(rawPeriod) ? parseInt(rawPeriod, 10) : null;
    const stats = deps.statsExportService.computeStats(auth.libraryId, auth.userId, periodDays);
    return c.json({ ok: true, stats });
  });

  return router;
}
