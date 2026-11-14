// functions/api/v2/[[route]].ts
// Point d'entrée automatique Cloudflare Pages Functions pour toutes les routes /api/v2/*
// Cloudflare injecte automatiquement `context.env.DB` (D1) et `context.env.COVERS_BUCKET` (R2)
// déclarés dans wrangler.toml.

import type { AppBackendEnv } from '../../../src/core/adapters/storage-db.interface';
import { handleV2ApiRequest } from '../../../src/core/services/v2-backend-router.service';

export interface CloudflarePagesContext {
  request: Request;
  env: AppBackendEnv;
  params: Record<string, string | string[]>;
}

export const onRequest = async (context: CloudflarePagesContext): Promise<Response> => {
  return handleV2ApiRequest(context.request, context.env);
};
