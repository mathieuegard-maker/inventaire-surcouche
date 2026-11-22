// src/core/services/v2-backend-router.service.ts
// Routeur Backend V2 100% standard Web (Request -> Response) et DRY.
// Tourne à l'identique sur :
// - Cloudflare Pages Functions (D1 + R2)
// - En local dans Vite / Wrangler
// - En auto-hébergement Docker / Node.js (Plan B)

import type { AppBackendEnv } from '../adapters/storage-db.interface';
import type { SyncDeltaRequest, SyncDeltaResponse } from '../domain/v2.types';
import { resolveAuthSession } from './d1-gateway.service';
import { PipelineTracer, type PipelineLayer, type PipelineStepStatus } from './pipeline-logger.service';
import {
  addGenresToBooksOptionB,
  drainEnrichmentQueueBatch,
  excludeBookFromSeriesForLibrary,
  getV4SeriesBooks,
  runV4IngestionPipeline,
  searchLocalBooksForCanal3,
  syncV4LibraryBooks,
  updateV4BookMetadata,
  type SourceChannel,
  type UserIngestHint
} from './v4-pipeline.service';
import {
  getUserDefaultGenres,
  getUserReadingStatus,
  listUserReadingStatuses,
  updateUserDefaultGenres,
  upsertUserReadingStatus
} from './user-preferences.service';
import { resolveBookHintsCanal3 } from './canal3-resolver.service';
import { searchCatalogExhaustive } from './catalog-search.service';
import {
  clearUserPhotoScanJobs,
  createPhotoScanJob,
  deleteUserPhotoScanJob,
  listUserPhotoScanJobs,
  retryUserFailedPhotoScanJobs
} from './photo-scan-jobs.service';

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
      if (env.DB) {
        const auth = await resolveAuthSession(env.DB, request, null);
        if (!auth) {
          return jsonResponse({ error: 'Authentification requise' }, 401);
        }
      }
      const key = decodeURIComponent(path.slice('covers/'.length));
      if (!/^covers\/(isbn|url)\/[a-zA-Z0-9_-]+$/.test(key)) {
        return jsonResponse({ error: 'Clé de couverture invalide' }, 400);
      }
      const rawContentType = (request.headers.get('Content-Type') || 'image/webp').split(';')[0].trim().toLowerCase();
      if (!/^image\/(webp|jpeg|png|gif|avif)$/.test(rawContentType)) {
        return jsonResponse({ error: 'Format image raster requis (webp, jpeg, png)' }, 400);
      }
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > 500 * 1024) {
        return jsonResponse({ error: 'Image trop volumineuse (max 500 Ko après compression WebP)' }, 413);
      }
      await env.COVERS_BUCKET.put(key, buffer, {
        httpMetadata: {
          contentType: rawContentType,
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
      const auth = await resolveAuthSession(env.DB, request, payload.libraryId);
      if (!auth || auth.libraryId !== payload.libraryId) {
        return jsonResponse({ error: 'Authentification requise' }, 401);
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
        .prepare('SELECT * FROM reading_statuses WHERE library_id = ? AND user_id = ? AND updated_at > ?')
        .bind(payload.libraryId, auth.userId, since)
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

    // 5. Canal 3 (V4) : Recherche textuelle sur le catalogue serveur D1 AVANT appels API externes
    if (path === 'books/search-local' && method === 'GET') {
      if (!env.DB) {
        return jsonResponse({ error: 'Base D1 non configurée' }, 503);
      }
      const hits = await searchLocalBooksForCanal3(env.DB, {
        q: url.searchParams.get('q') || undefined,
        title: url.searchParams.get('title') || undefined,
        author: url.searchParams.get('author') || undefined,
        series: url.searchParams.get('series') || undefined,
        volumeNumber: url.searchParams.get('volumeNumber') || undefined,
        limit: Number(url.searchParams.get('limit') || 10)
      });
      return jsonResponse({ hits });
    }

    // 5C. Recherche Catalogue Exhaustive (Séries + Œuvres) — dédiée à la Recherche textuelle & Auteur
    if (path === 'books/search-catalog' && method === 'POST') {
      if (!env.DB) {
        return jsonResponse({ error: 'Base non configurée' }, 503);
      }
      const payload = (await request.json().catch(() => ({}))) as {
        q?: string;
        title?: string;
        series?: string;
        volumeNumber?: string;
        author?: string;
        edition?: string;
        publisher?: string;
        userUri?: string;
      };
      const auth = await resolveAuthSession(
        env.DB,
        request,
        typeof payload.userUri === 'string' ? payload.userUri : null
      );
      const res = await searchCatalogExhaustive(env.DB, payload, auth?.libraryId || null);
      return jsonResponse({ ok: true, ...res });
    }

    // 6. Contrat Pivot V4 (Couches 1 -> 5) : Ingestion d'ISBNs vers Index O(1), Découverte C3, Consolidation C4 et Série C5
    if (path === 'books/ingest' && method === 'POST') {
      if (!env.DB) {
        return jsonResponse({ error: 'Base D1 non configurée' }, 503);
      }
      const payload = (await request.json().catch(() => ({}))) as {
        isbns?: unknown;
        isbn?: unknown;
        source_channel?: unknown;
        action?: unknown;
        libraryId?: unknown;
        userUri?: unknown;
        traceId?: unknown;
        hints?: Record<string, UserIngestHint>;
      };

      const auth = await resolveAuthSession(
        env.DB,
        request,
        typeof payload.userUri === 'string' ? payload.userUri : null
      );
      const rawIsbns = Array.isArray(payload.isbns)
        ? payload.isbns.map(String)
        : payload.isbn
          ? [String(payload.isbn)]
          : [];
      if (rawIsbns.length === 0) {
        return jsonResponse({ error: 'Paramètre isbns requis' }, 400);
      }

      const validChannels: SourceChannel[] = [
        'canal_1_barcode',
        'canal_2_manual_isbn',
        'canal_3_text_search',
        'canal_4_ai_photo'
      ];
      const sourceChannel: SourceChannel = validChannels.includes(payload.source_channel as SourceChannel)
        ? (payload.source_channel as SourceChannel)
        : 'canal_2_manual_isbn';

      const action =
        payload.action === 'owned' || payload.action === 'wishlist' || payload.action === 'preview'
          ? payload.action
          : 'preview';

      const result = await runV4IngestionPipeline(env.DB, {
        isbns: rawIsbns,
        sourceChannel,
        libraryId: auth?.libraryId || (typeof payload.libraryId === 'string' ? payload.libraryId : null),
        userId: auth?.userId || null,
        action,
        traceId: typeof payload.traceId === 'string' ? payload.traceId : undefined,
        hints: payload.hints && typeof payload.hints === 'object' ? payload.hints : undefined
      });
      return jsonResponse(result);
    }

    // 6B. Canal 3 Back-End : Résolution Texte / OCR -> ISBN-13 FR + alternatives d'éditions (Passe 1 D1 -> Passe 2 multi-sources)
    if (path === 'books/resolve-hints' && method === 'POST') {
      if (!env.DB) {
        return jsonResponse({ error: 'Base D1 non configurée' }, 503);
      }
      const payload = (await request.json().catch(() => ({}))) as {
        hints?: {
          title?: string;
          subtitle?: string;
          series?: string;
          volumeNumber?: string;
          author?: string;
          illustrator?: string;
          publisher?: string;
          collection?: string;
          rawSpineText?: string;
        };
        aiConfidence?: 'high' | 'medium' | 'low';
        source_channel?: SourceChannel;
        userUri?: string;
        skipLocalD1?: boolean;
      };
      if (!payload.hints || typeof payload.hints !== 'object') {
        return jsonResponse({ error: 'Objet hints requis' }, 400);
      }
      const auth = await resolveAuthSession(
        env.DB,
        request,
        typeof payload.userUri === 'string' ? payload.userUri : null
      );
      const resolved = await resolveBookHintsCanal3(env.DB, payload.hints, {
        aiConfidence: payload.aiConfidence,
        sourceChannel: payload.source_channel || 'canal_4_ai_photo',
        userId: auth?.userId || null,
        skipLocalD1: Boolean(payload.skipLocalD1)
      });
      return jsonResponse(resolved);
    }

    // 6C. Synchro différentielle V4 pure (books + v4_library_books + tomes des séries suivies)
    if (path === 'books/sync' && method === 'GET') {
      if (!env.DB) {
        return jsonResponse({ error: 'Base D1 non configurée' }, 503);
      }
      const userUriParam = url.searchParams.get('userUri');
      const auth = await resolveAuthSession(env.DB, request, userUriParam);
      if (!auth?.libraryId) {
        return jsonResponse({ error: 'Authentification requise' }, 401);
      }
      const since = url.searchParams.get('since');
      const syncData = await syncV4LibraryBooks(env.DB, {
        libraryId: auth.libraryId,
        since
      });
      return jsonResponse(syncData);
    }

    // 6D. Lecture V4 pure d'une série (tous les tomes consolidés de `books` sans passer par V2 catalog_entities)
    if (path.startsWith('books/series/') && method === 'GET') {
      if (!env.DB) {
        return jsonResponse({ error: 'Base D1 non configurée' }, 503);
      }
      const seriesId = decodeURIComponent(path.slice('books/series/'.length)).trim();
      if (!seriesId) {
        return jsonResponse({ error: 'Identifiant de série requis' }, 400);
      }
      const userUriParam = url.searchParams.get('userUri');
      const forceEnrich = url.searchParams.get('force') === '1';
      const auth = await resolveAuthSession(env.DB, request, userUriParam);
      if (forceEnrich) {
        await env.DB
          .prepare('UPDATE v4_series SET is_complete_expanded = 0 WHERE id = ?')
          .bind(seriesId)
          .run()
          .catch(() => {});
      }
      const seriesData = await getV4SeriesBooks(env.DB, {
        seriesId,
        libraryId: auth?.libraryId || null
      });
      if (forceEnrich) {
        await drainEnrichmentQueueBatch(env.DB, 6).catch(() => {});
        const refreshed = await getV4SeriesBooks(env.DB, {
          seriesId,
          libraryId: auth?.libraryId || null
        });
        return jsonResponse(refreshed);
      }
      return jsonResponse(seriesData);
    }

    // 6E. Mise à jour manuelle d'une fiche livre V4 (BookEdit.vue -> tables books & v4_library_books)
    if (path === 'books/update' && (method === 'PATCH' || method === 'POST')) {
      if (!env.DB) {
        return jsonResponse({ error: 'Base D1 non configurée' }, 503);
      }
      const payload = (await request.json().catch(() => ({}))) as {
        bookId?: string;
        uri?: string;
        isbn13?: string;
        userUri?: string;
        title?: string;
        authors?: string[];
        series?: string;
        seriesId?: string | null;
        seriesNumber?: string;
        isIntegral?: boolean;
        includedVolumeNumbers?: string[];
        publisher?: string;
        publishDate?: string;
        coverUrl?: string;
        genres?: string[];
      };
      const auth = await resolveAuthSession(
        env.DB,
        request,
        typeof payload.userUri === 'string' ? payload.userUri : null
      );
      if (!auth) {
        return jsonResponse({ error: 'Authentification requise' }, 401);
      }
      const updated = await updateV4BookMetadata(env.DB, {
        bookId: payload.bookId,
        uri: payload.uri,
        isbn13: payload.isbn13,
        libraryId: auth.libraryId,
        title: payload.title,
        authors: payload.authors,
        series: payload.series,
        seriesId: payload.seriesId,
        seriesNumber: payload.seriesNumber,
        isIntegral: payload.isIntegral,
        includedVolumeNumbers: Array.isArray(payload.includedVolumeNumbers)
          ? payload.includedVolumeNumbers.map(String)
          : undefined,
        publisher: payload.publisher,
        publishDate: payload.publishDate,
        coverUrl: payload.coverUrl,
        genres: payload.genres
      });
      return jsonResponse({ ok: Boolean(updated), book: updated });
    }

    // 6F. Option B : Exclure / masquer un tome d'une série uniquement pour le foyer courant
    if (path === 'books/exclude-from-series' && method === 'POST') {
      if (!env.DB) {
        return jsonResponse({ error: 'Base D1 non configurée' }, 503);
      }
      const payload = (await request.json().catch(() => ({}))) as {
        seriesId?: string;
        bookId?: string;
        uri?: string;
        isbn13?: string;
        detachOwned?: boolean;
        userUri?: string;
      };
      const auth = await resolveAuthSession(
        env.DB,
        request,
        typeof payload.userUri === 'string' ? payload.userUri : null
      );
      if (!auth?.libraryId) {
        return jsonResponse({ error: 'Authentification requise' }, 401);
      }
      if (!payload.seriesId) {
        return jsonResponse({ error: 'seriesId requis' }, 400);
      }
      const updated = await excludeBookFromSeriesForLibrary(env.DB, {
        libraryId: auth.libraryId,
        seriesId: payload.seriesId,
        bookId: payload.bookId,
        uri: payload.uri,
        isbn13: payload.isbn13,
        detachOwned: Boolean(payload.detachOwned)
      });
      return jsonResponse({ ok: Boolean(updated), book: updated });
    }

    // 7. Observabilité V4 : Enregistrement des logs détaillés d'appels API émis par Couche 1 / Canal 3 côté client
    if (path === 'logs/client' && method === 'POST') {
      if (!env.DB) {
        return jsonResponse({ error: 'Base D1 non configurée' }, 503);
      }
      const payload = (await request.json().catch(() => ({}))) as {
        traceId?: string;
        sourceChannel?: string;
        userUri?: string;
        steps?: Array<{
          layer?: PipelineLayer;
          stepName?: string;
          status?: PipelineStepStatus;
          summary?: string;
          payload?: unknown;
          durationMs?: number;
        }>;
      };
      const auth = await resolveAuthSession(
        env.DB,
        request,
        typeof payload.userUri === 'string' ? payload.userUri : null
      );
      if (!auth) {
        return jsonResponse({ error: 'Authentification requise' }, 401);
      }
      const steps = Array.isArray(payload.steps) ? payload.steps.slice(0, 40) : [];
      if (steps.length > 0) {
        const tracer = new PipelineTracer({
          traceId: typeof payload.traceId === 'string' && payload.traceId ? payload.traceId : undefined,
          userId: auth.userId,
          sourceChannel: payload.sourceChannel || 'canal_3_text_search'
        });
        for (const s of steps) {
          tracer.record(
            s.layer || 'C3',
            String(s.stepName || 'client_api').slice(0, 80),
            s.status === 'error' || s.status === 'warn' ? s.status : 'ok',
            String(s.summary || 'Requête API client'),
            s.payload,
            s.durationMs
          );
        }
        await tracer.flush(env.DB);
        return jsonResponse({ ok: true, traceId: tracer.traceId, recorded: steps.length });
      }
      return jsonResponse({ ok: true, recorded: 0 });
    }

    // 8. Traitement Photo IA en tâche de fond côté serveur (isolé par utilisateur / foyer)
    if (path === 'photo-jobs' && method === 'POST') {
      if (!env.DB) return jsonResponse({ error: 'Base non configurée' }, 503);
      const payload = (await request.json().catch(() => ({}))) as {
        mode?: 'cover' | 'shelf';
        imageDataUrl?: string;
        mimeType?: string;
        userUri?: string;
      };
      const auth = await resolveAuthSession(
        env.DB,
        request,
        typeof payload.userUri === 'string' ? payload.userUri : null
      );
      if (!auth) return jsonResponse({ error: 'Authentification requise' }, 401);
      if (!payload.imageDataUrl || typeof payload.imageDataUrl !== 'string') {
        return jsonResponse({ error: 'imageDataUrl requis' }, 400);
      }
      const job = await createPhotoScanJob(env.DB, env, {
        userId: auth.userId,
        libraryId: auth.libraryId,
        mode: payload.mode === 'cover' ? 'cover' : 'shelf',
        imageDataUrl: payload.imageDataUrl,
        mimeType: payload.mimeType
      });
      return jsonResponse({ ok: true, job }, 202);
    }

    if (path === 'photo-jobs' && method === 'GET') {
      if (!env.DB) return jsonResponse({ error: 'Base non configurée' }, 503);
      const userUriParam = url.searchParams.get('userUri');
      const auth = await resolveAuthSession(env.DB, request, userUriParam);
      if (!auth) return jsonResponse({ error: 'Authentification requise' }, 401);
      const jobs = await listUserPhotoScanJobs(env.DB, auth.userId);
      return jsonResponse({ ok: true, jobs });
    }

    if (path === 'photo-jobs/retry' && method === 'POST') {
      if (!env.DB) return jsonResponse({ error: 'Base non configurée' }, 503);
      const payload = (await request.json().catch(() => ({}))) as { userUri?: string };
      const auth = await resolveAuthSession(
        env.DB,
        request,
        typeof payload.userUri === 'string' ? payload.userUri : null
      );
      if (!auth) return jsonResponse({ error: 'Authentification requise' }, 401);
      const retried = await retryUserFailedPhotoScanJobs(env.DB, env, auth.userId);
      return jsonResponse({ ok: true, retried });
    }

    if (path === 'photo-jobs' && method === 'DELETE') {
      if (!env.DB) return jsonResponse({ error: 'Base non configurée' }, 503);
      const userUriParam = url.searchParams.get('userUri');
      const auth = await resolveAuthSession(env.DB, request, userUriParam);
      if (!auth) return jsonResponse({ error: 'Authentification requise' }, 401);
      await clearUserPhotoScanJobs(env.DB, auth.userId);
      return jsonResponse({ ok: true });
    }

    if (path.startsWith('photo-jobs/') && method === 'DELETE') {
      if (!env.DB) return jsonResponse({ error: 'Base non configurée' }, 503);
      const jobId = decodeURIComponent(path.slice('photo-jobs/'.length));
      const userUriParam = url.searchParams.get('userUri');
      const auth = await resolveAuthSession(env.DB, request, userUriParam);
      if (!auth) return jsonResponse({ error: 'Authentification requise' }, 401);
      await deleteUserPhotoScanJob(env.DB, auth.userId, jobId);
      return jsonResponse({ ok: true });
    }

    // 9. Statut de lecture, note & notes personnelles STRICTEMENT individuels par compte (`user_id`)
    if (path === 'reading-status' && method === 'GET') {
      if (!env.DB) return jsonResponse({ error: 'Base non configurée' }, 503);
      const auth = await resolveAuthSession(env.DB, request, url.searchParams.get('userUri'));
      if (!auth) return jsonResponse({ error: 'Authentification requise' }, 401);
      const workId = (url.searchParams.get('workId') || '').trim();
      if (workId) {
        const record = await getUserReadingStatus(env.DB, auth.userId, auth.libraryId, workId);
        return jsonResponse({ ok: true, record });
      }
      const records = await listUserReadingStatuses(env.DB, auth.userId, auth.libraryId);
      return jsonResponse({ ok: true, records });
    }

    if (path === 'reading-status' && (method === 'PUT' || method === 'POST')) {
      if (!env.DB) return jsonResponse({ error: 'Base non configurée' }, 503);
      const payload = (await request.json().catch(() => ({}))) as {
        workId?: string;
        status?: string;
        rating?: number | null;
        personalNotes?: string | null;
        userUri?: string;
      };
      const auth = await resolveAuthSession(
        env.DB,
        request,
        typeof payload.userUri === 'string' ? payload.userUri : null
      );
      if (!auth) return jsonResponse({ error: 'Authentification requise' }, 401);
      const workId = String(payload.workId || '').trim();
      if (!workId) return jsonResponse({ error: 'workId requis' }, 400);
      const record = await upsertUserReadingStatus(env.DB, {
        userId: auth.userId,
        libraryId: auth.libraryId,
        workId,
        status: payload.status || 'none',
        rating: payload.rating,
        personalNotes: payload.personalNotes
      });
      return jsonResponse({ ok: true, record });
    }

    // 10. Genres par défaut personnalisés par compte (`user_default_genres`)
    if (path === 'user-genres' && method === 'GET') {
      if (!env.DB) return jsonResponse({ error: 'Base non configurée' }, 503);
      const auth = await resolveAuthSession(env.DB, request, url.searchParams.get('userUri'));
      if (!auth) return jsonResponse({ error: 'Authentification requise' }, 401);
      const res = await getUserDefaultGenres(env.DB, auth.userId);
      return jsonResponse({ ok: true, ...res });
    }

    if (path === 'user-genres' && method === 'POST') {
      if (!env.DB) return jsonResponse({ error: 'Base non configurée' }, 503);
      const payload = (await request.json().catch(() => ({}))) as {
        action?: 'add' | 'remove' | 'reset';
        genre?: string;
        userUri?: string;
      };
      const auth = await resolveAuthSession(
        env.DB,
        request,
        typeof payload.userUri === 'string' ? payload.userUri : null
      );
      if (!auth) return jsonResponse({ error: 'Authentification requise' }, 401);
      const action = payload.action === 'remove' || payload.action === 'reset' ? payload.action : 'add';
      const res = await updateUserDefaultGenres(env.DB, auth.userId, action, payload.genre);
      return jsonResponse({ ok: true, ...res });
    }

    // 11. Ajout cumulatif de genre(s) en lot sur N livres (Option B isolée au foyer)
    if (path === 'books/batch-genres' && method === 'POST') {
      if (!env.DB) return jsonResponse({ error: 'Base non configurée' }, 503);
      const payload = (await request.json().catch(() => ({}))) as {
        bookUris?: string[];
        genres?: string[];
        userUri?: string;
      };
      const auth = await resolveAuthSession(
        env.DB,
        request,
        typeof payload.userUri === 'string' ? payload.userUri : null
      );
      if (!auth) return jsonResponse({ error: 'Authentification requise' }, 401);
      const res = await addGenresToBooksOptionB(env.DB, {
        libraryId: auth.libraryId,
        bookUris: Array.isArray(payload.bookUris) ? payload.bookUris : [],
        genres: Array.isArray(payload.genres) ? payload.genres : []
      });
      return jsonResponse({ ok: true, ...res });
    }

    return jsonResponse({ error: `Route V2 inconnue: ${method} /api/v2/${path}` }, 404);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur interne du serveur';
    return jsonResponse({ error: message }, 500);
  }
}
