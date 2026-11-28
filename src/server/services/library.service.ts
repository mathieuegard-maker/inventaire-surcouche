// src/server/services/library.service.ts
// Service métier Foyer : vues fusionnées (Couche 3 > Couche 2 > Couche 1), actions par lot (avec choix livres prêtés) et genres en lot.

import crypto from 'node:crypto';
import { buildEditionLineage } from '../../shared/bibliographic/edition-lineage.util';
import { annotateIntegralCoverage, parseIncludedVolumeNumbers } from '../../shared/bibliographic/integral.util';
import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import { classifyBookMetadata } from '../../shared/bibliographic/category-classifier';
import {
  isGenericVolumeTitle,
  normalizeTextKey,
  tokenOverlapRatio
} from '../../shared/bibliographic/text-normalize.util';
import type {
  ActiveLoanView,
  BookMainCategory,
  BookView,
  CoverCandidateEditionMeta,
  CoverCandidateItem,
  LibraryBookOverrides,
  OwnershipStatus,
  SeriesView,
  UserReadingStateView
} from '../../shared/types/domain.types';
import type { BibliographicConnectors } from '../connectors/types';
import type { DatabaseAdapter } from '../db/database.adapter';
import type { BookRow, CatalogRepository } from '../repositories/catalog.repo';
import type { LibraryBookRow, LibraryRepository } from '../repositories/library.repo';
import type { LoanRepository } from '../repositories/loan.repo';
import type { ReadingRepository } from '../repositories/reading.repo';
import type { JobRepository } from '../repositories/job.repo';
import type { IngestionService } from './acquisition/ingestion.service';
import type { ComparisonTableService } from './acquisition/comparison-table.service';
import type { SeriesGraphService } from './acquisition/series-graph.service';
import type { CoverService } from './cover.service';
import { mapLoanRowToView, type LoanContactSuggestion, type LoanService } from './loan.service';
import { AppError } from '../middleware/error.middleware';

export interface BookSeriesContext {
  seriesId: string;
  seriesName: string;
  totalVolumes: number;
  ownedCount: number;
  prevBookId: string | null;
  nextBookId: string | null;
}

export interface BookDetailPayload {
  book: BookView;
  seriesContext: BookSeriesContext | null;
}

export type { CoverCandidateItem };

export interface SyncPullPayload {
  serverTime: string;
  isFullSync: boolean;
  books: BookView[];
  series: SeriesView[];
  deletedBookIds: string[];
  loans: ActiveLoanView[];
  contacts: LoanContactSuggestion[];
  unreadAlertsCount: number;
}

export interface BatchStatusResult {
  updatedIds: string[];
  deletedIds: string[];
  keptLentIds: string[];
  returnedAndDeletedIds: string[];
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

export class LibraryService {
  private readonly db: DatabaseAdapter;
  private readonly catalogRepo: CatalogRepository;
  private readonly libraryRepo: LibraryRepository;
  private readonly loanRepo: LoanRepository;
  private readonly readingRepo: ReadingRepository;
  private readonly jobRepo: JobRepository;
  private readonly ingestionService: IngestionService;
  private readonly comparisonService: ComparisonTableService;
  private readonly seriesGraphService: SeriesGraphService;
  private readonly coverService: CoverService;
  private readonly loanService: LoanService;
  private readonly connectors?: BibliographicConnectors;
  private readonly onJobEnqueued?: () => void;

  constructor(deps: {
    db: DatabaseAdapter;
    catalogRepo: CatalogRepository;
    libraryRepo: LibraryRepository;
    loanRepo: LoanRepository;
    readingRepo: ReadingRepository;
    jobRepo: JobRepository;
    ingestionService: IngestionService;
    comparisonService: ComparisonTableService;
    seriesGraphService: SeriesGraphService;
    coverService: CoverService;
    loanService: LoanService;
    connectors?: BibliographicConnectors;
    onJobEnqueued?: () => void;
  }) {
    this.db = deps.db;
    this.catalogRepo = deps.catalogRepo;
    this.libraryRepo = deps.libraryRepo;
    this.loanRepo = deps.loanRepo;
    this.readingRepo = deps.readingRepo;
    this.jobRepo = deps.jobRepo;
    this.ingestionService = deps.ingestionService;
    this.comparisonService = deps.comparisonService;
    this.seriesGraphService = deps.seriesGraphService;
    this.coverService = deps.coverService;
    this.loanService = deps.loanService;
    this.connectors = deps.connectors;
    this.onJobEnqueued = deps.onJobEnqueued;
  }

  /**
   * Construit le payload complet ou incrémental (delta `since`) pour un foyer + utilisateur.
   * Ne retourne JAMAIS `wishlist_reservations` aux membres du foyer (anti-spoiler).
   */
  buildSyncPullPayload(libraryId: string, userId: string, since?: string): SyncPullPayload {
    const serverTime = new Date().toISOString();

    // 1. Récupération des lignes library_books du foyer
    const allActiveLibRows = this.libraryRepo.listLibraryBooks(libraryId);
    const resetRun = this.jobRepo.getCronRun('catalog_reset');
    const resetAfterClientSync = Boolean(since && resetRun?.last_run_at && since < resetRun.last_run_at);
    // Force un snapshot complet (qui purge IndexedDB côté client) si première sync, foyer vide ou reset catalogue serveur
    const isFullSync = !since || allActiveLibRows.length === 0 || resetAfterClientSync;
    const deltaLibRows = !isFullSync && since ? this.libraryRepo.listLibraryBooks(libraryId, since) : allActiveLibRows;

    const libRowByBookId = new Map<string, LibraryBookRow>();
    for (const r of allActiveLibRows) {
      libRowByBookId.set(r.book_id, r);
    }

    const deletedBookIds: string[] = [];
    if (!isFullSync && since) {
      for (const r of deltaLibRows) {
        if (r.deleted_at || r.status === 'none') {
          deletedBookIds.push(r.book_id);
        } else {
          libRowByBookId.set(r.book_id, r);
        }
      }
    }

    // 2. Récupération des prêts actifs et états de lecture individuels (user_id)
    const activeLoans = this.loanRepo.listActiveLoans(libraryId);
    const loanByBookId = new Map<string, ActiveLoanView>();
    for (const l of activeLoans) {
      loanByBookId.set(l.book_id, mapLoanRowToView(l));
    }

    const readingRows = this.readingRepo.listByUser(userId);
    const readingByBookId = new Map<string, UserReadingStateView>();
    for (const r of readingRows) {
      readingByBookId.set(r.book_id, {
        status: r.status,
        rating: r.rating,
        notes: r.notes,
        updatedAt: r.updated_at
      });
    }

    // 3. Résolution des prénoms pour `wished_by_user_id`
    const wisherIds = Array.from(libRowByBookId.values())
      .map((r) => r.wished_by_user_id)
      .filter((id): id is string => Boolean(id));
    const usernameMap = this.libraryRepo.mapUsernamesByIds(wisherIds);

    // 4. Assemblage des BookViews actifs du foyer + calcul de la couverture intégrales bidirectionnelle
    const activeBookIds = Array.from(libRowByBookId.keys());
    const activeBookRows: BookRow[] = [];
    const seriesIds = new Set<string>();

    for (const bookId of activeBookIds) {
      const bookRow = this.catalogRepo.findBookById(bookId);
      if (!bookRow) continue;
      activeBookRows.push(bookRow);
    }

    const coherentBySeriesCache = new Map<string, Map<string, string>>();
    const getCoherentCoverKey = (seriesId: string | null, bookId: string): string | null => {
      if (!seriesId) return null;
      let map = coherentBySeriesCache.get(seriesId);
      if (!map) {
        map = this.ingestionService.computeSeriesCoherentCoverMap(seriesId, libraryId);
        coherentBySeriesCache.set(seriesId, map);
      }
      return map.get(bookId) ?? null;
    };

    const rawActiveViews: BookView[] = activeBookRows.map((bookRow) => {
      const libRow = libRowByBookId.get(bookRow.id) ?? null;
      const ov = parseOverrides(libRow?.overrides_json);
      const effectiveSid = ov.oneShotForced ? null : (ov.seriesId !== undefined ? ov.seriesId : bookRow.series_id);
      const merged = this.ingestionService.buildMergedBookView(bookRow, libRow, {
        coherentCoverKey: getCoherentCoverKey(effectiveSid, bookRow.id)
      });
      merged.activeLoan = loanByBookId.get(bookRow.id) ?? null;
      merged.readingState = readingByBookId.get(bookRow.id) ?? null;
      merged.wishedByName = libRow?.wished_by_user_id ? (usernameMap.get(libRow.wished_by_user_id) ?? null) : null;
      if (merged.seriesId) seriesIds.add(merged.seriesId);
      return merged;
    });

    const annotatedActiveViews = annotateIntegralCoverage(rawActiveViews, rawActiveViews);

    // 5. Construction des SeriesView pour les séries présentes dans le foyer
    // Règle stricte : les intégrales sont exclues du total de tomes unitaires et comptent par les tomes unitaires qu'elles couvrent (ex. Int. 1-3 -> 3 / 6).
    const seriesViews: SeriesView[] = [];
    for (const sId of seriesIds) {
      const sRow = this.catalogRepo.findSeriesById(sId);
      if (!sRow) continue;

      const catalogSeriesBooks = this.catalogRepo.listBooksBySeriesId(sId);
      const seenBookIds = new Set(catalogSeriesBooks.map((b) => b.id));
      for (const libBook of annotatedActiveViews) {
        if (libBook.seriesId === sId && !seenBookIds.has(libBook.id)) {
          const extraRow = this.catalogRepo.findBookById(libBook.id);
          if (extraRow) {
            catalogSeriesBooks.push(extraRow);
            seenBookIds.add(extraRow.id);
          }
        }
      }

      const visibleSeriesViews: BookView[] = [];
      for (const bRow of catalogSeriesBooks) {
        const lr = libRowByBookId.get(bRow.id) ?? this.libraryRepo.findLibraryBook(libraryId, bRow.id);
        const ov = parseOverrides(lr?.overrides_json);
        if (ov.oneShotForced) continue;
        if (ov.seriesId && ov.seriesId !== sId) continue;
        if ((ov.hiddenSeriesIds ?? []).includes(sId)) continue;
        visibleSeriesViews.push(
          this.ingestionService.buildMergedBookView(bRow, lr, {
            coherentCoverKey: getCoherentCoverKey(sId, bRow.id)
          })
        );
      }

      const annotatedSeriesViews = annotateIntegralCoverage(visibleSeriesViews, visibleSeriesViews);
      const unitaryViews = annotatedSeriesViews.filter((b) => !b.isIntegral);
      const progressPool = unitaryViews.length > 0 ? unitaryViews : annotatedSeriesViews;
      const ownedCount = progressPool.filter(
        (b) => b.ownershipStatus === 'owned' || Boolean(b.ownedViaIntegral)
      ).length;
      const knownVolumesCount =
        unitaryViews.length > 0 ? unitaryViews.length : Math.max(sRow.known_volumes_count, annotatedSeriesViews.length);

      const coverBook =
        unitaryViews.find((b) => b.ownershipStatus === 'owned' && b.coverUrl) ??
        annotatedSeriesViews.find((b) => b.ownershipStatus === 'owned' && b.coverUrl) ??
        unitaryViews.find((b) => b.coverUrl) ??
        annotatedSeriesViews.find((b) => b.coverUrl);

      seriesViews.push({
        id: sRow.id,
        franchiseId: sRow.franchise_id,
        canonicalName: sRow.canonical_name,
        editionSignature: sRow.edition_signature || null,
        aliases: parseJsonStringArray(sRow.aliases_json),
        primaryAuthors: parseJsonStringArray(sRow.primary_authors_json),
        wikidataQid: sRow.wikidata_qid,
        isCompleteExpanded: sRow.is_complete_expanded === 1,
        knownVolumesCount,
        ownedCount,
        coverUrl: coverBook?.coverUrl ?? null,
        updatedAt: sRow.updated_at
      });
    }

    // 6. Filtrage delta si `since` est fourni (sauf reset / fullSync forcé)
    let booksToReturn = annotatedActiveViews;
    if (!isFullSync && since) {
      const changedLoanBookIds = new Set(this.loanRepo.listLoansSince(libraryId, since).map((l) => l.book_id));
      const changedReadingBookIds = new Set(this.readingRepo.listByUser(userId, since).map((r) => r.book_id));
      const changedLibBookIds = new Set(deltaLibRows.map((r) => r.book_id));

      booksToReturn = annotatedActiveViews.filter(
        (b) =>
          changedLibBookIds.has(b.id) ||
          changedLoanBookIds.has(b.id) ||
          changedReadingBookIds.has(b.id) ||
          b.updatedAt > since
      );
    }

    const { loans, contacts } = this.loanService.listLoansAndContacts(libraryId, userId);

    return {
      serverTime,
      isFullSync,
      books: booksToReturn,
      series: seriesViews,
      deletedBookIds,
      loans,
      contacts,
      unreadAlertsCount: this.libraryRepo.countActiveAlerts(libraryId)
    };
  }

  /**
   * Applique un changement de statut en lot (`owned`, `wish`, `none`).
   * Règle UX obligatoire (AGENTS.md) :
   * - Pour `status === 'none'` (suppression), les livres non prêtés sont supprimés immédiatement (après confirmation UI),
   *   et chaque livre prêté suit son choix individuel (`lentDecisions[bookId]`: `'keep'` vs `'return_and_delete'`).
   */
  applyBatchStatus(input: {
    libraryId: string;
    userId: string;
    bookIds: string[];
    status: OwnershipStatus;
    lentDecisions?: Record<string, 'keep' | 'return_and_delete'>;
    now?: string;
  }): BatchStatusResult {
    const now = input.now ?? new Date().toISOString();
    const updatedIds: string[] = [];
    const deletedIds: string[] = [];
    const keptLentIds: string[] = [];
    const returnedAndDeletedIds: string[] = [];

    this.db.transaction(() => {
      for (const bookId of input.bookIds) {
        if (input.status === 'none') {
          const activeLoan = this.loanRepo.findActiveLoanByBook(input.libraryId, bookId);
          if (activeLoan) {
            const decision = input.lentDecisions?.[bookId] ?? 'keep';
            if (decision === 'return_and_delete') {
              this.loanRepo.markReturnedByBook(input.libraryId, bookId, now);
              this.libraryRepo.upsertLibraryBookStatusLww({
                libraryId: input.libraryId,
                bookId,
                status: 'none',
                timestamp: now
              });
              returnedAndDeletedIds.push(bookId);
              deletedIds.push(bookId);
            } else {
              keptLentIds.push(bookId);
            }
          } else {
            this.libraryRepo.upsertLibraryBookStatusLww({
              libraryId: input.libraryId,
              bookId,
              status: 'none',
              timestamp: now
            });
            deletedIds.push(bookId);
          }
        } else {
          this.libraryRepo.upsertLibraryBookStatusLww({
            libraryId: input.libraryId,
            bookId,
            status: input.status,
            wishedByUserId: input.status === 'wish' ? input.userId : null,
            timestamp: now
          });
          updatedIds.push(bookId);
        }
      }
    });

    return { updatedIds, deletedIds, keptLentIds, returnedAndDeletedIds };
  }

  /**
   * Ajoute cumulativement un lot de genres en Couche 3 (`overrides_json.genres`) sur la sélection.
   */
  applyBatchGenres(input: {
    libraryId: string;
    bookIds: string[];
    genres: string[];
    now?: string;
  }): { updatedCount: number } {
    const now = input.now ?? new Date().toISOString();
    const cleanIncoming = input.genres.map((g) => g.trim()).filter(Boolean);
    if (cleanIncoming.length === 0) return { updatedCount: 0 };

    let updatedCount = 0;

    this.db.transaction(() => {
      for (const bookId of input.bookIds) {
        const bookRow = this.catalogRepo.findBookById(bookId);
        if (!bookRow) continue;

        const libRow = this.libraryRepo.findLibraryBook(input.libraryId, bookId);
        const overrides = parseOverrides(libRow?.overrides_json);

        const existingGenres = overrides.genres ?? [
          bookRow.main_category,
          ...parseJsonStringArray(bookRow.subgenres_json)
        ];

        const mergedSet = new Map<string, string>();
        for (const g of [...existingGenres, ...cleanIncoming]) {
          const clean = g.trim();
          if (!clean) continue;
          const key = clean.toLowerCase();
          if (!mergedSet.has(key)) mergedSet.set(key, clean);
        }

        const nextOverrides: LibraryBookOverrides = {
          ...overrides,
          genres: Array.from(mergedSet.values())
        };

        this.libraryRepo.setLibraryBookOverrides(input.libraryId, bookId, nextOverrides, now);
        updatedCount++;
      }
    });

    return { updatedCount };
  }

  // ==================== FICHE LIVRE, COUCHES 3, COUVERTURES & CRÉATION MANUELLE (JALON 4) ====================

  private resolveBookRowByIdOrIsbn(bookIdOrIsbn: string): BookRow | null {
    const clean = bookIdOrIsbn.trim();
    if (clean.toLowerCase().startsWith('isbn:')) {
      const isbn13 = isbnUtil.normalizeToIsbn13(clean.slice(5));
      return isbn13 ? this.catalogRepo.findBookByIsbn13(isbn13) : null;
    }
    return this.catalogRepo.findBookById(clean);
  }

  private enrichSingleBookView(libraryId: string, userId: string, bookRow: BookRow): BookView {
    const libRow = this.libraryRepo.findLibraryBook(libraryId, bookRow.id);
    const ov = parseOverrides(libRow?.overrides_json);
    const effectiveSid = ov.oneShotForced ? null : (ov.seriesId !== undefined ? ov.seriesId : bookRow.series_id);
    const coherentCoverKey = effectiveSid
      ? (this.ingestionService.computeSeriesCoherentCoverMap(effectiveSid, libraryId).get(bookRow.id) ?? null)
      : null;
    const merged = this.ingestionService.buildMergedBookView(bookRow, libRow, { coherentCoverKey });
    const activeLoan = this.loanRepo.findActiveLoanByBook(libraryId, bookRow.id);
    merged.activeLoan = activeLoan ? mapLoanRowToView(activeLoan) : null;

    const readingRow = this.readingRepo.findByUserAndBook(userId, bookRow.id);
    merged.readingState = readingRow
      ? {
          status: readingRow.status,
          rating: readingRow.rating,
          notes: readingRow.notes,
          updatedAt: readingRow.updated_at
        }
      : null;

    if (libRow?.wished_by_user_id) {
      const names = this.libraryRepo.mapUsernamesByIds([libRow.wished_by_user_id]);
      merged.wishedByName = names.get(libRow.wished_by_user_id) ?? null;
    }

    // Calcul de la couverture par intégrale possédée dans le foyer
    if (!merged.isIntegral && (merged.seriesId || merged.seriesName)) {
      const allLibRows = this.libraryRepo.listLibraryBooks(libraryId);
      const ownedIntegrals: BookView[] = [];
      for (const lr of allLibRows) {
        if (lr.status !== 'owned' || lr.deleted_at) continue;
        const br = this.catalogRepo.findBookById(lr.book_id);
        if (!br) continue;
        const mv = this.ingestionService.buildMergedBookView(br, lr);
        if (mv.isIntegral && mv.includedVolumes.length > 0) {
          ownedIntegrals.push(mv);
        }
      }
      const [annotated] = annotateIntegralCoverage([merged], ownedIntegrals);
      merged.ownedViaIntegral = annotated.ownedViaIntegral;
    }

    return merged;
  }

  getBookDetail(libraryId: string, userId: string, bookIdOrIsbn: string): BookDetailPayload {
    const bookRow = this.resolveBookRowByIdOrIsbn(bookIdOrIsbn);
    if (!bookRow) {
      throw new AppError(404, 'BOOK_NOT_FOUND', 'Ouvrage introuvable.');
    }

    const book = this.enrichSingleBookView(libraryId, userId, bookRow);
    let seriesContext: BookSeriesContext | null = null;

    if (book.seriesId && !book.hiddenSeriesIds.includes(book.seriesId)) {
      const seriesRow = this.catalogRepo.findSeriesById(book.seriesId);
      if (seriesRow) {
        const seriesBooks = this.catalogRepo.listBooksBySeriesId(seriesRow.id);
        const rawVisibleViews: BookView[] = [];
        for (const sb of seriesBooks) {
          const lr = this.libraryRepo.findLibraryBook(libraryId, sb.id);
          const ov = parseOverrides(lr?.overrides_json);
          if (ov.oneShotForced) continue;
          if (ov.seriesId && ov.seriesId !== seriesRow.id) continue;
          if ((ov.hiddenSeriesIds ?? []).includes(seriesRow.id)) continue;
          rawVisibleViews.push(this.ingestionService.buildMergedBookView(sb, lr));
        }

        const annotatedSeries = annotateIntegralCoverage(rawVisibleViews, rawVisibleViews).sort((a, b) => {
          const sa = a.sortOrder ?? a.volumeNumber ?? 999999;
          const sb = b.sortOrder ?? b.volumeNumber ?? 999999;
          if (sa !== sb) return sa - sb;
          return a.title.localeCompare(b.title, 'fr');
        });

        const unitaryInSeries = annotatedSeries.filter((sb) => !sb.isIntegral);
        const progressPool = unitaryInSeries.length > 0 ? unitaryInSeries : annotatedSeries;
        const navPool = book.isIntegral
          ? annotatedSeries.filter((sb) => sb.isIntegral)
          : progressPool;

        const idx = navPool.findIndex((sb) => sb.id === book.id);
        const prevBookId = idx > 0 ? navPool[idx - 1].id : null;
        const nextBookId = idx >= 0 && idx < navPool.length - 1 ? navPool[idx + 1].id : null;

        const ownedCount = progressPool.filter(
          (sb) => sb.ownershipStatus === 'owned' || Boolean(sb.ownedViaIntegral)
        ).length;

        seriesContext = {
          seriesId: seriesRow.id,
          seriesName: seriesRow.canonical_name,
          totalVolumes: progressPool.length,
          ownedCount,
          prevBookId,
          nextBookId
        };
      }
    }

    return { book, seriesContext };
  }

  /**
   * Met à jour les surcharges souveraines Couche 3 du foyer (`library_books.overrides_json`).
   * Ne modifie JAMAIS le Catalogue Central (`books` — séparation stricte Moi ≠ Admin).
   */
  updateBookOverrides(
    libraryId: string,
    userId: string,
    bookId: string,
    patch: LibraryBookOverrides & { propagateGenresToSeries?: boolean }
  ): BookView {
    const bookRow = this.catalogRepo.findBookById(bookId);
    if (!bookRow) {
      throw new AppError(404, 'BOOK_NOT_FOUND', 'Ouvrage introuvable.');
    }

    const now = new Date().toISOString();
    const existingLib = this.libraryRepo.findLibraryBook(libraryId, bookId);
    const current = parseOverrides(existingLib?.overrides_json);

    const { propagateGenresToSeries, ...fields } = patch;
    const nextOverrides: LibraryBookOverrides = { ...current };

    if (fields.title !== undefined) nextOverrides.title = fields.title.trim();
    if (fields.authors !== undefined) nextOverrides.authors = fields.authors;
    if (fields.scriptwriters !== undefined) nextOverrides.scriptwriters = fields.scriptwriters;
    if (fields.illustrators !== undefined) nextOverrides.illustrators = fields.illustrators;
    if (fields.colorists !== undefined) nextOverrides.colorists = fields.colorists;
    if (fields.oneShotForced !== undefined) {
      nextOverrides.oneShotForced = fields.oneShotForced;
      if (fields.oneShotForced) {
        nextOverrides.seriesId = null;
        nextOverrides.seriesName = null;
      }
    }
    if (!nextOverrides.oneShotForced) {
      if (fields.seriesId !== undefined) nextOverrides.seriesId = fields.seriesId;
      if (fields.seriesName !== undefined) nextOverrides.seriesName = fields.seriesName;
    }
    if (fields.volumeNumber !== undefined) nextOverrides.volumeNumber = fields.volumeNumber;
    if (fields.volumeLabel !== undefined) nextOverrides.volumeLabel = fields.volumeLabel;
    if (fields.sortOrder !== undefined) nextOverrides.sortOrder = fields.sortOrder;
    if (fields.isHorsSerie !== undefined) nextOverrides.isHorsSerie = fields.isHorsSerie;
    if (fields.isIntegral !== undefined) {
      nextOverrides.isIntegral = fields.isIntegral;
      if (!fields.isIntegral) {
        nextOverrides.includedVolumes = [];
      }
    }
    if (fields.includedVolumes !== undefined) {
      nextOverrides.includedVolumes = parseIncludedVolumeNumbers(fields.includedVolumes);
    }
    if (fields.publisher !== undefined) nextOverrides.publisher = fields.publisher;
    if (fields.publishYear !== undefined) nextOverrides.publishYear = fields.publishYear;
    if (fields.pageCount !== undefined) nextOverrides.pageCount = fields.pageCount;
    if (fields.mainCategory !== undefined) nextOverrides.mainCategory = fields.mainCategory;
    if (fields.genres !== undefined) nextOverrides.genres = fields.genres;
    if (fields.coverKey !== undefined) nextOverrides.coverKey = fields.coverKey;
    if (fields.hiddenSeriesIds !== undefined) {
      nextOverrides.hiddenSeriesIds = Array.from(new Set(fields.hiddenSeriesIds));
    }

    this.db.transaction(() => {
      this.libraryRepo.setLibraryBookOverrides(libraryId, bookId, nextOverrides, now);

      // Propagation optionnelle des genres Couche 3 aux autres tomes possédés/souhaités de la même série
      if (propagateGenresToSeries && fields.genres && fields.genres.length > 0) {
        const targetSeriesId = nextOverrides.seriesId ?? bookRow.series_id;
        if (targetSeriesId) {
          const siblingBooks = this.catalogRepo.listBooksBySeriesId(targetSeriesId);
          for (const sib of siblingBooks) {
            if (sib.id === bookId) continue;
            const sibLib = this.libraryRepo.findLibraryBook(libraryId, sib.id);
            if (!sibLib || sibLib.deleted_at) continue;
            const sibOv = parseOverrides(sibLib.overrides_json);
            const merged = Array.from(new Set([...(sibOv.genres ?? []), ...fields.genres]));
            this.libraryRepo.setLibraryBookOverrides(libraryId, sib.id, { ...sibOv, genres: merged }, now);
          }
        }
      }
    });

    return this.enrichSingleBookView(libraryId, userId, bookRow);
  }

  /**
   * Lève toutes les surcharges Couche 3 sur un livre (clic explicite "Réinitialiser avec les données automatiques").
   */
  resetBookOverrides(libraryId: string, userId: string, bookId: string): BookView {
    const bookRow = this.catalogRepo.findBookById(bookId);
    if (!bookRow) {
      throw new AppError(404, 'BOOK_NOT_FOUND', 'Ouvrage introuvable.');
    }
    const now = new Date().toISOString();
    this.libraryRepo.setLibraryBookOverrides(libraryId, bookId, {}, now);
    return this.enrichSingleBookView(libraryId, userId, bookRow);
  }

  /**
   * Galerie dédupliquée des couvertures disponibles pour un livre (Couche 3 + Catalogue + Éditions sœurs + Sources externes)
   * enrichie de la signature éditoriale (`edition`) lorsque la couverture provient d'une édition identifiable.
   */
  async listBookCoverCandidates(
    libraryId: string,
    bookId: string,
    includeExternal = false
  ): Promise<CoverCandidateItem[]> {
    const bookRow = this.catalogRepo.findBookById(bookId);
    if (!bookRow) {
      throw new AppError(404, 'BOOK_NOT_FOUND', 'Ouvrage introuvable.');
    }

    const toEditionMeta = (input: {
      isbn13?: string | null;
      publisher?: string | null;
      collectionName?: string | null;
      publishYear?: string | null;
    }): CoverCandidateEditionMeta | null => {
      const lineage = buildEditionLineage(input);
      if (!lineage) return null;
      return {
        isbn13: input.isbn13 ?? null,
        publisher: lineage.publisher,
        collectionName: lineage.collectionName,
        publishYear: input.publishYear ?? null,
        lineageKey: lineage.key,
        lineageLabel: lineage.label,
        isbnPrefix: lineage.isbnPrefix
      };
    };

    const candidates: CoverCandidateItem[] = [];
    const seenUrls = new Set<string>();
    const seenExternalUrls = new Set<string>();

    const pushLocal = (
      coverKey: string | null | undefined,
      label: string,
      edition: CoverCandidateEditionMeta | null = null
    ) => {
      if (!coverKey) return;
      const url = `/api/covers/${coverKey}`;
      const existing = candidates.find((c) => c.url === url);
      if (existing) {
        // Enrichit un candidat déjà présent s'il n'avait pas encore de métadonnée d'édition précise
        if (edition && (!existing.edition || (!existing.edition.publisher && edition.publisher))) {
          existing.edition = edition;
        }
        return;
      }
      seenUrls.add(url);
      const covRow = this.catalogRepo.findCoverByKey(coverKey);
      if (covRow?.source_url) seenExternalUrls.add(covRow.source_url);
      candidates.push({ id: coverKey, kind: 'local', coverKey, url, label, edition });
    };

    const libRow = this.libraryRepo.findLibraryBook(libraryId, bookId);
    const overrides = parseOverrides(libRow?.overrides_json);
    const editions = this.catalogRepo.listEditionsByBookId(bookId);

    const editionMetaByCoverKey = new Map<string, CoverCandidateEditionMeta>();
    const editionMetaByIsbn = new Map<string, CoverCandidateEditionMeta>();
    for (const ed of editions) {
      const edPub = ed.publisher ?? (ed.cover_key && ed.cover_key === bookRow.cover_key ? bookRow.publisher : null);
      const edCol =
        ed.collection_name ??
        (!ed.publisher && ed.cover_key && ed.cover_key === bookRow.cover_key ? bookRow.collection_name : null);
      const meta = toEditionMeta({
        isbn13: ed.isbn13,
        publisher: edPub,
        collectionName: edCol,
        publishYear: ed.publish_year
      });
      if (meta) {
        editionMetaByIsbn.set(ed.isbn13, meta);
        if (ed.cover_key && !editionMetaByCoverKey.has(ed.cover_key)) {
          editionMetaByCoverKey.set(ed.cover_key, meta);
        }
      }
    }

    // Couverture personnalisée Foyer : ne porte une édition que si elle correspond à une édition connue du livre
    const overrideEdition = overrides.coverKey ? (editionMetaByCoverKey.get(overrides.coverKey) ?? null) : null;
    pushLocal(
      overrides.coverKey,
      overrideEdition ? `${overrideEdition.lineageLabel} (Foyer)` : 'Couverture personnalisée (Foyer)',
      overrideEdition
    );

    // Couverture principale Catalogue
    const primaryEdition =
      (bookRow.cover_key ? editionMetaByCoverKey.get(bookRow.cover_key) : null) ??
      toEditionMeta({
        isbn13: editions[0]?.isbn13 ?? null,
        publisher: bookRow.publisher,
        collectionName: bookRow.collection_name,
        publishYear: bookRow.publish_year
      });
    pushLocal(
      bookRow.cover_key,
      primaryEdition ? `${primaryEdition.lineageLabel}${primaryEdition.publishYear ? ` (${primaryEdition.publishYear})` : ''}` : 'Couverture principale (Catalogue)',
      primaryEdition
    );

    for (const ed of editions) {
      const meta = editionMetaByIsbn.get(ed.isbn13) ?? null;
      const yearPart = ed.publish_year ? ` (${ed.publish_year})` : '';
      const label = meta ? `${meta.lineageLabel}${yearPart}` : `Édition ${ed.publisher || ed.isbn13}`;
      pushLocal(ed.cover_key, label, meta);
    }

    if (includeExternal) {
      const effectiveTitle = (overrides.title ?? bookRow.title).trim();
      const effectiveSeriesRow = (overrides.seriesId ?? bookRow.series_id)
        ? this.catalogRepo.findSeriesById((overrides.seriesId ?? bookRow.series_id)!)
        : null;
      const effectiveSeriesName = overrides.oneShotForced
        ? null
        : (overrides.seriesName ?? effectiveSeriesRow?.canonical_name ?? null);
      const effectiveAuthors = overrides.authors ?? parseJsonStringArray(bookRow.authors_json);
      const firstAuthor = effectiveAuthors[0];

      const rawExternalQueue: Array<{
        url: string;
        label: string;
        minBytes?: number;
        rejectExactBytes?: number;
        edition?: CoverCandidateEditionMeta | null;
      }> = [];
      const enqueueExt = (
        url: string | null | undefined,
        label: string,
        minBytes?: number,
        rejectExactBytes?: number,
        edition?: CoverCandidateEditionMeta | null
      ) => {
        const clean = (url || '').trim();
        if (!clean || (!clean.startsWith('http://') && !clean.startsWith('https://'))) return;
        if (/\.svg(?:[?#]|$)/i.test(clean) || /(?:wikimedia|wikipedia)\.org/i.test(clean)) return;
        if (seenExternalUrls.has(clean)) return;
        seenExternalUrls.add(clean);
        rawExternalQueue.push({ url: clean, label, minBytes, rejectExactBytes, edition: edition ?? null });
      };

      const isbnsToProbe = new Set<string>(editions.map((e) => e.isbn13).filter(Boolean));
      const externalMetaByIsbn = new Map<string, CoverCandidateEditionMeta>(editionMetaByIsbn);
      const workUri = bookRow.inventaire_uri || (bookRow.wikidata_qid ? `wd:${bookRow.wikidata_qid}` : null);

      const titleIsGeneric = effectiveSeriesName
        ? isGenericVolumeTitle(effectiveTitle, effectiveSeriesName)
        : false;
      const bnfTitleQuery = titleIsGeneric && effectiveSeriesName ? effectiveSeriesName : effectiveTitle;
      const fullSearchTitle =
        effectiveSeriesName && !normalizeTextKey(effectiveTitle).includes(normalizeTextKey(effectiveSeriesName))
          ? `${effectiveSeriesName} ${effectiveTitle}`
          : effectiveTitle;

      const [draftRes, invEdRes, bnfRes, gbRes, itunesRes] = await Promise.allSettled([
        editions.length > 0 ? this.comparisonService.collectAndArbitrate(editions[0].isbn13) : Promise.resolve(null),
        workUri && this.connectors?.inventaire.fetchWorkEditions
          ? this.connectors.inventaire.fetchWorkEditions(workUri)
          : Promise.resolve({ isbn13s: [], coverUrls: [] }),
        this.connectors?.bnf && bnfTitleQuery
          ? this.connectors.bnf.searchByTitleAndAuthor(bnfTitleQuery, firstAuthor, 10)
          : Promise.resolve([]),
        this.connectors?.googleBooks.searchByTitleAndAuthor && fullSearchTitle
          ? this.connectors.googleBooks.searchByTitleAndAuthor(fullSearchTitle, firstAuthor, 5)
          : Promise.resolve([]),
        fullSearchTitle
          ? this.coverService.searchItunesCoverUrls(`${fullSearchTitle} ${firstAuthor ?? ''}`.trim(), 4)
          : Promise.resolve([])
      ]);

      // 1. Couvertures directes Inventaire éditions sœurs P629 (prioritaires sur BD franco-belges)
      if (invEdRes.status === 'fulfilled') {
        for (const u of invEdRes.value.coverUrls) enqueueExt(u, 'Inventaire (édition sœur)');
        for (const isbn of invEdRes.value.isbn13s.slice(0, 4)) {
          isbnsToProbe.add(isbn);
          if (!externalMetaByIsbn.has(isbn)) {
            const meta = toEditionMeta({ isbn13: isbn });
            if (meta) externalMetaByIsbn.set(isbn, meta);
          }
        }
      }

      // 2. Couvertures directes Tableau Comparatif (BnF / Inventaire / Google Books / Open Library)
      if (draftRes.status === 'fulfilled' && draftRes.value) {
        const draftMeta = toEditionMeta({
          isbn13: draftRes.value.isbn13,
          publisher: draftRes.value.publisher,
          collectionName: draftRes.value.collectionName,
          publishYear: draftRes.value.publishYear
        });
        for (const u of draftRes.value.coverCandidates) {
          enqueueExt(u, draftMeta ? `${draftMeta.lineageLabel} (catalogue)` : 'Catalogue externe', undefined, undefined, draftMeta);
        }
      }

      // 3. Résultats BnF par Titre + Auteur (filtrés par proximité titre — enrichis avec éditeur & collection)
      if (bnfRes.status === 'fulfilled') {
        for (const hit of bnfRes.value) {
          const hitText = `${hit.seriesName ?? ''} ${hit.title ?? ''}`.trim();
          const overlap = Math.max(
            tokenOverlapRatio(effectiveTitle, hitText),
            tokenOverlapRatio(fullSearchTitle, hitText)
          );
          if (overlap < 0.45 && !titleIsGeneric) continue;
          const hitMeta = toEditionMeta({
            isbn13: hit.isbn13,
            publisher: hit.publisher,
            collectionName: hit.collectionName,
            publishYear: hit.publishYear
          });
          if (hit.isbn13 && hitMeta) {
            const prev = externalMetaByIsbn.get(hit.isbn13);
            if (!prev || (!prev.publisher && hitMeta.publisher)) {
              externalMetaByIsbn.set(hit.isbn13, hitMeta);
            }
          }
          if (hit.coverUrl) {
            const yr = hit.publishYear ? ` (${hit.publishYear})` : '';
            enqueueExt(
              hit.coverUrl,
              hitMeta ? `${hitMeta.lineageLabel}${yr}` : `BnF (${hit.publisher || hit.isbn13 || 'catalogue'})`,
              undefined,
              undefined,
              hitMeta
            );
          }
          if (hit.isbn13 && isbnsToProbe.size < 6) isbnsToProbe.add(hit.isbn13);
        }
      }

      // 4. CDN Librairies (Amazon EU, Amazon Media, Eyrolles/Dilicom H1400, Open Library) sur tous les ISBNs connus/découverts
      for (const isbn of Array.from(isbnsToProbe).slice(0, 6)) {
        const isbnMeta = externalMetaByIsbn.get(isbn) ?? toEditionMeta({ isbn13: isbn });
        for (const cdn of this.coverService.buildIsbnCdnCandidates(isbn)) {
          const label = isbnMeta?.publisher
            ? `${isbnMeta.lineageLabel}${isbnMeta.publishYear ? ` (${isbnMeta.publishYear})` : ''}`
            : cdn.label;
          enqueueExt(cdn.url, label, cdn.minBytes, cdn.rejectExactBytes, isbnMeta);
        }
      }

      // 5. Google Books (si non rate-limité) & Apple Books / iTunes FR (sans métadonnée d'édition fiable -> edition: null)
      if (gbRes.status === 'fulfilled') {
        for (const hit of gbRes.value) {
          if (hit.coverUrl) {
            const gbMeta = toEditionMeta({
              isbn13: hit.isbn13,
              publisher: hit.publisher,
              publishYear: hit.publishYear
            });
            enqueueExt(
              hit.coverUrl,
              gbMeta ? `${gbMeta.lineageLabel} (Google Books)` : `Google Books (${hit.publisher || 'édition'})`,
              undefined,
              undefined,
              gbMeta
            );
          }
        }
      }
      if (itunesRes.status === 'fulfilled') {
        for (const u of itunesRes.value) enqueueExt(u, 'Apple Books', undefined, undefined, null);
      }

      // Vérification réelle + déduplication visuelle par empreinte perceptuelle dHash (consensus + meilleure résolution)
      const localCoverKeys = candidates
        .filter((c) => c.kind === 'local' && Boolean(c.coverKey))
        .map((c) => c.coverKey!);
      const verified = await this.coverService.deduplicateExternalCandidatesVisually(
        rawExternalQueue.slice(0, 22),
        localCoverKeys,
        12
      );

      for (const item of verified) {
        candidates.push({
          id: `ext_${crypto.createHash('md5').update(item.url).digest('hex').slice(0, 10)}`,
          kind: 'external',
          url: item.url,
          label: item.label,
          edition: item.edition ?? null
        });
      }
    }

    return candidates;
  }

  async importExternalCoverUrl(url: string): Promise<{ coverKey: string; coverUrl: string }> {
    const stored = await this.coverService.ingestFromExternalUrl(url);
    if (!stored) {
      throw new AppError(400, 'COVER_IMPORT_FAILED', "Impossible de télécharger ou convertir cette image.");
    }
    return { coverKey: stored.coverKey, coverUrl: stored.coverUrl };
  }

  /**
   * Création manuelle d'un ouvrage inconnu (`source_origin = 'manual'`, zéro dépendance Inventaire.io).
   */
  createManualBook(input: {
    libraryId: string;
    userId: string;
    isbn13?: string;
    title: string;
    authors: string[];
    scriptwriters?: string[];
    illustrators?: string[];
    colorists?: string[];
    seriesName?: string | null;
    seriesId?: string | null;
    volumeNumber?: number | null;
    volumeLabel?: string | null;
    oneShot: boolean;
    expandSeries: boolean;
    isIntegral: boolean;
    includedVolumes: string[];
    publisher?: string | null;
    publishYear?: string | null;
    pageCount?: number | null;
    mainCategory?: BookMainCategory;
    genres: string[];
    coverKey?: string | null;
    ownershipStatus: OwnershipStatus;
  }): { book: BookView; enqueuedSeriesExpandJobId: string | null } {
    const now = new Date().toISOString();
    const cleanTitle = input.title.trim();
    const normTitle = normalizeTextKey(cleanTitle);
    const cleanIsbn13 = input.isbn13 ? isbnUtil.normalizeToIsbn13(input.isbn13) : null;

    let enqueuedSeriesExpandJobId: string | null = null;
    let savedBookId = '';

    this.db.transaction(() => {
      // Si ISBN déjà présent dans le Catalogue Central, on le réutilise proprement
      const existingByIsbn = cleanIsbn13 ? this.catalogRepo.findBookByIsbn13(cleanIsbn13) : null;

      let resolvedSeriesId: string | null = null;
      if (!input.oneShot) {
        if (input.seriesId) {
          const foundSeries = this.catalogRepo.findSeriesById(input.seriesId);
          resolvedSeriesId = foundSeries?.id ?? null;
        } else if (input.seriesName?.trim()) {
          const { series } = this.seriesGraphService.resolveOrCreateSeriesCut({
            seriesName: input.seriesName.trim(),
            bookTitle: cleanTitle,
            volumeNumber: input.volumeNumber ?? null,
            isHorsSerie: false,
            isIntegral: input.isIntegral,
            pageCount: input.pageCount ?? null,
            publisher: input.publisher ?? null,
            mainCategory: input.mainCategory ?? null,
            authors: input.authors,
            now
          });
          resolvedSeriesId = series.id;
        }
      }

      const parsedIncluded = input.isIntegral ? parseIncludedVolumeNumbers(input.includedVolumes) : [];
      const classification = classifyBookMetadata({
        title: cleanTitle,
        series: input.seriesName ?? undefined,
        publisher: input.publisher ?? undefined,
        rawSubjects: input.genres
      });

      const effectiveCategory = input.mainCategory ?? classification.mainCategory;
      const effectiveSubgenres = Array.from(
        new Set(input.genres.filter((g) => g.toLowerCase() !== effectiveCategory.toLowerCase()))
      );

      const bookRow = existingByIsbn
        ? existingByIsbn
        : this.catalogRepo.upsertBookAutomatic({
            id: `bk_${crypto.randomBytes(6).toString('hex')}`,
            workCanonicalId: cleanIsbn13
              ? `manual:isbn:${cleanIsbn13}`
              : `manual:${crypto.randomBytes(6).toString('hex')}`,
            seriesId: resolvedSeriesId,
            title: cleanTitle,
            normalizedTitle: normTitle,
            volumeNumber: input.volumeNumber ?? null,
            volumeLabel: input.volumeLabel?.trim() || (input.volumeNumber ? String(input.volumeNumber) : null),
            sortOrder: input.volumeNumber ?? null,
            isHorsSerie: false,
            isIntegral: input.isIntegral,
            includedVolumes: parsedIncluded,
            authors: input.authors,
            scriptwriters: input.scriptwriters ?? [],
            illustrators: input.illustrators ?? [],
            colorists: input.colorists ?? [],
            publisher: input.publisher?.trim() || null,
            collectionName: null,
            publishYear: input.publishYear?.trim() || null,
            pageCount: input.pageCount ?? null,
            description: null,
            language: 'fr',
            mainCategory: effectiveCategory,
            subgenres: effectiveSubgenres,
            coverKey: input.coverKey ?? null,
            wikidataQid: null,
            inventaireUri: null,
            sourceOrigin: 'manual',
            now
          });

      savedBookId = bookRow.id;

      if (cleanIsbn13) {
        this.catalogRepo.upsertBookEdition({
          isbn13: cleanIsbn13,
          bookId: bookRow.id,
          publisher: input.publisher?.trim() || null,
          collectionName: null,
          publishYear: input.publishYear?.trim() || null,
          pageCount: input.pageCount ?? null,
          coverKey: input.coverKey ?? null,
          source: 'manual',
          now
        });
      }

      if (resolvedSeriesId) {
        this.catalogRepo.recountSeriesVolumes(resolvedSeriesId, now);
      }

      if (input.ownershipStatus === 'owned' || input.ownershipStatus === 'wish') {
        this.libraryRepo.upsertLibraryBookStatusLww({
          libraryId: input.libraryId,
          bookId: bookRow.id,
          status: input.ownershipStatus,
          wishedByUserId: input.ownershipStatus === 'wish' ? input.userId : null,
          timestamp: now
        });
      }

      if (input.expandSeries && resolvedSeriesId) {
        const activeJob = this.jobRepo.findActiveJobByTypeAndPayloadKey('series_expand', resolvedSeriesId);
        if (activeJob) {
          enqueuedSeriesExpandJobId = activeJob.id;
        } else {
          const job = this.jobRepo.createJob({
            id: `job_${crypto.randomBytes(6).toString('hex')}`,
            type: 'series_expand',
            userId: input.userId,
            libraryId: input.libraryId,
            payload: { seriesId: resolvedSeriesId },
            progressTotal: 1,
            now
          });
          enqueuedSeriesExpandJobId = job.id;
        }
      }
    });

    if (enqueuedSeriesExpandJobId) {
      this.onJobEnqueued?.();
    }

    const detail = this.getBookDetail(input.libraryId, input.userId, savedBookId);
    return { book: detail.book, enqueuedSeriesExpandJobId };
  }

  /**
   * Remplace une fiche erronée dans le Foyer par le bon ouvrage identifié via son ISBN-13
   * ("Ce n'est pas le bon livre") : ne corrompt jamais l'ancien livre du Catalogue Central,
   * transfère statut foyer, état de lecture/notes perso et prêts actifs vers le nouveau livre,
   * puis retire l'ancien livre du foyer.
   */
  async replaceBookInLibrary(input: {
    libraryId: string;
    userId: string;
    oldBookId: string;
    targetIsbn13: string;
  }): Promise<{ oldBookId: string; book: BookView }> {
    const oldBook = this.catalogRepo.findBookById(input.oldBookId);
    if (!oldBook) {
      throw new AppError(404, 'BOOK_NOT_FOUND', 'Ouvrage d’origine introuvable.');
    }

    const oldLib = this.libraryRepo.findLibraryBook(input.libraryId, input.oldBookId);
    const targetStatus: 'owned' | 'wish' =
      oldLib && !oldLib.deleted_at && oldLib.status === 'wish' ? 'wish' : 'owned';

    const resolved = await this.ingestionService.resolveIsbns({
      rawIsbns: [input.targetIsbn13],
      channel: 'manual_isbn',
      action: targetStatus,
      userId: input.userId,
      libraryId: input.libraryId
    });

    const newBook = resolved.results[0]?.book;
    if (!newBook) {
      throw new AppError(404, 'REPLACEMENT_BOOK_NOT_FOUND', 'Impossible de résoudre le nouvel ISBN sélectionné.');
    }

    if (newBook.id !== input.oldBookId) {
      const now = new Date().toISOString();
      this.db.transaction(() => {
        if (targetStatus === 'wish' && oldLib?.wished_by_user_id) {
          this.libraryRepo.upsertLibraryBookStatusLww({
            libraryId: input.libraryId,
            bookId: newBook.id,
            status: 'wish',
            wishedByUserId: oldLib.wished_by_user_id,
            timestamp: now
          });
        }

        // Transférer un éventuel prêt actif vers le nouveau livre
        this.loanRepo.transferActiveLoans(input.libraryId, input.oldBookId, newBook.id, now);

        // Transférer l'état de lecture individuel de l'utilisateur s'il existe et que le nouveau livre n'en a pas
        const oldReading = this.readingRepo.findByUserAndBook(input.userId, input.oldBookId);
        const existingNewReading = this.readingRepo.findByUserAndBook(input.userId, newBook.id);
        if (
          oldReading &&
          !existingNewReading &&
          (oldReading.status !== 'none' || oldReading.rating > 0 || oldReading.notes.trim().length > 0)
        ) {
          this.readingRepo.upsertReadingState({
            userId: input.userId,
            bookId: newBook.id,
            status: oldReading.status,
            rating: oldReading.rating,
            notes: oldReading.notes,
            timestamp: now
          });
        }

        // Retirer l'ancien livre du foyer (Couche 3)
        this.libraryRepo.upsertLibraryBookStatusLww({
          libraryId: input.libraryId,
          bookId: input.oldBookId,
          status: 'none',
          timestamp: now
        });
      });
    }

    const detail = this.getBookDetail(input.libraryId, input.userId, newBook.id);
    return { oldBookId: input.oldBookId, book: detail.book };
  }
}
