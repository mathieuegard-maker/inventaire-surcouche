// src/server/routes/admin.routes.ts
// Routes Console Administration (`/api/admin/*`, protégées par requireAuth + requireAdmin).

import { Hono, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  adminBenchmarkGradeSchema,
  adminCatalogPatchSchema,
  adminMaintenanceTaskSchema,
  adminResetCatalogSchema
} from '../../shared/schemas';
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

  router.post('/users/:userId/ban', (c) => {
    const auth = c.get('auth')!;
    const userId = c.req.param('userId');
    const result = deps.adminService.setUserBanned(userId, auth.userId, true);
    return c.json({ ok: true, ...result });
  });

  router.post('/users/:userId/unban', (c) => {
    const auth = c.get('auth')!;
    const userId = c.req.param('userId');
    const result = deps.adminService.setUserBanned(userId, auth.userId, false);
    return c.json({ ok: true, ...result });
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

  router.get('/import-benchmarks', (c) => {
    const limit = Number(c.req.query('limit') || 15) || 15;
    const data = deps.adminService.listImportBenchmarks(limit);
    const pendingGroundTruth = deps.adminService.getPendingGroundTruthMeta();
    return c.json({ ok: true, ...data, pendingGroundTruth });
  });

  router.get('/import-benchmarks/pending-ground-truth', (c) => {
    const pendingGroundTruth = deps.adminService.getPendingGroundTruthMeta();
    return c.json({ ok: true, pendingGroundTruth });
  });

  router.post(
    '/import-benchmarks/pending-ground-truth',
    zValidator('json', adminBenchmarkGradeSchema),
    async (c) => {
      const body = c.req.valid('json');
      const pendingGroundTruth = await deps.adminService.savePendingGroundTruth(body);
      return c.json({ ok: true, pendingGroundTruth });
    }
  );

  router.delete('/import-benchmarks/pending-ground-truth', async (c) => {
    await deps.adminService.clearPendingGroundTruth();
    return c.json({ ok: true });
  });

  router.get('/import-benchmarks/:jobId/grade', async (c) => {
    const jobId = c.req.param('jobId');
    const res = await deps.adminService.getImportBenchmarkGrade(jobId);
    return c.json({ ok: true, ...res });
  });

  router.post(
    '/import-benchmarks/:jobId/grade',
    zValidator('json', adminBenchmarkGradeSchema),
    async (c) => {
      const jobId = c.req.param('jobId');
      const body = c.req.valid('json');
      const res = await deps.adminService.gradeImportBenchmark(jobId, body);
      return c.json({ ok: true, ...res });
    }
  );

  router.post('/import-benchmarks/:jobId/regrade', async (c) => {
    const jobId = c.req.param('jobId');
    const res = await deps.adminService.regradeImportBenchmark(jobId);
    return c.json({ ok: true, ...res });
  });

  router.get('/import-benchmarks/:jobId/report.md', async (c) => {
    const jobId = c.req.param('jobId');
    const found = await deps.adminService.getBenchmarkMarkdownReport(jobId);
    if (!found) {
      throw new AppError(404, 'BENCHMARK_REPORT_NOT_FOUND', 'Aucun rapport Markdown généré pour ce lot.');
    }
    return new Response(found.markdown, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${found.filename}"`,
        'Cache-Control': 'no-store'
      }
    });
  });

  router.get('/import-benchmarks/:jobId/series-report.md', async (c) => {
    const jobId = c.req.param('jobId');
    const found = await deps.adminService.getBenchmarkSeriesMarkdownReport(jobId);
    if (!found) {
      throw new AppError(404, 'BENCHMARK_SERIES_REPORT_NOT_FOUND', 'Aucun rapport séries généré pour ce lot.');
    }
    return new Response(found.markdown, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${found.filename}"`,
        'Cache-Control': 'no-store'
      }
    });
  });

  router.post('/reset-book-catalog', zValidator('json', adminResetCatalogSchema), async (c) => {
    const result = await deps.adminService.resetBookCatalogForTests();
    return c.json({ ok: true, ...result });
  });

  return router;
}
