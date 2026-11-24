// src/server/services/admin.service.ts
// Service Console Administration (`/admin` uniquement) : Catalogue Maître Couche 2 (locked_fields), Comptes, Quotas, Maintenance & Logs.
// Zéro SQL brut : délègue 100 % des requêtes à AdminRepository / CatalogRepository / UserRepository / LogRepository.

import crypto from 'node:crypto';
import { normalizeTextKey } from '../../shared/bibliographic/text-normalize.util';
import type { BookMainCategory } from '../../shared/types/domain.types';
import type { DatabaseAdapter } from '../db/database.adapter';
import type { AdminRepository } from '../repositories/admin.repo';
import type { CatalogRepository } from '../repositories/catalog.repo';
import type { LogRepository } from '../repositories/log.repo';
import type { UserRepository } from '../repositories/user.repo';
import type { CoverService } from './cover.service';
import type { CronScheduler } from '../workers/cron-scheduler';

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
  private readonly userRepo: UserRepository;
  private readonly logRepo: LogRepository;
  private readonly coverService: CoverService;
  private readonly cronScheduler: CronScheduler;

  constructor(deps: {
    db: DatabaseAdapter;
    adminRepo: AdminRepository;
    catalogRepo: CatalogRepository;
    userRepo: UserRepository;
    logRepo: LogRepository;
    coverService: CoverService;
    cronScheduler: CronScheduler;
  }) {
    this.db = deps.db;
    this.adminRepo = deps.adminRepo;
    this.catalogRepo = deps.catalogRepo;
    this.userRepo = deps.userRepo;
    this.logRepo = deps.logRepo;
    this.coverService = deps.coverService;
    this.cronScheduler = deps.cronScheduler;
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
}
