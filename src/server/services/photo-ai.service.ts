// src/server/services/photo-ai.service.ts
// Service Photo IA 100 % Serveur : quota mensuel, OCR Gemini, résolution BnF, arbitrage persisté, relance BnF serveur & validation lot.

import crypto from 'node:crypto';
import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import { parseIncludedVolumeNumbers } from '../../shared/bibliographic/integral.util';
import {
  isGenericVolumeTitle,
  matchesAuthorName,
  normalizeSeriesNumber,
  normalizeTextKey,
  tokenOverlapRatio
} from '../../shared/bibliographic/text-normalize.util';
import type { BackgroundJobView, OwnershipStatus } from '../../shared/types/domain.types';
import type { ServerConfig } from '../config';
import type { BibliographicConnectors, SourceCandidateRecord } from '../connectors/types';
import type { GeminiConnector, GeminiExtractedBookHint } from '../connectors/gemini.connector';
import type { CatalogRepository } from '../repositories/catalog.repo';
import type { BackgroundJobRow, JobRepository } from '../repositories/job.repo';
import type { LibraryRepository } from '../repositories/library.repo';
import type { UserRepository } from '../repositories/user.repo';
import type { CoverService } from './cover.service';
import type { IngestionService } from './acquisition/ingestion.service';
import type { LibraryService } from './library.service';
import { mapJobRowToView, type JobHandlerContext } from '../workers/background-worker';
import { AppError } from '../middleware/error.middleware';

export interface PhotoCandidateOption {
  isbn13: string;
  title: string;
  seriesName: string | null;
  volumeNumber: string | null;
  authors: string[];
  publisher: string | null;
  publishYear: string | null;
  coverUrl: string | null;
  source: string;
}

export interface PhotoJobItem {
  id: string;
  /** Position visuelle sur l'étagère (1 = le plus à gauche) et nombre total détecté. */
  spineIndex?: number;
  totalSpines?: number;
  hint: GeminiExtractedBookHint;
  status: 'identified' | 'doubt' | 'unresolved';
  options: PhotoCandidateOption[];
  /** Couverture indicative WebP (ex. trouvée par titre/auteur si aucune option ISBN n'a été identifiée). */
  fallbackCoverUrl?: string | null;
  selectedOptionIsbn13: string | null;
  selected: boolean;
  ignored: boolean;
  alreadyStatus: OwnershipStatus;
  isIntegral: boolean;
  includedVolumes: string[];
  committedBookId: string | null;
}

export interface PhotoJobResultPayload {
  mode: 'shelf' | 'cover';
  previewCoverKey: string | null;
  previewUrl: string | null;
  items: PhotoJobItem[];
}

function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function toOption(rec: SourceCandidateRecord): PhotoCandidateOption | null {
  if (!rec.isbn13 || !rec.title) return null;
  return {
    isbn13: rec.isbn13,
    title: rec.title,
    seriesName: rec.seriesName ?? null,
    volumeNumber: rec.volumeNumber ?? null,
    authors: rec.authors,
    publisher: rec.publisher ?? null,
    publishYear: rec.publishYear ?? null,
    coverUrl: rec.coverUrl ?? null,
    source: rec.source
  };
}

export class PhotoAiService {
  private readonly config: ServerConfig;
  private readonly gemini: GeminiConnector;
  private readonly connectors: BibliographicConnectors;
  private readonly userRepo: UserRepository;
  private readonly catalogRepo: CatalogRepository;
  private readonly libraryRepo: LibraryRepository;
  private readonly jobRepo: JobRepository;
  private readonly coverService: CoverService;
  private readonly ingestionService: IngestionService;
  private readonly libraryService: LibraryService;
  private readonly onJobChanged?: (job: BackgroundJobRow) => void;

  constructor(deps: {
    config: ServerConfig;
    gemini: GeminiConnector;
    connectors: BibliographicConnectors;
    userRepo: UserRepository;
    catalogRepo: CatalogRepository;
    libraryRepo: LibraryRepository;
    jobRepo: JobRepository;
    coverService: CoverService;
    ingestionService: IngestionService;
    libraryService: LibraryService;
    onJobChanged?: (job: BackgroundJobRow) => void;
  }) {
    this.config = deps.config;
    this.gemini = deps.gemini;
    this.connectors = deps.connectors;
    this.userRepo = deps.userRepo;
    this.catalogRepo = deps.catalogRepo;
    this.libraryRepo = deps.libraryRepo;
    this.jobRepo = deps.jobRepo;
    this.coverService = deps.coverService;
    this.ingestionService = deps.ingestionService;
    this.libraryService = deps.libraryService;
    this.onJobChanged = deps.onJobChanged;
  }

  private assertOwnedJob(jobId: string, userId: string, libraryId: string): BackgroundJobRow {
    const row = this.jobRepo.findJobById(jobId);
    if (!row || row.type !== 'photo_ocr') {
      throw new AppError(404, 'PHOTO_JOB_NOT_FOUND', 'Lot Photo IA introuvable.');
    }
    if (row.user_id !== userId && row.library_id !== libraryId) {
      throw new AppError(403, 'FORBIDDEN', 'Accès refusé à ce lot Photo IA.');
    }
    return row;
  }

  private parseResult(row: BackgroundJobRow): PhotoJobResultPayload {
    if (row.result_json) {
      try {
        const parsed = JSON.parse(row.result_json) as Partial<PhotoJobResultPayload>;
        return {
          mode: parsed.mode === 'cover' ? 'cover' : 'shelf',
          previewCoverKey: parsed.previewCoverKey ?? null,
          previewUrl: parsed.previewCoverKey ? `/api/covers/${parsed.previewCoverKey}` : (parsed.previewUrl ?? null),
          items: Array.isArray(parsed.items) ? parsed.items : []
        };
      } catch {
        // fallback below
      }
    }
    return { mode: 'shelf', previewCoverKey: null, previewUrl: null, items: [] };
  }

  private lookupFoyerOwnershipByIsbn(libraryId: string, isbn13: string): OwnershipStatus {
    const book = this.catalogRepo.findBookByIsbn13(isbn13);
    if (!book) return 'none';
    const lib = this.libraryRepo.findLibraryBook(libraryId, book.id);
    if (!lib || lib.deleted_at) return 'none';
    return lib.status;
  }

  private async resolveHintOptions(hint: {
    title?: string;
    series?: string;
    volumeNumber?: string;
    author?: string;
    publisher?: string;
    isbn?: string;
  }): Promise<PhotoCandidateOption[]> {
    const options: PhotoCandidateOption[] = [];
    const seenIsbns = new Set<string>();

    const pushOpt = (opt: PhotoCandidateOption | null) => {
      if (!opt || !opt.isbn13 || seenIsbns.has(opt.isbn13)) return;
      seenIsbns.add(opt.isbn13);
      options.push(opt);
    };

    // 1. Si ISBN fourni directement -> résolution directe BnF
    if (hint.isbn) {
      const cleanIsbn = isbnUtil.normalizeToIsbn13(hint.isbn);
      if (cleanIsbn) {
        const rec = await this.connectors.bnf.lookupByIsbn(cleanIsbn);
        if (rec) pushOpt(toOption(rec));
      }
    }

    // 2. Recherche locale SQLite rapide (si déjà dans le Catalogue Central)
    const volNumStr = normalizeSeriesNumber(hint.volumeNumber);
    const volNum = /^\d+$/.test(volNumStr) ? parseInt(volNumStr, 10) : null;
    if (hint.title || hint.series) {
      const local = this.catalogRepo.searchLocalCatalog({
        titleNorm: hint.title ? normalizeTextKey(hint.title) : undefined,
        seriesNorm: hint.series ? normalizeTextKey(hint.series) : undefined,
        volumeNumber: volNum,
        authorNorm: hint.author ? normalizeTextKey(hint.author) : undefined,
        publisherNorm: hint.publisher ? normalizeTextKey(hint.publisher) : undefined,
        limit: 5
      });
      for (const b of local.books) {
        const eds = this.catalogRepo.listEditionsByBookId(b.id);
        if (eds[0]?.isbn13) {
          pushOpt({
            isbn13: eds[0].isbn13,
            title: b.title,
            seriesName: b.series_id ? (this.catalogRepo.findSeriesById(b.series_id)?.canonical_name ?? null) : null,
            volumeNumber: b.volume_label,
            authors: JSON.parse(b.authors_json || '[]') as string[],
            publisher: b.publisher,
            publishYear: b.publish_year,
            coverUrl: b.cover_key ? `/api/covers/${b.cover_key}` : null,
            source: 'local'
          });
        }
      }
    }

    // 3. Cascade externe progressive (BnF SRU + Inventaire.io) sans jamais coller le n° de tome dans bib.title all :
    //    Passe A : Série + Titre + Auteur
    //    Passe B (si < 2 options et série connue) : Série + Auteur (rattrape "Le vol du corbeau T.1/2", "SOS Bonheur S2", ou sous-titre OCR imparfait)
    //    Passe C (si 0 option et titre distinct de la série) : Titre + Auteur
    const cleanSeries = hint.series?.trim() || '';
    const cleanTitle = hint.title?.trim() || '';
    const cleanAuthor = hint.author?.trim() || undefined;
    const normSeries = normalizeTextKey(cleanSeries);
    const normTitle = normalizeTextKey(cleanTitle);
    const normPub = hint.publisher ? normalizeTextKey(hint.publisher) : '';

    const runExternalPass = async (titleQuery: string, authorQuery?: string, bnfLimit = 10) => {
      if (!titleQuery && !authorQuery) return;
      const bnfHits = await this.connectors.bnf
        .searchByTitleAndAuthor(titleQuery, authorQuery, bnfLimit)
        .catch(() => []);
      for (const hit of bnfHits) {
        pushOpt(toOption(hit));
      }

      // Secours Inventaire.io uniquement si la BnF n'a pas trouvé de candidat suffisant
      // (évite une saturation HTTP 429 d'Inventaire sur les photos d'étagère de 20+ livres).
      const bnfMatchedTargetVol = Boolean(
        volNumStr && bnfHits.some((h) => normalizeSeriesNumber(h.volumeNumber) === volNumStr)
      );
      const needsInventaireFallback =
        Boolean(titleQuery && this.connectors.inventaire.searchByText) &&
        (bnfHits.length === 0 || (Boolean(volNumStr) && !bnfMatchedTargetVol && bnfHits.length < 2));

      if (needsInventaireFallback && this.connectors.inventaire.searchByText) {
        const rawInvHits = await this.connectors.inventaire.searchByText(titleQuery, 4).catch(() => []);
        const invHits = rawInvHits.filter((hit) => {
          const candidateText = `${hit.seriesName ?? ''} ${hit.title ?? ''}`.trim();
          return tokenOverlapRatio(titleQuery, candidateText) >= 0.4;
        });
        for (const hit of invHits) {
          pushOpt(toOption(hit));
        }
      }
    };

    const combinedTitle =
      cleanSeries && cleanTitle && !normTitle.includes(normSeries)
        ? `${cleanSeries} ${cleanTitle}`
        : cleanTitle || cleanSeries;

    if (combinedTitle) {
      await runExternalPass(combinedTitle, cleanAuthor, 12);
    }

    const hasTargetVolume = Boolean(
      volNumStr && options.some((o) => normalizeSeriesNumber(o.volumeNumber) === volNumStr)
    );
    if ((options.length < 2 || (volNumStr && !hasTargetVolume)) && cleanSeries) {
      await runExternalPass(cleanSeries, cleanAuthor, 25);
    }

    if (options.length === 0 && cleanTitle && cleanTitle !== combinedTitle) {
      await runExternalPass(cleanTitle, cleanAuthor, 12);
    }

    // Passe D (secours pseudonyme / co-auteur absent de BnF, ex. "Pappa in Afrika" / Anton Kannemeyer -> Joe Dog) :
    // Uniquement si 0 option trouvée AVEC auteur et que le titre est suffisamment distinctif (>= 6 car., non générique).
    const titleFallbackQuery = cleanTitle || cleanSeries;
    if (
      options.length === 0 &&
      cleanAuthor &&
      titleFallbackQuery &&
      normalizeTextKey(titleFallbackQuery).length >= 6 &&
      !isGenericVolumeTitle(titleFallbackQuery, cleanSeries)
    ) {
      await runExternalPass(titleFallbackQuery, undefined, 10);
    }

    // Scoring déterministe pour placer la meilleure édition (tome exact > titre proche > éditeur > auteur) en #1
    const scoreOption = (opt: PhotoCandidateOption): number => {
      let score = 0;
      const optVol = normalizeSeriesNumber(opt.volumeNumber);
      if (volNumStr) {
        if (optVol && optVol === volNumStr) score += 55;
        else if (optVol && optVol !== volNumStr) score -= 25;
        else if (new RegExp(`\\b${volNumStr}\\b`).test(opt.title)) score += 20;
      }
      if (cleanTitle) {
        score += Math.round(tokenOverlapRatio(cleanTitle, `${opt.seriesName ?? ''} ${opt.title}`) * 30);
      }
      if (cleanSeries) {
        score += Math.round(tokenOverlapRatio(cleanSeries, `${opt.seriesName ?? ''} ${opt.title}`) * 20);
      }
      if (normPub && opt.publisher && normalizeTextKey(opt.publisher).includes(normPub)) {
        score += 15;
      }
      if (cleanAuthor && opt.authors.some((a) => matchesAuthorName(a, cleanAuthor))) {
        score += 10;
      }
      if (opt.source === 'local') score += 5;
      return score;
    };

    options.sort((a, b) => scoreOption(b) - scoreOption(a));

    const topOptions = options.slice(0, 6);

    // 4. Enrichissement couverture WebP locale (/api/covers/...) en parallèle pour les 4 premières options
    await Promise.allSettled(
      topOptions.slice(0, 4).map(async (opt) => {
        if (opt.coverUrl && opt.coverUrl.startsWith('/api/covers/')) return;
        const existingBook = this.catalogRepo.findBookByIsbn13(opt.isbn13);
        if (existingBook?.cover_key) {
          opt.coverUrl = `/api/covers/${existingBook.cover_key}`;
          return;
        }
        const stored = await this.coverService.resolveBestCoverFromCascade({
          isbn13: opt.isbn13,
          candidateUrls: opt.coverUrl ? [opt.coverUrl] : [],
          skipTitleFallback: true
        });
        if (stored) {
          opt.coverUrl = stored.coverUrl;
        }
      })
    );

    return topOptions;
  }

  /**
   * Crée un job Photo IA sur le serveur (vérifie et décrémente le quota mensuel).
   */
  async createPhotoJob(input: {
    userId: string;
    libraryId: string;
    isAdmin: boolean;
    mode: 'shelf' | 'cover';
    imageDataUrl: string;
    mimeType: string;
  }): Promise<{ job: BackgroundJobView; quota: { monthKey: string; used: number; limit: number; remaining: number } }> {
    if (!this.gemini.isConfigured()) {
      throw new AppError(503, 'GEMINI_NOT_CONFIGURED', 'Le service Photo IA n’est pas configuré sur le serveur.');
    }

    const monthKey = currentMonthKey();
    const limit = this.config.monthlyAiQuota;
    const currentUsage = this.userRepo.getAiUsage(input.userId);
    const currentUsed = currentUsage && currentUsage.month_key === monthKey ? currentUsage.month_used : 0;

    if (!input.isAdmin && currentUsed >= limit) {
      throw new AppError(429, 'AI_QUOTA_EXCEEDED', `Quota mensuel Photo IA atteint (${limit}/${limit}).`);
    }

    const now = new Date().toISOString();

    // Compresse la photo d'étagère en WebP haute définition (1800 px) sur disque (/data/covers/) — zéro image base64 dans SQLite
    const storedPreview = await this.coverService.storePreviewDataUrlAsWebp(input.imageDataUrl);
    const previewCoverKey = storedPreview.coverKey;

    const updatedUsage = this.userRepo.incrementAiUsage(input.userId, monthKey, now);

    const row = this.jobRepo.createJob({
      id: generateId('pjob'),
      type: 'photo_ocr',
      userId: input.userId,
      libraryId: input.libraryId,
      payload: {
        mode: input.mode,
        mimeType: 'image/webp',
        previewCoverKey
      },
      progressTotal: 1,
      now
    });

    this.onJobChanged?.(row);

    return {
      job: mapJobRowToView(row),
      quota: {
        monthKey,
        used: updatedUsage.month_used,
        limit,
        remaining: Math.max(0, limit - updatedUsage.month_used)
      }
    };
  }

  /**
   * Exécution serveur dans le BackgroundWorker : OCR Gemini -> Résolution BnF -> Statuts Foyer -> Mise à jour SSE.
   */
  async executePhotoOcrJob(ctx: JobHandlerContext): Promise<{ result: PhotoJobResultPayload; total: number }> {
    const mode = ctx.payload.mode === 'cover' ? 'cover' : 'shelf';
    let imageDataUrl = typeof ctx.payload.imageDataUrl === 'string' ? ctx.payload.imageDataUrl : '';
    let mimeType = typeof ctx.payload.mimeType === 'string' ? ctx.payload.mimeType : 'image/webp';
    const previewCoverKey = typeof ctx.payload.previewCoverKey === 'string' ? ctx.payload.previewCoverKey : null;
    const libraryId = ctx.job.library_id ?? '';

    if (!imageDataUrl && previewCoverKey) {
      const storedBin = await this.coverService.readCoverBinary(previewCoverKey);
      if (!storedBin) {
        throw new AppError(400, 'PHOTO_IMAGE_MISSING', "L'image de cette analyse n'est plus disponible : reprenez une photo.");
      }
      mimeType = storedBin.mimeType;
      imageDataUrl = `data:${storedBin.mimeType};base64,${storedBin.buffer.toString('base64')}`;
    }

    const hints = await this.gemini.extractBooksFromImage({ imageDataUrl, mimeType, mode });
    const total = Math.max(1, hints.length);
    const items: PhotoJobItem[] = [];

    const mergeSavedArbitrations = () => {
      const latestRow = this.jobRepo.findJobById(ctx.job.id);
      if (!latestRow?.result_json) return;
      const savedItems = this.parseResult(latestRow).items;
      if (savedItems.length === 0) return;
      const savedById = new Map(savedItems.map((it) => [it.id, it]));
      for (let idx = 0; idx < items.length; idx++) {
        const persisted = savedById.get(items[idx].id);
        if (persisted) {
          // Conserve les choix déjà enregistrés par l'utilisateur pendant l'analyse en cours (édition choisie, sélection, relance BnF, intégrale)
          items[idx] = { ...items[idx], ...persisted };
        }
      }
    };

    const buildPayload = (): PhotoJobResultPayload => {
      mergeSavedArbitrations();
      return {
        mode,
        previewCoverKey,
        previewUrl: previewCoverKey ? `/api/covers/${previewCoverKey}` : null,
        items: [...items]
      };
    };

    ctx.reportProgress(0, total, buildPayload());

    for (let i = 0; i < hints.length; i++) {
      const hint = hints[i];
      const options = await this.resolveHintOptions(hint);
      const bestIsbn = options[0]?.isbn13 ?? null;
      const alreadyStatus = bestIsbn && libraryId ? this.lookupFoyerOwnershipByIsbn(libraryId, bestIsbn) : 'none';

      let status: PhotoJobItem['status'] = 'unresolved';
      if (options.length === 1 && hint.confidence === 'high') {
        status = 'identified';
      } else if (options.length >= 1) {
        status = hint.confidence === 'high' ? 'identified' : 'doubt';
      }

      // Pour les éléments non identifiés (0 option ISBN), tenter une couverture indicative par titre + auteur
      let fallbackCoverUrl: string | null = null;
      if (options.length === 0 && hint.title) {
        const storedHintCover = await this.coverService.resolveBestCoverFromCascade({
          title: [hint.series, hint.title].filter(Boolean).join(' '),
          author: hint.author
        });
        if (storedHintCover) {
          fallbackCoverUrl = storedHintCover.coverUrl;
        }
      }

      items.push({
        id: generateId('pit'),
        spineIndex: hint.spineIndex ?? i + 1,
        totalSpines: hints.length,
        hint,
        status,
        options,
        fallbackCoverUrl,
        selectedOptionIsbn13: bestIsbn,
        selected: status === 'identified' && alreadyStatus === 'none',
        ignored: false,
        alreadyStatus,
        isIntegral: false,
        includedVolumes: [],
        committedBookId: null
      });

      ctx.reportProgress(i + 1, total, buildPayload());
    }

    return { result: buildPayload(), total };
  }

  /**
   * Persiste sur le serveur l'arbitrage d'un item (sélection, édition choisie, intégrale, ignoré).
   */
  updateItemArbitration(input: {
    userId: string;
    libraryId: string;
    jobId: string;
    itemId: string;
    patch: {
      selected?: boolean;
      ignored?: boolean;
      selectedOptionIsbn13?: string | null;
      isIntegral?: boolean;
      includedVolumes?: string[];
    };
  }): BackgroundJobView {
    const row = this.assertOwnedJob(input.jobId, input.userId, input.libraryId);
    const result = this.parseResult(row);
    const item = result.items.find((it) => it.id === input.itemId);
    if (!item) {
      throw new AppError(404, 'PHOTO_ITEM_NOT_FOUND', 'Élément Photo IA introuvable.');
    }

    if (input.patch.selected !== undefined) item.selected = input.patch.selected;
    if (input.patch.ignored !== undefined) {
      item.ignored = input.patch.ignored;
      if (item.ignored) item.selected = false;
    }
    if (input.patch.selectedOptionIsbn13 !== undefined) {
      item.selectedOptionIsbn13 = input.patch.selectedOptionIsbn13;
      if (item.selectedOptionIsbn13) {
        item.alreadyStatus = this.lookupFoyerOwnershipByIsbn(input.libraryId, item.selectedOptionIsbn13);
      }
    }
    if (input.patch.isIntegral !== undefined) {
      item.isIntegral = input.patch.isIntegral;
      if (!item.isIntegral) item.includedVolumes = [];
    }
    if (input.patch.includedVolumes !== undefined) {
      item.includedVolumes = parseIncludedVolumeNumbers(input.patch.includedVolumes);
    }

    const now = new Date().toISOString();
    this.jobRepo.updateJobProgress(row.id, row.progress_done, row.progress_total, now, result);
    const updated = this.jobRepo.findJobById(row.id)!;
    this.onJobChanged?.(updated);
    return mapJobRowToView(updated);
  }

  /**
   * Relance BnF ciblée 100 % côté serveur à partir des 6 champs manuels de la sous-modale Photo IA.
   */
  async retryItemBnf(input: {
    userId: string;
    libraryId: string;
    jobId: string;
    itemId: string;
    hints: {
      title?: string;
      series?: string;
      volumeNumber?: string;
      author?: string;
      publisher?: string;
      isbn?: string;
    };
  }): Promise<{ job: BackgroundJobView; item: PhotoJobItem }> {
    const row = this.assertOwnedJob(input.jobId, input.userId, input.libraryId);
    const result = this.parseResult(row);
    const item = result.items.find((it) => it.id === input.itemId);
    if (!item) {
      throw new AppError(404, 'PHOTO_ITEM_NOT_FOUND', 'Élément Photo IA introuvable.');
    }

    const options = await this.resolveHintOptions(input.hints);
    item.options = options;
    item.selectedOptionIsbn13 = options[0]?.isbn13 ?? null;
    item.status = options.length === 1 ? 'identified' : options.length > 1 ? 'doubt' : 'unresolved';
    item.ignored = false;
    item.alreadyStatus = item.selectedOptionIsbn13
      ? this.lookupFoyerOwnershipByIsbn(input.libraryId, item.selectedOptionIsbn13)
      : 'none';
    item.selected = options.length > 0 && item.alreadyStatus === 'none';

    const now = new Date().toISOString();
    this.jobRepo.updateJobProgress(row.id, row.progress_done, row.progress_total, now, result);
    const updated = this.jobRepo.findJobById(row.id)!;
    this.onJobChanged?.(updated);
    return { job: mapJobRowToView(updated), item };
  }

  async retryFailedItems(input: { userId: string; libraryId: string; jobId: string }): Promise<BackgroundJobView> {
    const row = this.assertOwnedJob(input.jobId, input.userId, input.libraryId);
    const result = this.parseResult(row);

    for (const item of result.items) {
      if (item.status !== 'unresolved' || item.ignored) continue;
      const options = await this.resolveHintOptions(item.hint);
      if (options.length > 0) {
        item.options = options;
        item.selectedOptionIsbn13 = options[0].isbn13;
        item.status = options.length === 1 ? 'identified' : 'doubt';
        item.alreadyStatus = this.lookupFoyerOwnershipByIsbn(input.libraryId, options[0].isbn13);
        item.selected = item.alreadyStatus === 'none';
      }
    }

    const now = new Date().toISOString();
    this.jobRepo.updateJobProgress(row.id, row.progress_done, row.progress_total, now, result);
    const updated = this.jobRepo.findJobById(row.id)!;
    this.onJobChanged?.(updated);
    return mapJobRowToView(updated);
  }

  /**
   * Recherche publique réutilisable (utilisée par Photo IA et par "Ce n'est pas le bon livre" sur une fiche).
   */
  async searchBookCandidates(hints: {
    title?: string;
    series?: string;
    volumeNumber?: string;
    author?: string;
    publisher?: string;
    isbn?: string;
  }): Promise<PhotoCandidateOption[]> {
    return this.resolveHintOptions(hints);
  }

  /**
   * Valide les items cochés du lot Photo IA vers la Collection (`owned`) ou la Wishlist (`wish`).
   * Exécution parallélisée par lots de 4 (rapide), ou en tâche de fond `photo_commit` pour les gros lots (> 3 livres ou async=true).
   */
  async commitJobItems(input: {
    userId: string;
    libraryId: string;
    jobId: string;
    targetStatus: 'owned' | 'wish';
    itemIds?: string[];
    async?: boolean;
  }): Promise<{
    committedCount: number;
    queued: boolean;
    targetCount: number;
    commitJob?: BackgroundJobView;
    job: BackgroundJobView;
  }> {
    const row = this.assertOwnedJob(input.jobId, input.userId, input.libraryId);
    const result = this.parseResult(row);

    const targets = result.items.filter((it) => {
      if (it.ignored || !it.selectedOptionIsbn13) return false;
      if (input.itemIds && input.itemIds.length > 0) return input.itemIds.includes(it.id);
      return it.selected;
    });

    // Pour les lots > 3 livres (ou demande explicite async), confier au BackgroundWorker existant -> réponse immédiate (< 50 ms, zéro timeout)
    if (targets.length > 0 && (input.async || targets.length > 3)) {
      const now = new Date().toISOString();
      const commitRow = this.jobRepo.createJob({
        id: generateId('pcom'),
        type: 'photo_commit',
        userId: input.userId,
        libraryId: input.libraryId,
        payload: {
          photoJobId: row.id,
          targetStatus: input.targetStatus,
          itemIds: targets.map((t) => t.id)
        },
        progressTotal: targets.length,
        now
      });
      this.onJobChanged?.(commitRow);
      return {
        committedCount: 0,
        queued: true,
        targetCount: targets.length,
        commitJob: mapJobRowToView(commitRow),
        job: mapJobRowToView(row)
      };
    }

    const { committedCount, updatedJob } = await this.commitTargetsWithConcurrency({
      row,
      result,
      targets,
      userId: input.userId,
      libraryId: input.libraryId,
      targetStatus: input.targetStatus
    });

    return {
      committedCount,
      queued: false,
      targetCount: targets.length,
      job: updatedJob
    };
  }

  /**
   * Handler BackgroundWorker pour `photo_commit` (concurrence 4, progression temps réel SSE).
   */
  async executePhotoCommitJob(ctx: JobHandlerContext): Promise<{ result: { photoJobId: string; committedCount: number }; total: number }> {
    const photoJobId = typeof ctx.payload.photoJobId === 'string' ? ctx.payload.photoJobId : '';
    const targetStatus: 'owned' | 'wish' = ctx.payload.targetStatus === 'wish' ? 'wish' : 'owned';
    const itemIds = Array.isArray(ctx.payload.itemIds)
      ? ctx.payload.itemIds.filter((x): x is string => typeof x === 'string')
      : [];
    const userId = ctx.job.user_id ?? '';
    const libraryId = ctx.job.library_id ?? '';

    const row = this.assertOwnedJob(photoJobId, userId, libraryId);
    const result = this.parseResult(row);
    const targets = result.items.filter((it) => {
      if (it.ignored || !it.selectedOptionIsbn13) return false;
      if (itemIds.length > 0) return itemIds.includes(it.id);
      return it.selected;
    });

    const total = Math.max(1, targets.length);
    ctx.reportProgress(0, total, { photoJobId, committedCount: 0 });

    const { committedCount } = await this.commitTargetsWithConcurrency({
      row,
      result,
      targets,
      userId,
      libraryId,
      targetStatus,
      onItemDone: (done, committed) => {
        ctx.reportProgress(done, total, { photoJobId, committedCount: committed });
      }
    });

    return {
      result: { photoJobId, committedCount },
      total
    };
  }

  private async commitTargetsWithConcurrency(params: {
    row: BackgroundJobRow;
    result: PhotoJobResultPayload;
    targets: PhotoJobItem[];
    userId: string;
    libraryId: string;
    targetStatus: 'owned' | 'wish';
    onItemDone?: (doneCount: number, committedCount: number) => void;
  }): Promise<{ committedCount: number; updatedJob: BackgroundJobView }> {
    let committedCount = 0;
    let doneCount = 0;
    const CONCURRENCY = 4;

    for (let i = 0; i < params.targets.length; i += CONCURRENCY) {
      const batch = params.targets.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (item) => {
          if (!item.selectedOptionIsbn13) return;
          try {
            const resolved = await this.ingestionService.resolveIsbns({
              rawIsbns: [item.selectedOptionIsbn13],
              channel: 'photo_ai',
              action: params.targetStatus,
              userId: params.userId,
              libraryId: params.libraryId
            });

            const book = resolved.results[0]?.book;
            if (book) {
              const chosenOption = item.options.find((o) => o.isbn13 === item.selectedOptionIsbn13);
              let chosenCoverKey: string | null = null;
              if (chosenOption?.coverUrl?.startsWith('/api/covers/')) {
                chosenCoverKey = chosenOption.coverUrl.slice('/api/covers/'.length);
              } else if (chosenOption?.coverUrl) {
                const stored = await this.coverService.ingestFromExternalUrl(chosenOption.coverUrl);
                if (stored) chosenCoverKey = stored.coverKey;
              } else {
                const edRow = this.catalogRepo.findEditionByIsbn13(item.selectedOptionIsbn13);
                if (edRow?.cover_key) chosenCoverKey = edRow.cover_key;
              }

              const userPickedAlternateEdition =
                Boolean(item.options[0]?.isbn13) && item.selectedOptionIsbn13 !== item.options[0].isbn13;
              const overridePatch: {
                isIntegral?: boolean;
                includedVolumes?: string[];
                coverKey?: string;
              } = {};
              if (item.isIntegral) {
                overridePatch.isIntegral = true;
                overridePatch.includedVolumes = item.includedVolumes;
              }
              if (chosenCoverKey && chosenCoverKey !== book.coverKey && (userPickedAlternateEdition || !book.coverKey)) {
                overridePatch.coverKey = chosenCoverKey;
              }
              if (Object.keys(overridePatch).length > 0) {
                this.libraryService.updateBookOverrides(params.libraryId, params.userId, book.id, overridePatch);
              }
              item.committedBookId = book.id;
              item.alreadyStatus = params.targetStatus;
              item.selected = false;
              committedCount++;
            }
          } finally {
            doneCount++;
            params.onItemDone?.(doneCount, committedCount);
          }
        })
      );
    }

    const now = new Date().toISOString();
    this.jobRepo.updateJobProgress(params.row.id, params.row.progress_done, params.row.progress_total, now, params.result);
    const updated = this.jobRepo.findJobById(params.row.id)!;
    this.onJobChanged?.(updated);

    return { committedCount, updatedJob: mapJobRowToView(updated) };
  }

  /**
   * Relance l'analyse OCR Gemini d'un job Photo IA en erreur sans re-décompter le quota utilisateur.
   */
  retryOcrJob(input: { userId: string; libraryId: string; jobId: string }): BackgroundJobView {
    const row = this.assertOwnedJob(input.jobId, input.userId, input.libraryId);
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload_json || '{}') as Record<string, unknown>;
    } catch {
      payload = {};
    }
    const hasDiskImage = typeof payload.previewCoverKey === 'string' && payload.previewCoverKey.length > 0;
    const hasLegacyInlineImage = typeof payload.imageDataUrl === 'string' && payload.imageDataUrl.length > 0;
    if (!hasDiskImage && !hasLegacyInlineImage) {
      throw new AppError(400, 'PHOTO_IMAGE_MISSING', "L'image de cette analyse n'est plus disponible : reprenez une photo.");
    }
    const requeued = this.jobRepo.requeueJob(row.id, new Date().toISOString())!;
    this.onJobChanged?.(requeued);
    return mapJobRowToView(requeued);
  }

  deletePhotoJob(input: { userId: string; libraryId: string; jobId: string }): void {
    const row = this.assertOwnedJob(input.jobId, input.userId, input.libraryId);
    this.jobRepo.deleteJob(row.id);
  }
}
