// src/server/routes/index.ts
// Routeur API unique V2 monté sous /api/* (zéro /api/gateway).

import { Hono } from 'hono';
import type { ServerConfig } from '../config';
import type { AuthService } from '../services/auth.service';
import type { AppVariables } from '../middleware/auth.middleware';
import { createAuthRoutes } from './auth.routes';
import { createProfileRoutes } from './profile.routes';

export interface ApiRouterDeps {
  config: ServerConfig;
  authService: AuthService;
  startedAt: number;
}

export function createApiRouter(deps: ApiRouterDeps) {
  const api = new Hono<{ Variables: AppVariables }>();

  api.get('/health', (c) =>
    c.json({
      ok: true,
      version: '2.0.0',
      mode: 'self-hosted-sqlite',
      uptimeSec: Math.floor((Date.now() - deps.startedAt) / 1000)
    })
  );

  api.route('/auth', createAuthRoutes(deps.authService, deps.config));
  api.route('/me', createProfileRoutes(deps.authService));

  return api;
}
