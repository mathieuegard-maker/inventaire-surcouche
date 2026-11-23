// src/server/routes/covers.routes.ts
// Routes Couvertures WebP : GET /api/covers/:coverKey (Cache-Control immutable) et POST /api/covers/upload.

import { Hono, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { CoverService } from '../services/cover.service';
import type { AppVariables } from '../middleware/auth.middleware';
import { AppError } from '../middleware/error.middleware';

const uploadCoverSchema = z.object({
  imageDataUrl: z.string().startsWith('data:image/')
});

const importCoverUrlSchema = z.object({
  url: z.string().url()
});

export function createCoversRoutes(deps: {
  coverService: CoverService;
  requireAuth: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const router = new Hono<{ Variables: AppVariables }>();

  router.get('/:coverKey', async (c) => {
    const coverKey = c.req.param('coverKey');
    const binary = await deps.coverService.readCoverBinary(coverKey);
    if (!binary) {
      throw new AppError(404, 'COVER_NOT_FOUND', 'Couverture introuvable.');
    }

    return new Response(new Uint8Array(binary.buffer), {
      status: 200,
      headers: {
        'Content-Type': binary.mimeType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  });

  router.post('/upload', deps.requireAuth, zValidator('json', uploadCoverSchema), async (c) => {
    const { imageDataUrl } = c.req.valid('json');
    const stored = await deps.coverService.storeDataUrlAsWebp(imageDataUrl);
    return c.json({ ok: true, ...stored }, 201);
  });

  router.post('/import-url', deps.requireAuth, zValidator('json', importCoverUrlSchema), async (c) => {
    const { url } = c.req.valid('json');
    const stored = await deps.coverService.ingestFromExternalUrl(url);
    if (!stored) {
      throw new AppError(400, 'COVER_IMPORT_FAILED', "Impossible d'importer cette image.");
    }
    return c.json({ ok: true, ...stored }, 201);
  });

  return router;
}
