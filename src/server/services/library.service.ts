// src/server/services/library.service.ts
// Service métier Foyer : vues fusionnées (Couche 3 > Couche 2 > Couche 1), actions par lot (avec choix livres prêtés) et genres en lot.

import crypto from 'node:crypto';
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

export interface CoverCandidateItem {
  id: string;
  kind: 'local' | 'external';
  coverKey?: string;
  url: string;
  label: string;
}

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
    const merged = this.ingestionService.buildMergedBookView(bookRow, libRow);
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
        const visibleInSeries = seriesBooks.filter((sb) => {
          const lr = this.libraryRepo.findLibraryBook(libraryId, sb.id);
          const ov = parseOverrides(lr?.overrides_json);
          return !ov.oneShotForced && !(ov.hiddenSeriesIds ?? []).includes(seriesRow.id);
        });

        const idx = visibleInSeries.findIndex((sb) => sb.id === book.id);
        const prevBookId = idx > 0 ? visibleInSeries[idx - 1].id : null;
        const nextBookId = idx >= 0 && idx < visibleInSeries.length - 1 ? visibleInSeries[idx + 1].id : null;

        let ownedCount = 0;
        for (const sb of visibleInSeries) {
          const lr = this.libraryRepo.findLibraryBook(libraryId, sb.id);
          if (lr && !lr.deleted_at && lr.status === 'owned') ownedCount++;
        }

        seriesContext = {
          seriesId: seriesRow.id,
          seriesName: seriesRow.canonical_name,
          totalVolumes: visibleInSeries.length,
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
   * Galerie dédupliquée des couvertures disponibles pour un livre (Couche 3 + Catalogue + Éditions sœurs + Sources externes).
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

    const candidates: CoverCandidateItem[] = [];
    const seenUrls = new Set<string>();
    const seenExternalUrls = new Set<string>();

    const pushLocal = (coverKey: string | null | undefined, label: string) => {
      if (!coverKey) return;
      const url = `/api/covers/${coverKey}`;
      if (seenUrls.has(url)) return;
      seenUrls.add(url);
      const covRow = this.catalogRepo.findCoverByKey(coverKey);
      if (covRow?.source_url) seenExternalUrls.add(covRow.source_url);
      candidates.push({ id: coverKey, kind: 'local', coverKey, url, label });
    };

    const libRow = this.libraryRepo.findLibraryBook(libraryId, bookId);
    const overrides = parseOverrides(libRow?.overrides_json);

    pushLocal(overrides.coverKey, 'Couverture personnalisée (Foyer)');
    pushLocal(bookRow.cover_key, 'Couverture principale (Catalogue)');

    const editions = this.catalogRepo.listEditionsByBookId(bookId);
    for (const ed of editions) {
      pushLocal(ed.cover_key, `Édition ${ed.publisher || ed.isbn13}`);
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
      }> = [];
      const enqueueExt = (url: string | null | undefined, label: string, minBytes?: number, rejectExactBytes?: number) => {
        const clean = (url || '').trim();
        if (!clean || (!clean.startsWith('http://') && !clean.startsWith('https://'))) return;
        if (/\.svg(?:[?#]|$)/i.test(clean) || /(?:wikimedia|wikipedia)\.org/i.test(clean)) return;
        if (seenExternalUrls.has(clean)) return;
        seenExternalUrls.add(clean);
        rawExternalQueue.push({ url: clean, label, minBytes, rejectExactBytes });
      };

      const isbnsToProbe = new Set<string>(editions.map((e) => e.isbn13).filter(Boolean));
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
          ? this.connectors.bnf.searchByTitleAndAuthor(bnfTitleQuery, firstAuthor, 6)
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
        for (const isbn of invEdRes.value.isbn13s.slice(0, 3)) isbnsToProbe.add(isbn);
      }

      // 2. Couvertures directes Tableau Comparatif (BnF / Inventaire / Google Books / Open Library)
      if (draftRes.status === 'fulfilled' && draftRes.value) {
        for (const u of draftRes.value.coverCandidates) enqueueExt(u, 'Catalogue externe');
      }

      // 3. Résultats BnF par Titre + Auteur (filtrés par proximité titre)
      if (bnfRes.status === 'fulfilled') {
        for (const hit of bnfRes.value) {
          const hitText = `${hit.seriesName ?? ''} ${hit.title ?? ''}`.trim();
          const overlap = Math.max(
            tokenOverlapRatio(effectiveTitle, hitText),
            tokenOverlapRatio(fullSearchTitle, hitText)
          );
          if (overlap < 0.45 && !titleIsGeneric) continue;
          if (hit.coverUrl) enqueueExt(hit.coverUrl, `BnF (${hit.publisher || hit.isbn13 || 'catalogue'})`);
          if (hit.isbn13 && isbnsToProbe.size < 4) isbnsToProbe.add(hit.isbn13);
        }
      }

      // 4. CDN Librairies (Amazon EU, Amazon Media, Eyrolles/Dilicom H1400, Open Library) sur tous les ISBNs connus/découverts
      for (const isbn of Array.from(isbnsToProbe).slice(0, 4)) {
        for (const cdn of this.coverService.buildIsbnCdnCandidates(isbn)) {
          enqueueExt(cdn.url, cdn.label, cdn.minBytes, cdn.rejectExactBytes);
        }
      }

      // 5. Google Books (si non rate-limité) & Apple Books / iTunes FR (indispensable sans ISBN)
      if (gbRes.status === 'fulfilled') {
        for (const hit of gbRes.value) {
          if (hit.coverUrl) enqueueExt(hit.coverUrl, `Google Books (${hit.publisher || 'édition'})`);
        }
      }
      if (itunesRes.status === 'fulfilled') {
        for (const u of itunesRes.value) enqueueExt(u, 'Apple Books');
      }

      // Vérification réelle en parallèle (lots de 6) pour ne présenter que des images valides (zéro 404/placeholder)
      const toProbe = rawExternalQueue.slice(0, 18);
      const verified: typeof toProbe = [];
      for (let i = 0; i < toProbe.length && verified.length < 12; i += 6) {
        const batch = toProbe.slice(i, i + 6);
        const checks = await Promise.all(
          batch.map(async (item) => ({
            item,
            ok: await this.coverService.probeExternalCoverUrl(item.url, {
              minBytes: item.minBytes,
              rejectExactBytes: item.rejectExactBytes
            })
          }))
        );
        for (const c of checks) {
          if (c.ok && verified.length < 12) verified.push(c.item);
        }
      }

      for (const item of verified) {
        candidates.push({
          id: `ext_${crypto.createHash('md5').update(item.url).digest('hex').slice(0, 10)}`,
          kind: 'external',
          url: item.url,
          label: item.label
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
            scriptwriters: [],
            illustrators: [],
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
