// src/server/services/library.service.ts
// Service métier Foyer : vues fusionnées (Couche 3 > Couche 2 > Couche 1), actions par lot (avec choix livres prêtés) et genres en lot.

import { annotateIntegralCoverage } from '../../shared/bibliographic/integral.util';
import type {
  ActiveLoanView,
  BookView,
  LibraryBookOverrides,
  OwnershipStatus,
  SeriesView,
  UserReadingStateView
} from '../../shared/types/domain.types';
import type { DatabaseAdapter } from '../db/database.adapter';
import type { BookRow, CatalogRepository } from '../repositories/catalog.repo';
import type { LibraryBookRow, LibraryRepository } from '../repositories/library.repo';
import type { LoanRepository } from '../repositories/loan.repo';
import type { ReadingRepository } from '../repositories/reading.repo';
import type { IngestionService } from './acquisition/ingestion.service';
import { mapLoanRowToView, type LoanContactSuggestion, type LoanService } from './loan.service';

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
  private readonly ingestionService: IngestionService;
  private readonly loanService: LoanService;

  constructor(deps: {
    db: DatabaseAdapter;
    catalogRepo: CatalogRepository;
    libraryRepo: LibraryRepository;
    loanRepo: LoanRepository;
    readingRepo: ReadingRepository;
    ingestionService: IngestionService;
    loanService: LoanService;
  }) {
    this.db = deps.db;
    this.catalogRepo = deps.catalogRepo;
    this.libraryRepo = deps.libraryRepo;
    this.loanRepo = deps.loanRepo;
    this.readingRepo = deps.readingRepo;
    this.ingestionService = deps.ingestionService;
    this.loanService = deps.loanService;
  }

  /**
   * Construit le payload complet ou incrémental (delta `since`) pour un foyer + utilisateur.
   * Ne retourne JAMAIS `wishlist_reservations` aux membres du foyer (anti-spoiler).
   */
  buildSyncPullPayload(libraryId: string, userId: string, since?: string): SyncPullPayload {
    const serverTime = new Date().toISOString();
    const isFullSync = !since;

    // 1. Récupération des lignes library_books du foyer
    const allActiveLibRows = this.libraryRepo.listLibraryBooks(libraryId);
    const deltaLibRows = since ? this.libraryRepo.listLibraryBooks(libraryId, since) : allActiveLibRows;

    const libRowByBookId = new Map<string, LibraryBookRow>();
    for (const r of allActiveLibRows) {
      libRowByBookId.set(r.book_id, r);
    }

    const deletedBookIds: string[] = [];
    if (since) {
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

    const rawActiveViews: BookView[] = activeBookRows.map((bookRow) => {
      const libRow = libRowByBookId.get(bookRow.id) ?? null;
      const merged = this.ingestionService.buildMergedBookView(bookRow, libRow);
      merged.activeLoan = loanByBookId.get(bookRow.id) ?? null;
      merged.readingState = readingByBookId.get(bookRow.id) ?? null;
      merged.wishedByName = libRow?.wished_by_user_id ? (usernameMap.get(libRow.wished_by_user_id) ?? null) : null;
      if (merged.seriesId) seriesIds.add(merged.seriesId);
      return merged;
    });

    const annotatedActiveViews = annotateIntegralCoverage(rawActiveViews, rawActiveViews);

    // 5. Construction des SeriesView pour les séries présentes dans le foyer
    const seriesViews: SeriesView[] = [];
    for (const sId of seriesIds) {
      const sRow = this.catalogRepo.findSeriesById(sId);
      if (!sRow) continue;
      const seriesBooksInLibrary = annotatedActiveViews.filter((b) => b.seriesId === sId);
      const ownedCount = seriesBooksInLibrary.filter(
        (b) => b.ownershipStatus === 'owned' || Boolean(b.ownedViaIntegral)
      ).length;
      const coverBook =
        seriesBooksInLibrary.find((b) => b.ownershipStatus === 'owned' && b.coverUrl) ??
        seriesBooksInLibrary.find((b) => b.coverUrl);

      seriesViews.push({
        id: sRow.id,
        franchiseId: sRow.franchise_id,
        canonicalName: sRow.canonical_name,
        editionSignature: sRow.edition_signature || null,
        aliases: parseJsonStringArray(sRow.aliases_json),
        primaryAuthors: parseJsonStringArray(sRow.primary_authors_json),
        wikidataQid: sRow.wikidata_qid,
        isCompleteExpanded: sRow.is_complete_expanded === 1,
        knownVolumesCount: Math.max(sRow.known_volumes_count, seriesBooksInLibrary.length),
        ownedCount,
        coverUrl: coverBook?.coverUrl ?? null,
        updatedAt: sRow.updated_at
      });
    }

    // 6. Filtrage delta si `since` est fourni (tout en conservant les recalculs d'intégrales / prêts / lectures modifiés)
    let booksToReturn = annotatedActiveViews;
    if (since) {
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
}
