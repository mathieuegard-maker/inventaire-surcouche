// src/server/services/collection-import.service.ts
// Service d'import utilisateur CSV / JSON / Excel (.xlsx) 100 % serveur.
// Règle stricte : l'ISBN-13 est le pivot unique de toute ingestion (zéro création sans ISBN).

import crypto from 'node:crypto';
import { readSheet } from 'read-excel-file/node';
import {
  describeImportInputProfile,
  inspectJsonForImport,
  inspectMatrixForImport,
  parseCreatorNames,
  parseCsvToMatrix,
  parseImportJson,
  parseImportRowsFromMatrix,
  type ImportColumnMapping,
  type ImportFilePreview,
  type ImportedBookRow
} from '../../shared/bibliographic/collection-import.util';
import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import { normalizeTextKey } from '../../shared/bibliographic/text-normalize.util';
import type {
  BackgroundJobView,
  CollectionImportComparisonItem,
  CollectionImportResolutionChannel,
  LibraryBookOverrides
} from '../../shared/types/domain.types';
import { AppError } from '../middleware/error.middleware';
import type { BackgroundJobRow, JobRepository } from '../repositories/job.repo';
import { mapJobRowToView, type JobHandlerContext } from '../workers/background-worker';
import type { IngestionService } from './acquisition/ingestion.service';
import type { LibraryService } from './library.service';
import type { PhotoAiService } from './photo-ai.service';
import type { ReadingService } from './reading.service';

const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_ROWS = 5000;

export interface CollectionImportUnmatchedItem {
  rowNumber: number;
  isbn: string | null;
  title: string | null;
  series: string | null;
  author: string | null;
  reason: 'isbn_not_found' | 'catalog_not_found';
}

export interface CollectionImportResultPayload {
  filename: string;
  totalRows: number;
  importedCount: number;
  resolvedByIsbnCount: number;
  resolvedBySearchCount: number;
  skippedCount: number;
  unmatchedCount: number;
  unmatched: CollectionImportUnmatchedItem[];
  items?: CollectionImportComparisonItem[];
}

interface CollectionImportJobPayload {
  userId: string;
  libraryId: string;
  filename: string;
  defaultStatus: 'owned' | 'wish';
  skippedNoneCount: number;
  rows: ImportedBookRow[];
}

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function excelCellToString(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  if (typeof cell === 'boolean') return cell ? 'Oui' : 'Non';
  if (typeof cell === 'number') return Number.isFinite(cell) ? String(cell) : '';
  return String(cell);
}

export class CollectionImportService {
  private readonly jobRepo: JobRepository;
  private readonly ingestionService: IngestionService;
  private readonly photoAiService: PhotoAiService;
  private readonly libraryService: LibraryService;
  private readonly readingService: ReadingService;
  private readonly onJobEnqueued?: () => void;
  private readonly onJobChanged?: (job: BackgroundJobRow) => void;

  constructor(deps: {
    jobRepo: JobRepository;
    ingestionService: IngestionService;
    photoAiService: PhotoAiService;
    libraryService: LibraryService;
    readingService: ReadingService;
    onJobEnqueued?: () => void;
    onJobChanged?: (job: BackgroundJobRow) => void;
  }) {
    this.jobRepo = deps.jobRepo;
    this.ingestionService = deps.ingestionService;
    this.photoAiService = deps.photoAiService;
    this.libraryService = deps.libraryService;
    this.readingService = deps.readingService;
    this.onJobEnqueued = deps.onJobEnqueued;
    this.onJobChanged = deps.onJobChanged;
  }

  private async decodeUploadedSource(
    filename: string,
    contentBase64: string
  ): Promise<
    | { format: 'json'; rawText: string }
    | { format: 'csv' | 'xlsx'; matrix: string[][] }
  > {
    const cleanBase64 =
      contentBase64.startsWith('data:') && contentBase64.includes(',')
        ? contentBase64.slice(contentBase64.indexOf(',') + 1)
        : contentBase64;

    const buffer = Buffer.from(cleanBase64, 'base64');
    if (buffer.byteLength === 0) {
      throw new AppError(400, 'IMPORT_EMPTY', 'Le fichier fourni est vide.');
    }
    if (buffer.byteLength > MAX_IMPORT_FILE_BYTES) {
      throw new AppError(400, 'IMPORT_TOO_LARGE', 'Fichier trop volumineux (maximum 10 Mo).');
    }

    const lower = filename.trim().toLowerCase();

    if (lower.endsWith('.json')) {
      return { format: 'json', rawText: buffer.toString('utf8') };
    }
    if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
      return { format: 'csv', matrix: parseCsvToMatrix(buffer.toString('utf8')) };
    }
    if (lower.endsWith('.xlsx')) {
      try {
        const sheetRows = await readSheet(buffer);
        return { format: 'xlsx', matrix: sheetRows.map((r) => r.map(excelCellToString)) };
      } catch {
        throw new AppError(
          400,
          'IMPORT_INVALID_FILE',
          'Impossible de lire ce fichier Excel (.xlsx). Vérifiez qu’il est au format .xlsx valide.'
        );
      }
    }

    throw new AppError(
      400,
      'IMPORT_UNSUPPORTED_FORMAT',
      'Format non supporté. Utilisez un fichier CSV, JSON ou Excel (.xlsx).'
    );
  }

  /**
   * Analyse un fichier CSV, JSON ou Excel (.xlsx) avant import afin de présenter à l'utilisateur
   * les colonnes détectées, un aperçu des 3 premières valeurs et la bijection pré-proposée.
   */
  async previewUploadedFile(input: {
    filename: string;
    contentBase64: string;
    hasHeaderRow?: boolean;
  }): Promise<ImportFilePreview> {
    const decoded = await this.decodeUploadedSource(input.filename, input.contentBase64);
    let preview: ImportFilePreview;

    if (decoded.format === 'json') {
      try {
        preview = inspectJsonForImport(decoded.rawText);
      } catch {
        throw new AppError(400, 'IMPORT_INVALID_FILE', 'Fichier JSON invalide.');
      }
    } else {
      preview = inspectMatrixForImport(decoded.matrix, {
        format: decoded.format,
        hasHeaderRow: input.hasHeaderRow
      });
    }

    if (preview.totalDataRows === 0 || preview.columns.length === 0) {
      throw new AppError(
        400,
        'IMPORT_EMPTY',
        'Aucune ligne exploitable détectée dans ce fichier.'
      );
    }
    if (preview.totalDataRows > MAX_IMPORT_ROWS) {
      throw new AppError(
        400,
        'IMPORT_TOO_MANY_ROWS',
        `Trop de lignes dans le fichier (${preview.totalDataRows} — maximum ${MAX_IMPORT_ROWS} par import).`
      );
    }

    return preview;
  }

  async parseUploadedFile(
    filename: string,
    contentBase64: string,
    options?: { hasHeaderRow?: boolean; columnMapping?: ImportColumnMapping }
  ): Promise<ImportedBookRow[]> {
    const decoded = await this.decodeUploadedSource(filename, contentBase64);
    let rows: ImportedBookRow[] = [];

    if (decoded.format === 'json') {
      try {
        rows = parseImportJson(decoded.rawText, { columnMapping: options?.columnMapping });
      } catch {
        throw new AppError(400, 'IMPORT_INVALID_FILE', 'Fichier JSON invalide.');
      }
    } else {
      rows = parseImportRowsFromMatrix(decoded.matrix, {
        hasHeaderRow: options?.hasHeaderRow,
        columnMapping: options?.columnMapping
      });
    }

    if (rows.length === 0) {
      throw new AppError(
        400,
        'IMPORT_EMPTY',
        'Aucune ligne exploitable détectée (attendu : colonnes ISBN, Titre ou Série).'
      );
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new AppError(
        400,
        'IMPORT_TOO_MANY_ROWS',
        `Trop de lignes dans le fichier (${rows.length} — maximum ${MAX_IMPORT_ROWS} par import).`
      );
    }

    return rows;
  }

  async enqueueImportJob(input: {
    userId: string;
    libraryId: string;
    filename: string;
    contentBase64: string;
    defaultStatus: 'owned' | 'wish';
    hasHeaderRow?: boolean;
    columnMapping?: ImportColumnMapping;
  }): Promise<{ job: BackgroundJobView; totalRows: number; skippedCount: number }> {
    const parsedRows = await this.parseUploadedFile(input.filename, input.contentBase64, {
      hasHeaderRow: input.hasHeaderRow,
      columnMapping: input.columnMapping
    });
    const importableRows = parsedRows.filter((r) => r.ownershipStatus !== 'none');
    const skippedNoneCount = parsedRows.length - importableRows.length;

    if (importableRows.length === 0) {
      throw new AppError(
        400,
        'IMPORT_EMPTY',
        'Aucune ligne à importer (toutes les lignes ont un statut non possédé).'
      );
    }

    const now = new Date().toISOString();
    const jobRow = this.jobRepo.createJob({
      id: generateId('imp'),
      type: 'collection_import',
      userId: input.userId,
      libraryId: input.libraryId,
      progressTotal: importableRows.length,
      payload: {
        userId: input.userId,
        libraryId: input.libraryId,
        filename: input.filename,
        defaultStatus: input.defaultStatus,
        skippedNoneCount,
        rows: importableRows
      } satisfies CollectionImportJobPayload,
      now
    });

    this.onJobChanged?.(jobRow);
    this.onJobEnqueued?.();

    return {
      job: mapJobRowToView(jobRow),
      totalRows: importableRows.length,
      skippedCount: skippedNoneCount
    };
  }

  async executeCollectionImportJob(
    ctx: JobHandlerContext
  ): Promise<{ result: CollectionImportResultPayload; total: number }> {
    const payload = ctx.payload as unknown as CollectionImportJobPayload;
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    const total = rows.length;

    const result: CollectionImportResultPayload = {
      filename: payload.filename || 'import',
      totalRows: total,
      importedCount: 0,
      resolvedByIsbnCount: 0,
      resolvedBySearchCount: 0,
      skippedCount: payload.skippedNoneCount ?? 0,
      unmatchedCount: 0,
      unmatched: [],
      items: []
    };

    const buildInputTrace = (row: ImportedBookRow): CollectionImportComparisonItem['input'] => ({
      isbn: row.isbn,
      title: row.title,
      series: row.series,
      volumeNumber: row.volumeNumber,
      author: row.author,
      publisher: row.publisher,
      isIntegral: row.isIntegral,
      includedVolumes: row.includedVolumes,
      testCategory: row.testCategory ?? null,
      notes: row.notes,
      inputProfile: describeImportInputProfile(row)
    });

    const recordUnmatched = (
      row: ImportedBookRow,
      reason: 'isbn_not_found' | 'catalog_not_found',
      startedAtMs: number
    ) => {
      result.unmatched.push({
        rowNumber: row.rowNumber,
        isbn: row.isbn,
        title: row.title,
        series: row.series,
        author: row.author,
        reason
      });
      result.unmatchedCount = result.unmatched.length;
      result.items?.push({
        rowNumber: row.rowNumber,
        input: buildInputTrace(row),
        status: 'unmatched',
        resolutionChannel: 'unmatched',
        unmatchedReason: reason,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        resolvedBookId: null,
        resolvedIsbn13: null,
        snapshot: null
      });
    };

    const reportRowProgress = (done: number) => {
      const shouldPersistFullResult = total <= 50 || done % 5 === 0 || done === total;
      ctx.reportProgress(done, total, shouldPersistFullResult ? { ...result } : undefined);
    };

    for (let i = 0; i < total; i++) {
      if (ctx.isCancelled?.()) break;
      const row = rows[i];
      const rowStartedAt = Date.now();
      const targetStatus: 'owned' | 'wish' =
        row.ownershipStatus === 'wish' || row.ownershipStatus === 'owned'
          ? row.ownershipStatus
          : payload.defaultStatus;

      try {
        // Règle absolue : pivot ISBN-13 obligatoire (zéro création sans ISBN).
        let isbn13 = row.isbn ? isbnUtil.normalizeToIsbn13(row.isbn) : null;
        let resolvedViaSearch = false;

        // Si le fichier précise un média (BD/Manga/Comics/Roman), le transmettre en indice de recherche sans ISBN
        const mediaHintSuffix =
          row.mainCategory &&
          (row.mainCategory === 'BD' ||
            row.mainCategory === 'Manga' ||
            row.mainCategory === 'Comics' ||
            row.mainCategory === 'Roman')
            ? ` (${row.mainCategory})`
            : '';
        const searchTitleHint = row.title
          ? mediaHintSuffix && !/\((?:bd|manga|comics|roman)\)/i.test(row.title)
            ? `${row.title}${mediaHintSuffix}`
            : row.title
          : undefined;
        const searchSeriesHint = row.series
          ? !searchTitleHint && mediaHintSuffix && !/\((?:bd|manga|comics|roman)\)/i.test(row.series)
            ? `${row.series}${mediaHintSuffix}`
            : row.series
          : undefined;

        if (!isbn13 && (row.title || row.series)) {
          const candidates = await this.photoAiService.searchBookCandidates({
            title: searchTitleHint,
            series: searchSeriesHint,
            volumeNumber: row.volumeNumber ?? undefined,
            author: row.author ?? undefined,
            publisher: row.publisher ?? undefined,
            isIntegral: row.isIntegral ?? undefined
          });
          isbn13 = candidates[0]?.isbn13 ?? null;
          if (isbn13) resolvedViaSearch = true;
        }

        if (ctx.isCancelled?.()) break;

        if (!isbn13) {
          recordUnmatched(row, 'isbn_not_found', rowStartedAt);
          reportRowProgress(i + 1);
          continue;
        }

        let resolved = await this.ingestionService.resolveIsbns({
          rawIsbns: [isbn13],
          channel: 'import',
          action: targetStatus,
          userId: payload.userId,
          libraryId: payload.libraryId
        });

        if (ctx.isCancelled?.()) break;

        let item = resolved.results[0];

        // Si l'ISBN du fichier n'a rien donné mais qu'un titre/série est présent, tenter de trouver un autre ISBN-13 valide.
        if ((!item?.found || !item.book) && !resolvedViaSearch && (row.title || row.series)) {
          const candidates = await this.photoAiService.searchBookCandidates({
            title: searchTitleHint,
            series: searchSeriesHint,
            volumeNumber: row.volumeNumber ?? undefined,
            author: row.author ?? undefined,
            publisher: row.publisher ?? undefined,
            isIntegral: row.isIntegral ?? undefined
          });
          const altIsbn = candidates.find((c) => c.isbn13 && c.isbn13 !== isbn13)?.isbn13 ?? null;
          if (altIsbn) {
            resolved = await this.ingestionService.resolveIsbns({
              rawIsbns: [altIsbn],
              channel: 'import',
              action: targetStatus,
              userId: payload.userId,
              libraryId: payload.libraryId
            });
            item = resolved.results[0];
            if (item?.found && item.book) {
              resolvedViaSearch = true;
            }
          }
        }

        if (!item?.found || !item.book) {
          recordUnmatched(row, 'catalog_not_found', rowStartedAt);
          reportRowProgress(i + 1);
          continue;
        }

        // Application Couche 3 Foyer (Option 1A) : rôles créateurs, genre principal, sous-genres et intégrale issus du fichier priment pour le foyer
        const overridesPatch: LibraryBookOverrides = {};
        if (row.isIntegral === true || row.includedVolumes.length > 0) {
          overridesPatch.isIntegral = true;
          overridesPatch.includedVolumes = row.includedVolumes;
        }

        const rowScriptwriters = row.scriptwriters ?? [];
        const rowIllustrators = row.illustrators ?? [];
        const rowColorists = row.colorists ?? [];
        const hasDetailedRoles =
          rowScriptwriters.length > 0 || rowIllustrators.length > 0 || rowColorists.length > 0;
        if (rowScriptwriters.length > 0) overridesPatch.scriptwriters = rowScriptwriters;
        if (rowIllustrators.length > 0) overridesPatch.illustrators = rowIllustrators;
        if (rowColorists.length > 0) overridesPatch.colorists = rowColorists;

        if (hasDetailedRoles) {
          const mergedAuthors: string[] = [];
          const seenAuthorKeys = new Set<string>();
          const pushAuthor = (name: string) => {
            const k = normalizeTextKey(name);
            if (!k || seenAuthorKeys.has(k)) return;
            seenAuthorKeys.add(k);
            mergedAuthors.push(name);
          };
          for (const n of rowScriptwriters) pushAuthor(n);
          for (const n of rowIllustrators) pushAuthor(n);
          for (const n of rowColorists) pushAuthor(n);
          for (const n of item.book.authors) pushAuthor(n);
          if (mergedAuthors.length > 0) overridesPatch.authors = mergedAuthors;
        } else if (row.author && item.book.authors.length === 0) {
          const parsedFallbackAuthors = parseCreatorNames(row.author);
          if (parsedFallbackAuthors.length > 0) overridesPatch.authors = parsedFallbackAuthors;
        }

        const rowMainCat = row.mainCategory ?? null;
        const rowGenres = row.genres ?? [];
        if (rowMainCat) {
          overridesPatch.mainCategory = rowMainCat;
        }
        if (rowMainCat || rowGenres.length > 0) {
          const effectiveCat = rowMainCat ?? item.book.mainCategory;
          const oldMainCatKey = rowMainCat ? normalizeTextKey(item.book.mainCategory) : '';
          const mergedGenres: string[] = [];
          const seenGenreKeys = new Set<string>();
          const pushGenre = (g: string) => {
            const k = normalizeTextKey(g);
            if (!k || seenGenreKeys.has(k)) return;
            seenGenreKeys.add(k);
            mergedGenres.push(g);
          };
          pushGenre(effectiveCat);
          for (const g of item.book.genres) {
            if (oldMainCatKey && normalizeTextKey(g) === oldMainCatKey && normalizeTextKey(effectiveCat) !== oldMainCatKey) {
              continue;
            }
            pushGenre(g);
          }
          for (const g of rowGenres) pushGenre(g);
          overridesPatch.genres = mergedGenres;
        }

        let effectiveBook = item.book;
        if (Object.keys(overridesPatch).length > 0) {
          effectiveBook = this.libraryService.updateBookOverrides(
            payload.libraryId,
            payload.userId,
            item.book.id,
            overridesPatch
          );
        }

        result.importedCount++;
        if (resolvedViaSearch) result.resolvedBySearchCount++;
        else result.resolvedByIsbnCount++;

        const resolutionChannel: CollectionImportResolutionChannel = resolvedViaSearch
          ? 'search_to_isbn'
          : item.fromCache
            ? 'cache'
            : 'isbn_direct';

        result.items?.push({
          rowNumber: row.rowNumber,
          input: buildInputTrace(row),
          status: 'matched',
          resolutionChannel,
          unmatchedReason: null,
          durationMs: Math.max(0, Date.now() - rowStartedAt),
          resolvedBookId: effectiveBook.id,
          resolvedIsbn13: effectiveBook.primaryIsbn13 ?? item.isbn13 ?? isbn13,
          snapshot: {
            title: effectiveBook.title,
            seriesId: effectiveBook.seriesId,
            seriesName: effectiveBook.seriesName,
            volumeNumber: effectiveBook.volumeNumber,
            isIntegral: effectiveBook.isIntegral,
            includedVolumes: effectiveBook.includedVolumes,
            authors: effectiveBook.authors,
            publisher: effectiveBook.publisher,
            mainCategory: effectiveBook.mainCategory,
            coverUrl: effectiveBook.coverUrl
          }
        });

        // Restauration optionnelle de la lecture / note / notes personnelles (strictement user_id)
        const hasReadingData =
          (row.readingStatus !== null && row.readingStatus !== 'none') ||
          (row.rating !== null && row.rating > 0) ||
          (row.notes !== null && row.notes.length > 0);

        if (hasReadingData) {
          this.readingService.saveReadingState({
            userId: payload.userId,
            bookId: effectiveBook.id,
            status: row.readingStatus ?? 'none',
            rating: row.rating ?? 0,
            notes: row.notes ?? ''
          });
        }
      } catch {
        recordUnmatched(row, 'catalog_not_found', rowStartedAt);
      }

      reportRowProgress(i + 1);
    }

    return { result, total };
  }
}
