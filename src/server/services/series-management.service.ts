// src/server/services/series-management.service.ts
// Service métier Séries (Franchise -> Découpages, enrichissement à la demande, rattachement/fusion Couche 3, exclusion) & Profil Auteur.

import crypto from 'node:crypto';
import { annotateIntegralCoverage } from '../../shared/bibliographic/integral.util';
import { normalizeTextKey } from '../../shared/bibliographic/text-normalize.util';
import type { BookView, LibraryBookOverrides, SeriesView } from '../../shared/types/domain.types';
import type { DatabaseAdapter } from '../db/database.adapter';
import type { CatalogRepository, SeriesRow } from '../repositories/catalog.repo';
import type { LibraryRepository } from '../repositories/library.repo';
import type { LoanRepository } from '../repositories/loan.repo';
import type { ReadingRepository } from '../repositories/reading.repo';
import type { IngestionService } from './acquisition/ingestion.service';
import type { SeriesExpansionReport, SeriesGraphService } from './acquisition/series-graph.service';
import { mapLoanRowToView } from './loan.service';
import { AppError } from '../middleware/error.middleware';

export interface SeriesDetailPayload {
  series: SeriesView;
  franchiseName: string | null;
  siblingCuts: SeriesView[];
  books: BookView[];
}

export interface AuthorDetailPayload {
  authorName: string;
  series: SeriesView[];
  books: BookView[];
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

  constructor(deps: {
    db: DatabaseAdapter;
    catalogRepo: CatalogRepository;
    libraryRepo: LibraryRepository;
    loanRepo: LoanRepository;
    readingRepo: ReadingRepository;
    ingestionService: IngestionService;
    seriesGraphService: SeriesGraphService;
  }) {
    this.db = deps.db;
    this.catalogRepo = deps.catalogRepo;
    this.libraryRepo = deps.libraryRepo;
    this.loanRepo = deps.loanRepo;
    this.readingRepo = deps.readingRepo;
    this.ingestionService = deps.ingestionService;
    this.seriesGraphService = deps.seriesGraphService;
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

    const views: BookView[] = [];
    for (const bookRow of catalogBooks) {
      const libRow = this.libraryRepo.findLibraryBook(libraryId, bookRow.id);
      const ov = parseOverrides(libRow?.overrides_json);

      // Exclure si one-shot forcé, rattaché ailleurs en Couche 3, ou explicitement masqué de cette série
      if (ov.oneShotForced) continue;
      if (ov.seriesId && ov.seriesId !== seriesId) continue;
      if ((ov.hiddenSeriesIds ?? []).includes(seriesId)) continue;

      const merged = this.ingestionService.buildMergedBookView(bookRow, libRow);
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
    const ownedCount = books.filter((b) => b.ownershipStatus === 'owned' || Boolean(b.ownedViaIntegral)).length;
    const coverBook =
      books.find((b) => b.ownershipStatus === 'owned' && b.coverUrl) ?? books.find((b) => b.coverUrl);

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
        knownVolumesCount: Math.max(sRow.known_volumes_count, books.length),
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
    const detail = this.getSeriesDetail(libraryId, userId, seriesId);
    return { report, detail };
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
    }

    let updatedCount = 0;
    const targetId = targetSeries.id;
    const targetName = targetSeries.canonical_name;

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
   * Profil Auteur : toutes les séries et œuvres de l'auteur dans le Catalogue Central enrichies des statuts Foyer.
   */
  getAuthorDetail(libraryId: string, userId: string, authorName: string): AuthorDetailPayload {
    const cleanName = authorName.trim();
    const authorNorm = normalizeTextKey(cleanName);
    if (!authorNorm) {
      return { authorName: cleanName, series: [], books: [] };
    }

    const found = this.catalogRepo.searchLocalCatalog({ authorNorm, limit: 100 });
    const seriesViews = found.series.map((s) => this.buildSeriesSummary(libraryId, userId, s).view);

    const activeLoans = this.loanRepo.listActiveLoans(libraryId);
    const loanByBookId = new Map(activeLoans.map((l) => [l.book_id, mapLoanRowToView(l)]));

    const rawBooks = found.books.map((bookRow) => {
      const libRow = this.libraryRepo.findLibraryBook(libraryId, bookRow.id);
      const merged = this.ingestionService.buildMergedBookView(bookRow, libRow);
      merged.activeLoan = loanByBookId.get(bookRow.id) ?? null;
      return merged;
    });

    const annotatedBooks = annotateIntegralCoverage(rawBooks, rawBooks);

    return {
      authorName: cleanName,
      series: seriesViews,
      books: annotatedBooks
    };
  }
}
