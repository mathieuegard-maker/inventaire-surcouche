// src/core/services/v2-backend-router.service.ts
// Routeur Backend V2 100% standard Web (Request -> Response) et DRY.
// Tourne à l'identique sur :
// - Cloudflare Pages Functions (D1 + R2)
// - En local dans Vite / Wrangler
// - En auto-hébergement Docker / Node.js (Plan B)

import type { AppBackendEnv } from '../adapters/storage-db.interface';
import type { SyncDeltaRequest, SyncDeltaResponse } from '../domain/v2.types';

function jsonResponse(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

export async function handleV2ApiRequest(request: Request, env: AppBackendEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/v2\/?/, '');
  const method = request.method.toUpperCase();

  try {
    // 1. Endpoint de santé / diagnostic de connexion Cloudflare D1 & R2
    if (path === 'health' && method === 'GET') {
      const dbOk = Boolean(env?.DB);
      const r2Ok = Boolean(env?.COVERS_BUCKET);
      return jsonResponse({
        status: 'ok',
        engine: 'v2-cloudflare-portable',
        bindings: { d1Database: dbOk, r2CoversBucket: r2Ok },
        timestamp: new Date().toISOString()
      });
    }

    // 2. Lecture d'une couverture WebP dédupliquée depuis Cloudflare R2 (0€ d'egress)
    if (path.startsWith('covers/') && method === 'GET') {
      if (!env.COVERS_BUCKET) {
        return jsonResponse({ error: 'Bucket R2 non configuré' }, 503);
      }
      const key = decodeURIComponent(path.slice('covers/'.length));
      const object = await env.COVERS_BUCKET.get(key);
      if (!object || !object.body) {
        return jsonResponse({ error: 'Couverture introuvable' }, 404);
      }
      return new Response(object.body, {
        status: 200,
        headers: {
          'Content-Type': object.httpMetadata?.contentType || 'image/webp',
          // Cache navigateur long (1 an) car chaque couverture est immuable par ISBN/clé
          'Cache-Control': 'public, max-age=31536000, immutable'
        }
      });
    }

    // 3. Upload d'une couverture WebP compressée par le client (~30-50 Ko)
    if (path.startsWith('covers/') && method === 'PUT') {
      if (!env.COVERS_BUCKET) {
        return jsonResponse({ error: 'Bucket R2 non configuré' }, 503);
      }
      const key = decodeURIComponent(path.slice('covers/'.length));
      const contentType = request.headers.get('Content-Type') || 'image/webp';
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > 500 * 1024) {
        return jsonResponse({ error: 'Image trop volumineuse (max 500 Ko après compression WebP)' }, 413);
      }
      await env.COVERS_BUCKET.put(key, buffer, {
        httpMetadata: {
          contentType,
          cacheControl: 'public, max-age=31536000, immutable'
        }
      });
      return jsonResponse({ ok: true, key, url: `/api/v2/covers/${encodeURIComponent(key)}` });
    }

    // 4. Synchronisation différentielle (Delta Sync) entre IndexedDB (téléphone) et D1 (Cloud)
    if (path === 'sync' && method === 'POST') {
      if (!env.DB) {
        return jsonResponse({ error: 'Base D1 non configurée' }, 503);
      }
      const payload = (await request.json()) as SyncDeltaRequest;
      if (!payload.libraryId) {
        return jsonResponse({ error: 'libraryId requis' }, 400);
      }

      const now = new Date().toISOString();
      const since = payload.lastSyncedAt || '1970-01-01T00:00:00.000Z';

      // Récupération des changements serveur intervenus depuis `lastSyncedAt`
      const itemsRows = await env.DB
        .prepare('SELECT * FROM library_items WHERE library_id = ? AND updated_at > ?')
        .bind(payload.libraryId, since)
        .all();

      const loansRows = await env.DB
        .prepare('SELECT * FROM loans WHERE library_id = ? AND updated_at > ?')
        .bind(payload.libraryId, since)
        .all();

      const readingRows = await env.DB
        .prepare('SELECT * FROM reading_statuses WHERE library_id = ? AND updated_at > ?')
        .bind(payload.libraryId, since)
        .all();

      const response: SyncDeltaResponse = {
        serverTimestamp: now,
        items: (itemsRows.results as unknown as SyncDeltaResponse['items']) || [],
        loans: (loansRows.results as unknown as SyncDeltaResponse['loans']) || [],
        readingStatuses: (readingRows.results as unknown as SyncDeltaResponse['readingStatuses']) || [],
        works: [],
        editions: [],
        series: []
      };

      return jsonResponse(response);
    }

    return jsonResponse({ error: `Route V2 inconnue: ${method} /api/v2/${path}` }, 404);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur interne du serveur';
    return jsonResponse({ error: message }, 500);
  }
}
