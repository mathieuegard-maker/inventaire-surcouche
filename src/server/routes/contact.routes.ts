// src/server/routes/contact.routes.ts
// Route publique/authentifiée POST /api/contact (accessible même depuis /login).

import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { zValidator } from '@hono/zod-validator';
import { contactMessageSchema } from '../../shared/schemas';
import { SESSION_COOKIE_NAME } from '../middleware/auth.middleware';
import type { AuthService } from '../services/auth.service';
import type { ContactService } from '../services/contact.service';

export function createContactRoutes(deps: {
  contactService: ContactService;
  authService: AuthService;
}) {
  const router = new Hono();

  router.post('/', zValidator('json', contactMessageSchema), async (c) => {
    const body = c.req.valid('json');
    const rawSession = getCookie(c, SESSION_COOKIE_NAME);
    const viewerAuth = rawSession ? deps.authService.resolveSessionByRawToken(rawSession) : null;

    const forwardedFor = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || '';
    const ipKey = forwardedFor.split(',')[0]?.trim() || 'local';
    const clientKey = viewerAuth ? `user:${viewerAuth.userId}` : `ip:${ipKey}`;

    const res = await deps.contactService.sendContactMessage({
      input: body,
      clientKey,
      viewerAuth
    });

    return c.json({ ok: true, delivered: res.delivered });
  });

  return router;
}
