// src/server/services/collection-import.service.ts
// Service d'import utilisateur CSV / JSON / Excel (.xlsx) 100 % serveur.
// Règle stricte : l'ISBN-13 est le pivot unique de toute ingestion (zéro création sans ISBN).

import crypto from 'node:crypto';
import { readSheet } from 'read-excel-file/node';
import {
  parseCsvToMatrix,
  parseImportJson,
  parseImportRowsFromMatrix,
  type ImportedBookRow
} from '../../shared/bibliographic/collection-import.util';
import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import type { BackgroundJobView } from '../../shared/types/domain.types';
import { AppError } from '../middleware/error.middleware';
import type { BackgroundJobRow, JobRepository } from '../repositories/job.repo';
import { mapJobRowToView, type JobHandlerContext } from '../workers/background-worker';
import type { IngestionService } from './acquisition/ingestion.service';
import type { LibraryService } from './library.service';
import type { PhotoAiService } from './photo-ai.service';
import type { ReadingService } from './reading.service';

const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_ROWS = 1000;

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

  async parseUploadedFile(filename: string, contentBase64: string): Promise<ImportedBookRow[]> {
    const cleanBase64 =
      contentBase64.startsWith('data:') && contentBase64.includes(',')
        ? contentBase64.slice(contentBase64.indexOf(',') + 1)
        : contentBase64;

    const buffer = Buffer.from(cleanBase64, 'base64');
    if (buffer.byteLength === 0) {
      throw new AppError(400, 'IMPORT_EMPTY', 'Le fichier fourni est vide.');
    }
    if (buffer.byteLength > MAX_IMPORT_FILE_BYTES) {
      throw new AppError(400, 'IMPORT_TOO_LARGE', 'Fichier trop volumineux (maximum 5 Mo).');
    }

    const lower = filename.trim().toLowerCase();
    let rows: ImportedBookRow[] = [];

    if (lower.endsWith('.json')) {
      try {
        rows = parseImportJson(buffer.toString('utf8'));
      } catch {
        throw new AppError(400, 'IMPORT_INVALID_FILE', 'Fichier JSON invalide.');
      }
    } else if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
      const matrix = parseCsvToMatrix(buffer.toString('utf8'));
      rows = parseImportRowsFromMatrix(matrix);
    } else if (lower.endsWith('.xlsx')) {
      try {
        const sheetRows = await readSheet(buffer);
        const matrix = sheetRows.map((r) => r.map(excelCellToString));
        rows = parseImportRowsFromMatrix(matrix);
      } catch {
        throw new AppError(
          400,
          'IMPORT_INVALID_FILE',
          'Impossible de lire ce fichier Excel (.xlsx). Vérifiez qu’il est au format .xlsx valide.'
        );
      }
    } else {
      throw new AppError(
        400,
        'IMPORT_UNSUPPORTED_FORMAT',
        'Format non supporté. Utilisez un fichier CSV, JSON ou Excel (.xlsx).'
      );
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
  }): Promise<{ job: BackgroundJobView; totalRows: number; skippedCount: number }> {
    const parsedRows = await this.parseUploadedFile(input.filename, input.contentBase64);
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
      unmatched: []
    };

    const recordUnmatched = (row: ImportedBookRow, reason: 'isbn_not_found' | 'catalog_not_found') => {
      result.unmatched.push({
        rowNumber: row.rowNumber,
        isbn: row.isbn,
        title: row.title,
        series: row.series,
        author: row.author,
        reason
      });
      result.unmatchedCount = result.unmatched.length;
    };

    for (let i = 0; i < total; i++) {
      const row = rows[i];
      const targetStatus: 'owned' | 'wish' =
        row.ownershipStatus === 'wish' || row.ownershipStatus === 'owned'
          ? row.ownershipStatus
          : payload.defaultStatus;

      try {
        // Règle absolue : pivot ISBN-13 obligatoire (zéro création sans ISBN).
        let isbn13 = row.isbn ? isbnUtil.normalizeToIsbn13(row.isbn) : null;
        let resolvedViaSearch = false;

        if (!isbn13 && (row.title || row.series)) {
          const candidates = await this.photoAiService.searchBookCandidates({
            title: row.title ?? undefined,
            series: row.series ?? undefined,
            volumeNumber: row.volumeNumber ?? undefined,
            author: row.author ?? undefined,
            publisher: row.publisher ?? undefined
          });
          isbn13 = candidates[0]?.isbn13 ?? null;
          if (isbn13) resolvedViaSearch = true;
        }

        if (!isbn13) {
          recordUnmatched(row, 'isbn_not_found');
          ctx.reportProgress(i + 1, total, { ...result });
          continue;
        }

        let resolved = await this.ingestionService.resolveIsbns({
          rawIsbns: [isbn13],
          channel: 'import',
          action: targetStatus,
          userId: payload.userId,
          libraryId: payload.libraryId
        });

        let item = resolved.results[0];

        // Si l'ISBN du fichier n'a rien donné mais qu'un titre/série est présent, tenter de trouver un autre ISBN-13 valide.
        if ((!item?.found || !item.book) && !resolvedViaSearch && (row.title || row.series)) {
          const candidates = await this.photoAiService.searchBookCandidates({
            title: row.title ?? undefined,
            series: row.series ?? undefined,
            volumeNumber: row.volumeNumber ?? undefined,
            author: row.author ?? undefined,
            publisher: row.publisher ?? undefined
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
          recordUnmatched(row, 'catalog_not_found');
          ctx.reportProgress(i + 1, total, { ...result });
          continue;
        }

        result.importedCount++;
        if (resolvedViaSearch) result.resolvedBySearchCount++;
        else result.resolvedByIsbnCount++;

        // Restauration optionnelle des métadonnées intégrale en Couche 3
        if (row.isIntegral === true || row.includedVolumes.length > 0) {
          this.libraryService.updateBookOverrides(payload.libraryId, payload.userId, item.book.id, {
            isIntegral: true,
            includedVolumes: row.includedVolumes
          });
        }

        // Restauration optionnelle de la lecture / note / notes personnelles (strictement user_id)
        const hasReadingData =
          (row.readingStatus !== null && row.readingStatus !== 'none') ||
          (row.rating !== null && row.rating > 0) ||
          (row.notes !== null && row.notes.length > 0);

        if (hasReadingData) {
          this.readingService.saveReadingState({
            userId: payload.userId,
            bookId: item.book.id,
            status: row.readingStatus ?? 'none',
            rating: row.rating ?? 0,
            notes: row.notes ?? ''
          });
        }
      } catch {
        recordUnmatched(row, 'catalog_not_found');
      }

      ctx.reportProgress(i + 1, total, { ...result });
    }

    return { result, total };
  }
}
