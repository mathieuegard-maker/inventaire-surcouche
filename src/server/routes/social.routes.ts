// src/server/routes/social.routes.ts
// Routes Social : Foyer (join, regenerate), Amis (list/add/remove), Vitrine /share/:token & Réservations Cadeaux anti-spoiler.

import { Hono, type MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { zValidator } from '@hono/zod-validator';
import { addFriendSchema, joinFamilySchema, regenerateTokenSchema } from '../../shared/schemas';
import { SESSION_COOKIE_NAME, type AppVariables } from '../middleware/auth.middleware';
import type { AuthService } from '../services/auth.service';
import type { SocialService } from '../services/social.service';

export function createSocialRoutes(deps: {
  socialService: SocialService;
  authService: AuthService;
  requireAuth: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const router = new Hono<{ Variables: AppVariables }>();

  // Vitrine partagée via jeton secret PUB-... (détection optionnelle de session pour anti-spoiler & réservations)
  router.get('/share/:token', (c) => {
    const token = c.req.param('token');
    const rawSession = getCookie(c, SESSION_COOKIE_NAME);
    const viewerAuth = rawSession ? deps.authService.resolveSessionByRawToken(rawSession) : null;
    const shared = deps.socialService.getSharedLibraryByToken(token, viewerAuth);
    return c.json({ ok: true, shared });
  });

  // Réservation cadeau (strictement réservée aux amis inscrits et connectés hors foyer)
  router.post('/share/:token/reserve/:bookId', deps.requireAuth, (c) => {
    const auth = c.get('auth')!;
    const token = c.req.param('token');
    const bookId = c.req.param('bookId');
    const res = deps.socialService.reserveGift({
      token,
      bookId,
      viewerUserId: auth.userId,
      viewerLibraryId: auth.libraryId
    });
    return c.json({ ok: true, ...res }, 201);
  });

  router.delete('/share/:token/reserve/:bookId', deps.requireAuth, (c) => {
    const auth = c.get('auth')!;
    const token = c.req.param('token');
    const bookId = c.req.param('bookId');
    const res = deps.socialService.cancelGiftReservation({
      token,
      bookId,
      viewerUserId: auth.userId,
      viewerLibraryId: auth.libraryId
    });
    return c.json({ ok: true, ...res });
  });

  // Foyer & Codes
  router.post('/family/join', deps.requireAuth, zValidator('json', joinFamilySchema), (c) => {
    const auth = c.get('auth')!;
    const { inviteCode } = c.req.valid('json');
    const joined = deps.socialService.joinFamily(auth.userId, inviteCode);
    const profile = deps.authService.buildProfilePayload(auth.userId);
    return c.json({ ok: true, ...joined, profile });
  });

  router.post('/tokens/regenerate', deps.requireAuth, zValidator('json', regenerateTokenSchema), (c) => {
    const auth = c.get('auth')!;
    const { tokenType } = c.req.valid('json');
    const res = deps.socialService.regenerateToken(auth.libraryId, tokenType);
    const profile = deps.authService.buildProfilePayload(auth.userId);
    return c.json({ ok: true, ...res, profile });
  });

  // Amis suivis
  router.get('/friends', deps.requireAuth, (c) => {
    const auth = c.get('auth')!;
    return c.json({ ok: true, friends: deps.socialService.listFriends(auth.userId) });
  });

  router.post('/friends', deps.requireAuth, zValidator('json', addFriendSchema), (c) => {
    const auth = c.get('auth')!;
    const { shareToken } = c.req.valid('json');
    const added = deps.socialService.addFriend(auth.userId, auth.libraryId, shareToken);
    return c.json({ ok: true, ...added, friends: deps.socialService.listFriends(auth.userId) }, 201);
  });

  router.delete('/friends/:targetLibraryId', deps.requireAuth, (c) => {
    const auth = c.get('auth')!;
    const targetLibraryId = c.req.param('targetLibraryId');
    deps.socialService.removeFriend(auth.userId, targetLibraryId);
    return c.json({ ok: true, friends: deps.socialService.listFriends(auth.userId) });
  });

  return router;
}
