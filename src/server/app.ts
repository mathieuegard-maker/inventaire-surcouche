// src/server/app.ts
// Fabrique d'application Hono injectable et 100 % testable sur SQLite :memory:.

import { Hono } from 'hono';
import type { DatabaseAdapter } from './db/database.adapter';
import type { ServerConfig } from './config';
import { createResendConnector, type MailSender } from './connectors/resend.connector';
import { UserRepository } from './repositories/user.repo';
import { LibraryRepository } from './repositories/library.repo';
import { AuthService } from './services/auth.service';
import { createApiRouter } from './routes';
import { handleServerError } from './middleware/error.middleware';

export interface CreateAppOptions {
  db: DatabaseAdapter;
  config: ServerConfig;
  mailSender?: MailSender;
}

export function createApp(options: CreateAppOptions) {
  const startedAt = Date.now();
  const app = new Hono();

  app.onError(handleServerError);

  // En-têtes de sécurité & Permissions Caméra PWA
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    if (c.req.header('x-forwarded-proto') === 'https' || options.config.nodeEnv === 'production') {
      c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  });

  const userRepo = new UserRepository(options.db);
  const libraryRepo = new LibraryRepository(options.db);
  const mailSender =
    options.mailSender ?? createResendConnector(options.config.resendApiKey, options.config.mailFrom);

  const authService = new AuthService({
    db: options.db,
    userRepo,
    libraryRepo,
    config: options.config,
    mailSender
  });

  const api = createApiRouter({
    config: options.config,
    authService,
    startedAt
  });

  app.route('/api', api);

  // Alias santé racine pour Docker healthcheck
  app.get('/health', (c) =>
    c.json({
      ok: true,
      version: '2.0.0',
      mode: 'self-hosted-sqlite',
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000)
    })
  );

  return { app, services: { authService } };
}
