// src/server/services/admin.service.ts
// Service Console Administration (`/admin` uniquement) : Catalogue Maître Couche 2 (locked_fields), Comptes, Quotas, Maintenance & Logs.
// Zéro SQL brut : délègue 100 % des requêtes à AdminRepository / CatalogRepository / UserRepository / LogRepository.

import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  alignGroundTruthToItems,
  buildBenchmarkGradedReport,
  buildSeriesAuditEntries,
  evaluateBenchmarkItemAgainstGroundTruth,
  generateBenchmarkMarkdownReport,
  generateBenchmarkSeriesStandaloneMarkdown,
  parseGroundTruthCsv,
  type RawSeriesAuditInput
} from '../../shared/bibliographic/benchmark-grading.util';
import {
  isCompatibleSeriesName,
  isGenericVolumeTitle,
  matchesAuthorName,
  normalizeSeriesNumber,
  normalizeTextKey,
  tokenOverlapRatio
} from '../../shared/bibliographic/text-normalize.util';
import type {
  AdminBenchmarkGradedReport,
  AdminBenchmarkJobView,
  AdminBenchmarkLiveBookState,
  AdminBenchmarkLiveItem,
  BenchmarkGradedActualState,
  BenchmarkVerdict,
  BenchmarkWarningCode,
  BookMainCategory,
  CollectionImportComparisonItem,
  CollectionImportComparisonSnapshot,
  GroundTruthRow,
  LibraryBookOverrides
} from '../../shared/types/domain.types';
import type { DatabaseAdapter } from '../db/database.adapter';
import { AppError } from '../middleware/error.middleware';
import type { AdminRepository } from '../repositories/admin.repo';
import type { CatalogRepository } from '../repositories/catalog.repo';
import type { LibraryRepository } from '../repositories/library.repo';
import type { LogRepository } from '../repositories/log.repo';
import type { ReadingRepository } from '../repositories/reading.repo';
import type { UserRepository } from '../repositories/user.repo';
import type { CollectionImportResultPayload } from './collection-import.service';
import type { CoverService } from './cover.service';
import type { CronScheduler } from '../workers/cron-scheduler';

const SAFE_JOB_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;
const MAX_GROUND_TRUTH_BYTES = 10 * 1024 * 1024;

interface StoredGroundTruthFile {
  filename: string;
  uploadedAt: string;
  rows: GroundTruthRow[];
}

export interface AdminCatalogBookItem {
  id: string;
  title: string;
  seriesId: string | null;
  seriesName: string | null;
  volumeNumber: number | null;
  authors: string[];
  publisher: string | null;
  publishYear: string | null;
  mainCategory: BookMainCategory;
  subgenres: string[];
  coverKey: string | null;
  coverUrl: string | null;
  lockedFields: string[];
  primaryIsbn13: string | null;
  updatedAt: string;
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

export class AdminService {
  private readonly db: DatabaseAdapter;
  private readonly adminRepo: AdminRepository;
  private readonly catalogRepo: CatalogRepository;
  private readonly libraryRepo?: LibraryRepository;
  private readonly readingRepo?: ReadingRepository;
  private readonly userRepo: UserRepository;
  private readonly logRepo: LogRepository;
  private readonly coverService: CoverService;
  private readonly cronScheduler: CronScheduler;
  private readonly reportsDir: string;
  private readonly onCatalogReset?: () => void;

  constructor(deps: {
    db: DatabaseAdapter;
    adminRepo: AdminRepository;
    catalogRepo: CatalogRepository;
    libraryRepo?: LibraryRepository;
    readingRepo?: ReadingRepository;
    userRepo: UserRepository;
    logRepo: LogRepository;
    coverService: CoverService;
    cronScheduler: CronScheduler;
    reportsDir?: string;
    onCatalogReset?: () => void;
  }) {
    this.db = deps.db;
    this.adminRepo = deps.adminRepo;
    this.catalogRepo = deps.catalogRepo;
    this.libraryRepo = deps.libraryRepo;
    this.readingRepo = deps.readingRepo;
    this.userRepo = deps.userRepo;
    this.logRepo = deps.logRepo;
    this.coverService = deps.coverService;
    this.cronScheduler = deps.cronScheduler;
    this.reportsDir = path.resolve(deps.reportsDir ?? path.join(process.cwd(), 'data', 'benchmark-reports'));
    this.onCatalogReset = deps.onCatalogReset;
  }

  getOverview() {
    return this.adminRepo.getOverviewCounts();
  }

  listCatalog(input: {
    search?: string;
    filter?: 'all' | 'no_cover' | 'no_series';
    category?: string;
    page?: number;
    pageSize?: number;
  }): { total: number; page: number; pageSize: number; items: AdminCatalogBookItem[] } {
    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.min(60, Math.max(12, input.pageSize ?? 24));
    const offset = (page - 1) * pageSize;

    const searchRaw = input.search?.trim() || undefined;
    const searchNormalized = searchRaw ? normalizeTextKey(searchRaw) : undefined;

    const { total, rows } = this.adminRepo.listCatalogBooks({
      searchNormalized,
      searchRaw,
      filter: input.filter,
      category: input.category?.trim() || undefined,
      limit: pageSize,
      offset
    });

    const items: AdminCatalogBookItem[] = rows.map((r) => {
      const editions = this.catalogRepo.listEditionsByBookId(r.id);
      return {
        id: r.id,
        title: r.title,
        seriesId: r.series_id,
        seriesName: r.series_name,
        volumeNumber: r.volume_number,
        authors: parseJsonArray(r.authors_json),
        publisher: r.publisher,
        publishYear: r.publish_year,
        mainCategory: r.main_category,
        subgenres: parseJsonArray(r.subgenres_json),
        coverKey: r.cover_key,
        coverUrl: r.cover_key ? `/api/covers/${r.cover_key}` : null,
        lockedFields: parseJsonArray(r.locked_fields_json),
        primaryIsbn13: editions[0]?.isbn13 ?? null,
        updatedAt: r.updated_at
      };
    });

    return { total, page, pageSize, items };
  }

  /**
   * Mise à jour Couche 2 Admin (unitaire ou par lot) :
   * Modifie le Catalogue Maître ET inscrit automatiquement chaque champ édité dans `locked_fields_json`
   * afin qu'aucun robot (Couche 1) ne puisse jamais l'écraser.
   */
  updateCatalogBulk(input: {
    bookIds: string[];
    patch: {
      title?: string;
      authors?: string[];
      seriesName?: string | null;
      volumeNumber?: number | null;
      publisher?: string | null;
      publishYear?: string | null;
      mainCategory?: BookMainCategory;
      subgenres?: string[];
      coverKey?: string | null;
    };
  }): { updatedCount: number; lockedFieldsAdded: string[] } {
    const now = new Date().toISOString();
    const { patch } = input;
    const lockedToAdd: string[] = [];

    let resolvedSeriesId: string | null | undefined = undefined;
    if (patch.seriesName !== undefined) {
      lockedToAdd.push('seriesId');
      if (patch.seriesName === null || !patch.seriesName.trim()) {
        resolvedSeriesId = null;
      } else {
        const norm = normalizeTextKey(patch.seriesName);
        const existing = this.catalogRepo.findSeriesByKeyAndSignature(norm, '');
        if (existing) {
          resolvedSeriesId = existing.id;
        } else {
          const created = this.catalogRepo.createSeries({
            id: `ser_${crypto.randomBytes(6).toString('hex')}`,
            franchiseId: null,
            canonicalName: patch.seriesName.trim(),
            normalizedKey: norm,
            editionSignature: '',
            aliases: [],
            primaryAuthors: patch.authors ?? [],
            wikidataQid: null,
            bnfEnsembleIds: [],
            now
          });
          resolvedSeriesId = created.id;
        }
      }
    }

    if (patch.title !== undefined) lockedToAdd.push('title');
    if (patch.authors !== undefined) lockedToAdd.push('authors');
    if (patch.volumeNumber !== undefined) lockedToAdd.push('volumeNumber', 'volumeLabel', 'sortOrder');
    if (patch.publisher !== undefined) lockedToAdd.push('publisher');
    if (patch.publishYear !== undefined) lockedToAdd.push('publishYear');
    if (patch.mainCategory !== undefined) lockedToAdd.push('mainCategory');
    if (patch.subgenres !== undefined) lockedToAdd.push('subgenres');
    if (patch.coverKey !== undefined) lockedToAdd.push('coverKey');

    let updatedCount = 0;

    this.db.transaction(() => {
      for (const bookId of input.bookIds) {
        const existing = this.catalogRepo.findBookById(bookId);
        if (!existing) continue;

        const mergedLocked = Array.from(new Set([...parseJsonArray(existing.locked_fields_json), ...lockedToAdd]));

        this.adminRepo.updateCatalogBookLocked(bookId, {
          title: patch.title !== undefined ? patch.title.trim() : undefined,
          normalizedTitle: patch.title !== undefined ? normalizeTextKey(patch.title) : undefined,
          authorsJson: patch.authors !== undefined ? JSON.stringify(patch.authors) : undefined,
          seriesId: resolvedSeriesId,
          volumeNumber: patch.volumeNumber,
          volumeLabel: patch.volumeNumber !== undefined && patch.volumeNumber !== null ? String(patch.volumeNumber) : null,
          sortOrder: patch.volumeNumber,
          publisher: patch.publisher,
          publishYear: patch.publishYear,
          mainCategory: patch.mainCategory,
          subgenresJson: patch.subgenres !== undefined ? JSON.stringify(patch.subgenres) : undefined,
          coverKey: patch.coverKey,
          lockedFieldsJson: JSON.stringify(mergedLocked),
          updatedAt: now
        });
        updatedCount++;
      }
    });

    return { updatedCount, lockedFieldsAdded: lockedToAdd };
  }

  listUsers() {
    const monthKey = new Date().toISOString().slice(0, 7);
    return this.adminRepo.listUsersWithLibraryAndAi().map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      isAdmin: u.is_admin === 1,
      createdAt: u.created_at,
      libraryName: u.library_name,
      aiMonthUsed: u.month_key === monthKey ? Number(u.month_used ?? 0) : 0,
      aiTotalUsed: Number(u.total_used ?? 0)
    }));
  }

  resetUserAiQuota(userId: string): void {
    const monthKey = new Date().toISOString().slice(0, 7);
    this.userRepo.resetAiUsage(userId, monthKey, new Date().toISOString());
  }

  listLogs(input: { stage?: string; status?: string; query?: string; limit?: number }) {
    const limit = Math.min(300, Math.max(10, input.limit ?? 100));
    return this.adminRepo.listPipelineLogs({
      stage: input.stage?.trim() || undefined,
      status: input.status?.trim() || undefined,
      query: input.query?.trim() || undefined,
      limit
    });
  }

  purgeLogs(days = 30): { purgedCount: number } {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return { purgedCount: this.logRepo.purgeOlderThan(cutoff) };
  }

  async runMaintenanceTask(
    task: 'release_sweep' | 'sister_editions' | 'purge_orphan_covers' | 'purge_logs'
  ): Promise<unknown> {
    if (task === 'release_sweep') {
      return this.cronScheduler.runNightlyPass(new Date(), { force: true });
    }
    if (task === 'purge_orphan_covers') {
      return this.coverService.purgeOrphanCovers(30);
    }
    if (task === 'purge_logs') {
      return this.purgeLogs(30);
    }
    // sister_editions : rapport synthétique d'état des éditions sœurs
    return { editionsIndexed: this.adminRepo.countEditions() };
  }

  /**
   * Calcule automatiquement les anomalies probables entre l'entrée CSV de test et l'état résolu (live ou snapshot).
   */
  private computeBenchmarkWarnings(
    item: CollectionImportComparisonItem,
    effective: CollectionImportComparisonSnapshot | null
  ): BenchmarkWarningCode[] {
    if (item.status === 'unmatched' || !effective) return [];

    const warnings: BenchmarkWarningCode[] = [];
    const { input } = item;

    if (!effective.coverUrl) {
      warnings.push('missing_cover');
    }

    if (input.volumeNumber) {
      const normalizedExpected = normalizeSeriesNumber(input.volumeNumber);
      const parsedExpected = /^\d+$/.test(normalizedExpected) ? parseInt(normalizedExpected, 10) : null;
      if (parsedExpected !== null) {
        const coveredByIntegral =
          effective.isIntegral && effective.includedVolumes.includes(String(parsedExpected));
        if (!coveredByIntegral && (effective.volumeNumber === null || effective.volumeNumber !== parsedExpected)) {
          warnings.push('volume_mismatch');
        }
      }
    }

    if (input.series) {
      if (!effective.seriesName || !isCompatibleSeriesName(effective.seriesName, input.series)) {
        warnings.push('series_mismatch');
      }
    }

    if (input.title) {
      const refSeries = input.series || effective.seriesName || '';
      const inputIsGenericOrSeriesOnly =
        isGenericVolumeTitle(input.title, refSeries) ||
        (Boolean(effective.seriesName) && isCompatibleSeriesName(input.title, effective.seriesName!));

      if (!inputIsGenericOrSeriesOnly) {
        const fullOut = [effective.seriesName, effective.title].filter(Boolean).join(' ');
        const normIn = normalizeTextKey(input.title);
        const normOut = normalizeTextKey(effective.title);
        const directSubstr =
          normIn.length >= 4 &&
          normOut.length >= 4 &&
          (normOut.includes(normIn) || normIn.includes(normOut));
        const overlap = Math.max(
          tokenOverlapRatio(input.title, effective.title),
          tokenOverlapRatio(effective.title, input.title),
          tokenOverlapRatio(input.title, fullOut)
        );
        if (!directSubstr && overlap < 0.45) {
          warnings.push('title_mismatch');
        }
      }
    }

    if (input.author) {
      const hasMatch = effective.authors.some((a) => matchesAuthorName(a, input.author!));
      if (!hasMatch) {
        warnings.push('author_mismatch');
      }
    }

    if (input.isIntegral !== null && input.isIntegral !== effective.isIntegral) {
      warnings.push('integral_mismatch');
    }

    return warnings;
  }

  /**
   * Retourne l'historique des imports CSV/JSON/XLSX enrichis en direct avec l'état courant du Catalogue Central
   * (couvertures WebP arrivées en différé, déploiement de séries, éditions) + détection automatique d'anomalies.
   */
  listImportBenchmarks(limit = 15): { activeCatalogJobsCount: number; jobs: AdminBenchmarkJobView[] } {
    const safeLimit = Math.min(30, Math.max(1, limit));
    const jobRows = this.adminRepo.listCollectionImportJobs(safeLimit);
    const activeCatalogJobsCount = this.adminRepo.countActiveSeriesBackgroundJobs();

    const jobs: AdminBenchmarkJobView[] = jobRows.map((row) => {
      let parsedResult: CollectionImportResultPayload | null = null;
      let parsedPayload: { filename?: string; rows?: unknown[] } | null = null;
      try {
        if (row.result_json) parsedResult = JSON.parse(row.result_json) as CollectionImportResultPayload;
      } catch {
        parsedResult = null;
      }
      try {
        if (row.payload_json) parsedPayload = JSON.parse(row.payload_json) as { filename?: string; rows?: unknown[] };
      } catch {
        parsedPayload = null;
      }

      const rawItems: CollectionImportComparisonItem[] = Array.isArray(parsedResult?.items)
        ? parsedResult.items
        : [];

      let okCount = 0;
      let warningCount = 0;
      let unmatchedCount = 0;
      let missingCoverCount = 0;
      let totalDurationMs = 0;

      const enrichedItems: AdminBenchmarkLiveItem[] = rawItems.map((item) => {
        totalDurationMs += Number(item.durationMs ?? 0);
        let live: AdminBenchmarkLiveBookState | null = null;

        if (item.resolvedBookId) {
          const bookRow = this.catalogRepo.findBookById(item.resolvedBookId);
          if (bookRow) {
            const seriesRow = bookRow.series_id ? this.catalogRepo.findSeriesById(bookRow.series_id) : null;
            const editions = this.catalogRepo.listEditionsByBookId(bookRow.id);
            live = {
              title: bookRow.title,
              seriesId: bookRow.series_id,
              seriesName: seriesRow?.canonical_name ?? null,
              seriesTotalVolumes: seriesRow?.known_volumes_count ?? 0,
              seriesExpanded: seriesRow?.is_complete_expanded === 1,
              volumeNumber: bookRow.volume_number,
              isIntegral: bookRow.is_integral === 1,
              includedVolumes: parseJsonArray(bookRow.included_volumes_json),
              authors: parseJsonArray(bookRow.authors_json),
              publisher: bookRow.publisher,
              mainCategory: bookRow.main_category,
              coverUrl: bookRow.cover_key ? `/api/covers/${bookRow.cover_key}` : null,
              editionsCount: editions.length
            };
          }
        }

        const effective: CollectionImportComparisonSnapshot | null = live ?? item.snapshot;
        const warnings = this.computeBenchmarkWarnings(item, effective);
        const verdict: BenchmarkVerdict =
          item.status === 'unmatched' ? 'failed' : warnings.length > 0 ? 'warning' : 'ok';

        if (verdict === 'failed') unmatchedCount++;
        else if (verdict === 'warning') warningCount++;
        else okCount++;

        if (item.status === 'matched' && warnings.includes('missing_cover')) {
          missingCoverCount++;
        }

        return {
          ...item,
          live,
          warnings,
          verdict
        };
      });

      const totalRows =
        parsedResult?.totalRows ??
        row.progress_total ??
        (Array.isArray(parsedPayload?.rows) ? parsedPayload.rows.length : 0);
      const matchedCount = okCount + warningCount;
      const processedRows = enrichedItems.length > 0 ? enrichedItems.length : row.progress_done;
      const gtMeta = this.readGroundTruthMetaSync(row.id);

      return {
        id: row.id,
        filename: parsedResult?.filename || parsedPayload?.filename || 'import',
        status: row.status,
        progressDone: row.progress_done,
        progressTotal: row.progress_total || totalRows,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        summary: {
          totalRows,
          processedRows,
          matchedCount: enrichedItems.length > 0 ? matchedCount : (parsedResult?.importedCount ?? 0),
          okCount,
          warningCount,
          unmatchedCount: enrichedItems.length > 0 ? unmatchedCount : (parsedResult?.unmatchedCount ?? 0),
          missingCoverCount,
          resolvedByIsbnCount: parsedResult?.resolvedByIsbnCount ?? 0,
          resolvedBySearchCount: parsedResult?.resolvedBySearchCount ?? 0,
          avgDurationMs: enrichedItems.length > 0 ? Math.round(totalDurationMs / enrichedItems.length) : 0
        },
        items: enrichedItems,
        hasGroundTruth: gtMeta.hasGroundTruth,
        groundTruthFilename: gtMeta.groundTruthFilename,
        latestReportFilename: gtMeta.latestReportFilename
      };
    });

    return { activeCatalogJobsCount, jobs };
  }

  private assertSafeJobId(jobId: string): string {
    if (!SAFE_JOB_ID_RE.test(jobId)) {
      throw new AppError(400, 'INVALID_JOB_ID', 'Identifiant de lot invalide.');
    }
    return jobId;
  }

  private getGroundTruthPath(jobId: string): string {
    return path.join(this.reportsDir, `ground-truth-${this.assertSafeJobId(jobId)}.json`);
  }

  private getLatestReportPath(jobId: string): string {
    return path.join(this.reportsDir, `report-${this.assertSafeJobId(jobId)}.md`);
  }

  private getLatestSeriesReportPath(jobId: string): string {
    return path.join(this.reportsDir, `series-${this.assertSafeJobId(jobId)}.md`);
  }

  private getPendingGroundTruthPath(): string {
    return path.join(this.reportsDir, 'pending-ground-truth.json');
  }

  async savePendingGroundTruth(input: {
    filename: string;
    contentBase64: string;
  }): Promise<{ filename: string; rowCount: number; uploadedAt: string }> {
    const cleanBase64 =
      input.contentBase64.startsWith('data:') && input.contentBase64.includes(',')
        ? input.contentBase64.slice(input.contentBase64.indexOf(',') + 1)
        : input.contentBase64;
    const buf = Buffer.from(cleanBase64, 'base64');
    if (buf.byteLength === 0) {
      throw new AppError(400, 'GROUND_TRUTH_EMPTY', 'Le fichier de correction est vide.');
    }
    if (buf.byteLength > MAX_GROUND_TRUTH_BYTES) {
      throw new AppError(400, 'GROUND_TRUTH_TOO_LARGE', 'Fichier de correction trop volumineux (max 10 Mo).');
    }
    const rows = parseGroundTruthCsv(buf.toString('utf8'));
    if (rows.length === 0) {
      throw new AppError(
        400,
        'GROUND_TRUTH_INVALID',
        'Aucune ligne exploitable détectée dans le CSV de correction (colonnes attendues : Ligne, Titre_Attendu, Serie_Attendue...).'
      );
    }
    const stored: StoredGroundTruthFile = {
      filename: input.filename.trim() || 'correction.csv',
      uploadedAt: new Date().toISOString(),
      rows
    };
    await fs.mkdir(this.reportsDir, { recursive: true });
    await fs.writeFile(this.getPendingGroundTruthPath(), JSON.stringify(stored), 'utf8');
    return { filename: stored.filename, rowCount: rows.length, uploadedAt: stored.uploadedAt };
  }

  getPendingGroundTruthMeta(): { filename: string; rowCount: number; uploadedAt: string } | null {
    const p = this.getPendingGroundTruthPath();
    try {
      if (!fsSync.existsSync(p)) return null;
      const parsed = JSON.parse(fsSync.readFileSync(p, 'utf8')) as Partial<StoredGroundTruthFile>;
      if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) return null;
      return {
        filename: typeof parsed.filename === 'string' ? parsed.filename : 'correction.csv',
        rowCount: parsed.rows.length,
        uploadedAt: typeof parsed.uploadedAt === 'string' ? parsed.uploadedAt : new Date().toISOString()
      };
    } catch {
      return null;
    }
  }

  async clearPendingGroundTruth(): Promise<void> {
    await fs.rm(this.getPendingGroundTruthPath(), { force: true }).catch(() => undefined);
  }

  /**
   * Si un CSV de correction a été préchargé sur le serveur avant/pendant l'import,
   * exécute automatiquement la notation complète dès la fin du job (même si le navigateur est fermé).
   */
  async autoGradeWithPendingGroundTruth(jobId: string): Promise<boolean> {
    const pendingPath = this.getPendingGroundTruthPath();
    if (!fsSync.existsSync(pendingPath)) return false;
    try {
      const raw = await fs.readFile(pendingPath, 'utf8');
      const storedGt = JSON.parse(raw) as StoredGroundTruthFile;
      if (!storedGt || !Array.isArray(storedGt.rows) || storedGt.rows.length === 0) {
        return false;
      }
      const { report, markdown, seriesMarkdown } = this.computeLiveGradedReport(jobId, storedGt);
      await fs.mkdir(this.reportsDir, { recursive: true });
      await fs.writeFile(this.getGroundTruthPath(jobId), JSON.stringify(storedGt), 'utf8');
      await this.persistReportAndLog(jobId, report, markdown, seriesMarkdown);
      await fs.rm(pendingPath, { force: true }).catch(() => undefined);
      return true;
    } catch (err) {
      console.warn(`[benchmark_report] Auto-notation différée impossible pour ${jobId}:`, err);
      return false;
    }
  }

  private readGroundTruthMetaSync(jobId: string): {
    hasGroundTruth: boolean;
    groundTruthFilename: string | null;
    latestReportFilename: string | null;
  } {
    if (!SAFE_JOB_ID_RE.test(jobId)) {
      return { hasGroundTruth: false, groundTruthFilename: null, latestReportFilename: null };
    }
    const gtPath = path.join(this.reportsDir, `ground-truth-${jobId}.json`);
    const repFilename = `report-${jobId}.md`;
    const repPath = path.join(this.reportsDir, repFilename);
    let groundTruthFilename: string | null = null;
    let hasGroundTruth = false;
    try {
      if (fsSync.existsSync(gtPath)) {
        const parsed = JSON.parse(fsSync.readFileSync(gtPath, 'utf8')) as Partial<StoredGroundTruthFile>;
        if (Array.isArray(parsed.rows) && parsed.rows.length > 0) {
          hasGroundTruth = true;
          groundTruthFilename = typeof parsed.filename === 'string' ? parsed.filename : null;
        }
      }
    } catch {
      hasGroundTruth = false;
    }
    const latestReportFilename = fsSync.existsSync(repPath) ? repFilename : null;
    return { hasGroundTruth, groundTruthFilename, latestReportFilename };
  }

  private buildActualStateForItem(
    item: CollectionImportComparisonItem,
    userId: string | null,
    libraryId: string | null
  ): BenchmarkGradedActualState {
    if (item.status === 'unmatched' || !item.resolvedBookId) {
      return {
        resolved: false,
        bookId: null,
        primaryIsbn13: null,
        knownIsbns: [],
        title: null,
        seriesId: null,
        seriesName: null,
        seriesTotalVolumes: 0,
        seriesExpanded: false,
        volumeNumber: null,
        authors: [],
        publisher: null,
        allPublishers: [],
        collectionName: null,
        mainCategory: null,
        catalogIsIntegral: false,
        effectiveIsIntegral: false,
        effectiveIncludedVolumes: [],
        coverUrl: null,
        ownershipStatus: null,
        readingStatus: null,
        rating: null,
        notes: null,
        resolutionChannel: item.resolutionChannel,
        unmatchedReason: item.unmatchedReason,
        durationMs: item.durationMs
      };
    }

    const bookRow = this.catalogRepo.findBookById(item.resolvedBookId);
    const seriesRow = bookRow?.series_id ? this.catalogRepo.findSeriesById(bookRow.series_id) : null;
    const editions = bookRow ? this.catalogRepo.listEditionsByBookId(bookRow.id) : [];
    const libRow = bookRow && libraryId && this.libraryRepo ? this.libraryRepo.findLibraryBook(libraryId, bookRow.id) : null;
    const readRow = bookRow && userId && this.readingRepo ? this.readingRepo.findByUserAndBook(userId, bookRow.id) : null;

    let overrides: LibraryBookOverrides = {};
    if (libRow?.overrides_json) {
      try {
        const parsed = JSON.parse(libRow.overrides_json);
        if (parsed && typeof parsed === 'object') overrides = parsed as LibraryBookOverrides;
      } catch {
        overrides = {};
      }
    }

    const catalogAuthors = bookRow
      ? Array.from(
          new Set([
            ...parseJsonArray(bookRow.authors_json),
            ...parseJsonArray(bookRow.scriptwriters_json),
            ...parseJsonArray(bookRow.illustrators_json)
          ])
        )
      : item.snapshot?.authors ?? [];

    const catalogIsIntegral = bookRow ? bookRow.is_integral === 1 : Boolean(item.snapshot?.isIntegral);
    const effectiveIsIntegral =
      typeof overrides.isIntegral === 'boolean' ? overrides.isIntegral : catalogIsIntegral;

    const catalogIncluded = bookRow
      ? parseJsonArray(bookRow.included_volumes_json)
      : item.snapshot?.includedVolumes ?? [];
    const effectiveIncludedVolumes =
      Array.isArray(overrides.includedVolumes) && overrides.includedVolumes.length > 0
        ? overrides.includedVolumes
        : catalogIncluded;

    const knownIsbns = Array.from(
      new Set([
        ...(item.resolvedIsbn13 ? [item.resolvedIsbn13] : []),
        ...editions.map((e) => e.isbn13)
      ])
    );
    const allPublishers = Array.from(
      new Set(
        [
          bookRow?.publisher ?? item.snapshot?.publisher ?? null,
          ...editions.map((e) => e.publisher)
        ].filter((p): p is string => Boolean(p && p.trim()))
      )
    );

    const coverKey = overrides.coverKey !== undefined ? overrides.coverKey : bookRow?.cover_key ?? null;
    const coverUrl = coverKey ? `/api/covers/${coverKey}` : item.snapshot?.coverUrl ?? null;

    return {
      resolved: true,
      bookId: bookRow?.id ?? item.resolvedBookId,
      primaryIsbn13: editions[0]?.isbn13 ?? item.resolvedIsbn13,
      knownIsbns,
      title: bookRow?.title ?? item.snapshot?.title ?? null,
      seriesId: bookRow?.series_id ?? item.snapshot?.seriesId ?? null,
      seriesName: seriesRow?.canonical_name ?? item.snapshot?.seriesName ?? null,
      seriesTotalVolumes: seriesRow?.known_volumes_count ?? 0,
      seriesExpanded: seriesRow?.is_complete_expanded === 1,
      volumeNumber: bookRow ? bookRow.volume_number : (item.snapshot?.volumeNumber ?? null),
      authors: catalogAuthors,
      publisher: bookRow?.publisher ?? item.snapshot?.publisher ?? null,
      allPublishers,
      collectionName: bookRow?.collection_name ?? null,
      mainCategory: bookRow?.main_category ?? item.snapshot?.mainCategory ?? null,
      catalogIsIntegral,
      effectiveIsIntegral,
      effectiveIncludedVolumes,
      coverUrl,
      ownershipStatus: libRow ? libRow.status : null,
      readingStatus: readRow ? readRow.status : 'none',
      rating: readRow ? readRow.rating : 0,
      notes: readRow ? readRow.notes : '',
      resolutionChannel: item.resolutionChannel,
      unmatchedReason: item.unmatchedReason,
      durationMs: item.durationMs
    };
  }

  private collectLiveSeriesAudit(
    gradedItems: Array<{ dataLineNumber: number; actual: BenchmarkGradedActualState }>
  ) {
    const rowsBySeriesId = new Map<string, number[]>();
    for (const it of gradedItems) {
      if (!it.actual.seriesId) continue;
      const list = rowsBySeriesId.get(it.actual.seriesId) ?? [];
      list.push(it.dataLineNumber);
      rowsBySeriesId.set(it.actual.seriesId, list);
    }

    // Inclut aussi les séries sœurs partageant la même franchise afin de repérer immédiatement une fragmentation
    const allSeriesIds = new Set<string>(rowsBySeriesId.keys());
    const franchiseCache = new Map<string, string>();
    for (const sId of Array.from(allSeriesIds)) {
      const sRow = this.catalogRepo.findSeriesById(sId);
      if (!sRow?.franchise_id) continue;
      const fRow = this.catalogRepo.findFranchiseById(sRow.franchise_id);
      if (fRow) franchiseCache.set(fRow.id, fRow.canonical_name);
      for (const sibling of this.catalogRepo.findSeriesByFranchiseId(sRow.franchise_id)) {
        allSeriesIds.add(sibling.id);
      }
    }

    const rawInputs: RawSeriesAuditInput[] = [];
    for (const sId of allSeriesIds) {
      const sRow = this.catalogRepo.findSeriesById(sId);
      if (!sRow) continue;
      let franchiseName: string | null = null;
      if (sRow.franchise_id) {
        franchiseName =
          franchiseCache.get(sRow.franchise_id) ??
          this.catalogRepo.findFranchiseById(sRow.franchise_id)?.canonical_name ??
          null;
      }

      const books = this.catalogRepo.listBooksBySeriesId(sId);
      rawInputs.push({
        seriesId: sRow.id,
        canonicalName: sRow.canonical_name,
        editionSignature: sRow.edition_signature || null,
        franchiseName,
        wikidataQid: sRow.wikidata_qid,
        isCompleteExpanded: sRow.is_complete_expanded === 1,
        sourceRowNumbers: rowsBySeriesId.get(sId) ?? [],
        volumes: books.map((b) => {
          const editions = this.catalogRepo.listEditionsByBookId(b.id);
          return {
            bookId: b.id,
            title: b.title,
            volumeNumber: b.volume_number,
            volumeLabel: b.volume_label,
            sortOrder: b.sort_order,
            isHorsSerie: b.is_hors_serie === 1,
            isIntegral: b.is_integral === 1,
            includedVolumes: parseJsonArray(b.included_volumes_json),
            primaryIsbn13: editions[0]?.isbn13 ?? null,
            publisher: b.publisher,
            mainCategory: b.main_category,
            hasCover: Boolean(b.cover_key),
            authors: parseJsonArray(b.authors_json)
          };
        })
      });
    }

    return buildSeriesAuditEntries(rawInputs);
  }

  private computeLiveGradedReport(
    jobId: string,
    storedGt: StoredGroundTruthFile
  ): { report: AdminBenchmarkGradedReport; markdown: string; seriesMarkdown: string } {
    const jobRow = this.adminRepo.findCollectionImportJobById(jobId);
    if (!jobRow) {
      throw new AppError(404, 'BENCHMARK_JOB_NOT_FOUND', 'Lot d’import introuvable.');
    }

    let parsedResult: CollectionImportResultPayload | null = null;
    let parsedPayload: { filename?: string; userId?: string; libraryId?: string } | null = null;
    try {
      if (jobRow.result_json) parsedResult = JSON.parse(jobRow.result_json) as CollectionImportResultPayload;
    } catch {
      parsedResult = null;
    }
    try {
      if (jobRow.payload_json) {
        parsedPayload = JSON.parse(jobRow.payload_json) as { filename?: string; userId?: string; libraryId?: string };
      }
    } catch {
      parsedPayload = null;
    }

    const rawItems: CollectionImportComparisonItem[] = Array.isArray(parsedResult?.items)
      ? parsedResult.items
      : [];
    if (rawItems.length === 0) {
      throw new AppError(
        400,
        'BENCHMARK_NO_ITEMS',
        'Ce lot d’import ne contient pas encore de lignes traitées à comparer.'
      );
    }

    const inputFilename = parsedResult?.filename || parsedPayload?.filename || 'import.csv';
    const userId = jobRow.user_id ?? parsedPayload?.userId ?? null;
    const libraryId = jobRow.library_id ?? parsedPayload?.libraryId ?? null;
    const activeCatalogJobsCount = this.adminRepo.countActiveSeriesBackgroundJobs();

    const { alignmentMode, pairs, unalignedCount } = alignGroundTruthToItems(
      inputFilename,
      rawItems,
      storedGt.rows
    );
    if (pairs.length === 0) {
      throw new AppError(
        400,
        'BENCHMARK_ALIGNMENT_EMPTY',
        'Aucune ligne du CSV de correction n’a pu être alignée avec ce lot d’import.'
      );
    }

    const gradedItems = pairs.map(({ item, dataLineNumber, expected }) =>
      evaluateBenchmarkItemAgainstGroundTruth({
        item,
        dataLineNumber,
        expected,
        actual: this.buildActualStateForItem(item, userId, libraryId)
      })
    );

    const seriesAudit = this.collectLiveSeriesAudit(gradedItems);

    const report = buildBenchmarkGradedReport({
      jobId,
      inputFilename,
      groundTruthFilename: storedGt.filename,
      alignmentMode,
      activeCatalogJobsCount,
      unalignedRows: unalignedCount,
      items: gradedItems,
      seriesAudit
    });
    const markdown = generateBenchmarkMarkdownReport(report);
    const seriesMarkdown = generateBenchmarkSeriesStandaloneMarkdown(report);
    return { report, markdown, seriesMarkdown };
  }

  private async persistReportAndLog(
    jobId: string,
    report: AdminBenchmarkGradedReport,
    markdown: string,
    seriesMarkdown: string
  ): Promise<{
    reportFilename: string;
    archiveFilename: string;
    seriesReportFilename: string;
    seriesArchiveFilename: string;
  }> {
    await fs.mkdir(this.reportsDir, { recursive: true });
    const safeId = this.assertSafeJobId(jobId);
    const stamp = report.generatedAt.replace(/[:.]/g, '-').slice(0, 19);
    const reportFilename = `report-${safeId}.md`;
    const archiveFilename = `report-${safeId}-${stamp}.md`;
    const seriesReportFilename = `series-${safeId}.md`;
    const seriesArchiveFilename = `series-${safeId}-${stamp}.md`;

    await fs.writeFile(path.join(this.reportsDir, reportFilename), markdown, 'utf8');
    await fs.writeFile(path.join(this.reportsDir, archiveFilename), markdown, 'utf8');
    await fs.writeFile(path.join(this.reportsDir, seriesReportFilename), seriesMarkdown, 'utf8');
    await fs.writeFile(path.join(this.reportsDir, seriesArchiveFilename), seriesMarkdown, 'utf8');

    const { totals } = report;
    const totalSeries = report.seriesAudit.length;
    const flaggedSeries = report.seriesAudit.filter((s) => s.flags.length > 0).length;
    const totalSeriesVolumes = report.seriesAudit.reduce((sum, s) => sum + s.totalCount, 0);
    const totalSeriesCovers = report.seriesAudit.reduce((sum, s) => sum + s.coversCount, 0);

    const summaryLine =
      `Benchmark ${report.inputFilename} vs ${report.groundTruthFilename} : ` +
      `${totals.resolvedRows}/${totals.evaluatedRows} trouvés (${totals.resolvedRatePct}%), ` +
      `${totals.perfectRows} parfaits (${totals.perfectRatePct}%), ` +
      `précision champs ${totals.fieldAccuracyPct}%, ` +
      `séries ${totalSeries} (${flaggedSeries} avec signaux, ${totalSeriesCovers}/${totalSeriesVolumes} couv.) → ${archiveFilename}`;

    this.logRepo.append({
      traceId: jobId,
      channel: 'admin',
      stage: 'benchmark_report',
      step: 'grade_ground_truth',
      status: totals.failedRows === 0 && totals.partialRows === 0 ? 'ok' : 'warn',
      durationMs: totals.avgDurationMs,
      summary: summaryLine,
      payload: {
        reportFilename,
        archiveFilename,
        seriesReportFilename,
        seriesArchiveFilename,
        alignmentMode: report.alignmentMode,
        totals,
        fieldStats: report.fieldStats,
        byCategory: report.byCategory,
        byProfile: report.byProfile,
        seriesAuditSummary: {
          totalSeries,
          flaggedSeries,
          totalVolumes: totalSeriesVolumes,
          totalCovers: totalSeriesCovers
        }
      }
    });

    console.info(`[benchmark_report] ${summaryLine}`);
    return { reportFilename, archiveFilename, seriesReportFilename, seriesArchiveFilename };
  }

  /**
   * Charge un CSV de correction (`reponses_complet_1080.csv` ou unitaire), l'associe au lot d'import,
   * exécute la comparaison automatique champ par champ et génère les rapports Markdown en log.
   */
  async gradeImportBenchmark(
    jobId: string,
    input: { filename: string; contentBase64: string }
  ): Promise<{
    report: AdminBenchmarkGradedReport;
    markdown: string;
    seriesMarkdown: string;
    reportFilename: string;
    archiveFilename: string;
    seriesReportFilename: string;
    seriesArchiveFilename: string;
  }> {
    this.assertSafeJobId(jobId);
    const cleanBase64 =
      input.contentBase64.startsWith('data:') && input.contentBase64.includes(',')
        ? input.contentBase64.slice(input.contentBase64.indexOf(',') + 1)
        : input.contentBase64;
    const buf = Buffer.from(cleanBase64, 'base64');
    if (buf.byteLength === 0) {
      throw new AppError(400, 'GROUND_TRUTH_EMPTY', 'Le fichier de correction est vide.');
    }
    if (buf.byteLength > MAX_GROUND_TRUTH_BYTES) {
      throw new AppError(400, 'GROUND_TRUTH_TOO_LARGE', 'Fichier de correction trop volumineux (max 10 Mo).');
    }

    const rows = parseGroundTruthCsv(buf.toString('utf8'));
    if (rows.length === 0) {
      throw new AppError(
        400,
        'GROUND_TRUTH_INVALID',
        'Aucune ligne exploitable détectée dans le CSV de correction (colonnes attendues : Ligne, Titre_Attendu, Serie_Attendue...).'
      );
    }

    const storedGt: StoredGroundTruthFile = {
      filename: input.filename.trim() || 'correction.csv',
      uploadedAt: new Date().toISOString(),
      rows
    };

    const { report, markdown, seriesMarkdown } = this.computeLiveGradedReport(jobId, storedGt);
    await fs.mkdir(this.reportsDir, { recursive: true });
    await fs.writeFile(this.getGroundTruthPath(jobId), JSON.stringify(storedGt), 'utf8');
    const files = await this.persistReportAndLog(jobId, report, markdown, seriesMarkdown);

    return { report, markdown, seriesMarkdown, ...files };
  }

  /**
   * Relance la notation automatique LIVE à partir du CSV de correction déjà rattaché à ce lot
   * (utile une fois que les déploiements de séries et couvertures différées sont terminés).
   */
  async regradeImportBenchmark(jobId: string): Promise<{
    report: AdminBenchmarkGradedReport;
    markdown: string;
    seriesMarkdown: string;
    reportFilename: string;
    archiveFilename: string;
    seriesReportFilename: string;
    seriesArchiveFilename: string;
  }> {
    const gtPath = this.getGroundTruthPath(jobId);
    let storedGt: StoredGroundTruthFile;
    try {
      storedGt = JSON.parse(await fs.readFile(gtPath, 'utf8')) as StoredGroundTruthFile;
    } catch {
      throw new AppError(
        404,
        'GROUND_TRUTH_NOT_FOUND',
        'Aucun fichier CSV de correction n’est associé à ce lot.'
      );
    }

    const { report, markdown, seriesMarkdown } = this.computeLiveGradedReport(jobId, storedGt);
    const files = await this.persistReportAndLog(jobId, report, markdown, seriesMarkdown);
    return { report, markdown, seriesMarkdown, ...files };
  }

  /**
   * Lecture seule de la notation live si un CSV de correction est déjà rattaché (sans dupliquer de log).
   */
  async getImportBenchmarkGrade(jobId: string): Promise<{
    hasGroundTruth: boolean;
    report?: AdminBenchmarkGradedReport;
    markdown?: string;
    seriesMarkdown?: string;
    reportFilename?: string;
    seriesReportFilename?: string;
  }> {
    const gtPath = this.getGroundTruthPath(jobId);
    let storedGt: StoredGroundTruthFile;
    try {
      storedGt = JSON.parse(await fs.readFile(gtPath, 'utf8')) as StoredGroundTruthFile;
    } catch {
      return { hasGroundTruth: false };
    }
    const { report, markdown, seriesMarkdown } = this.computeLiveGradedReport(jobId, storedGt);
    const safeId = this.assertSafeJobId(jobId);
    return {
      hasGroundTruth: true,
      report,
      markdown,
      seriesMarkdown,
      reportFilename: `report-${safeId}.md`,
      seriesReportFilename: `series-${safeId}.md`
    };
  }

  /**
   * Lit le dernier rapport Markdown généré sur disque (ou le régénère à la volée si le corrigé existe).
   */
  async getBenchmarkMarkdownReport(jobId: string): Promise<{ filename: string; markdown: string } | null> {
    const safeId = this.assertSafeJobId(jobId);
    const repPath = this.getLatestReportPath(safeId);
    try {
      const markdown = await fs.readFile(repPath, 'utf8');
      return { filename: `rapport-benchmark-${safeId}.md`, markdown };
    } catch {
      const live = await this.getImportBenchmarkGrade(safeId);
      if (live.hasGroundTruth && live.markdown) {
        return { filename: `rapport-benchmark-${safeId}.md`, markdown: live.markdown };
      }
      return null;
    }
  }

  /**
   * Lit le rapport Markdown dédié aux extensions de séries (`series-<jobId>.md`).
   */
  async getBenchmarkSeriesMarkdownReport(jobId: string): Promise<{ filename: string; markdown: string } | null> {
    const safeId = this.assertSafeJobId(jobId);
    const repPath = this.getLatestSeriesReportPath(safeId);
    try {
      const markdown = await fs.readFile(repPath, 'utf8');
      return { filename: `rapport-series-${safeId}.md`, markdown };
    } catch {
      const live = await this.getImportBenchmarkGrade(safeId);
      if (live.hasGroundTruth && live.seriesMarkdown) {
        return { filename: `rapport-series-${safeId}.md`, markdown: live.seriesMarkdown };
      }
      return null;
    }
  }

  /**
   * Réinitialise proprement toute la base livres/séries/couvertures entre deux vagues de tests CSV
   * en préservant intégralement les comptes utilisateurs, sessions, foyers et préférences.
   */
  async resetBookCatalogForTests(): Promise<{
    deletedBooks: number;
    deletedSeries: number;
    deletedCoverFiles: number;
    resetAt: string;
  }> {
    const resetAt = new Date().toISOString();
    // Signale immédiatement aux jobs en cours de s'arrêter avant de vider la base
    this.onCatalogReset?.();
    const { deletedBooks, deletedSeries } = this.db.transaction(() =>
      this.adminRepo.clearBookCatalogKeepingAccounts(resetAt)
    );
    const deletedCoverFiles = await this.coverService.deleteAllStoredCoverFiles();
    // Nettoie les fichiers temporaires ground-truth-*.json liés aux anciens jobs tout en préservant les archives report-*.md
    try {
      const entries = await fs.readdir(this.reportsDir);
      for (const name of entries) {
        if (name.startsWith('ground-truth-') && name.endsWith('.json')) {
          await fs.unlink(path.join(this.reportsDir, path.basename(name))).catch(() => undefined);
        }
      }
    } catch {
      // dossier inexistant
    }
    return {
      deletedBooks,
      deletedSeries,
      deletedCoverFiles,
      resetAt
    };
  }
}
