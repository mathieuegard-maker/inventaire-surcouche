// src/server/middleware/auth.middleware.ts
// Authentification stricte par cookie HttpOnly — ZÉRO fallback userUri.

import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AuthService, AuthSessionContext } from '../services/auth.service';
import { AppError } from './error.middleware';

export const SESSION_COOKIE_NAME = 'biblio_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export interface AppVariables {
  auth?: AuthSessionContext;
}

export function setSessionCookie(c: Context, rawToken: string, isProduction: boolean): void {
  setCookie(c, SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
}

export function createRequireAuthMiddleware(authService: AuthService): MiddlewareHandler<{
  Variables: AppVariables;
}> {
  return async (c, next) => {
    const rawToken = getCookie(c, SESSION_COOKIE_NAME);
    if (!rawToken) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentification requise.');
    }
    const ctx = authService.resolveSessionByRawToken(rawToken);
    if (!ctx) {
      clearSessionCookie(c);
      throw new AppError(401, 'SESSION_EXPIRED', 'Session expirée ou invalide.');
    }
    c.set('auth', ctx);
    await next();
  };
}

export function createRequireAdminMiddleware(authService: AuthService): MiddlewareHandler<{
  Variables: AppVariables;
}> {
  const requireAuth = createRequireAuthMiddleware(authService);
  return async (c, next) => {
    await requireAuth(c, async () => {
      const auth = c.get('auth');
      if (!auth?.isAdmin) {
        throw new AppError(403, 'FORBIDDEN', 'Accès réservé aux administrateurs.');
      }
      await next();
    });
  };
}
