// src/server/services/acquisition/ingestion.service.ts
// Orchestrateur Pipeline 3 Étages : ISBN -> Tableau Comparatif -> Graphe & Couverture WebP -> Catalogue Central -> Liaison Foyer.

import crypto from 'node:crypto';
import { isbnUtil } from '../../../shared/bibliographic/isbn.util';
import {
  extractFranchiseBaseName,
  isGenericVolumeTitle,
  matchesAuthorName,
  stripCompilationSeriesPrefix,
  tokenOverlapRatio
} from '../../../shared/bibliographic/text-normalize.util';
import type { AcquisitionChannel, BookView, LibraryBookOverrides } from '../../../shared/types/domain.types';
import type { BibliographicConnectors } from '../../connectors/types';
import type { BookRow, CatalogRepository, SeriesRow } from '../../repositories/catalog.repo';
import type { LibraryBookRow, LibraryRepository } from '../../repositories/library.repo';
import type { JobRepository } from '../../repositories/job.repo';
import type { LogRepository } from '../../repositories/log.repo';
import type { CoverService } from '../cover.service';
import type { BookIdentifierService } from './book-identifier.service';
import type { ComparisonTableService } from './comparison-table.service';
import { compareSameVolumeContent, type SeriesGraphService } from './series-graph.service';

export interface SeriesVolumeEnrichmentReport {
  seriesId: string;
  processed: number;
  enrichedByIsbn: number;
  coversAdded: number;
  stillMissingIsbn: number;
  rateLimitedCount: number;
}

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
  private readonly bookIdentifier?: BookIdentifierService;
  private readonly connectors?: BibliographicConnectors;
  private readonly onJobEnqueued?: () => void;

  constructor(deps: {
    catalogRepo: CatalogRepository;
    libraryRepo: LibraryRepository;
    jobRepo: JobRepository;
    logRepo: LogRepository;
    comparisonService: ComparisonTableService;
    seriesGraphService: SeriesGraphService;
    coverService: CoverService;
    bookIdentifier?: BookIdentifierService;
    connectors?: BibliographicConnectors;
    onJobEnqueued?: () => void;
  }) {
    this.catalogRepo = deps.catalogRepo;
    this.libraryRepo = deps.libraryRepo;
    this.jobRepo = deps.jobRepo;
    this.logRepo = deps.logRepo;
    this.comparisonService = deps.comparisonService;
    this.seriesGraphService = deps.seriesGraphService;
    this.coverService = deps.coverService;
    this.bookIdentifier = deps.bookIdentifier;
    this.connectors = deps.connectors;
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

        // 3. Rattachement éventuel à une œuvre déjà existante :
        //    Ordre strict : ISBN -> Q-ID Wikidata -> titre distinctif dans la série -> n° de tome (UNIQUEMENT si contenu compatible)
        const resolvedSeriesRow = resolvedSeriesId ? this.catalogRepo.findSeriesById(resolvedSeriesId) : null;
        let existingWork: BookRow | null =
          bookRow ??
          (draft.wikidataWorkQid ? this.catalogRepo.findBookByWikidataQid(draft.wikidataWorkQid) : null);

        if (!existingWork && resolvedSeriesId) {
          const seriesLabel = resolvedSeriesRow?.canonical_name ?? draft.seriesName ?? '';
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
              // Garde-fou anti-décalage éditorial (ex. France Loisirs T.3 = "Le Tour de Gaule" vs Astérix canonique T.3 = "Astérix et les Goths") :
              // si l'œuvre canonique en base porte un Q-ID Wikidata + titre distinctif et que l'édition entrante porte un titre distinctif
              // incompatible sans le même Q-ID, ne pas écraser l'œuvre canonique !
              const canonicalDistinct =
                Boolean(volCandidate.wikidata_qid) &&
                !isGenericVolumeTitle(volCandidate.title, seriesLabel) &&
                !isGeneric &&
                (!draft.wikidataWorkQid || draft.wikidataWorkQid !== volCandidate.wikidata_qid);
              const titleOverlap = Math.max(
                tokenOverlapRatio(draft.title, volCandidate.title),
                tokenOverlapRatio(volCandidate.title, draft.title)
              );
              if (!canonicalDistinct || titleOverlap >= 0.4) {
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
        }

        // 4. Téléchargement & compression WebP via cascade multi-éditions avant iTunes (disque /data/covers/)
        let coverKey: string | null = bookRow?.cover_key ?? existingWork?.cover_key ?? null;
        if (!coverKey) {
          // Niveau 1 : Candidats API directs + CDN librairies sur l'ISBN scanné (sans iTunes)
          const storedCdn = await this.coverService.resolveBestCoverFromCascade({
            isbn13,
            candidateUrls: draft.coverCandidates,
            skipTitleFallback: true
          });
          if (storedCdn) {
            coverKey = storedCdn.coverKey;
          }
        }
        if (!coverKey) {
          // Niveau 2a (0 ms) : Réutilisation locale d'une couverture de la même franchise / même album
          coverKey = this.findLocalReusableCover({
            franchiseId: resolvedSeriesRow?.franchise_id ?? null,
            seriesName: resolvedSeriesRow?.canonical_name ?? draft.seriesName ?? '',
            title: draft.title,
            normalizedTitle: draft.normalizedTitle,
            authors: draft.authors,
            isIntegral: draft.isIntegral,
            excludeBookId: existingWork?.id
          });
        }
        if (!coverKey && this.connectors?.inventaire.fetchWorkEditions && (draft.wikidataWorkQid || draft.inventaireWorkUri)) {
          // Niveau 2b (multi-éditions Graphe avant iTunes) : éditions sœurs Inventaire.io P629
          const workUri = draft.wikidataWorkQid ? `wd:${draft.wikidataWorkQid}` : draft.inventaireWorkUri!;
          const workEd = await this.connectors.inventaire
            .fetchWorkEditions(workUri)
            .catch(() => ({ isbn13s: [] as string[], coverUrls: [] as string[] }));
          const siblingIsbns = workEd.isbn13s.filter((sib) => sib !== isbn13).slice(0, 4);
          if (siblingIsbns.length > 0 || workEd.coverUrls.length > 0) {
            const consensus = await this.coverService.electBestCoverFromMultiEditions({
              isbn13s: siblingIsbns,
              candidateUrls: workEd.coverUrls,
              maxEditions: 4,
              maxDistinctStored: 4
            });
            if (consensus.winner) {
              coverKey = consensus.winner.coverKey;
            }
          }
        }
        if (!coverKey) {
          // Niveau 3 (dernier recours régulé) : Apple Books / iTunes FR
          const storedItunes = await this.coverService.resolveBestCoverFromCascade({
            isbn13: null,
            candidateUrls: [],
            title: draft.title,
            author: draft.authors[0],
            skipTitleFallback: false
          });
          if (storedItunes) {
            coverKey = storedItunes.coverKey;
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

  /**
   * Phase 3C — Enrichit une fiche tome déjà existante d'une série à partir d'un ISBN-13 résolu
   * en réutilisant EXACTEMENT le moteur Étage 2 (Tableau Comparatif + Cascade couvertures WebP) :
   * - Zéro boucle infinie (ne relance JAMAIS series_expand),
   * - Zéro déplacement hors de la série et préservation du numéro canonique déjà établi,
   * - Zéro collision ISBN avec un autre tome de la base,
   * - Respect strict de Couche 2 (`locked_fields_json`) et Couche 3 (`overrides_json`).
   */
  async enrichExistingBookByIsbn(
    bookId: string,
    rawIsbn: string,
    siblingIsbns: string[] = []
  ): Promise<{ enriched: boolean; coverAdded: boolean }> {
    const existing = this.catalogRepo.findBookById(bookId);
    const isbn13 = isbnUtil.normalizeToIsbn13(rawIsbn);
    if (!existing || !isbn13) return { enriched: false, coverAdded: false };

    // Garde-fou anti-collision : ne jamais rattacher un ISBN qui appartient déjà à un autre livre du catalogue
    const ownerOfIsbn = this.catalogRepo.findBookByIsbn13(isbn13);
    if (ownerOfIsbn && ownerOfIsbn.id !== existing.id) {
      return { enriched: false, coverAdded: false };
    }

    const draft = await this.comparisonService.collectAndArbitrate(isbn13);
    if (!draft) return { enriched: false, coverAdded: false };

    const safeSiblingIsbns = Array.from(
      new Set(
        [isbn13, ...siblingIsbns]
          .map((x) => isbnUtil.normalizeToIsbn13(x))
          .filter((x): x is string => {
            if (!x) return false;
            const owner = this.catalogRepo.findBookByIsbn13(x);
            return !owner || owner.id === existing.id;
          })
      )
    ).slice(0, 4);

    const hadCover = Boolean(existing.cover_key);
    let coverKey: string | null = existing.cover_key ?? null;
    const coverByIsbn = new Map<string, string>();
    const seriesRow = existing.series_id ? this.catalogRepo.findSeriesById(existing.series_id) : null;
    const seriesLabel = seriesRow?.canonical_name ?? draft.seriesName ?? '';
    const existingAuthors = parseJsonStringArray(existing.authors_json);
    const effectiveAuthors = draft.authors.length > 0 ? draft.authors : existingAuthors;

    if (!coverKey && safeSiblingIsbns.length >= 2) {
      // Niveau 1 (multi-éditions) : consensus visuel dHash CDN sans iTunes
      const consensus = await this.coverService.electBestCoverFromMultiEditions({
        isbn13s: safeSiblingIsbns,
        candidateUrls: draft.coverCandidates,
        maxEditions: 4,
        maxDistinctStored: 4
      });
      if (consensus.winner) {
        coverKey = consensus.winner.coverKey;
      }
      for (const entry of consensus.distinctCovers) {
        if (entry.sourceIsbn && !coverByIsbn.has(entry.sourceIsbn)) {
          coverByIsbn.set(entry.sourceIsbn, entry.cover.coverKey);
        }
      }
    }

    if (!coverKey) {
      // Niveau 1 (single ISBN) : candidats directs API + CDN librairies sans iTunes
      const storedCdn = await this.coverService.resolveBestCoverFromCascade({
        isbn13,
        candidateUrls: draft.coverCandidates,
        skipTitleFallback: true
      });
      if (storedCdn) coverKey = storedCdn.coverKey;
    }

    if (!coverKey) {
      // Niveau 2a (0 ms local) : réutilisation depuis une autre édition/découpage de la même franchise ou du même album
      coverKey = this.findLocalReusableCover({
        franchiseId: seriesRow?.franchise_id ?? null,
        seriesName: seriesLabel,
        title: existing.title || draft.title,
        normalizedTitle: existing.normalized_title || draft.normalizedTitle,
        authors: effectiveAuthors,
        isIntegral: existing.is_integral === 1,
        excludeBookId: existing.id
      });
    }

    if (!coverKey) {
      // Niveau 3 (dernier recours régulé) : Apple Books / iTunes FR
      const storedItunes = await this.coverService.resolveBestCoverFromCascade({
        isbn13: null,
        candidateUrls: [],
        title: existing.title || draft.title,
        author: effectiveAuthors[0],
        skipTitleFallback: false
      });
      if (storedItunes) coverKey = storedItunes.coverKey;
    }

    const now = new Date().toISOString();
    const isOfficialFrenchCatalogDraft =
      (draft.contributingSources.includes('bnf') || draft.contributingSources.includes('sudoc')) &&
      (!draft.language || draft.language === 'fr' || draft.language === 'fre') &&
      Boolean(draft.title?.trim()) &&
      !isGenericVolumeTitle(draft.title, seriesLabel);
    const sameProvenWikidataWork = Boolean(
      existing.wikidata_qid && draft.wikidataWorkQid && existing.wikidata_qid === draft.wikidataWorkQid
    );
    const keepExistingTitle =
      Boolean(existing.title?.trim()) &&
      !isGenericVolumeTitle(existing.title, seriesLabel) &&
      !(sameProvenWikidataWork && isOfficialFrenchCatalogDraft);
    const effectiveTitle = keepExistingTitle ? existing.title : draft.title;
    const effectiveNormTitle = keepExistingTitle ? existing.normalized_title : draft.normalizedTitle;

    const existingScriptwriters = parseJsonStringArray(existing.scriptwriters_json);
    const existingIllustrators = parseJsonStringArray(existing.illustrators_json);
    const existingSubgenres = parseJsonStringArray(existing.subgenres_json);
    const existingIncluded = parseJsonStringArray(existing.included_volumes_json);

    this.catalogRepo.upsertBookAutomatic({
      id: existing.id,
      workCanonicalId: existing.work_canonical_id,
      seriesId: existing.series_id,
      title: effectiveTitle,
      normalizedTitle: effectiveNormTitle,
      volumeNumber: existing.volume_number !== null ? existing.volume_number : draft.volumeNumber,
      volumeLabel: existing.volume_label ?? draft.volumeLabel,
      sortOrder: existing.sort_order !== null ? existing.sort_order : draft.sortOrder,
      isHorsSerie: existing.is_hors_serie === 1,
      isIntegral: existing.is_integral === 1,
      includedVolumes: existingIncluded.length > 0 ? existingIncluded : draft.includedVolumes,
      authors: effectiveAuthors,
      scriptwriters: draft.scriptwriters.length > 0 ? draft.scriptwriters : existingScriptwriters,
      illustrators: draft.illustrators.length > 0 ? draft.illustrators : existingIllustrators,
      publisher: draft.publisher ?? existing.publisher,
      collectionName: draft.collectionName ?? existing.collection_name,
      publishYear: draft.publishYear ?? existing.publish_year,
      pageCount: draft.pageCount ?? existing.page_count,
      description: draft.description ?? existing.description,
      language: draft.language || existing.language || 'fr',
      mainCategory:
        draft.mainCategory !== 'Autre' &&
        (existing.main_category === 'Autre' || draft.categoryConfidence === 'explicit')
          ? draft.mainCategory
          : existing.main_category,
      subgenres: draft.subgenres.length > 0 ? draft.subgenres : existingSubgenres,
      coverKey,
      wikidataQid: existing.wikidata_qid ?? draft.wikidataWorkQid,
      inventaireUri: existing.inventaire_uri ?? draft.inventaireWorkUri,
      sourceOrigin: existing.source_origin,
      now
    });

    this.catalogRepo.upsertBookEdition({
      isbn13,
      bookId: existing.id,
      publisher: draft.publisher,
      collectionName: draft.collectionName,
      publishYear: draft.publishYear,
      pageCount: draft.pageCount,
      coverKey: coverByIsbn.get(isbn13) ?? coverKey,
      source: draft.contributingSources[0] ?? 'auto',
      now
    });

    // Enregistre également les éditions sœurs découvertes (et leurs couvertures distinctes) dans l'Œuvre abstraite
    for (const sibIsbn of safeSiblingIsbns) {
      if (sibIsbn === isbn13) continue;
      this.catalogRepo.upsertBookEdition({
        isbn13: sibIsbn,
        bookId: existing.id,
        publisher: null,
        collectionName: null,
        publishYear: null,
        pageCount: null,
        coverKey: coverByIsbn.get(sibIsbn) ?? null,
        source: 'bnf',
        now
      });
    }

    return {
      enriched: true,
      coverAdded: !hadCover && Boolean(coverKey)
    };
  }

  /**
   * Niveau 2a (0 ms local) : cherche une couverture WebP déjà présente dans le Catalogue Central
   * sur un autre découpage de la même franchise (ex. "Spirou et Fantasio en albums" pour un tome
   * de "La collection Spirou et Fantasio") ou un autre ouvrage portant exactement le même titre distinctif
   * avec auteur ou série compatible.
   */
  private findLocalReusableCover(input: {
    franchiseId?: string | null;
    seriesName: string;
    title: string;
    normalizedTitle: string;
    authors: string[];
    isIntegral: boolean;
    excludeBookId?: string;
  }): string | null {
    if (!input.normalizedTitle || isGenericVolumeTitle(input.title, input.seriesName)) {
      return null;
    }

    // 1. Même franchise (exact puis fuzzy)
    if (input.franchiseId) {
      const exact = this.catalogRepo.findFranchiseCoverByNormalizedTitle(
        input.franchiseId,
        input.normalizedTitle,
        input.isIntegral,
        input.excludeBookId
      );
      if (exact) return exact;

      const strippedIn = extractFranchiseBaseName(input.title).normalizedKey;
      const franchiseBooks = this.catalogRepo.listCoveredBooksInFranchise(input.franchiseId);
      for (const cand of franchiseBooks) {
        if (input.excludeBookId && cand.id === input.excludeBookId) continue;
        if (Boolean(cand.is_integral) !== input.isIntegral) continue;
        if (isGenericVolumeTitle(cand.title, input.seriesName)) continue;
        if (strippedIn && extractFranchiseBaseName(cand.title).normalizedKey === strippedIn) {
          return cand.cover_key;
        }
        if (tokenOverlapRatio(input.title, cand.title) >= 0.8 && tokenOverlapRatio(cand.title, input.title) >= 0.8) {
          return cand.cover_key;
        }
      }
    }

    // 2. Même titre normalisé distinctif (>= 4 car.) dans le catalogue local avec auteur ou série compatible
    if (input.normalizedTitle.length >= 4) {
      const sameTitleBooks = this.catalogRepo.listCoveredBooksByNormalizedTitle(
        input.normalizedTitle,
        input.isIntegral,
        input.excludeBookId
      );
      const strippedSelfSeries = input.seriesName ? stripCompilationSeriesPrefix(input.seriesName) : '';

      for (const cand of sameTitleBooks) {
        const candAuthors = parseJsonStringArray(cand.authors_json);
        const authorMatches =
          input.authors.length > 0 &&
          candAuthors.some((ca) => input.authors.some((ia) => matchesAuthorName(ca, ia)));
        if (authorMatches) return cand.cover_key;

        if (cand.series_id && strippedSelfSeries) {
          const candSeries = this.catalogRepo.findSeriesById(cand.series_id);
          if (candSeries) {
            const strippedCandSeries = stripCompilationSeriesPrefix(candSeries.canonical_name);
            const overlap = Math.max(
              tokenOverlapRatio(strippedSelfSeries, strippedCandSeries),
              tokenOverlapRatio(strippedCandSeries, strippedSelfSeries)
            );
            if (overlap >= 0.6) return cand.cover_key;
          }
        }
      }
    }

    return null;
  }

  /**
   * Niveau 2b (Multi-éditions avant iTunes) : cherche des ISBNs / couvertures d'éditions sœurs
   * (Graphe Inventaire.io P629 + BookIdentifierService BnF/Inventaire) afin d'obtenir une couverture
   * sur les CDN librairies (Amazon, Eyrolles, OpenLibrary) sans solliciter Apple iTunes.
   */
  private async discoverSiblingEditionCover(input: {
    book: BookRow;
    knownIsbns: string[];
    series: SeriesRow | null;
    authors: string[];
    mediaFamily: 'graphic' | 'prose' | 'neutral';
  }): Promise<{
    coverKey: string;
    newEditions: Array<{ isbn13: string; coverKey: string | null; source: string }>;
  } | null> {
    const knownSet = new Set(input.knownIsbns);
    const siblingIsbns: string[] = [];
    const candidateCoverUrls: string[] = [];

    const pushSiblingIsbn = (raw: string) => {
      const norm = isbnUtil.normalizeToIsbn13(raw);
      if (norm && !knownSet.has(norm) && !siblingIsbns.includes(norm)) {
        siblingIsbns.push(norm);
      }
    };

    // 1. Graphe Inventaire.io (éditions sœurs P629) si Q-ID Wikidata ou URI Inventaire disponible
    if (this.connectors?.inventaire.fetchWorkEditions && (input.book.wikidata_qid || input.book.inventaire_uri)) {
      const workUri = input.book.wikidata_qid ? `wd:${input.book.wikidata_qid}` : input.book.inventaire_uri!;
      const workEd = await this.connectors.inventaire
        .fetchWorkEditions(workUri)
        .catch(() => ({ isbn13s: [] as string[], coverUrls: [] as string[] }));
      for (const isbn of workEd.isbn13s) pushSiblingIsbn(isbn);
      for (const url of workEd.coverUrls) {
        if (url && !candidateCoverUrls.includes(url)) candidateCoverUrls.push(url);
      }
    }

    // 2. Recherche catalogue multi-éditions (BnF -> Inventaire) en retirant un éventuel préfixe kiosque/collection
    //    UNIQUEMENT lorsque le titre est distinctif (évite les faux positifs sur les titres génériques "Tome N").
    if (this.bookIdentifier && siblingIsbns.length < 4) {
      const rawSeriesName = input.series?.canonical_name ?? '';
      const isGeneric = isGenericVolumeTitle(input.book.title, rawSeriesName);
      const strippedSeriesName =
        !isGeneric && rawSeriesName ? stripCompilationSeriesPrefix(rawSeriesName) : rawSeriesName;
      const strippedChanged = Boolean(rawSeriesName && strippedSeriesName !== rawSeriesName);

      const discovered = await this.bookIdentifier
        .findRankedIsbnsForSeriesVolume(
          {
            seriesName: strippedSeriesName,
            title: input.book.title,
            volumeNumber: strippedChanged ? null : input.book.volume_number,
            authors: input.authors,
            mediaFamily: input.mediaFamily,
            isIntegral: input.book.is_integral === 1
          },
          4
        )
        .catch(() => []);
      for (const isbn of discovered) pushSiblingIsbn(isbn);
    }

    if (siblingIsbns.length === 0 && candidateCoverUrls.length === 0) {
      return null;
    }

    // 3. Vérification des propriétaires locaux d'ISBN :
    //    - ISBN déjà possédé par un autre livre compatible ayant une couverture -> réutilisation instantanée (0 ms) sans voler l'ISBN !
    //    - ISBN libre -> peut être sondé ET enregistré dans `book_editions`.
    const freeSiblingIsbns: string[] = [];
    const borrowedProbeIsbns: string[] = [];

    for (const sib of siblingIsbns) {
      const owner = this.catalogRepo.findBookByIsbn13(sib);
      if (!owner || owner.id === input.book.id) {
        freeSiblingIsbns.push(sib);
      } else {
        const compatibleTitle =
          owner.is_integral === input.book.is_integral &&
          (owner.normalized_title === input.book.normalized_title ||
            Math.max(tokenOverlapRatio(input.book.title, owner.title), tokenOverlapRatio(owner.title, input.book.title)) >=
              0.65);
        if (compatibleTitle) {
          if (owner.cover_key) {
            return { coverKey: owner.cover_key, newEditions: [] };
          }
          borrowedProbeIsbns.push(sib);
        }
      }
    }

    const probeIsbns = [...freeSiblingIsbns, ...borrowedProbeIsbns].slice(0, 4);
    if (probeIsbns.length === 0 && candidateCoverUrls.length === 0) {
      return null;
    }

    // 4. Consensus visuel dHash CDN (Amazon, Eyrolles, OpenLibrary, Inventaire) — ZÉRO iTunes
    const consensus = await this.coverService.electBestCoverFromMultiEditions({
      isbn13s: probeIsbns,
      candidateUrls: candidateCoverUrls,
      maxEditions: 4,
      maxDistinctStored: 4
    });

    if (!consensus.winner) {
      return null;
    }

    const coverByIsbn = new Map<string, string>();
    for (const entry of consensus.distinctCovers) {
      if (entry.sourceIsbn && !coverByIsbn.has(entry.sourceIsbn)) {
        coverByIsbn.set(entry.sourceIsbn, entry.cover.coverKey);
      }
    }

    return {
      coverKey: consensus.winner.coverKey,
      newEditions: freeSiblingIsbns.slice(0, 4).map((isbn13) => ({
        isbn13,
        coverKey: coverByIsbn.get(isbn13) ?? null,
        source: 'auto'
      }))
    };
  }

  private persistBookCoverAndEditions(
    book: BookRow,
    coverKey: string,
    newEditions: Array<{ isbn13: string; coverKey: string | null; source: string }> = []
  ): void {
    const now = new Date().toISOString();
    this.catalogRepo.upsertBookAutomatic({
      id: book.id,
      workCanonicalId: book.work_canonical_id,
      seriesId: book.series_id,
      title: book.title,
      normalizedTitle: book.normalized_title,
      volumeNumber: book.volume_number,
      volumeLabel: book.volume_label,
      sortOrder: book.sort_order,
      isHorsSerie: book.is_hors_serie === 1,
      isIntegral: book.is_integral === 1,
      includedVolumes: parseJsonStringArray(book.included_volumes_json),
      authors: parseJsonStringArray(book.authors_json),
      scriptwriters: parseJsonStringArray(book.scriptwriters_json),
      illustrators: parseJsonStringArray(book.illustrators_json),
      publisher: book.publisher,
      collectionName: book.collection_name,
      publishYear: book.publish_year,
      pageCount: book.page_count,
      description: book.description,
      language: book.language,
      mainCategory: book.main_category,
      subgenres: parseJsonStringArray(book.subgenres_json),
      coverKey,
      wikidataQid: book.wikidata_qid,
      inventaireUri: book.inventaire_uri,
      sourceOrigin: book.source_origin,
      now
    });

    for (const ed of newEditions) {
      const owner = this.catalogRepo.findBookByIsbn13(ed.isbn13);
      if (owner && owner.id !== book.id) continue;
      this.catalogRepo.upsertBookEdition({
        isbn13: ed.isbn13,
        bookId: book.id,
        publisher: null,
        collectionName: null,
        publishYear: null,
        pageCount: null,
        coverKey: ed.coverKey,
        source: ed.source,
        now
      });
    }
  }

  /**
   * Cascade couvertures complète en 3 niveaux pour un tome dépourvu de couverture :
   * - Niveau 1 : CDN directs sur les ISBNs déjà connus (sans iTunes)
   * - Niveau 2a (0 ms) : réutilisation locale depuis la même franchise / même album
   * - Niveau 2b : recherche d'éditions sœurs (Graphe Inventaire + BnF/Inventaire) sur CDN (sans iTunes)
   * - Niveau 3 : dernier recours Apple Books / iTunes FR régulé (1 req / 3,2 s, HIGH > LOW).
   */
  private async resolveCoverWithMultiEditionCascade(input: {
    book: BookRow;
    knownIsbns: string[];
    series: SeriesRow;
    authors: string[];
    mediaFamily: 'graphic' | 'prose' | 'neutral';
    skipKnownIsbnsCdn?: boolean;
  }): Promise<{ coverAdded: boolean; rateLimited: boolean }> {
    const startedAt = Date.now();
    let coverKey: string | null = null;
    let newEditions: Array<{ isbn13: string; coverKey: string | null; source: string }> = [];

    // Niveau 1 : CDN directs sur les ISBNs déjà connus (sans iTunes)
    if (!input.skipKnownIsbnsCdn && input.knownIsbns.length > 0) {
      if (input.knownIsbns.length >= 2) {
        const consensus = await this.coverService.electBestCoverFromMultiEditions({
          isbn13s: input.knownIsbns,
          maxEditions: 4,
          maxDistinctStored: 4
        });
        if (consensus.winner) coverKey = consensus.winner.coverKey;
      } else {
        const stored = await this.coverService.resolveBestCoverFromCascade({
          isbn13: input.knownIsbns[0],
          candidateUrls: [],
          skipTitleFallback: true
        });
        if (stored) coverKey = stored.coverKey;
      }
    }

    // Niveau 2a (0 ms) : réutilisation locale même franchise / même album
    if (!coverKey) {
      coverKey = this.findLocalReusableCover({
        franchiseId: input.series.franchise_id,
        seriesName: input.series.canonical_name,
        title: input.book.title,
        normalizedTitle: input.book.normalized_title,
        authors: input.authors,
        isIntegral: input.book.is_integral === 1,
        excludeBookId: input.book.id
      });
    }

    // Niveau 2b : recherche d'éditions sœurs multi-éditions avant iTunes
    if (!coverKey) {
      const siblingResult = await this.discoverSiblingEditionCover({
        book: input.book,
        knownIsbns: input.knownIsbns,
        series: input.series,
        authors: input.authors,
        mediaFamily: input.mediaFamily
      });
      if (siblingResult) {
        coverKey = siblingResult.coverKey;
        newEditions = siblingResult.newEditions;
      }
    }

    // Niveau 3 : dernier recours Apple Books / iTunes FR régulé
    if (!coverKey) {
      const baseSeries = stripCompilationSeriesPrefix(input.series.canonical_name) || input.series.canonical_name;
      const isGeneric = isGenericVolumeTitle(input.book.title, input.series.canonical_name);
      const titleQuery = isGeneric
        ? `${baseSeries} ${input.book.volume_number ?? ''}`.trim()
        : `${baseSeries} ${input.book.title}`.trim();
      const stored = await this.coverService.resolveBestCoverFromCascade({
        isbn13: null,
        candidateUrls: [],
        title: titleQuery,
        expectedTitle: isGeneric ? undefined : input.book.title,
        author: input.authors[0],
        skipTitleFallback: false
      });
      if (stored) coverKey = stored.coverKey;
    }

    if (coverKey) {
      this.persistBookCoverAndEditions(input.book, coverKey, newEditions);
      return { coverAdded: true, rateLimited: false };
    }

    return {
      coverAdded: false,
      rateLimited: this.coverService.wasItunesRateLimitedSince(startedAt)
    };
  }

  /**
   * Phases 3B + 3C — Complète en tâche de fond tous les tomes d'une série encore dépourvus d'ISBN ou de couverture :
   * 1. Si ISBN déjà présent sans couverture -> cascade multi-éditions (CDN -> Franchise locale -> Éditions sœurs -> iTunes régulé) ;
   * 2. Si aucun ISBN -> BookIdentifierService (Étage 1) puis enrichExistingBookByIsbn (Étage 2) ;
   * 3. Si introuvable ou sans couverture -> cascade multi-éditions (Franchise locale -> Éditions sœurs -> iTunes régulé).
   */
  async enrichIncompleteSeriesVolumes(
    seriesId: string,
    onProgress?: (done: number, total: number) => void
  ): Promise<SeriesVolumeEnrichmentReport> {
    const series = this.catalogRepo.findSeriesById(seriesId);
    if (!series) {
      return { seriesId, processed: 0, enrichedByIsbn: 0, coversAdded: 0, stillMissingIsbn: 0, rateLimitedCount: 0 };
    }

    const allBooks = this.catalogRepo.listBooksBySeriesId(series.id);
    let graphicCount = 0;
    let proseCount = 0;
    for (const b of allBooks) {
      if (b.main_category === 'BD' || b.main_category === 'Manga' || b.main_category === 'Comics') graphicCount++;
      else if (b.main_category === 'Roman' || b.main_category === 'Essai' || b.main_category === 'Poésie / Théâtre') {
        proseCount++;
      }
    }
    const mediaFamily: 'graphic' | 'prose' | 'neutral' =
      graphicCount > 0 && graphicCount >= proseCount
        ? 'graphic'
        : proseCount > 0 && proseCount > graphicCount
          ? 'prose'
          : 'neutral';

    const incomplete = allBooks
      .map((book) => ({ book, editions: this.catalogRepo.listEditionsByBookId(book.id) }))
      .filter(({ book, editions }) => editions.length === 0 || !book.cover_key);

    const total = incomplete.length;
    onProgress?.(0, Math.max(1, total));
    if (total === 0) {
      return { seriesId, processed: 0, enrichedByIsbn: 0, coversAdded: 0, stillMissingIsbn: 0, rateLimitedCount: 0 };
    }

    let processed = 0;
    let enrichedByIsbn = 0;
    let coversAdded = 0;
    let stillMissingIsbn = 0;
    let rateLimitedCount = 0;

    for (const { book, editions } of incomplete) {
      const authors = parseJsonStringArray(book.authors_json);

      try {
        if (editions.length > 0 && !book.cover_key) {
          const outcome = await this.resolveCoverWithMultiEditionCascade({
            book,
            knownIsbns: editions.map((e) => e.isbn13),
            series,
            authors,
            mediaFamily
          });
          if (outcome.coverAdded) coversAdded++;
          if (outcome.rateLimited) rateLimitedCount++;
        } else if (editions.length === 0) {
          // Aucun ISBN -> Phase 3B (Étage 1 multi-éditions) puis Phase 3C (Étage 2 + consensus visuel dHash)
          const bookStartedAt = Date.now();
          const resolvedIsbns = this.bookIdentifier
            ? await this.bookIdentifier.findRankedIsbnsForSeriesVolume(
                {
                  seriesName: series.canonical_name,
                  title: book.title,
                  volumeNumber: book.volume_number,
                  authors,
                  mediaFamily,
                  isIntegral: book.is_integral === 1
                },
                4
              )
            : [];

          if (resolvedIsbns.length > 0) {
            const res = await this.enrichExistingBookByIsbn(book.id, resolvedIsbns[0], resolvedIsbns.slice(1));
            if (res.enriched) enrichedByIsbn++;
            if (res.coverAdded) {
              coversAdded++;
            } else if (!book.cover_key) {
              const refreshed = this.catalogRepo.findBookById(book.id);
              if (!refreshed?.cover_key) {
                if (!res.enriched) {
                  // ISBN trouvé appartient déjà à un autre livre (ex. autre découpage) -> récupérer la couverture quand même !
                  const outcome = await this.resolveCoverWithMultiEditionCascade({
                    book,
                    knownIsbns: [],
                    series,
                    authors,
                    mediaFamily,
                    skipKnownIsbnsCdn: true
                  });
                  if (outcome.coverAdded) coversAdded++;
                  if (outcome.rateLimited) rateLimitedCount++;
                } else if (this.coverService.wasItunesRateLimitedSince(bookStartedAt)) {
                  rateLimitedCount++;
                }
              }
            }
          } else {
            stillMissingIsbn++;
            // Aucun ISBN sur le nom de série exact : cascade multi-éditions (Franchise locale -> Éditions sœurs -> iTunes)
            if (!book.cover_key) {
              const outcome = await this.resolveCoverWithMultiEditionCascade({
                book,
                knownIsbns: [],
                series,
                authors,
                mediaFamily,
                skipKnownIsbnsCdn: true
              });
              if (outcome.coverAdded) coversAdded++;
              if (outcome.rateLimited) rateLimitedCount++;
            }
          }
        }
      } catch {
        // Un tome en échec n'interrompt jamais le reste de la série
      }

      processed++;
      onProgress?.(processed, total);
    }

    return { seriesId, processed, enrichedByIsbn, coversAdded, stillMissingIsbn, rateLimitedCount };
  }
}
