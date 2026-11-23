// src/server/routes/admin.routes.ts
// Routes Console Administration (`/api/admin/*`, protégées par requireAuth + requireAdmin).

import { Hono, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { adminCatalogPatchSchema, adminMaintenanceTaskSchema } from '../../shared/schemas';
import type { AppVariables } from '../middleware/auth.middleware';
import type { AdminService } from '../services/admin.service';
import { AppError } from '../middleware/error.middleware';

export function createAdminRoutes(deps: {
  adminService: AdminService;
  requireAuth: MiddlewareHandler<{ Variables: AppVariables }>;
  requireAdmin: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const router = new Hono<{ Variables: AppVariables }>();

  router.use('*', deps.requireAuth);
  router.use('*', deps.requireAdmin);

  router.get('/overview', (c) => {
    return c.json({ ok: true, overview: deps.adminService.getOverview() });
  });

  router.get('/catalog', (c) => {
    const search = c.req.query('search') || undefined;
    const rawFilter = c.req.query('filter');
    const filter =
      rawFilter === 'no_cover' || rawFilter === 'no_series' ? rawFilter : 'all';
    const category = c.req.query('category') || undefined;
    const page = Number(c.req.query('page') || 1) || 1;
    const pageSize = Number(c.req.query('pageSize') || 24) || 24;

    const result = deps.adminService.listCatalog({ search, filter, category, page, pageSize });
    return c.json({ ok: true, ...result });
  });

  router.patch('/catalog/bulk', zValidator('json', adminCatalogPatchSchema), (c) => {
    const body = c.req.valid('json');
    const result = deps.adminService.updateCatalogBulk(body);
    return c.json({ ok: true, ...result });
  });

  router.get('/users', (c) => {
    return c.json({ ok: true, users: deps.adminService.listUsers() });
  });

  router.post('/users/:userId/reset-ai-quota', (c) => {
    const userId = c.req.param('userId');
    deps.adminService.resetUserAiQuota(userId);
    return c.json({ ok: true });
  });

  router.get('/logs', (c) => {
    const stage = c.req.query('stage') || undefined;
    const status = c.req.query('status') || undefined;
    const query = c.req.query('query') || undefined;
    const limit = Number(c.req.query('limit') || 100) || 100;
    return c.json({ ok: true, logs: deps.adminService.listLogs({ stage, status, query, limit }) });
  });

  router.delete('/logs', (c) => {
    const days = Number(c.req.query('days') || 30) || 30;
    const res = deps.adminService.purgeLogs(days);
    return c.json({ ok: true, ...res });
  });

  router.post('/maintenance/:task', async (c) => {
    const parsed = adminMaintenanceTaskSchema.safeParse(c.req.param('task'));
    if (!parsed.success) {
      throw new AppError(400, 'INVALID_MAINTENANCE_TASK', 'Tâche de maintenance inconnue.');
    }
    const result = await deps.adminService.runMaintenanceTask(parsed.data);
    return c.json({ ok: true, task: parsed.data, result });
  });

  return router;
}
