// src/server/routes/auth.routes.ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema
} from '../../shared/schemas/auth.schema';
import type { AuthService } from '../services/auth.service';
import type { ServerConfig } from '../config';
import {
  clearSessionCookie,
  createRequireAuthMiddleware,
  setSessionCookie,
  type AppVariables
} from '../middleware/auth.middleware';

export function createAuthRoutes(authService: AuthService, config: ServerConfig) {
  const router = new Hono<{ Variables: AppVariables }>();
  const requireAuth = createRequireAuthMiddleware(authService);
  const isProd = config.nodeEnv === 'production';

  router.post('/register', zValidator('json', registerSchema), (c) => {
    const body = c.req.valid('json');
    const result = authService.register(body);
    setSessionCookie(c, result.sessionToken, isProd);
    return c.json({ ok: true, profile: result.profile }, 201);
  });

  router.post('/login', zValidator('json', loginSchema), (c) => {
    const body = c.req.valid('json');
    const result = authService.login(body);
    setSessionCookie(c, result.sessionToken, isProd);
    return c.json({ ok: true, profile: result.profile });
  });

  router.post('/logout', requireAuth, (c) => {
    const auth = c.get('auth')!;
    authService.logout(auth.sessionTokenHash);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  router.post('/forgot-password', zValidator('json', forgotPasswordSchema), async (c) => {
    const { identifier } = c.req.valid('json');
    const res = await authService.requestPasswordReset(identifier);
    return c.json({ ok: true, ...res });
  });

  router.post('/reset-password', zValidator('json', resetPasswordSchema), (c) => {
    const body = c.req.valid('json');
    authService.resetPassword(body);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  return router;
}
