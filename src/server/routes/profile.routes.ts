// src/server/routes/profile.routes.ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  deleteAccountSchema,
  updateDefaultGenresSchema,
  updateProfileSchema
} from '../../shared/schemas/auth.schema';
import type { AuthService } from '../services/auth.service';
import type { StatsExportService } from '../services/stats-export.service';
import {
  clearSessionCookie,
  createRequireAuthMiddleware,
  type AppVariables
} from '../middleware/auth.middleware';

export function createProfileRoutes(authService: AuthService, statsExportService?: StatsExportService) {
  const router = new Hono<{ Variables: AppVariables }>();
  const requireAuth = createRequireAuthMiddleware(authService);

  router.use('*', requireAuth);

  router.get('/', (c) => {
    const auth = c.get('auth')!;
    return c.json({ ok: true, profile: authService.buildProfilePayload(auth.userId) });
  });

  router.patch('/', zValidator('json', updateProfileSchema), (c) => {
    const auth = c.get('auth')!;
    const body = c.req.valid('json');
    const profile = authService.updateProfile(auth.userId, body);
    return c.json({ ok: true, profile });
  });

  router.delete('/', zValidator('json', deleteAccountSchema), (c) => {
    const auth = c.get('auth')!;
    const { password } = c.req.valid('json');
    const result = authService.deleteAccount(auth.userId, password);
    clearSessionCookie(c);
    return c.json({ ok: true, ...result });
  });

  router.put('/genres', zValidator('json', updateDefaultGenresSchema), (c) => {
    const auth = c.get('auth')!;
    const { action, genre } = c.req.valid('json');
    const defaultGenres = authService.updateDefaultGenres(auth.userId, action, genre);
    return c.json({ ok: true, defaultGenres });
  });

  router.get('/export', (c) => {
    const auth = c.get('auth')!;
    if (!statsExportService) {
      return c.json({ error: { code: 'EXPORT_UNAVAILABLE', message: 'Service export non disponible.' } }, 503);
    }
    const format = c.req.query('format') === 'csv' ? 'csv' : 'json';
    const exported = statsExportService.exportLibrary(auth.libraryId, auth.userId, format);
    return new Response(exported.body, {
      status: 200,
      headers: {
        'Content-Type': exported.contentType,
        'Content-Disposition': `attachment; filename="${exported.filename}"`,
        'Cache-Control': 'no-store'
      }
    });
  });

  return router;
}
