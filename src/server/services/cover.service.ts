// src/server/services/cover.service.ts
// Gestionnaire unique de couvertures WebP sur disque (/data/covers/) — ZÉRO blob/base64 dans SQLite.
// Cascade multi-sources vérifiée : BnF 950$a -> Inventaire invp:P2 -> Amazon ISBN-10 -> Eyrolles/Dilicom H1400 -> iTunes FR -> OpenLibrary.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import sharp from 'sharp';
import {
  computeDHashFromRgba,
  DEFAULT_DHASH_THRESHOLD,
  DHASH_HEIGHT,
  DHASH_WIDTH,
  electConsensusCovers,
  hammingDistanceHex
} from '../../shared/bibliographic/cover-dhash.util';
import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import { normalizeTextKey, tokenOverlapRatio } from '../../shared/bibliographic/text-normalize.util';
import { PriorityRateLimiter } from '../connectors/request-priority';
import type { CoverCandidateEditionMeta } from '../../shared/types/domain.types';
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

export interface MultiEditionConsensusResult {
  winner: StoredCoverResult | null;
  distinctCovers: Array<{
    cover: StoredCoverResult;
    sourceIsbn?: string;
    sourceIsbns: string[];
    sourceUrl: string;
    clusterSize: number;
  }>;
}

export interface ExternalCoverProbeInput {
  url: string;
  label: string;
  minBytes?: number;
  rejectExactBytes?: number;
  edition?: CoverCandidateEditionMeta | null;
}

export interface CoverCascadeInput {
  isbn13?: string | null;
  candidateUrls?: string[];
  title?: string;
  /** Titre distinctif attendu (sans préfixe de série) pour rejeter les couvertures génériques iTunes hors-sujet. */
  expectedTitle?: string;
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
  private readonly rateLimiter: PriorityRateLimiter;
  private readonly inFlightItunes = new Map<string, Promise<string[]>>();
  private readonly inFlightIngest = new Map<string, Promise<StoredCoverResult | null>>();
  private lastItunesRateLimitedAt = 0;

  constructor(deps: {
    coversDir: string;
    catalogRepo: CatalogRepository;
    libraryRepo: LibraryRepository;
    fetchImpl?: typeof fetch;
    rateLimiter?: PriorityRateLimiter;
  }) {
    this.coversDir = path.resolve(deps.coversDir);
    this.catalogRepo = deps.catalogRepo;
    this.libraryRepo = deps.libraryRepo;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.hasCustomFetch = Boolean(deps.fetchImpl);
    this.rateLimiter = deps.rateLimiter ?? new PriorityRateLimiter({ bypassTiming: this.hasCustomFetch });
  }

  /**
   * Indique si Apple iTunes Search API a répondu HTTP 429 ou 403 (throttling) depuis `sinceMs`,
   * permettant aux jobs de fond de reprogrammer une reprise différée sans jamais abandonner de couvertures.
   */
  wasItunesRateLimitedSince(sinceMs: number): boolean {
    return this.lastItunesRateLimitedAt >= sinceMs;
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
   * Construit les URLs CDN librairies vérifiables pour un ISBN-13 (source DRY partagée cascade & galerie).
   */
  buildIsbnCdnCandidates(
    isbn13: string
  ): Array<{ url: string; label: string; minBytes: number; rejectExactBytes?: number }> {
    const cleanIsbn13 = isbnUtil.normalizeToIsbn13(isbn13);
    if (!cleanIsbn13) return [];
    const out: Array<{ url: string; label: string; minBytes: number; rejectExactBytes?: number }> = [];
    const isbn10 = isbnUtil.toIsbn10(cleanIsbn13);
    if (isbn10) {
      out.push(
        {
          url: `https://images-eu.ssl-images-amazon.com/images/P/${isbn10}.08.LZZZZZZZ.jpg`,
          label: `Amazon (${cleanIsbn13})`,
          minBytes: 1500
        },
        {
          url: `https://m.media-amazon.com/images/P/${isbn10}.01._SCLZZZZZZZ_SX500_.jpg`,
          label: `Amazon Media (${cleanIsbn13})`,
          minBytes: 1500
        }
      );
    }
    out.push(
      {
        url: `https://servimg.eyrolles.com/static/media/${cleanIsbn13.slice(-4)}/${cleanIsbn13}_internet_h1400.jpg`,
        label: `Eyrolles / Dilicom (${cleanIsbn13})`,
        minBytes: 2000,
        rejectExactBytes: EYROLLES_PLACEHOLDER_BYTES
      },
      {
        url: `https://covers.openlibrary.org/b/isbn/${cleanIsbn13}-L.jpg?default=false`,
        label: `Open Library (${cleanIsbn13})`,
        minBytes: 1500
      }
    );
    return out;
  }

  /**
   * Recherche des URLs de couvertures haute résolution sur Apple Books / iTunes FR.
   * Régulée par le PriorityRateLimiter (`itunes`: 1 req / 3,2 s, HIGH interactif > LOW tâche de fond)
   * avec déduplication des requêtes simultanées identiques, filtrage par pertinence de titre (`expectedTitle`)
   * et backoff automatique sur HTTP 429/403.
   */
  async searchItunesCoverUrls(term: string, limit = 4, expectedTitle?: string): Promise<string[]> {
    const clean = term.trim();
    if (!clean) return [];
    const safeLimit = Math.min(8, Math.max(1, limit));
    const cleanExpected = (expectedTitle ?? '').trim();
    const shouldVerifyTitle =
      Boolean(cleanExpected) &&
      !isbnUtil.normalizeToIsbn13(cleanExpected) &&
      normalizeTextKey(cleanExpected).length >= 4;
    const inflightKey = `${clean.toLowerCase()}|${safeLimit}|${shouldVerifyTitle ? normalizeTextKey(cleanExpected) : ''}`;
    const existing = this.inFlightItunes.get(inflightKey);
    if (existing) return existing;

    const promise = (async (): Promise<string[]> => {
      try {
        return await this.rateLimiter.schedule('itunes', async () => {
          const queryLimit = shouldVerifyTitle ? Math.max(safeLimit, 4) : safeLimit;
          const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(clean)}&country=fr&entity=ebook&limit=${Math.min(8, queryLimit)}`;
          const res = await this.fetchImpl(itunesUrl, {
            headers: { 'User-Agent': BROWSER_USER_AGENT },
            signal: AbortSignal.timeout(4500)
          });
          if (res.status === 429 || res.status === 403) {
            this.lastItunesRateLimitedAt = Date.now();
            this.rateLimiter.pushBackoff('itunes', 15_000);
            return [];
          }
          if (!res.ok) return [];
          const data = (await res.json()) as {
            results?: Array<{ artworkUrl100?: string; trackName?: string; collectionName?: string }>;
          };
          const out: string[] = [];
          for (const item of data?.results ?? []) {
            if (!item.artworkUrl100) continue;
            if (shouldVerifyTitle) {
              const hitTitle = [item.trackName, item.collectionName].filter(Boolean).join(' ').trim();
              if (hitTitle && tokenOverlapRatio(cleanExpected, hitTitle) < 0.6) {
                continue;
              }
            }
            const hiRes = item.artworkUrl100.replace('100x100bb.jpg', '600x600bb.jpg');
            if (!out.includes(hiRes)) out.push(hiRes);
            if (out.length >= safeLimit) break;
          }
          return out;
        });
      } catch {
        return [];
      } finally {
        this.inFlightItunes.delete(inflightKey);
      }
    })();

    this.inFlightItunes.set(inflightKey, promise);
    return promise;
  }

  private async fetchAndValidateImageBuffer(
    cleanUrl: string,
    options?: { minBytes?: number; rejectExactBytes?: number; timeoutMs?: number }
  ): Promise<Buffer | null> {
    if (!cleanUrl || (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://'))) {
      return null;
    }
    if (/\.svg(?:[?#]|$)/i.test(cleanUrl)) {
      return null;
    }

    try {
      const timeoutMs = options?.timeoutMs ?? 4000;
      const downloaded = await this.rateLimiter.schedule('covers_cdn', async () => {
        if (!this.hasCustomFetch && /^https?:\/\/catalogue\.bnf\.fr\b/i.test(cleanUrl)) {
          const res = await fetchBinaryIpv4(cleanUrl, Math.max(timeoutMs, 4500));
          if (!res) return null;
          return { contentType: res.contentType, rawBuf: res.buffer };
        }
        const res = await this.fetchImpl(cleanUrl, {
          headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'image/*,*/*;q=0.8' },
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!res.ok) return null;
        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        const arrayBuf = await res.arrayBuffer();
        return { contentType, rawBuf: Buffer.from(arrayBuf) };
      });

      if (!downloaded || !downloaded.rawBuf) return null;
      const { contentType, rawBuf } = downloaded;
      if (contentType.includes('svg')) return null;
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

      return rawBuf;
    } catch {
      return null;
    }
  }

  /**
   * Calcule l'empreinte perceptuelle dHash 64-bit et la résolution d'une image en mémoire (< 2 ms via sharp).
   */
  async computeBufferVisualMeta(
    rawBuffer: Buffer
  ): Promise<{ hash: string; width: number; height: number; area: number } | null> {
    try {
      const meta = await sharp(rawBuffer, { failOn: 'none' }).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      if (width < 40 || height < 40) return null;

      const rawRgba = await sharp(rawBuffer, { failOn: 'none' })
        .rotate()
        .resize(DHASH_WIDTH, DHASH_HEIGHT, { fit: 'fill' })
        .ensureAlpha()
        .raw()
        .toBuffer();

      const hash = computeDHashFromRgba(rawRgba, DHASH_WIDTH, DHASH_HEIGHT);
      return { hash, width, height, area: width * height };
    } catch {
      return null;
    }
  }

  /**
   * Vérifie et déduplique visuellement une liste de couvertures externes par empreinte dHash
   * (élimine les doublons quasi-identiques entre Amazon/Eyrolles/BnF et les copies des couvertures déjà en base).
   */
  async deduplicateExternalCandidatesVisually(
    items: ExternalCoverProbeInput[],
    existingLocalCoverKeys: string[] = [],
    maxResults = 12
  ): Promise<Array<ExternalCoverProbeInput & { clusterSize: number }>> {
    if (items.length === 0) return [];

    // 1. Empreintes des couvertures locales déjà présentes sur disque
    const localHashes: string[] = [];
    for (const key of existingLocalCoverKeys) {
      const bin = await this.readCoverBinary(key);
      if (!bin) continue;
      const meta = await this.computeBufferVisualMeta(bin.buffer);
      if (meta) localHashes.push(meta.hash);
    }

    // 2. Téléchargement + calcul dHash en parallèle par lots de 6
    type ProbedEntry = {
      item: ExternalCoverProbeInput;
      hash: string;
      area: number;
    };
    const probed: ProbedEntry[] = [];
    const queue = items.slice(0, 18);

    for (let i = 0; i < queue.length; i += 6) {
      const batch = queue.slice(i, i + 6);
      const settled = await Promise.all(
        batch.map(async (item): Promise<ProbedEntry | null> => {
          const cleanUrl = (item.url || '').trim();
          if (!cleanUrl || /(?:wikimedia|wikipedia)\.org/i.test(cleanUrl)) return null;

          // Réutilise l'image déjà stockée si connue
          const existingCov = this.catalogRepo.findCoverBySourceUrl(cleanUrl);
          if (existingCov) {
            const bin = await this.readCoverBinary(existingCov.cover_key);
            if (bin) {
              const meta = await this.computeBufferVisualMeta(bin.buffer);
              if (meta) return { item, hash: meta.hash, area: meta.area };
            }
          }

          const rawBuf = await this.fetchAndValidateImageBuffer(cleanUrl, {
            minBytes: item.minBytes ?? 1000,
            rejectExactBytes: item.rejectExactBytes ?? EYROLLES_PLACEHOLDER_BYTES,
            timeoutMs: 3500
          });
          if (!rawBuf) return null;
          const meta = await this.computeBufferVisualMeta(rawBuf);
          if (!meta) return null;
          return { item, hash: meta.hash, area: meta.area };
        })
      );
      for (const entry of settled) {
        if (entry) probed.push(entry);
      }
    }

    if (probed.length === 0) return [];

    // 3. Regroupement visuel & vote majoritaire (élimine les doublons quasi-identiques)
    const { clusters } = electConsensusCovers(probed, DEFAULT_DHASH_THRESHOLD);
    const out: Array<ExternalCoverProbeInput & { clusterSize: number }> = [];

    for (const cluster of clusters) {
      const rep = cluster.representative;
      // Ne pas reproposer en "externe" une couverture déjà identique visuellement à une couverture locale
      const alreadyLocal = localHashes.some((h) => hammingDistanceHex(h, rep.hash) <= DEFAULT_DHASH_THRESHOLD);
      if (alreadyLocal) continue;
      // Préférer les métadonnées d'édition les plus riches (éditeur + collection) au sein du groupe visuel identique
      const bestEdition =
        rep.item.edition && rep.item.edition.publisher
          ? rep.item.edition
          : cluster.members.find((m) => m.item.edition?.publisher)?.item.edition ??
            rep.item.edition ??
            cluster.members.find((m) => m.item.edition)?.item.edition ??
            null;
      out.push({
        ...rep.item,
        edition: bestEdition,
        clusterSize: cluster.count
      });
      if (out.length >= maxResults) break;
    }

    return out;
  }

  /**
   * Collecte les couvertures de plusieurs éditions (ISBNs) d'une même Œuvre abstraite,
   * les compare visuellement par dHash et élit la couverture majoritaire la plus nette,
   * tout en stockant jusqu'à 4 couvertures distinctes en WebP pour le choix utilisateur.
   */
  async electBestCoverFromMultiEditions(input: {
    isbn13s: string[];
    candidateUrls?: string[];
    preferredIsbns?: string[];
    maxEditions?: number;
    maxDistinctStored?: number;
  }): Promise<MultiEditionConsensusResult> {
    const preferredSet = new Set(
      (input.preferredIsbns ?? [])
        .map((raw) => isbnUtil.normalizeToIsbn13(raw))
        .filter((x): x is string => Boolean(x))
    );
    const orderedInputIsbns = [
      ...Array.from(preferredSet),
      ...input.isbn13s
    ];
    const cleanIsbns = Array.from(
      new Set(
        orderedInputIsbns
          .map((raw) => isbnUtil.normalizeToIsbn13(raw))
          .filter((x): x is string => Boolean(x))
      )
    ).slice(0, input.maxEditions ?? 4);

    const probes: Array<{ url: string; sourceIsbn?: string; minBytes?: number; rejectExactBytes?: number }> = [];
    const seenUrls = new Set<string>();
    const pushProbe = (url: string, sourceIsbn?: string, minBytes?: number, rejectExactBytes?: number) => {
      const clean = (url || '').trim();
      if (!clean || seenUrls.has(clean)) return;
      if (/\.svg(?:[?#]|$)/i.test(clean) || /(?:wikimedia|wikipedia)\.org/i.test(clean)) return;
      seenUrls.add(clean);
      probes.push({ url: clean, sourceIsbn, minBytes, rejectExactBytes });
    };

    for (const u of input.candidateUrls ?? []) {
      pushProbe(u, cleanIsbns[0], 500, EYROLLES_PLACEHOLDER_BYTES);
    }

    for (const isbn of cleanIsbns) {
      // Sur plusieurs éditions, on prend les 2 CDN les plus rapides/fiables par ISBN (Amazon EU + Eyrolles H1400) + OpenLibrary
      const cdns = this.buildIsbnCdnCandidates(isbn);
      for (const cdn of cdns) {
        if (cdn.label.startsWith('Amazon Media')) continue;
        pushProbe(cdn.url, isbn, cdn.minBytes, cdn.rejectExactBytes);
      }
    }

    type DownloadedCandidate = {
      url: string;
      sourceIsbn?: string;
      buffer: Buffer;
      hash: string;
      area: number;
    };

    const downloaded: DownloadedCandidate[] = [];
    const limitedProbes = probes.slice(0, 12);

    for (let i = 0; i < limitedProbes.length; i += 6) {
      const batch = limitedProbes.slice(i, i + 6);
      const settled = await Promise.all(
        batch.map(async (p): Promise<DownloadedCandidate | null> => {
          const buf = await this.fetchAndValidateImageBuffer(p.url, {
            minBytes: p.minBytes ?? 1000,
            rejectExactBytes: p.rejectExactBytes ?? EYROLLES_PLACEHOLDER_BYTES,
            timeoutMs: 3500
          });
          if (!buf) return null;
          const meta = await this.computeBufferVisualMeta(buf);
          if (!meta) return null;
          return { url: p.url, sourceIsbn: p.sourceIsbn, buffer: buf, hash: meta.hash, area: meta.area };
        })
      );
      for (const d of settled) {
        if (d) downloaded.push(d);
      }
    }

    if (downloaded.length === 0) {
      return { winner: null, distinctCovers: [] };
    }

    const { clusters } = electConsensusCovers(downloaded, DEFAULT_DHASH_THRESHOLD);
    const maxStore = input.maxDistinctStored ?? 4;
    const distinctCovers: MultiEditionConsensusResult['distinctCovers'] = [];

    for (const cluster of clusters.slice(0, maxStore)) {
      const rep = cluster.representative;
      const memberIsbns = Array.from(
        new Set(
          cluster.members
            .map((m) => m.sourceIsbn)
            .filter((x): x is string => Boolean(x))
        )
      );
      try {
        const stored = await this.storeBufferAsWebp(rep.buffer, rep.url);
        distinctCovers.push({
          cover: stored,
          sourceIsbn: rep.sourceIsbn,
          sourceIsbns: memberIsbns,
          sourceUrl: rep.url,
          clusterSize: cluster.count
        });
      } catch {
        // ignore single conversion failure
      }
    }

    const preferredEntry =
      preferredSet.size > 0
        ? distinctCovers.find((entry) => entry.sourceIsbns.some((isbn) => preferredSet.has(isbn)))
        : undefined;

    return {
      winner: preferredEntry?.cover ?? distinctCovers[0]?.cover ?? null,
      distinctCovers
    };
  }

  /**
   * Vérifie qu'une URL externe répond bien avec une vraie image décodable (>= 40x40, non SVG, non Wikimedia, non placeholder).
   */
  async probeExternalCoverUrl(
    url: string,
    options?: { minBytes?: number; rejectExactBytes?: number }
  ): Promise<boolean> {
    const cleanUrl = (url || '').trim();
    if (!cleanUrl || /(?:wikimedia|wikipedia)\.org/i.test(cleanUrl)) return false;
    if (this.catalogRepo.findCoverBySourceUrl(cleanUrl)) return true;
    const buf = await this.fetchAndValidateImageBuffer(cleanUrl, {
      minBytes: options?.minBytes ?? 1000,
      rejectExactBytes: options?.rejectExactBytes ?? EYROLLES_PLACEHOLDER_BYTES,
      timeoutMs: 3500
    });
    return buf !== null;
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

    const inFlight = this.inFlightIngest.get(cleanUrl);
    if (inFlight) return inFlight;

    const promise = (async (): Promise<StoredCoverResult | null> => {
      try {
        const rawBuf = await this.fetchAndValidateImageBuffer(cleanUrl, options);
        if (!rawBuf) return null;
        return await this.storeBufferAsWebp(rawBuf, cleanUrl);
      } catch {
        return null;
      } finally {
        this.inFlightIngest.delete(cleanUrl);
      }
    })();

    this.inFlightIngest.set(cleanUrl, promise);
    return promise;
  }

  /**
   * Cascade multi-sources complète vérifiée avant conversion WebP sur disque :
   * 1. Candidats directs API (BnF 950$a, Inventaire invp:P2, Google Books, Open Library — Wikimedia P18 exclu)
   * 2. CDN Amazon Direct ISBN-10 (très fiable sur BD franco-belges)
   * 3. CDN Librairies Françaises Eyrolles / Dilicom H1400 (en écartant le placeholder exact 63601 octets)
   * 4. OpenLibrary Covers par ISBN (?default=false)
   * 5. Apple Books / iTunes Search API FR (par ISBN puis Titre + Auteur)
   */
  async resolveBestCoverFromCascade(input: CoverCascadeInput): Promise<StoredCoverResult | null> {
    const isWikimediaUrl = (u: string): boolean => /(?:wikimedia|wikipedia)\.org/i.test(u);
    // Exclure les .svg et les photos Wikimedia P18 Wikidata (qui sont des photos thématiques libres de droit, jamais des couvertures éditeur)
    const primaryCandidates = (input.candidateUrls ?? []).filter(
      (u) => Boolean(u && !/\.svg(?:[?#]|$)/i.test(u) && !isWikimediaUrl(u))
    );

    // 1. Candidats directs éditeurs/catalogues (BnF, Inventaire invp:P2, Google Books, Open Library)
    for (const rawUrl of primaryCandidates) {
      const stored = await this.ingestFromExternalUrl(rawUrl, {
        minBytes: 500,
        rejectExactBytes: EYROLLES_PLACEHOLDER_BYTES
      });
      if (stored) return stored;
    }

    const cleanIsbn13 = input.isbn13 ? isbnUtil.normalizeToIsbn13(input.isbn13) : null;

    if (cleanIsbn13) {
      // 2-4. Fallbacks CDN ISBN en PARALLÈLE (priorité conservée : Amazon EU -> Amazon Media -> Eyrolles H1400 -> OpenLibrary)
      const cdnCandidates = this.buildIsbnCdnCandidates(cleanIsbn13);
      const settled = await Promise.allSettled(
        cdnCandidates.map((cand) =>
          this.ingestFromExternalUrl(cand.url, {
            minBytes: cand.minBytes,
            rejectExactBytes: cand.rejectExactBytes
          })
        )
      );
      for (const item of settled) {
        if (item.status === 'fulfilled' && item.value) {
          return item.value;
        }
      }
    }

    // 5. Apple Books / iTunes FR (1 seule requête régulée par ouvrage : Titre + Auteur prioritaire, sinon ISBN)
    if (!input.skipTitleFallback) {
      const term = input.title
        ? `${input.title} ${input.author || ''}`.trim()
        : cleanIsbn13 ?? '';
      if (term) {
        const urls = await this.searchItunesCoverUrls(term, 1, input.expectedTitle ?? input.title);
        for (const hiRes of urls) {
          const stored = await this.ingestFromExternalUrl(hiRes, { minBytes: 1500 });
          if (stored) return stored;
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

  /**
   * Supprime tous les fichiers `.webp` stockés sur disque dans `coversDir` (utilisé lors d'un reset catalogue admin de tests).
   */
  async deleteAllStoredCoverFiles(): Promise<number> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.coversDir);
    } catch {
      return 0;
    }

    let deleted = 0;
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.webp')) continue;
      try {
        await fs.unlink(path.join(this.coversDir, path.basename(name)));
        deleted++;
      } catch {
        // fichier déjà supprimé
      }
    }
    return deleted;
  }
}
