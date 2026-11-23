// src/server/routes/notifications.routes.ts
// Routes Nouveautés (`/api/releases/*`) et Préférences Notifications / Web Push VAPID (`/api/notifications/*`).

import { Hono, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { notificationPrefsSchema, pushSubscribeSchema } from '../../shared/schemas';
import type { AppVariables } from '../middleware/auth.middleware';
import type { NotificationService } from '../services/notification.service';

const dismissReleaseSchema = z.object({
  alertId: z.string().trim().min(1).optional(),
  all: z.boolean().optional()
});

const unsubscribePushSchema = z.object({
  endpoint: z.string().url().optional()
});

export function createReleasesRoutes(deps: {
  notificationService: NotificationService;
  requireAuth: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const router = new Hono<{ Variables: AppVariables }>();
  router.use('*', deps.requireAuth);

  router.get('/', (c) => {
    const auth = c.get('auth')!;
    const alerts = deps.notificationService.listActiveReleaseAlerts(auth.libraryId);
    return c.json({ ok: true, alerts });
  });

  router.post('/check', async (c) => {
    const auth = c.get('auth')!;
    const outcome = await deps.notificationService.checkReleasesForLibrary(auth.libraryId);
    const alerts = deps.notificationService.listActiveReleaseAlerts(auth.libraryId);
    return c.json({ ok: true, ...outcome, alerts });
  });

  router.post('/dismiss', zValidator('json', dismissReleaseSchema), (c) => {
    const auth = c.get('auth')!;
    const body = c.req.valid('json');
    const res = deps.notificationService.dismissAlerts(auth.libraryId, body.all ? undefined : body.alertId);
    return c.json({ ok: true, ...res });
  });

  return router;
}

export function createNotificationsRoutes(deps: {
  notificationService: NotificationService;
  requireAuth: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const router = new Hono<{ Variables: AppVariables }>();
  router.use('*', deps.requireAuth);

  router.get('/prefs', (c) => {
    const auth = c.get('auth')!;
    const prefs = deps.notificationService.getPrefs(auth.userId);
    return c.json({ ok: true, prefs });
  });

  router.put('/prefs', zValidator('json', notificationPrefsSchema), (c) => {
    const auth = c.get('auth')!;
    const body = c.req.valid('json');
    const prefs = deps.notificationService.savePrefs(auth.userId, body);
    return c.json({ ok: true, prefs });
  });

  router.post('/push', zValidator('json', pushSubscribeSchema), (c) => {
    const auth = c.get('auth')!;
    const body = c.req.valid('json');
    deps.notificationService.subscribePush(auth.userId, body);
    return c.json({ ok: true }, 201);
  });

  router.delete('/push', zValidator('json', unsubscribePushSchema), (c) => {
    const auth = c.get('auth')!;
    const body = c.req.valid('json');
    deps.notificationService.unsubscribePush(auth.userId, body.endpoint);
    return c.json({ ok: true });
  });

  return router;
}
