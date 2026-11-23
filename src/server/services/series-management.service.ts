// src/server/services/series-management.service.ts
// Service métier Séries (Franchise -> Découpages, enrichissement à la demande, rattachement/fusion Couche 3, exclusion) & Profil Auteur.

import crypto from 'node:crypto';
import { annotateIntegralCoverage } from '../../shared/bibliographic/integral.util';
import {
  cleanSeriesName,
  cleanTitle,
  extractFranchiseBaseName,
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

  constructor(deps: {
    db: DatabaseAdapter;
    catalogRepo: CatalogRepository;
    libraryRepo: LibraryRepository;
    loanRepo: LoanRepository;
    readingRepo: ReadingRepository;
    ingestionService: IngestionService;
    seriesGraphService: SeriesGraphService;
    connectors?: BibliographicConnectors;
  }) {
    this.db = deps.db;
    this.catalogRepo = deps.catalogRepo;
    this.libraryRepo = deps.libraryRepo;
    this.loanRepo = deps.loanRepo;
    this.readingRepo = deps.readingRepo;
    this.ingestionService = deps.ingestionService;
    this.seriesGraphService = deps.seriesGraphService;
    this.connectors = deps.connectors;
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
