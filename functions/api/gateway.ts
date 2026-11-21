// functions/api/gateway.ts
// Point d'entrée Cloudflare Pages Functions pour /api/gateway (délègue au routeur portable).

import type { AppBackendEnv } from '../../src/core/adapters/storage-db.interface';
import { handleGatewayRequest } from '../../src/core/services/gateway-router.service';

export const onRequest = async (context: {
  request: Request;
  env: AppBackendEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
}): Promise<Response> => {
  return handleGatewayRequest(context);
};
