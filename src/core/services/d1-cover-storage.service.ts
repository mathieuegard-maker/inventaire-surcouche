// src/core/services/d1-cover-storage.service.ts
// Stockage centralisé et scalabilité des couvertures (Cloudflare R2 10 Go prioritaire + repli Cloudflare D1 catalog_covers)

import type { AppBackendEnv } from '../adapters/storage-db.interface';
import { isbnUtil } from '../utils/isbn.util';

const MAX_CENTRAL_COVER_BYTES_D1 = 260 * 1024; // ~260 Ko max par vignette WebP/JPEG en D1
const MAX_CENTRAL_COVER_BYTES_R2 = 2 * 1024 * 1024; // 2 Mo max en R2

export interface StoredCoverResult {
  bytes: ArrayBuffer | Uint8Array;
  contentType: string;
  storage: 'r2' | 'd1';
  key: string;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    let part = '';
    for (let j = 0; j < slice.length; j++) {
      part += String.fromCharCode(slice[j]);
    }
    binary += part;
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function parseCoverDataUrl(
  dataUrl: string
): { contentType: string; base64: string; bytes: Uint8Array } | null {
  const match = /^data:(image\/(?:webp|jpeg|png|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(
    (dataUrl || '').trim()
  );
  if (!match) return null;
  try {
    const contentType = match[1].toLowerCase();
    const base64 = match[2];
    const bytes = base64ToBytes(base64);
    if (bytes.byteLength < 100 || bytes.byteLength > MAX_CENTRAL_COVER_BYTES_R2) {
      return null;
    }
    return { contentType, base64, bytes };
  } catch {
    return null;
  }
}

async function hashUrlHex(rawUrl: string): Promise<string> {
  const data = new TextEncoder().encode(rawUrl.trim());
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function buildCoverLookupKeys(params: {
  isbn?: string | null;
  url?: string | null;
}): Promise<{ primaryKey?: string; urlKey?: string; cleanIsbn13?: string }> {
  let cleanIsbn13 = '';
  if (params.isbn) {
    const norm = isbnUtil.normalize(params.isbn);
    cleanIsbn13 = norm.length === 10 ? isbnUtil.toIsbn13(norm) : norm;
  }
  const primaryKey =
    cleanIsbn13.length === 13 ? `covers/isbn/${cleanIsbn13}` : undefined;
  const urlKey =
    params.url && params.url.trim() && !params.url.trim().startsWith('data:')
      ? `covers/url/${await hashUrlHex(params.url.trim())}`
      : undefined;

  return {
    primaryKey,
    urlKey,
    cleanIsbn13: cleanIsbn13.length === 13 ? cleanIsbn13 : undefined
  };
}

export async function getStoredCover(
  env: AppBackendEnv | undefined,
  params: { isbn?: string | null; url?: string | null }
): Promise<StoredCoverResult | null> {
  if (!env) return null;
  const { primaryKey, urlKey, cleanIsbn13 } = await buildCoverLookupKeys(params);
  const candidateKeys = [primaryKey, urlKey].filter((k): k is string => Boolean(k));
  if (candidateKeys.length === 0) return null;

  // 1. Lecture prioritaire sur Cloudflare R2 si le bucket est activé et lié
  if (env.COVERS_BUCKET) {
    for (const key of candidateKeys) {
      try {
        const obj = await env.COVERS_BUCKET.get(key);
        if (obj) {
          const bytes =
            typeof obj.arrayBuffer === 'function'
              ? await obj.arrayBuffer()
              : obj.body
                ? await new Response(obj.body).arrayBuffer()
                : new ArrayBuffer(0);
          if (bytes.byteLength >= 100) {
            return {
              bytes,
              contentType: obj.httpMetadata?.contentType || 'image/webp',
              storage: 'r2',
              key
            };
          }
        }
      } catch {
        // Repli D1 en cas d'indisponibilité R2
      }
    }
  }

  // 2. Repli Cloudflare D1 (table catalog_covers)
  if (env.DB) {
    try {
      for (const key of candidateKeys) {
        const row = await env.DB.prepare(
          'SELECT cover_key, content_type, image_data FROM catalog_covers WHERE cover_key = ? LIMIT 1'
        )
          .bind(key)
          .first<{ cover_key: string; content_type: string; image_data: string }>();
        if (row?.image_data) {
          return {
            bytes: base64ToBytes(row.image_data),
            contentType: row.content_type || 'image/webp',
            storage: 'd1',
            key: row.cover_key
          };
        }
      }
      if (cleanIsbn13) {
        const byIsbn = await env.DB.prepare(
          'SELECT cover_key, content_type, image_data FROM catalog_covers WHERE isbn13 = ? LIMIT 1'
        )
          .bind(cleanIsbn13)
          .first<{ cover_key: string; content_type: string; image_data: string }>();
        if (byIsbn?.image_data) {
          return {
            bytes: base64ToBytes(byIsbn.image_data),
            contentType: byIsbn.content_type || 'image/webp',
            storage: 'd1',
            key: byIsbn.cover_key
          };
        }
      }
    } catch {
      // Table catalog_covers pas encore migrée : ignorer sans bloquer
    }
  }

  return null;
}

export async function storeCompressedCover(
  env: AppBackendEnv | undefined,
  params: {
    isbn?: string | null;
    url?: string | null;
    contentType: string;
    bytes: Uint8Array;
    base64Data?: string;
  }
): Promise<{ ok: boolean; storage?: 'r2' | 'd1'; key?: string; byteSize?: number }> {
  if (!env || params.bytes.byteLength < 100) {
    return { ok: false };
  }

  const { primaryKey, urlKey, cleanIsbn13 } = await buildCoverLookupKeys({
    isbn: params.isbn,
    url: params.url
  });
  const targetKey = primaryKey || urlKey;
  if (!targetKey) return { ok: false };

  // 1. Écriture prioritaire vers R2 (10 Go gratuits + scalable)
  if (env.COVERS_BUCKET && params.bytes.byteLength <= MAX_CENTRAL_COVER_BYTES_R2) {
    try {
      await env.COVERS_BUCKET.put(targetKey, params.bytes, {
        httpMetadata: {
          contentType: params.contentType,
          cacheControl: 'public, max-age=31536000, immutable'
        }
      });
      if (urlKey && urlKey !== targetKey) {
        await env.COVERS_BUCKET.put(urlKey, params.bytes, {
          httpMetadata: {
            contentType: params.contentType,
            cacheControl: 'public, max-age=31536000, immutable'
          }
        }).catch(() => {});
      }
      return {
        ok: true,
        storage: 'r2',
        key: targetKey,
        byteSize: params.bytes.byteLength
      };
    } catch {
      // Repli vers D1 si R2 échoue
    }
  }

  // 2. Repli vers Cloudflare D1 (catalog_covers) pour les vignettes compressées (<= 260 Ko)
  if (env.DB && params.bytes.byteLength <= MAX_CENTRAL_COVER_BYTES_D1) {
    try {
      const b64 = params.base64Data || bytesToBase64(params.bytes);
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO catalog_covers (cover_key, isbn13, content_type, image_data, byte_size, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(cover_key) DO UPDATE SET
           isbn13 = COALESCE(excluded.isbn13, catalog_covers.isbn13),
           content_type = excluded.content_type,
           image_data = excluded.image_data,
           byte_size = excluded.byte_size,
           updated_at = excluded.updated_at`
      )
        .bind(
          targetKey,
          cleanIsbn13 || null,
          params.contentType,
          b64,
          params.bytes.byteLength,
          now
        )
        .run();

      return {
        ok: true,
        storage: 'd1',
        key: targetKey,
        byteSize: params.bytes.byteLength
      };
    } catch {
      return { ok: false };
    }
  }

  return { ok: false };
}
