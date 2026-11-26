// src/server/services/series-management.service.ts
// Service métier Séries (Franchise -> Découpages, enrichissement à la demande, rattachement/fusion Couche 3, exclusion) & Profil Auteur.

import crypto from 'node:crypto';
import {
  annotateIntegralCoverage,
  formatIncludedVolumeNumbers,
  formatIntegralRangeLabel,
  parseIncludedVolumeNumbers
} from '../../shared/bibliographic/integral.util';
import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import {
  cleanSeriesName,
  cleanTitle,
  extractFranchiseBaseName,
  isGenericVolumeTitle,
  matchesAuthorName,
  normalizeTextKey
} from '../../shared/bibliographic/text-normalize.util';
import type { BookView, LibraryBookOverrides, SeriesView } from '../../shared/types/domain.types';
import type { BibliographicConnectors } from '../connectors/types';
import type { DatabaseAdapter } from '../db/database.adapter';
import type { CatalogRepository, SeriesRow } from '../repositories/catalog.repo';
import type { LibraryRepository } from '../repositories/library.repo';
import type { LoanRepository } from '../repositories/loan.repo';
import type { ReadingRepository } from '../repositories/reading.repo';
import type { IngestionService } from './acquisition/ingestion.service';
import type { SeriesExpansionReport, SeriesGraphService } from './acquisition/series-graph.service';
import { mapLoanRowToView } from './loan.service';
import { AppError } from '../middleware/error.middleware';
import type { BackgroundJobRow, JobRepository } from '../repositories/job.repo';

export interface SeriesDetailPayload {
  series: SeriesView;
  franchiseName: string | null;
  siblingCuts: SeriesView[];
  books: BookView[];
}

export interface AuthorExternalSeriesHit {
  seriesName: string;
  normalizedKey: string;
  sampleIsbn13: string;
  volumesCount: number;
  sampleTitles: string[];
  coverUrl: string | null;
  source: string;
}

export interface AuthorExternalBookHit {
  isbn13: string;
  title: string;
  authors: string[];
  publisher: string | null;
  publishYear: string | null;
  coverUrl: string | null;
  source: string;
}

export interface AuthorDetailPayload {
  authorName: string;
  series: SeriesView[];
  books: BookView[];
  externalSeries: AuthorExternalSeriesHit[];
  externalBooks: AuthorExternalBookHit[];
}

function parseJsonArray(raw: string | null | undefined): string[] {
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

export class SeriesManagementService {
  private readonly db: DatabaseAdapter;
  private readonly catalogRepo: CatalogRepository;
  private readonly libraryRepo: LibraryRepository;
  private readonly loanRepo: LoanRepository;
  private readonly readingRepo: ReadingRepository;
  private readonly ingestionService: IngestionService;
  private readonly seriesGraphService: SeriesGraphService;
  private readonly connectors?: BibliographicConnectors;
  private readonly jobRepo?: JobRepository;
  private readonly onJobEnqueued?: () => void;
  private readonly onJobChanged?: (row: BackgroundJobRow | null) => void;

  constructor(deps: {
    db: DatabaseAdapter;
    catalogRepo: CatalogRepository;
    libraryRepo: LibraryRepository;
    loanRepo: LoanRepository;
    readingRepo: ReadingRepository;
    ingestionService: IngestionService;
    seriesGraphService: SeriesGraphService;
    connectors?: BibliographicConnectors;
    jobRepo?: JobRepository;
    onJobEnqueued?: () => void;
    onJobChanged?: (row: BackgroundJobRow | null) => void;
  }) {
    this.db = deps.db;
    this.catalogRepo = deps.catalogRepo;
    this.libraryRepo = deps.libraryRepo;
    this.loanRepo = deps.loanRepo;
    this.readingRepo = deps.readingRepo;
    this.ingestionService = deps.ingestionService;
    this.seriesGraphService = deps.seriesGraphService;
    this.connectors = deps.connectors;
    this.jobRepo = deps.jobRepo;
    this.onJobEnqueued = deps.onJobEnqueued;
    this.onJobChanged = deps.onJobChanged;
  }

  private buildBookViewsForSeries(libraryId: string, userId: string, seriesId: string): BookView[] {
    const catalogBooks = this.catalogRepo.listBooksBySeriesId(seriesId);
    const seenIds = new Set(catalogBooks.map((b) => b.id));

    // Inclut aussi les livres rattachés à cette série uniquement en Couche 3 Foyer (`overrides_json.seriesId`)
    const allLibRows = this.libraryRepo.listLibraryBooks(libraryId);
    for (const lr of allLibRows) {
      if (seenIds.has(lr.book_id)) continue;
      const ov = parseOverrides(lr.overrides_json);
      if (!ov.oneShotForced && ov.seriesId === seriesId) {
        const br = this.catalogRepo.findBookById(lr.book_id);
        if (br) {
          catalogBooks.push(br);
          seenIds.add(br.id);
        }
      }
    }

    const activeLoans = this.loanRepo.listActiveLoans(libraryId);
    const loanByBookId = new Map(activeLoans.map((l) => [l.book_id, mapLoanRowToView(l)]));

    const readingRows = this.readingRepo.listByUser(userId);
    const readingByBookId = new Map(
      readingRows.map((r) => [
        r.book_id,
        { status: r.status, rating: r.rating, notes: r.notes, updatedAt: r.updated_at }
      ])
    );

    const coherentCoverByBookId = this.ingestionService.computeSeriesCoherentCoverMap(seriesId, libraryId);

    const views: BookView[] = [];
    for (const bookRow of catalogBooks) {
      const libRow = this.libraryRepo.findLibraryBook(libraryId, bookRow.id);
      const ov = parseOverrides(libRow?.overrides_json);

      // Exclure si one-shot forcé, rattaché ailleurs en Couche 3, ou explicitement masqué de cette série
      if (ov.oneShotForced) continue;
      if (ov.seriesId && ov.seriesId !== seriesId) continue;
      if ((ov.hiddenSeriesIds ?? []).includes(seriesId)) continue;

      const merged = this.ingestionService.buildMergedBookView(bookRow, libRow, {
        coherentCoverKey: coherentCoverByBookId.get(bookRow.id) ?? null
      });
      merged.activeLoan = loanByBookId.get(bookRow.id) ?? null;
      merged.readingState = readingByBookId.get(bookRow.id) ?? null;
      views.push(merged);
    }

    const annotated = annotateIntegralCoverage(views, views);
    return annotated.sort((a, b) => {
      const sa = a.sortOrder ?? a.volumeNumber ?? 999999;
      const sb = b.sortOrder ?? b.volumeNumber ?? 999999;
      if (sa !== sb) return sa - sb;
      return a.title.localeCompare(b.title, 'fr');
    });
  }

  private buildSeriesSummary(libraryId: string, userId: string, sRow: SeriesRow): {
    view: SeriesView;
    books: BookView[];
  } {
    const books = this.buildBookViewsForSeries(libraryId, userId, sRow.id);
    const unitaryBooks = books.filter((b) => !b.isIntegral);
    const progressPool = unitaryBooks.length > 0 ? unitaryBooks : books;
    const ownedCount = progressPool.filter(
      (b) => b.ownershipStatus === 'owned' || Boolean(b.ownedViaIntegral)
    ).length;
    const coverBook =
      books.find((b) => !b.isIntegral && b.ownershipStatus === 'owned' && b.coverUrl) ??
      books.find((b) => b.ownershipStatus === 'owned' && b.coverUrl) ??
      books.find((b) => !b.isIntegral && b.coverUrl) ??
      books.find((b) => b.coverUrl);

    return {
      view: {
        id: sRow.id,
        franchiseId: sRow.franchise_id,
        canonicalName: sRow.canonical_name,
        editionSignature: sRow.edition_signature || null,
        aliases: parseJsonArray(sRow.aliases_json),
        primaryAuthors: parseJsonArray(sRow.primary_authors_json),
        wikidataQid: sRow.wikidata_qid,
        isCompleteExpanded: sRow.is_complete_expanded === 1,
        knownVolumesCount: unitaryBooks.length > 0 ? unitaryBooks.length : Math.max(sRow.known_volumes_count, books.length),
        ownedCount,
        coverUrl: coverBook?.coverUrl ?? null,
        updatedAt: sRow.updated_at
      },
      books
    };
  }

  getSeriesDetail(libraryId: string, userId: string, seriesId: string): SeriesDetailPayload {
    const sRow = this.catalogRepo.findSeriesById(seriesId);
    if (!sRow) {
      throw new AppError(404, 'SERIES_NOT_FOUND', 'Série introuvable.');
    }

    const { view, books } = this.buildSeriesSummary(libraryId, userId, sRow);
    const franchise = sRow.franchise_id ? this.catalogRepo.findFranchiseById(sRow.franchise_id) : null;

    const siblingCuts: SeriesView[] = [];
    if (franchise) {
      const cuts = this.catalogRepo.findSeriesByFranchiseId(franchise.id);
      for (const cut of cuts) {
        if (cut.id === sRow.id) continue;
        siblingCuts.push(this.buildSeriesSummary(libraryId, userId, cut).view);
      }
    }

    return {
      series: view,
      franchiseName: franchise?.canonical_name ?? null,
      siblingCuts,
      books
    };
  }

  async expandSeriesNow(
    libraryId: string,
    userId: string,
    seriesId: string
  ): Promise<{ report: SeriesExpansionReport; detail: SeriesDetailPayload }> {
    const sRow = this.catalogRepo.findSeriesById(seriesId);
    if (!sRow) {
      throw new AppError(404, 'SERIES_NOT_FOUND', 'Série introuvable.');
    }
    const report = await this.seriesGraphService.expandSeriesByGraph(seriesId);
    if (report.incompleteVolumeCount > 0 && this.jobRepo) {
      const now = new Date().toISOString();
      const existing = this.jobRepo.findActiveJobByTypeAndPayloadKey('series_enrich_volumes', seriesId);
      if (!existing) {
        const created = this.jobRepo.createJob({
          id: `job_${crypto.randomBytes(6).toString('hex')}`,
          type: 'series_enrich_volumes',
          userId,
          libraryId,
          payload: { seriesId, priority: 'high' },
          progressTotal: report.incompleteVolumeCount,
          now
        });
        this.onJobChanged?.(created);
        this.onJobEnqueued?.();
      } else if (existing.status === 'pending') {
        const promoted = this.jobRepo.promotePendingJobPriority(existing.id, now);
        this.onJobChanged?.(promoted);
        this.onJobEnqueued?.();
      }
    }
    const detail = this.getSeriesDetail(libraryId, userId, seriesId);
    return { report, detail };
  }

  /**
   * Crée ou rattache une œuvre Intégrale DISTINCTE dans une série SANS JAMAIS écraser un tome unitaire existant.
   * Vérifie d'abord si une intégrale correspondante existe déjà en base ou à la BnF pour rapatrier son ISBN et sa couverture.
   */
  async createOrLinkIntegralForSeries(input: {
    libraryId: string;
    userId: string;
    seriesId: string;
    includedVolumes: string[];
    title?: string;
    isbn13?: string;
    ownershipStatus?: 'owned' | 'wish' | 'none';
  }): Promise<{ book: BookView; matchedExisting: boolean; matchedBnfIsbn: string | null }> {
    const series = this.catalogRepo.findSeriesById(input.seriesId);
    if (!series) {
      throw new AppError(404, 'SERIES_NOT_FOUND', 'Série introuvable.');
    }

    const vols = parseIncludedVolumeNumbers(input.includedVolumes);
    if (vols.length === 0) {
      throw new AppError(400, 'INVALID_INCLUDED_VOLUMES', 'Indiquez au moins un numéro de tome inclus (ex. 1-3).');
    }

    const now = new Date().toISOString();
    const targetSig = vols.join(',');
    const cleanInputIsbn = input.isbn13 ? isbnUtil.normalizeToIsbn13(input.isbn13) : null;

    // 1. Chercher une intégrale déjà existante dans cette série (par ISBN ou même plage de tomes)
    const seriesBooks = this.catalogRepo.listBooksBySeriesId(series.id);
    let targetBook =
      (cleanInputIsbn ? this.catalogRepo.findBookByIsbn13(cleanInputIsbn) : null) ??
      seriesBooks.find((b) => {
        if (b.is_integral !== 1) return false;
        const existingVols = parseIncludedVolumeNumbers(parseJsonArray(b.included_volumes_json));
        return existingVols.length > 0 && existingVols.join(',') === targetSig;
      }) ??
      null;

    // Garde-fou : ne JAMAIS réutiliser/écraser un tome unitaire !
    if (targetBook && targetBook.is_integral !== 1) {
      targetBook = null;
    }

    const matchedExisting = Boolean(targetBook);
    let matchedBnfIsbn: string | null = cleanInputIsbn;
    let bnfMatchTitle: string | null = null;
    let bnfAuthors: string[] = [];
    let bnfPublisher: string | null = null;
    let bnfYear: string | null = null;
    let bnfPages: number | null = null;

    // 2. Si absente en base, interroger BnF Intégrales pour rapatrier ISBN & métadonnées officielles
    if (!targetBook && !matchedBnfIsbn && this.connectors?.bnf.searchSeriesIntegrals) {
      try {
        const bnfIntegrals = await this.connectors.bnf.searchSeriesIntegrals(series.canonical_name, 20);
        const exactMatch =
          bnfIntegrals.find((it) => (it.includedVolumes ?? []).join(',') === targetSig) ??
          bnfIntegrals.find((it) => {
            const iv = it.includedVolumes ?? [];
            return iv.length > 0 && vols.every((v) => iv.includes(v));
          });
        if (exactMatch) {
          matchedBnfIsbn = exactMatch.isbn13s[0] ?? null;
          bnfMatchTitle = exactMatch.title;
          bnfAuthors = exactMatch.authors;
          bnfPublisher = exactMatch.publisher ?? null;
          bnfYear = exactMatch.publishYear ?? null;
          bnfPages = exactMatch.pageCount ?? null;
        }
      } catch {
        // continue sans BnF
      }
    }

    // 3. Créer la nouvelle fiche œuvre Intégrale distincte si nécessaire
    if (!targetBook) {
      const formattedRange = formatIncludedVolumeNumbers(vols);
      const effectiveTitle =
        input.title?.trim() ||
        bnfMatchTitle ||
        `${series.canonical_name} — Intégrale (${formattedRange})`;
      const primaryAuthors = parseJsonArray(series.primary_authors_json);
      const firstUnitary = seriesBooks.find((b) => b.is_integral === 0);
      const volumeLabel = formatIntegralRangeLabel(vols);

      targetBook = this.catalogRepo.upsertBookAutomatic({
        id: `bk_${crypto.randomBytes(6).toString('hex')}`,
        workCanonicalId: `ser:${series.id}:int:${vols.join('-')}:${crypto.randomBytes(3).toString('hex')}`,
        seriesId: series.id,
        title: effectiveTitle,
        normalizedTitle: normalizeTextKey(effectiveTitle),
        volumeNumber: null,
        volumeLabel,
        sortOrder: 10000 + (parseInt(vols[0], 10) || 999),
        isHorsSerie: false,
        isIntegral: true,
        includedVolumes: vols,
        authors: bnfAuthors.length > 0 ? bnfAuthors : primaryAuthors,
        scriptwriters: [],
        illustrators: [],
        publisher: bnfPublisher,
        collectionName: null,
        publishYear: bnfYear,
        pageCount: bnfPages,
        description: null,
        language: 'fr',
        mainCategory: firstUnitary?.main_category ?? 'BD',
        subgenres: [],
        coverKey: null,
        wikidataQid: null,
        inventaireUri: null,
        sourceOrigin: matchedBnfIsbn ? 'auto' : 'manual',
        now
      });
    }

    // 4. Si un ISBN BnF/saisi a été trouvé, enrichir via le moteur Étage 2 unique (couverture + métadonnées)
    if (matchedBnfIsbn) {
      await this.ingestionService.enrichExistingBookByIsbn(targetBook.id, matchedBnfIsbn).catch(() => null);
      targetBook = this.catalogRepo.findBookById(targetBook.id) ?? targetBook;
    }

    // 5. Enregistrer statut Foyer + surcharge Couche 3 des tomes inclus choisis par l'utilisateur
    const status = input.ownershipStatus ?? 'owned';
    if (status === 'owned' || status === 'wish') {
      this.libraryRepo.upsertLibraryBookStatus({
        libraryId: input.libraryId,
        bookId: targetBook.id,
        status,
        wishedByUserId: status === 'wish' ? input.userId : null,
        now
      });
    }
    const existingLib = this.libraryRepo.findLibraryBook(input.libraryId, targetBook.id);
    const existingOv = parseOverrides(existingLib?.overrides_json);
    const updatedLib = this.libraryRepo.setLibraryBookOverrides(
      input.libraryId,
      targetBook.id,
      {
        ...existingOv,
        isIntegral: true,
        includedVolumes: vols,
        volumeLabel: formatIntegralRangeLabel(vols)
      },
      now
    );

    const view = this.ingestionService.buildMergedBookView(targetBook, updatedLib);
    return { book: view, matchedExisting, matchedBnfIsbn };
  }

  /**
   * Rattache ou fusionne des livres (ou toute une série source) vers une série cible en Couche 3 Foyer.
   */
  attachBooksToSeries(input: {
    libraryId: string;
    userId: string;
    bookIds: string[];
    targetSeriesId?: string;
    newSeriesName?: string;
    mergeEntireSourceSeriesId?: string;
    volumeType?: 'standard' | 'hors_serie' | 'integrale' | 'unnumbered';
    volumeLabel?: string | null;
    sortOrder?: number | null;
  }): { targetSeriesId: string; updatedCount: number } {
    const now = new Date().toISOString();

    let targetSeries: SeriesRow | null = null;
    if (input.targetSeriesId) {
      targetSeries = this.catalogRepo.findSeriesById(input.targetSeriesId);
    } else if (input.newSeriesName?.trim()) {
      const norm = normalizeTextKey(input.newSeriesName);
      const existing = this.catalogRepo.findSeriesByKeyAndSignature(norm, '');
      if (existing) {
        targetSeries = existing;
      } else {
        targetSeries = this.catalogRepo.createSeries({
          id: `ser_${crypto.randomBytes(6).toString('hex')}`,
          franchiseId: null,
          canonicalName: input.newSeriesName.trim(),
          normalizedKey: norm,
          editionSignature: '',
          aliases: [],
          primaryAuthors: [],
          wikidataQid: null,
          bnfEnsembleIds: [],
          now
        });
      }
    }

    if (!targetSeries) {
      throw new AppError(400, 'TARGET_SERIES_REQUIRED', 'Veuillez choisir ou créer une série cible.');
    }

    const bookIdSet = new Set(input.bookIds);
    if (input.mergeEntireSourceSeriesId) {
      const sourceBooks = this.catalogRepo.listBooksBySeriesId(input.mergeEntireSourceSeriesId);
      for (const b of sourceBooks) bookIdSet.add(b.id);
      // Inclure également les livres rattachés à la série source en Couche 3 (fusions en cascade)
      for (const lr of this.libraryRepo.listLibraryBooks(input.libraryId)) {
        const ov = parseOverrides(lr.overrides_json);
        if (!ov.oneShotForced && ov.seriesId === input.mergeEntireSourceSeriesId) {
          bookIdSet.add(lr.book_id);
        }
      }
    }

    let updatedCount = 0;
    const targetId = targetSeries.id;
    const targetName = targetSeries.canonical_name;
    const existingTargetBooks = input.mergeEntireSourceSeriesId
      ? this.catalogRepo.listBooksBySeriesId(targetId)
      : [];

    this.db.transaction(() => {
      for (const bookId of bookIdSet) {
        const bookRow = this.catalogRepo.findBookById(bookId);
        if (!bookRow) continue;
        const libRow = this.libraryRepo.findLibraryBook(input.libraryId, bookId);
        const current = parseOverrides(libRow?.overrides_json);

        const nextHidden = (current.hiddenSeriesIds ?? []).filter((id) => id !== targetId);
        const nextOverrides: LibraryBookOverrides = {
          ...current,
          oneShotForced: false,
          seriesId: targetId,
          seriesName: targetName,
          hiddenSeriesIds: nextHidden
        };

        // Lors d'une fusion de série entière, si un livre possédé/souhaité de la série source a le même titre qu'un tome
        // non possédé déjà dans la série cible (ex. Tintin en Amérique), masquer le doublon non possédé en Couche 3
        // et reprendre son numéro/position de tri si manquant (Catalogue Central intact).
        const isUserTracked = Boolean(libRow && !libRow.deleted_at && (libRow.status === 'owned' || libRow.status === 'wish'));
        if (input.mergeEntireSourceSeriesId && isUserTracked && !isGenericVolumeTitle(bookRow.title, targetName)) {
          const srcBaseTitle = extractFranchiseBaseName(current.title ?? bookRow.title).normalizedKey;
          if (srcBaseTitle) {
            const unownedDup = existingTargetBooks.find((tb) => {
              if (tb.id === bookRow.id || bookIdSet.has(tb.id)) return false;
              if (Boolean(tb.is_integral) !== Boolean(current.isIntegral ?? bookRow.is_integral === 1)) return false;
              if (isGenericVolumeTitle(tb.title, targetName)) return false;
              const tbLib = this.libraryRepo.findLibraryBook(input.libraryId, tb.id);
              if (tbLib && !tbLib.deleted_at && (tbLib.status === 'owned' || tbLib.status === 'wish')) return false;
              return extractFranchiseBaseName(tb.title).normalizedKey === srcBaseTitle;
            });
            if (unownedDup) {
              const dupLib = this.libraryRepo.findLibraryBook(input.libraryId, unownedDup.id);
              const dupOv = parseOverrides(dupLib?.overrides_json);
              this.libraryRepo.setLibraryBookOverrides(
                input.libraryId,
                unownedDup.id,
                {
                  ...dupOv,
                  hiddenSeriesIds: Array.from(new Set([...(dupOv.hiddenSeriesIds ?? []), targetId]))
                },
                now
              );
              if (current.volumeNumber === undefined && bookRow.volume_number === null && unownedDup.volume_number !== null) {
                nextOverrides.volumeNumber = unownedDup.volume_number;
                nextOverrides.volumeLabel = unownedDup.volume_label ?? String(unownedDup.volume_number);
                nextOverrides.sortOrder = unownedDup.sort_order ?? unownedDup.volume_number;
              }
            }
          }
        }

        // Si un seul livre est rattaché avec des précisions de tome / position (ex. 0.5, HS)
        if (bookIdSet.size === 1) {
          if (input.volumeType === 'hors_serie') {
            nextOverrides.isHorsSerie = true;
            nextOverrides.isIntegral = false;
          } else if (input.volumeType === 'integrale') {
            nextOverrides.isIntegral = true;
            nextOverrides.isHorsSerie = false;
          } else if (input.volumeType === 'standard') {
            nextOverrides.isHorsSerie = false;
            nextOverrides.isIntegral = false;
          } else if (input.volumeType === 'unnumbered') {
            nextOverrides.volumeNumber = null;
            nextOverrides.volumeLabel = null;
          }
          if (input.volumeLabel !== undefined) nextOverrides.volumeLabel = input.volumeLabel;
          if (input.sortOrder !== undefined) nextOverrides.sortOrder = input.sortOrder;
        }

        this.libraryRepo.setLibraryBookOverrides(input.libraryId, bookId, nextOverrides, now);
        updatedCount++;
      }
    });

    return { targetSeriesId: targetId, updatedCount };
  }

  /**
   * Exclut un ou plusieurs tomes d'une série pour ce foyer (Couche 3 `hiddenSeriesIds`).
   */
  excludeBooksFromSeries(libraryId: string, seriesId: string, bookIds: string[]): { excludedCount: number } {
    const now = new Date().toISOString();
    let excludedCount = 0;

    this.db.transaction(() => {
      for (const bookId of bookIds) {
        const bookRow = this.catalogRepo.findBookById(bookId);
        if (!bookRow) continue;
        const libRow = this.libraryRepo.findLibraryBook(libraryId, bookId);
        const current = parseOverrides(libRow?.overrides_json);
        const nextHidden = Array.from(new Set([...(current.hiddenSeriesIds ?? []), seriesId]));

        const nextOverrides: LibraryBookOverrides = {
          ...current,
          hiddenSeriesIds: nextHidden,
          ...(current.seriesId === seriesId ? { seriesId: null, seriesName: null } : {})
        };
        this.libraryRepo.setLibraryBookOverrides(libraryId, bookId, nextOverrides, now);
        excludedCount++;
      }
    });

    return { excludedCount };
  }

  /**
   * Profil Auteur : œuvres et séries locales (priorisées possédées/souhaitées) + découverte externe BnF/Inventaire
   * triée en séries puis œuvres indépendantes.
   */
  async getAuthorDetail(libraryId: string, userId: string, authorName: string): Promise<AuthorDetailPayload> {
    const cleanName = authorName.trim();
    const authorNorm = normalizeTextKey(cleanName);
    if (!authorNorm) {
      return { authorName: cleanName, series: [], books: [], externalSeries: [], externalBooks: [] };
    }

    const found = this.catalogRepo.searchLocalCatalog({ authorNorm, limit: 200 });
    const activeLoans = this.loanRepo.listActiveLoans(libraryId);
    const loanByBookId = new Map(activeLoans.map((l) => [l.book_id, mapLoanRowToView(l)]));

    const rawBooks = found.books.map((bookRow) => {
      const libRow = this.libraryRepo.findLibraryBook(libraryId, bookRow.id);
      const merged = this.ingestionService.buildMergedBookView(bookRow, libRow);
      merged.activeLoan = loanByBookId.get(bookRow.id) ?? null;
      return merged;
    });

    // Inclure également les séries des livres locaux trouvés (même si primary_authors_json de la série était incomplet)
    const seriesById = new Map<string, SeriesRow>();
    for (const s of found.series) seriesById.set(s.id, s);
    for (const b of rawBooks) {
      if (b.seriesId && !seriesById.has(b.seriesId)) {
        const sRow = this.catalogRepo.findSeriesById(b.seriesId);
        if (sRow) seriesById.set(sRow.id, sRow);
      }
    }

    const seriesViews = Array.from(seriesById.values())
      .map((s) => this.buildSeriesSummary(libraryId, userId, s).view)
      .sort((a, b) => {
        const aOwned = a.ownedCount > 0 ? 1 : 0;
        const bOwned = b.ownedCount > 0 ? 1 : 0;
        if (bOwned !== aOwned) return bOwned - aOwned;
        return a.canonicalName.localeCompare(b.canonicalName, 'fr', { sensitivity: 'base' });
      });

    const annotatedBooks = annotateIntegralCoverage(rawBooks, rawBooks).sort((a, b) => {
      const rank = (s: BookView['ownershipStatus']) => (s === 'owned' ? 2 : s === 'wish' ? 1 : 0);
      const diff = rank(b.ownershipStatus) - rank(a.ownershipStatus);
      if (diff !== 0) return diff;
      return a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' });
    });

    // Découverte externe légère (BnF par auteur + Inventaire) pour montrer les autres séries & œuvres indépendantes
    const externalSeries: AuthorExternalSeriesHit[] = [];
    const externalBooks: AuthorExternalBookHit[] = [];

    if (this.connectors) {
      const knownIsbns = new Set<string>();
      const knownBookTitles = new Set<string>();
      for (const b of annotatedBooks) {
        for (const isbn of b.knownIsbns) knownIsbns.add(isbn);
        knownBookTitles.add(normalizeTextKey(b.title));
      }
      const knownSeriesKeys = new Set<string>();
      for (const s of seriesViews) {
        knownSeriesKeys.add(extractFranchiseBaseName(s.canonicalName).normalizedKey);
        for (const al of s.aliases) knownSeriesKeys.add(extractFranchiseBaseName(al).normalizedKey);
      }

      const [bnfRes, invRes] = await Promise.allSettled([
        this.connectors.bnf.searchByTitleAndAuthor('', cleanName, 30),
        this.connectors.inventaire.searchByText
          ? this.connectors.inventaire.searchByText(cleanName, 15)
          : Promise.resolve([])
      ]);

      const rawExternal = [
        ...(bnfRes.status === 'fulfilled' ? bnfRes.value : []),
        ...(invRes.status === 'fulfilled' ? invRes.value : [])
      ];

      const extSeriesMap = new Map<string, AuthorExternalSeriesHit>();
      const seenExtBookTitles = new Set<string>();

      for (const hit of rawExternal) {
        if (!hit.isbn13 || !hit.title) continue;
        if (knownIsbns.has(hit.isbn13)) continue;
        // Vérifier que cet auteur figure bien parmi les créateurs du livre trouvé
        const allCreators = [...hit.authors, ...hit.scriptwriters, ...hit.illustrators];
        if (allCreators.length > 0 && !allCreators.some((a) => matchesAuthorName(a, cleanName))) {
          continue;
        }

        const isTrueSeries =
          Boolean(hit.seriesName?.trim()) &&
          (hit.seriesLinkKind === 'graph_p179' || hit.seriesLinkKind === 'marc_ensemble_460');

        if (isTrueSeries && hit.seriesName) {
          const cleanedSer = cleanSeriesName(hit.seriesName);
          const serKey = extractFranchiseBaseName(cleanedSer).normalizedKey;
          if (!serKey || knownSeriesKeys.has(serKey)) continue;

          const existing = extSeriesMap.get(serKey);
          const cleanT = cleanTitle(hit.title);
          if (!existing) {
            extSeriesMap.set(serKey, {
              seriesName: cleanedSer,
              normalizedKey: serKey,
              sampleIsbn13: hit.isbn13,
              volumesCount: 1,
              sampleTitles: cleanT ? [cleanT] : [],
              coverUrl: hit.coverUrl && !/\.svg(?:[?#]|$)/i.test(hit.coverUrl) ? hit.coverUrl : null,
              source: hit.source
            });
          } else {
            existing.volumesCount++;
            if (cleanT && !existing.sampleTitles.includes(cleanT) && existing.sampleTitles.length < 3) {
              existing.sampleTitles.push(cleanT);
            }
            if (!existing.coverUrl && hit.coverUrl && !/\.svg(?:[?#]|$)/i.test(hit.coverUrl)) {
              existing.coverUrl = hit.coverUrl;
            }
          }
        } else {
          const cleanT = cleanTitle(hit.title);
          const normT = normalizeTextKey(cleanT);
          if (!normT || knownBookTitles.has(normT) || seenExtBookTitles.has(normT)) continue;
          seenExtBookTitles.add(normT);
          knownIsbns.add(hit.isbn13);

          externalBooks.push({
            isbn13: hit.isbn13,
            title: cleanT,
            authors: hit.authors,
            publisher: hit.publisher ?? null,
            publishYear: hit.publishYear ?? null,
            coverUrl: hit.coverUrl && !/\.svg(?:[?#]|$)/i.test(hit.coverUrl) ? hit.coverUrl : null,
            source: hit.source
          });
        }
      }

      externalSeries.push(
        ...Array.from(extSeriesMap.values()).sort((a, b) =>
          a.seriesName.localeCompare(b.seriesName, 'fr', { sensitivity: 'base' })
        )
      );
      externalBooks.sort((a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' }));
    }

    return {
      authorName: cleanName,
      series: seriesViews,
      books: annotatedBooks,
      externalSeries,
      externalBooks
    };
  }
}
