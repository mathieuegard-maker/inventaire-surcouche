// src/server/services/cover.service.ts
// Gestionnaire unique de couvertures WebP sur disque (/data/covers/) — ZÉRO blob/base64 dans SQLite.
// Cascade multi-sources vérifiée : BnF 950$a -> Inventaire invp:P2 -> Amazon ISBN-10 -> Eyrolles/Dilicom H1400 -> iTunes FR -> OpenLibrary.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import sharp from 'sharp';
import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import type { CatalogRepository, CoverRow } from '../repositories/catalog.repo';
import type { LibraryRepository } from '../repositories/library.repo';
import { AppError } from '../middleware/error.middleware';

const SAFE_COVER_KEY_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024; // 12 Mo brut max avant compression WebP
const EYROLLES_PLACEHOLDER_BYTES = 63601;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) BiblioCollection/2.0 Safari/537.36';

export interface StoredCoverResult {
  coverKey: string;
  coverUrl: string;
  byteSize: number;
  reused: boolean;
}

export interface CoverCascadeInput {
  isbn13?: string | null;
  candidateUrls?: string[];
  title?: string;
  author?: string;
  /** Évite l'appel iTunes par titre lors des déploiements massifs de séries (garde la cascade ISBN rapide). */
  skipTitleFallback?: boolean;
}

function fetchBinaryIpv4(
  urlStr: string,
  timeoutMs = 8000,
  redirectsLeft = 3
): Promise<{ status: number; contentType: string; buffer: Buffer } | null> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(urlStr);
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.get(
        {
          hostname: parsed.hostname,
          port: parsed.port || undefined,
          path: `${parsed.pathname}${parsed.search}`,
          family: 4,
          headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'image/*,*/*;q=0.8' },
          timeout: timeoutMs
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const location = res.headers.location;
          if (location && status >= 300 && status < 400 && redirectsLeft > 0) {
            res.resume();
            const nextUrl = new URL(location, parsed).toString();
            fetchBinaryIpv4(nextUrl, timeoutMs, redirectsLeft - 1).then(resolve);
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            resolve(null);
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total <= MAX_UPLOAD_BYTES) chunks.push(chunk);
          });
          res.on('end', () => {
            if (total > MAX_UPLOAD_BYTES) {
              resolve(null);
              return;
            }
            resolve({
              status,
              contentType: String(res.headers['content-type'] || '').toLowerCase(),
              buffer: Buffer.concat(chunks)
            });
          });
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

export class CoverService {
  private readonly coversDir: string;
  private readonly catalogRepo: CatalogRepository;
  private readonly libraryRepo: LibraryRepository;
  private readonly fetchImpl: typeof fetch;
  private readonly hasCustomFetch: boolean;

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
    this.hasCustomFetch = Boolean(deps.fetchImpl);
  }

  private async ensureCoversDir(): Promise<void> {
    await fs.mkdir(this.coversDir, { recursive: true });
  }

  private async compressToWebp(
    inputBuffer: Buffer,
    options?: { maxWidth?: number; maxHeight?: number; quality?: number }
  ): Promise<Buffer> {
    try {
      return await sharp(inputBuffer, { failOn: 'none' })
        .rotate()
        .resize({
          width: options?.maxWidth ?? 420,
          height: options?.maxHeight ?? 640,
          fit: 'inside',
          withoutEnlargement: true
        })
        .webp({ quality: options?.quality ?? 78, effort: 4 })
        .toBuffer();
    } catch {
      throw new AppError(400, 'INVALID_IMAGE', 'Image invalide ou non décodable.');
    }
  }

  /**
   * Compresse un buffer brut en WebP, déduplique par SHA-256 et persiste sur `/data/covers/`.
   */
  async storeBufferAsWebp(
    rawBuffer: Buffer,
    sourceUrl: string | null = null,
    resizeOptions?: { maxWidth?: number; maxHeight?: number; quality?: number }
  ): Promise<StoredCoverResult> {
    if (!rawBuffer || rawBuffer.length === 0) {
      throw new AppError(400, 'EMPTY_IMAGE', 'Image vide.');
    }
    if (rawBuffer.length > MAX_UPLOAD_BYTES) {
      throw new AppError(413, 'IMAGE_TOO_LARGE', 'Image trop volumineuse (max 12 Mo).');
    }

    const webpBuffer = await this.compressToWebp(rawBuffer, resizeOptions);
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
   * Stocke une couverture uploadée depuis le client (Data URL base64, format couverture 420×640).
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
   * Stocke une photo d'étagère / couverture Photo IA en haute définition (jusqu'à 1800 px, qualité 86)
   * pour qu'elle reste parfaitement lisible au zoom tactile à 2 doigts.
   */
  async storePreviewDataUrlAsWebp(dataUrl: string): Promise<StoredCoverResult> {
    const match = dataUrl.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match) {
      throw new AppError(400, 'INVALID_DATA_URL', 'Format data URL image invalide.');
    }
    const rawBuffer = Buffer.from(match[1], 'base64');
    return this.storeBufferAsWebp(rawBuffer, null, { maxWidth: 1800, maxHeight: 1800, quality: 86 });
  }

  /**
   * Télécharge une couverture externe une seule fois, la compresse en WebP et la stocke sur disque.
   * Rejette les logos vectoriels `.svg` (ex: Asterix.svg sur Wikimedia Commons), les placeholders et images trop petites.
   */
  async ingestFromExternalUrl(
    url: string,
    options?: { minBytes?: number; rejectExactBytes?: number }
  ): Promise<StoredCoverResult | null> {
    const cleanUrl = (url || '').trim();
    if (!cleanUrl || (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://'))) {
      return null;
    }
    if (/\.svg(?:[?#]|$)/i.test(cleanUrl)) {
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
      let contentType = '';
      let rawBuf: Buffer | null = null;

      if (!this.hasCustomFetch && /^https?:\/\/catalogue\.bnf\.fr\b/i.test(cleanUrl)) {
        const res = await fetchBinaryIpv4(cleanUrl, 4500);
        if (!res) return null;
        contentType = res.contentType;
        rawBuf = res.buffer;
      } else {
        const res = await this.fetchImpl(cleanUrl, {
          headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'image/*,*/*;q=0.8' },
          signal: AbortSignal.timeout(4000)
        });
        if (!res.ok) return null;
        contentType = (res.headers.get('content-type') || '').toLowerCase();
        const arrayBuf = await res.arrayBuffer();
        rawBuf = Buffer.from(arrayBuf);
      }

      if (!rawBuf) return null;
      if (contentType.includes('svg')) {
        return null;
      }
      if (contentType && !contentType.startsWith('image/') && !contentType.includes('octet-stream')) {
        return null;
      }

      const minBytes = options?.minBytes ?? 500;
      if (rawBuf.length < minBytes || rawBuf.length > MAX_UPLOAD_BYTES) {
        return null;
      }
      if (options?.rejectExactBytes && rawBuf.length === options.rejectExactBytes) {
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
   * Cascade multi-sources complète vérifiée avant conversion WebP sur disque :
   * 1. Candidats directs API (BnF 950$a, Inventaire invp:P2, Wikidata P18, Google Books, Open Library)
   * 2. CDN Amazon Direct ISBN-10 (très fiable sur BD franco-belges)
   * 3. CDN Librairies Françaises Eyrolles / Dilicom H1400 (en écartant le placeholder exact 63601 octets)
   * 4. OpenLibrary Covers par ISBN (?default=false)
   * 5. Apple Books / iTunes Search API FR (par ISBN puis Titre + Auteur)
   */
  async resolveBestCoverFromCascade(input: CoverCascadeInput): Promise<StoredCoverResult | null> {
    // 1. Candidats directs déjà collectés (BnF, Inventaire, Wikidata, etc.)
    for (const rawUrl of input.candidateUrls ?? []) {
      const stored = await this.ingestFromExternalUrl(rawUrl, {
        minBytes: 500,
        rejectExactBytes: EYROLLES_PLACEHOLDER_BYTES
      });
      if (stored) return stored;
    }

    const cleanIsbn13 = input.isbn13 ? isbnUtil.normalizeToIsbn13(input.isbn13) : null;

    if (cleanIsbn13) {
      // 2-4. Fallbacks CDN ISBN en PARALLÈLE (priorité conservée : Amazon EU -> Amazon Media -> Eyrolles H1400 -> OpenLibrary)
      const isbn10 = isbnUtil.toIsbn10(cleanIsbn13);
      const parallelTasks: Array<Promise<StoredCoverResult | null>> = [];
      if (isbn10) {
        parallelTasks.push(
          this.ingestFromExternalUrl(`https://images-eu.ssl-images-amazon.com/images/P/${isbn10}.08.LZZZZZZZ.jpg`, {
            minBytes: 1500
          }),
          this.ingestFromExternalUrl(`https://m.media-amazon.com/images/P/${isbn10}.01._SCLZZZZZZZ_SX500_.jpg`, {
            minBytes: 1500
          })
        );
      }
      parallelTasks.push(
        this.ingestFromExternalUrl(
          `https://servimg.eyrolles.com/static/media/${cleanIsbn13.slice(-4)}/${cleanIsbn13}_internet_h1400.jpg`,
          { minBytes: 2000, rejectExactBytes: EYROLLES_PLACEHOLDER_BYTES }
        ),
        this.ingestFromExternalUrl(`https://covers.openlibrary.org/b/isbn/${cleanIsbn13}-L.jpg?default=false`, {
          minBytes: 1500
        })
      );

      const settled = await Promise.allSettled(parallelTasks);
      for (const item of settled) {
        if (item.status === 'fulfilled' && item.value) {
          return item.value;
        }
      }
    }

    // 5. Apple Books / iTunes FR (ISBN puis Titre + Auteur)
    if (!input.skipTitleFallback) {
      const searchTerms = [
        cleanIsbn13 ?? '',
        input.title ? `${input.title} ${input.author || ''}`.trim() : ''
      ].filter(Boolean);

      for (const term of searchTerms) {
        try {
          const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=fr&entity=ebook&limit=1`;
          const res = await this.fetchImpl(itunesUrl, {
            headers: { 'User-Agent': BROWSER_USER_AGENT },
            signal: AbortSignal.timeout(3500)
          });
          if (!res.ok) continue;
          const data = (await res.json()) as { results?: Array<{ artworkUrl100?: string }> };
          const art = data?.results?.[0]?.artworkUrl100;
          if (art) {
            const hiRes = art.replace('100x100bb.jpg', '600x600bb.jpg');
            const stored = await this.ingestFromExternalUrl(hiRes, { minBytes: 1500 });
            if (stored) return stored;
          }
        } catch {
          // continue
        }
      }
    }

    return null;
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
