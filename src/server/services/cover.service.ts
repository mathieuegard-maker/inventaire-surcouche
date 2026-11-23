// src/server/services/cover.service.ts
// Gestionnaire unique de couvertures WebP sur disque (/data/covers/) — ZÉRO blob/base64 dans SQLite.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { CatalogRepository, CoverRow } from '../repositories/catalog.repo';
import type { LibraryRepository } from '../repositories/library.repo';
import { AppError } from '../middleware/error.middleware';

const SAFE_COVER_KEY_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024; // 12 Mo brut max avant compression WebP

export interface StoredCoverResult {
  coverKey: string;
  coverUrl: string;
  byteSize: number;
  reused: boolean;
}

export class CoverService {
  private readonly coversDir: string;
  private readonly catalogRepo: CatalogRepository;
  private readonly libraryRepo: LibraryRepository;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: {
    coversDir: string;
    catalogRepo: CatalogRepository;
    libraryRepo: LibraryRepository;
    fetchImpl?: typeof fetch;
  }) {
    this.coversDir = path.resolve(deps.coversDir);
    this.catalogRepo = deps.catalogRepo;
    this.libraryRepo = deps.libraryRepo;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  private async ensureCoversDir(): Promise<void> {
    await fs.mkdir(this.coversDir, { recursive: true });
  }

  private async compressToWebp(inputBuffer: Buffer): Promise<Buffer> {
    try {
      return await sharp(inputBuffer, { failOn: 'none' })
        .rotate()
        .resize({
          width: 420,
          height: 640,
          fit: 'inside',
          withoutEnlargement: true
        })
        .webp({ quality: 78, effort: 4 })
        .toBuffer();
    } catch {
      throw new AppError(400, 'INVALID_IMAGE', 'Image invalide ou non décodable.');
    }
  }

  /**
   * Compresse un buffer brut en WebP, déduplique par SHA-256 et persiste sur `/data/covers/`.
   */
  async storeBufferAsWebp(rawBuffer: Buffer, sourceUrl: string | null = null): Promise<StoredCoverResult> {
    if (!rawBuffer || rawBuffer.length === 0) {
      throw new AppError(400, 'EMPTY_IMAGE', 'Image vide.');
    }
    if (rawBuffer.length > MAX_UPLOAD_BYTES) {
      throw new AppError(413, 'IMAGE_TOO_LARGE', 'Image trop volumineuse (max 12 Mo).');
    }

    const webpBuffer = await this.compressToWebp(rawBuffer);
    const sha256 = crypto.createHash('sha256').update(webpBuffer).digest('hex');
    const now = new Date().toISOString();

    const existing = this.catalogRepo.findCoverBySha256(sha256);
    if (existing) {
      this.catalogRepo.touchCoverReference(existing.cover_key, now);
      return {
        coverKey: existing.cover_key,
        coverUrl: `/api/covers/${existing.cover_key}`,
        byteSize: existing.byte_size,
        reused: true
      };
    }

    await this.ensureCoversDir();
    const coverKey = `cov_${sha256.slice(0, 20)}`;
    const filename = `${coverKey}.webp`;
    const fullPath = path.join(this.coversDir, filename);

    await fs.writeFile(fullPath, webpBuffer);

    const row: CoverRow = {
      cover_key: coverKey,
      file_path: filename,
      source_url: sourceUrl,
      mime_type: 'image/webp',
      byte_size: webpBuffer.length,
      sha256,
      created_at: now,
      last_referenced_at: now
    };
    this.catalogRepo.upsertCover(row);

    return {
      coverKey,
      coverUrl: `/api/covers/${coverKey}`,
      byteSize: webpBuffer.length,
      reused: false
    };
  }

  /**
   * Stocke une couverture uploadée depuis le client (Data URL base64).
   */
  async storeDataUrlAsWebp(dataUrl: string): Promise<StoredCoverResult> {
    const match = dataUrl.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match) {
      throw new AppError(400, 'INVALID_DATA_URL', 'Format data URL image invalide.');
    }
    const rawBuffer = Buffer.from(match[1], 'base64');
    return this.storeBufferAsWebp(rawBuffer, null);
  }

  /**
   * Télécharge une couverture externe une seule fois, la compresse en WebP et la stocke sur disque.
   * Retourne `null` si l'URL distante est indisponible ou trop petite (pixel transparent / placeholder 1x1).
   */
  async ingestFromExternalUrl(url: string): Promise<StoredCoverResult | null> {
    const cleanUrl = (url || '').trim();
    if (!cleanUrl || (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://'))) {
      return null;
    }

    const existingByUrl = this.catalogRepo.findCoverBySourceUrl(cleanUrl);
    if (existingByUrl) {
      const now = new Date().toISOString();
      this.catalogRepo.touchCoverReference(existingByUrl.cover_key, now);
      return {
        coverKey: existingByUrl.cover_key,
        coverUrl: `/api/covers/${existingByUrl.cover_key}`,
        byteSize: existingByUrl.byte_size,
        reused: true
      };
    }

    try {
      const res = await this.fetchImpl(cleanUrl, {
        headers: { 'User-Agent': 'BiblioCollection/2.0 (cover-fetcher)' },
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) return null;

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (contentType && !contentType.startsWith('image/')) {
        return null;
      }

      const arrayBuf = await res.arrayBuffer();
      const rawBuf = Buffer.from(arrayBuf);
      // Rejette les pixels vides / placeholders < 500 octets
      if (rawBuf.length < 500 || rawBuf.length > MAX_UPLOAD_BYTES) {
        return null;
      }

      const meta = await sharp(rawBuf, { failOn: 'none' }).metadata();
      if (!meta.width || !meta.height || meta.width < 40 || meta.height < 40) {
        return null;
      }

      return await this.storeBufferAsWebp(rawBuf, cleanUrl);
    } catch {
      return null;
    }
  }

  /**
   * Lit le fichier binaire WebP depuis `/data/covers/` pour `GET /api/covers/:coverKey`.
   */
  async readCoverBinary(coverKey: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    if (!SAFE_COVER_KEY_RE.test(coverKey)) {
      return null;
    }
    const row = this.catalogRepo.findCoverByKey(coverKey);
    if (!row) return null;

    const fullPath = path.join(this.coversDir, path.basename(row.file_path));
    try {
      const buffer = await fs.readFile(fullPath);
      return { buffer, mimeType: row.mime_type || 'image/webp' };
    } catch {
      return null;
    }
  }

  /**
   * Purge nocturne des couvertures orphelines (> 30 jours sans aucune référence Catalogue ou Couche 3 Foyer).
   */
  async purgeOrphanCovers(olderThanDays = 30, nowMs = Date.now()): Promise<{ deletedCount: number; freedBytes: number }> {
    const cutoffIso = new Date(nowMs - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const candidates = this.catalogRepo.listCoversOlderThan(cutoffIso);
    if (candidates.length === 0) {
      return { deletedCount: 0, freedBytes: 0 };
    }

    const overrideRefs = this.libraryRepo.listReferencedCoverKeysInOverrides();
    let deletedCount = 0;
    let freedBytes = 0;

    for (const cov of candidates) {
      if (overrideRefs.has(cov.cover_key)) continue;

      const fullPath = path.join(this.coversDir, path.basename(cov.file_path));
      try {
        await fs.unlink(fullPath);
      } catch {
        // fichier déjà absent sur disque
      }
      this.catalogRepo.deleteCover(cov.cover_key);
      deletedCount++;
      freedBytes += cov.byte_size;
    }

    return { deletedCount, freedBytes };
  }
}
