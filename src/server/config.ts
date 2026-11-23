// src/server/config.ts
// Validation stricte des variables d'environnement serveur (zéro secret dans Git).

import path from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATA_DIR: z.string().default('./data'),
  SQLITE_DB_PATH: z.string().optional(),
  COVERS_DIR: z.string().optional(),
  STATIC_DIR: z.string().default('./dist'),
  MIGRATIONS_DIR: z.string().default('./migrations'),
  ADMIN_EMAIL: z.string().trim().email().or(z.literal('')).default(''),
  JWT_SECRET: z.string().default('dev-only-secret-change-in-production'),
  GEMINI_API_KEY: z.string().default(''),
  RESEND_API_KEY: z.string().default(''),
  MAIL_FROM: z.string().default('Biblio Collection <noreply@mathieuegardtest.fr>'),
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_JWK: z.string().default(''),
  VAPID_SUBJECT: z.string().default('mailto:contact@mathieuegardtest.fr'),
  CRON_ENABLED: z.string().default('true'),
  CRON_NIGHTLY_HOUR: z.coerce.number().int().min(0).max(23).default(2),
  MONTHLY_AI_QUOTA: z.coerce.number().int().positive().default(30)
});

export interface ServerConfig {
  nodeEnv: 'development' | 'production' | 'test';
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  coversDir: string;
  staticDir: string;
  migrationsDir: string;
  adminEmail: string;
  jwtSecret: string;
  geminiApiKey: string;
  resendApiKey: string;
  mailFrom: string;
  vapidPublicKey: string;
  vapidPrivateJwk: string;
  vapidSubject: string;
  cronEnabled: boolean;
  cronNightlyHour: number;
  monthlyAiQuota: number;
}

export function loadServerConfig(rawEnv: Record<string, string | undefined> = process.env): ServerConfig {
  const parsed = envSchema.parse(rawEnv);
  const dataDir = path.resolve(parsed.DATA_DIR);
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    dataDir,
    dbPath: path.resolve(parsed.SQLITE_DB_PATH || path.join(dataDir, 'biblio.sqlite')),
    coversDir: path.resolve(parsed.COVERS_DIR || path.join(dataDir, 'covers')),
    staticDir: path.resolve(parsed.STATIC_DIR),
    migrationsDir: path.resolve(parsed.MIGRATIONS_DIR),
    adminEmail: parsed.ADMIN_EMAIL.toLowerCase(),
    jwtSecret: parsed.JWT_SECRET,
    geminiApiKey: parsed.GEMINI_API_KEY,
    resendApiKey: parsed.RESEND_API_KEY,
    mailFrom: parsed.MAIL_FROM,
    vapidPublicKey: parsed.VAPID_PUBLIC_KEY,
    vapidPrivateJwk: parsed.VAPID_PRIVATE_JWK,
    vapidSubject: parsed.VAPID_SUBJECT,
    cronEnabled: parsed.CRON_ENABLED !== 'false',
    cronNightlyHour: parsed.CRON_NIGHTLY_HOUR,
    monthlyAiQuota: parsed.MONTHLY_AI_QUOTA
  };
}
