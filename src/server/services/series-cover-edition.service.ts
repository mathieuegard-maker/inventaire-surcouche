// src/server/services/series-cover-edition.service.ts
// Service dédié (SOLID) : aperçu, propagation Couche 3 Foyer et recherche en tâche de fond (Option B)
// des couvertures d'une même édition (éditeur / collection / préfixe ISBN) sur les tomes d'une série.

import crypto from 'node:crypto';
import {
  buildEditionLineage,
  formatIsbnPrefixLabel,
  matchEditionLineageScore,
  selectBestEditionForLineage,
  type EditionLineage
} from '../../shared/bibliographic/edition-lineage.util';
import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import type {
  ApplySeriesEditionCoversResponse,
  LibraryBookOverrides,
  OwnershipStatus,
  SeriesCoverPropagationScope,
  SeriesEditionCoverPreviewItem,
  SeriesEditionCoverPreviewResponse,
  SeriesEditionTargetInput
} from '../../shared/types/domain.types';
import type { BibliographicConnectors } from '../connectors/types';
import type { DatabaseAdapter } from '../db/database.adapter';
import { AppError } from '../middleware/error.middleware';
import type { BookRow, CatalogRepository, SeriesRow } from '../repositories/catalog.repo';
import type { BackgroundJobRow, JobRepository } from '../repositories/job.repo';
import type { LibraryBookRow, LibraryRepository } from '../repositories/library.repo';
import type { BookIdentifierService } from './acquisition/book-identifier.service';
import type { IngestionService } from './acquisition/ingestion.service';
import type { CoverService } from './cover.service';

export interface SeriesApplyEditionJobReport {
  seriesId: string;
  editionLabel: string;
  processed: number;
  updatedCount: number;
  stillMissingCount: number;
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

function resolveTargetLineage(target: SeriesEditionTargetInput | null | undefined): EditionLineage | null {
  if (!target) return null;
  const fromFields = buildEditionLineage({
    isbn13: target.isbn13 ?? null,
    publisher: target.publisher ?? null,
    collectionName: target.collectionName ?? null
  });
  if (fromFields) {
    if (!fromFields.isbnPrefix && target.isbnPrefix) {
      const cleanPfx = target.isbnPrefix.replace(/\D/g, '');
      if (cleanPfx.length >= 6) {
        return {
          ...fromFields,
          isbnPrefix: cleanPfx,
          label: target.label?.trim() || fromFields.label
        };
      }
    }
    return target.label?.trim() ? { ...fromFields, label: target.label.trim() } : fromFields;
  }

  const cleanPfx = (target.isbnPrefix ?? '').replace(/\D/g, '');
  if (cleanPfx.length >= 6) {
    return {
      key: `pfx:${cleanPfx}`,
      publisherKey: null,
      collectionKey: null,
      isbnPrefix: cleanPfx,
      label: target.label?.trim() || `Édition ${formatIsbnPrefixLabel(cleanPfx)}`,
      publisher: null,
      collectionName: null
    };
  }
  return null;
}

export class SeriesCoverEditionService {
  private readonly db: DatabaseAdapter;
  private readonly catalogRepo: CatalogRepository;
  private readonly libraryRepo: LibraryRepository;
  private readonly jobRepo: JobRepository;
  private readonly coverService: CoverService;
  private readonly ingestionService: IngestionService;
  private readonly bookIdentifier?: BookIdentifierService;
  private readonly connectors?: BibliographicConnectors;
  private readonly onJobEnqueued?: () => void;
  private readonly onJobChanged?: (row: BackgroundJobRow | null) => void;

  constructor(deps: {
    db: DatabaseAdapter;
    catalogRepo: CatalogRepository;
    libraryRepo: LibraryRepository;
    jobRepo: JobRepository;
    coverService: CoverService;
    ingestionService: IngestionService;
    bookIdentifier?: BookIdentifierService;
    connectors?: BibliographicConnectors;
    onJobEnqueued?: () => void;
    onJobChanged?: (row: BackgroundJobRow | null) => void;
  }) {
    this.db = deps.db;
    this.catalogRepo = deps.catalogRepo;
    this.libraryRepo = deps.libraryRepo;
    this.jobRepo = deps.jobRepo;
    this.coverService = deps.coverService;
    this.ingestionService = deps.ingestionService;
    this.bookIdentifier = deps.bookIdentifier;
    this.connectors = deps.connectors;
    this.onJobEnqueued = deps.onJobEnqueued;
    this.onJobChanged = deps.onJobChanged;
  }

  /**
   * Récupère les tomes visibles d'une série pour un foyer (incluant les rattachements Couche 3
   * et excluant les tomes forcés one-shot ou masqués de cette série).
   */
  private listVisibleSeriesBooksForLibrary(
    libraryId: string,
    seriesId: string
  ): Array<{ book: BookRow; libRow: LibraryBookRow | null; overrides: LibraryBookOverrides }> {
    const catalogBooks = [...this.catalogRepo.listBooksBySeriesId(seriesId)];
    const seenIds = new Set(catalogBooks.map((b) => b.id));

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

    const visible: Array<{ book: BookRow; libRow: LibraryBookRow | null; overrides: LibraryBookOverrides }> = [];
    for (const book of catalogBooks) {
      const libRow = this.libraryRepo.findLibraryBook(libraryId, book.id);
      const ov = parseOverrides(libRow?.overrides_json);
      if (ov.oneShotForced) continue;
      if (ov.seriesId && ov.seriesId !== seriesId) continue;
      if ((ov.hiddenSeriesIds ?? []).includes(seriesId)) continue;
      visible.push({ book, libRow, overrides: ov });
    }

    return visible.sort((a, b) => {
      const sa = a.overrides.sortOrder ?? a.book.sort_order ?? a.overrides.volumeNumber ?? a.book.volume_number ?? 999999;
      const sb = b.overrides.sortOrder ?? b.book.sort_order ?? b.overrides.volumeNumber ?? b.book.volume_number ?? 999999;
      if (sa !== sb) return sa - sb;
      return (a.overrides.title ?? a.book.title).localeCompare(b.overrides.title ?? b.book.title, 'fr');
    });
  }

  private resolveCurrentDisplayedCoverKey(
    book: BookRow,
    overrides: LibraryBookOverrides,
    coherentCoverMap: Map<string, string>
  ): string | null {
    if (overrides.coverKey !== undefined) return overrides.coverKey;
    const locked = parseJsonStringArray(book.locked_fields_json);
    if (locked.includes('coverKey')) return book.cover_key;
    return coherentCoverMap.get(book.id) ?? book.cover_key;
  }

  /**
   * Calcule l'aperçu (tome par tome) des couvertures déjà disponibles en base dans une édition cible
   * au sein d'une série, sans modifier aucune donnée.
   */
  previewSeriesEditionCovers(input: {
    libraryId: string;
    seriesId: string;
    sourceBookId: string;
    targetEdition: SeriesEditionTargetInput;
  }): SeriesEditionCoverPreviewResponse {
    const series = this.catalogRepo.findSeriesById(input.seriesId);
    if (!series) {
      throw new AppError(404, 'SERIES_NOT_FOUND', 'Série introuvable.');
    }

    const sourceBook = this.catalogRepo.findBookById(input.sourceBookId);
    if (!sourceBook) {
      throw new AppError(404, 'BOOK_NOT_FOUND', 'Ouvrage source introuvable.');
    }

    const targetLineage = resolveTargetLineage(input.targetEdition);
    if (!targetLineage) {
      throw new AppError(400, 'INVALID_TARGET_EDITION', 'Édition cible non identifiable.');
    }

    const sourceLib = this.libraryRepo.findLibraryBook(input.libraryId, sourceBook.id);
    const sourceOv = parseOverrides(sourceLib?.overrides_json);
    const sourceIsIntegral = sourceOv.isIntegral ?? (sourceBook.is_integral === 1);

    const visibleEntries = this.listVisibleSeriesBooksForLibrary(input.libraryId, series.id);
    const coherentMap = this.ingestionService.computeSeriesCoherentCoverMap(series.id, input.libraryId);

    const items: SeriesEditionCoverPreviewItem[] = [];
    let readyCount = 0;
    let sameCount = 0;
    let missingCount = 0;

    for (const { book, libRow, overrides } of visibleEntries) {
      if (book.id === sourceBook.id) continue;
      const effectiveIntegral = overrides.isIntegral ?? (book.is_integral === 1);
      // Ne mélange jamais tomes unitaires et intégrales lors de la propagation d'une édition
      if (effectiveIntegral !== sourceIsIntegral) continue;

      const currentCoverKey = this.resolveCurrentDisplayedCoverKey(book, overrides, coherentMap);
      const editions = this.catalogRepo.listEditionsByBookId(book.id).map((ed) => ({
        isbn13: ed.isbn13,
        publisher: ed.publisher ?? (ed.cover_key && ed.cover_key === book.cover_key ? book.publisher : null),
        collectionName:
          ed.collection_name ??
          (!ed.publisher && ed.cover_key && ed.cover_key === book.cover_key ? book.collection_name : null),
        publishYear: ed.publish_year,
        coverKey: ed.cover_key
      }));

      // Vérifie d'abord les éditions déjà pourvues d'une couverture WebP
      const matched = selectBestEditionForLineage(editions, targetLineage, true);
      let matchedCoverKey = matched?.edition.coverKey ?? null;
      let matchedIsbn13 = matched?.edition.isbn13 ?? null;
      let matchedPublisher = matched?.edition.publisher ?? null;
      let matchedCollectionName = matched?.edition.collectionName ?? null;

      // Repli si la couverture principale `book.cover_key` porte elle-même cette lignée sans être recopiée sur l'édition
      if (!matchedCoverKey && book.cover_key) {
        const bookLineage = buildEditionLineage({
          isbn13: editions[0]?.isbn13 ?? null,
          publisher: book.publisher,
          collectionName: book.collection_name
        });
        if (matchEditionLineageScore(targetLineage, bookLineage) >= 60) {
          matchedCoverKey = book.cover_key;
          matchedIsbn13 = editions[0]?.isbn13 ?? null;
          matchedPublisher = book.publisher;
          matchedCollectionName = book.collection_name;
        }
      }

      let matchStatus: 'ready' | 'same' | 'missing';
      if (!matchedCoverKey) {
        matchStatus = 'missing';
        missingCount++;
      } else if (matchedCoverKey === currentCoverKey) {
        matchStatus = 'same';
        sameCount++;
      } else {
        matchStatus = 'ready';
        readyCount++;
      }

      const ownershipStatus: OwnershipStatus =
        libRow && !libRow.deleted_at ? libRow.status : 'none';

      items.push({
        bookId: book.id,
        title: overrides.title ?? book.title,
        volumeNumber: overrides.volumeNumber !== undefined ? overrides.volumeNumber : book.volume_number,
        volumeLabel: overrides.volumeLabel !== undefined ? overrides.volumeLabel : book.volume_label,
        isIntegral: effectiveIntegral,
        ownershipStatus,
        hasUserCoverOverride: Boolean(overrides.coverKey),
        currentCoverUrl: currentCoverKey ? `/api/covers/${currentCoverKey}` : null,
        matchedCoverKey,
        matchedCoverUrl: matchedCoverKey ? `/api/covers/${matchedCoverKey}` : null,
        matchedIsbn13,
        matchedPublisher,
        matchedCollectionName,
        matchStatus
      });
    }

    return {
      seriesId: series.id,
      seriesName: series.canonical_name,
      sourceBookId: sourceBook.id,
      editionLabel: targetLineage.label,
      lineageKey: targetLineage.key,
      publisher: targetLineage.publisher,
      collectionName: targetLineage.collectionName,
      isbnPrefix: targetLineage.isbnPrefix,
      totalCount: items.length,
      readyCount,
      sameCount,
      missingCount,
      items
    };
  }

  /**
   * Applique une couverture d'édition en Couche 3 Foyer selon la portée choisie (`single`, `all`, `selected`),
   * et planifie optionnellement un job de fond `series_apply_edition_covers` (Option B) pour les tomes manquants.
   */
  applySeriesEditionCovers(input: {
    libraryId: string;
    userId: string;
    seriesId: string;
    sourceBookId: string;
    sourceCoverKey: string;
    scope: SeriesCoverPropagationScope;
    bookIds: string[];
    targetEdition?: SeriesEditionTargetInput | null;
    searchMissingInBackground: boolean;
  }): ApplySeriesEditionCoversResponse {
    const series = this.catalogRepo.findSeriesById(input.seriesId);
    if (!series) {
      throw new AppError(404, 'SERIES_NOT_FOUND', 'Série introuvable.');
    }

    const sourceBook = this.catalogRepo.findBookById(input.sourceBookId);
    if (!sourceBook) {
      throw new AppError(404, 'BOOK_NOT_FOUND', 'Ouvrage source introuvable.');
    }

    const coverRow = this.catalogRepo.findCoverByKey(input.sourceCoverKey);
    if (!coverRow) {
      throw new AppError(404, 'COVER_NOT_FOUND', 'Couverture introuvable sur le serveur.');
    }

    const now = new Date().toISOString();
    const appliedBookIds: string[] = [];
    const missingBookIds: string[] = [];
    let backgroundJobId: string | null = null;

    const targetLineage = resolveTargetLineage(input.targetEdition ?? null);
    const preview =
      input.scope !== 'single' && targetLineage
        ? this.previewSeriesEditionCovers({
            libraryId: input.libraryId,
            seriesId: input.seriesId,
            sourceBookId: input.sourceBookId,
            targetEdition: input.targetEdition!
          })
        : null;

    const selectedSet = new Set(input.bookIds);

    this.db.transaction(() => {
      // 1. Appliquer la couverture choisie sur le tome source (Couche 3 Foyer)
      const srcLib = this.libraryRepo.findLibraryBook(input.libraryId, sourceBook.id);
      const srcOv = parseOverrides(srcLib?.overrides_json);
      this.libraryRepo.setLibraryBookOverrides(
        input.libraryId,
        sourceBook.id,
        { ...srcOv, coverKey: input.sourceCoverKey },
        now
      );
      appliedBookIds.push(sourceBook.id);

      // Enrichissement non destructif de `book_editions` si la couverture importée portait un ISBN de ce livre
      const cleanSrcIsbn = input.targetEdition?.isbn13
        ? isbnUtil.normalizeToIsbn13(input.targetEdition.isbn13)
        : null;
      if (cleanSrcIsbn) {
        const owner = this.catalogRepo.findBookByIsbn13(cleanSrcIsbn);
        if (!owner || owner.id === sourceBook.id) {
          this.catalogRepo.upsertBookEdition({
            isbn13: cleanSrcIsbn,
            bookId: sourceBook.id,
            publisher: input.targetEdition?.publisher ?? null,
            collectionName: input.targetEdition?.collectionName ?? null,
            publishYear: null,
            pageCount: null,
            coverKey: input.sourceCoverKey,
            source: 'auto',
            now
          });
        }
      }

      // 2. Propagation immédiate sur les tomes visés qui disposent déjà de cette édition en base
      if (preview && input.scope !== 'single') {
        for (const item of preview.items) {
          if (input.scope === 'selected' && !selectedSet.has(item.bookId)) continue;

          if (item.matchedCoverKey) {
            const targetLib = this.libraryRepo.findLibraryBook(input.libraryId, item.bookId);
            const targetOv = parseOverrides(targetLib?.overrides_json);
            if (targetOv.coverKey !== item.matchedCoverKey) {
              this.libraryRepo.setLibraryBookOverrides(
                input.libraryId,
                item.bookId,
                { ...targetOv, coverKey: item.matchedCoverKey },
                now
              );
            }
            appliedBookIds.push(item.bookId);
          } else {
            missingBookIds.push(item.bookId);
          }
        }
      }

      // 3. Option B : recherche active en arrière-plan des couvertures manquantes dans cette édition
      if (
        input.searchMissingInBackground &&
        missingBookIds.length > 0 &&
        targetLineage &&
        input.scope !== 'single'
      ) {
        const job = this.jobRepo.createJob({
          id: `job_${crypto.randomBytes(6).toString('hex')}`,
          type: 'series_apply_edition_covers',
          userId: input.userId,
          libraryId: input.libraryId,
          payload: {
            seriesId: series.id,
            libraryId: input.libraryId,
            priority: 'high',
            targetBookIds: missingBookIds,
            targetEdition: {
              isbn13: input.targetEdition?.isbn13 ?? null,
              publisher: targetLineage.publisher,
              collectionName: targetLineage.collectionName,
              isbnPrefix: targetLineage.isbnPrefix,
              lineageKey: targetLineage.key,
              label: targetLineage.label
            }
          },
          progressTotal: missingBookIds.length,
          now
        });
        backgroundJobId = job.id;
      }
    });

    if (backgroundJobId) {
      this.onJobChanged?.(this.jobRepo.findJobById(backgroundJobId));
      this.onJobEnqueued?.();
    }

    return {
      appliedBookIds,
      appliedCount: appliedBookIds.length,
      missingBookIds,
      backgroundJobId
    };
  }

  /**
   * Worker Option B (`series_apply_edition_covers`) :
   * Recherche activement, tome par tome en arrière-plan (voie catalogue LOW), une édition correspondant
   * à la lignée éditoriale choisie par l'utilisateur, compresse sa couverture en WebP et l'applique
   * exclusivement en Couche 3 Foyer (`library_books.overrides_json.coverKey`).
   */
  async executeApplyEditionCoversJob(input: {
    seriesId: string;
    libraryId: string;
    targetBookIds: string[];
    targetEdition: SeriesEditionTargetInput;
    onProgress?: (done: number, total: number) => void;
  }): Promise<SeriesApplyEditionJobReport> {
    const series = this.catalogRepo.findSeriesById(input.seriesId);
    const targetLineage = resolveTargetLineage(input.targetEdition);
    if (!series || !targetLineage || input.targetBookIds.length === 0) {
      return {
        seriesId: input.seriesId,
        editionLabel: targetLineage?.label ?? '',
        processed: 0,
        updatedCount: 0,
        stillMissingCount: input.targetBookIds.length
      };
    }

    const allSeriesBooks = this.catalogRepo.listBooksBySeriesId(series.id);
    const mediaFamily = this.detectSeriesMediaFamily(allSeriesBooks);
    const total = input.targetBookIds.length;
    let processed = 0;
    let updatedCount = 0;
    let stillMissingCount = 0;

    input.onProgress?.(0, total);

    for (const bookId of input.targetBookIds) {
      try {
        const book = this.catalogRepo.findBookById(bookId);
        if (!book) {
          stillMissingCount++;
        } else {
          const foundCoverKey = await this.findAndIngestEditionCoverForBook(
            book,
            series,
            targetLineage,
            mediaFamily
          );
          if (foundCoverKey) {
            // Relecture fraîche des overrides Couche 3 pour ne jamais écraser un autre champ modifié entre-temps
            const libRow = this.libraryRepo.findLibraryBook(input.libraryId, book.id);
            const currentOv = parseOverrides(libRow?.overrides_json);
            this.libraryRepo.setLibraryBookOverrides(
              input.libraryId,
              book.id,
              { ...currentOv, coverKey: foundCoverKey },
              new Date().toISOString()
            );
            updatedCount++;
          } else {
            stillMissingCount++;
          }
        }
      } catch {
        stillMissingCount++;
      }

      processed++;
      input.onProgress?.(processed, total);
    }

    return {
      seriesId: series.id,
      editionLabel: targetLineage.label,
      processed,
      updatedCount,
      stillMissingCount
    };
  }

  private detectSeriesMediaFamily(books: BookRow[]): 'graphic' | 'prose' | 'neutral' {
    let graphicCount = 0;
    let proseCount = 0;
    for (const b of books) {
      if (b.main_category === 'BD' || b.main_category === 'Manga' || b.main_category === 'Comics') graphicCount++;
      else if (b.main_category === 'Roman' || b.main_category === 'Essai' || b.main_category === 'Poésie / Théâtre') {
        proseCount++;
      }
    }
    if (graphicCount > 0 && graphicCount >= proseCount) return 'graphic';
    if (proseCount > 0 && proseCount > graphicCount) return 'prose';
    return 'neutral';
  }

  private async findAndIngestEditionCoverForBook(
    book: BookRow,
    series: SeriesRow,
    targetLineage: EditionLineage,
    mediaFamily: 'graphic' | 'prose' | 'neutral'
  ): Promise<string | null> {
    const now = new Date().toISOString();

    // 1. Vérifier d'abord si une `book_edition` existante sur ce tome correspond déjà à la lignée cible (avec ou sans cover_key)
    const existingEditions = this.catalogRepo.listEditionsByBookId(book.id);
    const matchedLocalCovered = selectBestEditionForLineage(
      existingEditions.map((e) => ({
        isbn13: e.isbn13,
        publisher: e.publisher ?? (e.cover_key && e.cover_key === book.cover_key ? book.publisher : null),
        collectionName: e.collection_name,
        publishYear: e.publish_year,
        coverKey: e.cover_key
      })),
      targetLineage,
      true
    );
    if (matchedLocalCovered?.edition.coverKey) {
      return matchedLocalCovered.edition.coverKey;
    }

    const matchedLocalUncovered = selectBestEditionForLineage(
      existingEditions.map((e) => ({
        isbn13: e.isbn13,
        publisher: e.publisher,
        collectionName: e.collection_name,
        publishYear: e.publish_year,
        coverKey: e.cover_key
      })),
      targetLineage,
      false
    );
    if (matchedLocalUncovered) {
      const stored = await this.coverService.resolveBestCoverFromCascade({
        isbn13: matchedLocalUncovered.edition.isbn13,
        candidateUrls: [],
        skipTitleFallback: true
      });
      if (stored) {
        const rawEd = existingEditions.find((e) => e.isbn13 === matchedLocalUncovered.edition.isbn13);
        if (rawEd) {
          this.catalogRepo.upsertBookEdition({
            isbn13: rawEd.isbn13,
            bookId: book.id,
            publisher: rawEd.publisher,
            collectionName: rawEd.collection_name,
            publishYear: rawEd.publish_year,
            pageCount: rawEd.page_count,
            coverKey: stored.coverKey,
            source: rawEd.source,
            now
          });
        }
        return stored.coverKey;
      }
    }

    // 2. Recherche ciblée multi-éditions (BnF jusqu'à 20 notices + recherche éditeur + Inventaire)
    const candidateProbes: Array<{
      isbn13: string;
      publisher: string | null;
      collectionName: string | null;
      publishYear: string | null;
      pageCount: number | null;
      coverUrl: string | null;
      source: string;
      lineageScore: number;
    }> = [];
    const seenIsbns = new Set<string>();

    if (this.bookIdentifier) {
      const authors = parseJsonStringArray(book.authors_json);
      const discovered = await this.bookIdentifier
        .findRankedEditionsForSeriesVolume(
          {
            seriesName: series.canonical_name,
            title: book.title,
            volumeNumber: book.volume_number,
            authors,
            mediaFamily,
            isIntegral: book.is_integral === 1,
            preferredEdition: targetLineage,
            deepEditionSearch: true
          },
          8
        )
        .catch(() => []);

      for (const ed of discovered) {
        if (ed.lineageScore < 60 || seenIsbns.has(ed.isbn13)) continue;
        seenIsbns.add(ed.isbn13);
        candidateProbes.push(ed);
      }
    }

    // 3. Complément Graphe Inventaire P629 (si préfixe ISBN cible connu)
    if (
      candidateProbes.length === 0 &&
      targetLineage.isbnPrefix &&
      this.connectors?.inventaire.fetchWorkEditions &&
      (book.wikidata_qid || book.inventaire_uri)
    ) {
      const workUri = book.wikidata_qid ? `wd:${book.wikidata_qid}` : book.inventaire_uri!;
      const workEd = await this.connectors.inventaire
        .fetchWorkEditions(workUri)
        .catch(() => ({ isbn13s: [] as string[], coverUrls: [] as string[] }));
      for (const rawIsbn of workEd.isbn13s) {
        const cleanIsbn = isbnUtil.normalizeToIsbn13(rawIsbn);
        if (!cleanIsbn || seenIsbns.has(cleanIsbn)) continue;
        const lin = buildEditionLineage({ isbn13: cleanIsbn });
        const score = matchEditionLineageScore(targetLineage, lin);
        if (score >= 60) {
          seenIsbns.add(cleanIsbn);
          candidateProbes.push({
            isbn13: cleanIsbn,
            publisher: null,
            collectionName: null,
            publishYear: null,
            pageCount: null,
            coverUrl: null,
            source: 'inventaire',
            lineageScore: score
          });
        }
      }
    }

    candidateProbes.sort((a, b) => b.lineageScore - a.lineageScore);

    // 4. Téléchargement CDN vérifié (jamais de fallback iTunes générique pour préserver la fidélité d'édition)
    for (const probe of candidateProbes.slice(0, 3)) {
      const stored = await this.coverService.resolveBestCoverFromCascade({
        isbn13: probe.isbn13,
        candidateUrls: probe.coverUrl ? [probe.coverUrl] : [],
        skipTitleFallback: true
      });
      if (!stored) continue;

      const owner = this.catalogRepo.findBookByIsbn13(probe.isbn13);
      if (!owner || owner.id === book.id) {
        this.catalogRepo.upsertBookEdition({
          isbn13: probe.isbn13,
          bookId: book.id,
          publisher: probe.publisher,
          collectionName: probe.collectionName,
          publishYear: probe.publishYear,
          pageCount: probe.pageCount,
          coverKey: stored.coverKey,
          source: probe.source,
          now
        });
      }
      return stored.coverKey;
    }

    return null;
  }
}
