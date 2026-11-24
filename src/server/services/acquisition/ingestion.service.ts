// src/server/services/acquisition/ingestion.service.ts
// Orchestrateur Pipeline 3 Étages : ISBN -> Tableau Comparatif -> Graphe & Couverture WebP -> Catalogue Central -> Liaison Foyer.

import crypto from 'node:crypto';
import { isbnUtil } from '../../../shared/bibliographic/isbn.util';
import {
  extractFranchiseBaseName,
  isGenericVolumeTitle,
  tokenOverlapRatio
} from '../../../shared/bibliographic/text-normalize.util';
import type { AcquisitionChannel, BookView, LibraryBookOverrides } from '../../../shared/types/domain.types';
import type { BookRow, CatalogRepository } from '../../repositories/catalog.repo';
import type { LibraryBookRow, LibraryRepository } from '../../repositories/library.repo';
import type { JobRepository } from '../../repositories/job.repo';
import type { LogRepository } from '../../repositories/log.repo';
import type { CoverService } from '../cover.service';
import type { ComparisonTableService } from './comparison-table.service';
import { compareSameVolumeContent, type SeriesGraphService } from './series-graph.service';

export interface ResolveIsbnItemResult {
  isbn13: string;
  found: boolean;
  fromCache: boolean;
  book: BookView | null;
  enqueuedSeriesExpandJobId: string | null;
  error?: string;
}

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function parseOverrides(raw: string | null | undefined): LibraryBookOverrides {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as LibraryBookOverrides) : {};
  } catch {
    return {};
  }
}

export class IngestionService {
  private readonly catalogRepo: CatalogRepository;
  private readonly libraryRepo: LibraryRepository;
  private readonly jobRepo: JobRepository;
  private readonly logRepo: LogRepository;
  private readonly comparisonService: ComparisonTableService;
  private readonly seriesGraphService: SeriesGraphService;
  private readonly coverService: CoverService;
  private readonly onJobEnqueued?: () => void;

  constructor(deps: {
    catalogRepo: CatalogRepository;
    libraryRepo: LibraryRepository;
    jobRepo: JobRepository;
    logRepo: LogRepository;
    comparisonService: ComparisonTableService;
    seriesGraphService: SeriesGraphService;
    coverService: CoverService;
    onJobEnqueued?: () => void;
  }) {
    this.catalogRepo = deps.catalogRepo;
    this.libraryRepo = deps.libraryRepo;
    this.jobRepo = deps.jobRepo;
    this.logRepo = deps.logRepo;
    this.comparisonService = deps.comparisonService;
    this.seriesGraphService = deps.seriesGraphService;
    this.coverService = deps.coverService;
    this.onJobEnqueued = deps.onJobEnqueued;
  }

  /**
   * Fusionne un livre du Catalogue Central (Couches 1 & 2) avec les surcharges souveraines du Foyer (Couche 3).
   * Règle absolue : Couche 3 > Couche 2 > Couche 1.
   */
  buildMergedBookView(book: BookRow, libBook: LibraryBookRow | null): BookView {
    const overrides = parseOverrides(libBook?.overrides_json);
    const hasUserOverrides = Object.keys(overrides).length > 0;

    const effectiveSeriesId = overrides.oneShotForced
      ? null
      : overrides.seriesId !== undefined
        ? overrides.seriesId
        : book.series_id;

    const series = effectiveSeriesId ? this.catalogRepo.findSeriesById(effectiveSeriesId) : null;
    const editions = this.catalogRepo.listEditionsByBookId(book.id);

    const effectiveCoverKey = overrides.coverKey !== undefined ? overrides.coverKey : book.cover_key;
    const baseGenres = [book.main_category, ...parseJsonStringArray(book.subgenres_json)];
    const uniqueBaseGenres = Array.from(new Set(baseGenres.filter(Boolean)));

    return {
      id: book.id,
      workCanonicalId: book.work_canonical_id,
      title: overrides.title ?? book.title,
      seriesId: effectiveSeriesId,
      seriesName: overrides.oneShotForced
        ? null
        : overrides.seriesName !== undefined
          ? overrides.seriesName
          : series?.canonical_name ?? null,
      franchiseId: series?.franchise_id ?? null,
      volumeNumber: overrides.volumeNumber !== undefined ? overrides.volumeNumber : book.volume_number,
      volumeLabel: overrides.volumeLabel !== undefined ? overrides.volumeLabel : book.volume_label,
      sortOrder: overrides.sortOrder !== undefined ? overrides.sortOrder : book.sort_order,
      isHorsSerie: overrides.isHorsSerie !== undefined ? overrides.isHorsSerie : book.is_hors_serie === 1,
      isIntegral: overrides.isIntegral !== undefined ? overrides.isIntegral : book.is_integral === 1,
      includedVolumes:
        overrides.includedVolumes !== undefined
          ? overrides.includedVolumes
          : parseJsonStringArray(book.included_volumes_json),
      authors: overrides.authors ?? parseJsonStringArray(book.authors_json),
      scriptwriters: overrides.scriptwriters ?? parseJsonStringArray(book.scriptwriters_json),
      illustrators: overrides.illustrators ?? parseJsonStringArray(book.illustrators_json),
      publisher: overrides.publisher !== undefined ? overrides.publisher : book.publisher,
      collectionName: book.collection_name,
      publishYear: overrides.publishYear !== undefined ? overrides.publishYear : book.publish_year,
      pageCount: overrides.pageCount !== undefined ? overrides.pageCount : book.page_count,
      description: book.description,
      language: book.language,
      mainCategory: overrides.mainCategory ?? book.main_category,
      genres: overrides.genres ?? uniqueBaseGenres,
      coverKey: effectiveCoverKey,
      coverUrl: effectiveCoverKey ? `/api/covers/${effectiveCoverKey}` : null,
      primaryIsbn13: editions[0]?.isbn13 ?? null,
      knownIsbns: editions.map((e) => e.isbn13),
      editions: editions.map((e) => ({
        isbn13: e.isbn13,
        publisher: e.publisher,
        collectionName: e.collection_name,
        publishYear: e.publish_year,
        pageCount: e.page_count,
        coverKey: e.cover_key,
        coverUrl: e.cover_key ? `/api/covers/${e.cover_key}` : null,
        source: e.source
      })),
      ownershipStatus: libBook?.deleted_at ? 'none' : (libBook?.status ?? 'none'),
      wishedByName: null,
      ownedViaIntegral: null,
      activeLoan: null,
      readingState: null,
      hasUserOverrides,
      hiddenSeriesIds: overrides.hiddenSeriesIds ?? [],
      updatedAt: libBook?.updated_at && libBook.updated_at > book.updated_at ? libBook.updated_at : book.updated_at
    };
  }

  /**
   * Résout un lot d'ISBNs via les 3 étages et applique éventuellement l'action Foyer (`owned` / `wish`).
   */
  async resolveIsbns(input: {
    rawIsbns: string[];
    channel: AcquisitionChannel;
    action: 'preview' | 'owned' | 'wish';
    userId: string;
    libraryId: string;
    forceRefresh?: boolean;
  }): Promise<{ traceId: string; results: ResolveIsbnItemResult[] }> {
    const traceId = generateId('trc');
    const results: ResolveIsbnItemResult[] = [];

    for (const raw of input.rawIsbns) {
      const startedAt = Date.now();
      const isbn13 = isbnUtil.normalizeToIsbn13(raw);
      if (!isbn13) {
        results.push({
          isbn13: raw,
          found: false,
          fromCache: false,
          book: null,
          enqueuedSeriesExpandJobId: null,
          error: 'ISBN invalide'
        });
        continue;
      }

      // 1. Recherche O(1) dans le Catalogue Central (sauf forceRefresh)
      let bookRow = this.catalogRepo.findBookByIsbn13(isbn13);
      let fromCache = Boolean(bookRow);
      let enqueuedSeriesExpandJobId: string | null = null;

      if (!bookRow || input.forceRefresh) {
        fromCache = false;
        const draft = await this.comparisonService.collectAndArbitrate(isbn13);

        if (!draft) {
          this.logRepo.append({
            traceId,
            userId: input.userId,
            channel: input.channel,
            stage: 'stage2_comparison',
            step: 'collect',
            status: 'warn',
            durationMs: Date.now() - startedAt,
            summary: `Aucune notice trouvée pour ISBN ${isbn13}`
          });
          results.push({
            isbn13,
            found: false,
            fromCache: false,
            book: null,
            enqueuedSeriesExpandJobId: null
          });
          continue;
        }

        const now = new Date().toISOString();

        // 2. Étage 3 : Résolution Franchise -> Découpage Éditorial
        let resolvedSeriesId: string | null = null;
        if (draft.seriesName) {
          const { series } = this.seriesGraphService.resolveOrCreateSeriesCut({
            seriesName: draft.seriesName,
            wikidataSeriesQid: draft.wikidataSeriesQid,
            bnfEnsembleId: draft.bnfEnsembleId,
            bookTitle: draft.title,
            volumeNumber: draft.volumeNumber,
            isHorsSerie: draft.isHorsSerie,
            isIntegral: draft.isIntegral,
            wikidataWorkQid: draft.wikidataWorkQid,
            pageCount: draft.pageCount,
            collectionName: draft.collectionName,
            publisher: draft.publisher,
            mainCategory: draft.mainCategory,
            authors: draft.authors,
            now
          });
          resolvedSeriesId = series.id;

          // Déclenche une expansion de série en tâche de fond si pas encore étendue
          if (series.is_complete_expanded === 0) {
            const activeJob = this.jobRepo.findActiveJobByTypeAndPayloadKey('series_expand', series.id);
            if (!activeJob) {
              const job = this.jobRepo.createJob({
                id: generateId('job'),
                type: 'series_expand',
                userId: input.userId,
                libraryId: input.libraryId,
                payload: { seriesId: series.id },
                progressTotal: 1,
                now
              });
              enqueuedSeriesExpandJobId = job.id;
              this.onJobEnqueued?.();
            } else {
              enqueuedSeriesExpandJobId = activeJob.id;
            }
          }
        }

        // 3. Téléchargement & compression WebP via cascade multi-sources vérifiée (disque /data/covers/)
        let coverKey: string | null = bookRow?.cover_key ?? null;
        if (!coverKey) {
          const stored = await this.coverService.resolveBestCoverFromCascade({
            isbn13,
            candidateUrls: draft.coverCandidates,
            title: draft.title,
            author: draft.authors[0]
          });
          if (stored) {
            coverKey = stored.coverKey;
          }
        }

        // 4. Rattachement éventuel à une œuvre déjà existante :
        //    Ordre strict : ISBN -> Q-ID Wikidata -> titre distinctif dans la série -> n° de tome (UNIQUEMENT si contenu compatible)
        let existingWork: BookRow | null =
          bookRow ??
          (draft.wikidataWorkQid ? this.catalogRepo.findBookByWikidataQid(draft.wikidataWorkQid) : null);

        if (!existingWork && resolvedSeriesId) {
          const seriesRow = this.catalogRepo.findSeriesById(resolvedSeriesId);
          const seriesLabel = seriesRow?.canonical_name ?? draft.seriesName ?? '';
          const isGeneric = isGenericVolumeTitle(draft.title, seriesLabel);

          if (!isGeneric && draft.normalizedTitle) {
            const byExact = this.catalogRepo.findBookInSeriesByNormalizedTitle(resolvedSeriesId, draft.normalizedTitle);
            if (byExact && Boolean(byExact.is_integral) === Boolean(draft.isIntegral)) {
              existingWork = byExact;
            } else {
              const strippedIn = extractFranchiseBaseName(draft.title).normalizedKey;
              const seriesBooks = this.catalogRepo.listBooksBySeriesId(resolvedSeriesId);
              existingWork =
                seriesBooks.find((b) => {
                  if (Boolean(b.is_integral) !== Boolean(draft.isIntegral)) return false;
                  if (isGenericVolumeTitle(b.title, seriesLabel)) return false;
                  if (strippedIn && extractFranchiseBaseName(b.title).normalizedKey === strippedIn) return true;
                  return tokenOverlapRatio(draft.title, b.title) >= 0.8 && tokenOverlapRatio(b.title, draft.title) >= 0.8;
                }) ?? null;
            }
          }

          if (!existingWork && draft.volumeNumber && !draft.isHorsSerie && !draft.isIntegral) {
            const volCandidate = this.catalogRepo.findBookInSeriesByVolume(resolvedSeriesId, draft.volumeNumber);
            if (volCandidate) {
              const cmp = compareSameVolumeContent(volCandidate, {
                title: draft.title,
                wikidataWorkQid: draft.wikidataWorkQid,
                pageCount: draft.pageCount,
                collectionName: draft.collectionName,
                publisher: draft.publisher,
                seriesName: seriesLabel
              });
              if (cmp.sameContent) {
                existingWork = volCandidate;
              }
            }
          }
        }

        const workCanonicalId =
          existingWork?.work_canonical_id ??
          (draft.wikidataWorkQid
            ? `wd:${draft.wikidataWorkQid}`
            : draft.inventaireWorkUri
              ? `inv:${draft.inventaireWorkUri}`
              : `isbn:${isbn13}`);

        // Si l'œuvre canonique existe déjà avec un Q-ID Wikidata et un n° de tome établi,
        // une réédition à numérotation décalée (ex. Tintin Casterman vs Wikidata) ne doit pas écraser son n° de tome canonique.
        const preserveCanonicalVol = Boolean(
          existingWork?.wikidata_qid && existingWork.volume_number !== null && !draft.wikidataWorkQid
        );

        // Écriture Catalogue Central (Couche 1) en respectant STRICTEMENT locked_fields_json (Couche 2 Admin)
        bookRow = this.catalogRepo.upsertBookAutomatic({
          id: existingWork?.id ?? generateId('bk'),
          workCanonicalId,
          seriesId: resolvedSeriesId,
          title: draft.title,
          normalizedTitle: draft.normalizedTitle,
          volumeNumber: preserveCanonicalVol ? existingWork!.volume_number : draft.volumeNumber,
          volumeLabel: preserveCanonicalVol ? existingWork!.volume_label : draft.volumeLabel,
          sortOrder: preserveCanonicalVol ? existingWork!.sort_order : draft.sortOrder,
          isHorsSerie: draft.isHorsSerie,
          isIntegral: draft.isIntegral,
          includedVolumes: draft.includedVolumes,
          authors: draft.authors,
          scriptwriters: draft.scriptwriters,
          illustrators: draft.illustrators,
          publisher: draft.publisher,
          collectionName: draft.collectionName,
          publishYear: draft.publishYear,
          pageCount: draft.pageCount,
          description: draft.description,
          language: draft.language,
          mainCategory: draft.mainCategory,
          subgenres: draft.subgenres,
          coverKey,
          wikidataQid: draft.wikidataWorkQid,
          inventaireUri: draft.inventaireWorkUri,
          sourceOrigin: 'auto',
          now
        });

        this.catalogRepo.upsertBookEdition({
          isbn13,
          bookId: bookRow.id,
          publisher: draft.publisher,
          collectionName: draft.collectionName,
          publishYear: draft.publishYear,
          pageCount: draft.pageCount,
          coverKey,
          source: draft.contributingSources[0] ?? 'auto',
          now
        });

        if (resolvedSeriesId) {
          this.catalogRepo.recountSeriesVolumes(resolvedSeriesId, now);
        }

        this.logRepo.append({
          traceId,
          userId: input.userId,
          channel: input.channel,
          stage: 'stage3_ingestion',
          step: 'upsert_catalog',
          status: 'ok',
          durationMs: Date.now() - startedAt,
          summary: `ISBN ${isbn13} résolu -> "${bookRow.title}" (${draft.contributingSources.join(', ')})`,
          payload: {
            bookId: bookRow.id,
            seriesId: resolvedSeriesId,
            seriesGuard: draft.seriesGuardVerdict
          }
        });
      }

      // 5. Liaison Foyer (si action === 'owned' | 'wish') SANS JAMAIS écraser overrides_json (Couche 3)
      let libBook = this.libraryRepo.findLibraryBook(input.libraryId, bookRow.id);
      if (input.action === 'owned' || input.action === 'wish') {
        libBook = this.libraryRepo.upsertLibraryBookStatus({
          libraryId: input.libraryId,
          bookId: bookRow.id,
          status: input.action,
          wishedByUserId: input.action === 'wish' ? input.userId : null,
          now: new Date().toISOString()
        });
      }

      results.push({
        isbn13,
        found: true,
        fromCache,
        book: this.buildMergedBookView(bookRow, libBook),
        enqueuedSeriesExpandJobId
      });
    }

    return { traceId, results };
  }
}
