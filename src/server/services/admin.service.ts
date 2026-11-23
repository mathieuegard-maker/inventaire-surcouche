// src/server/services/admin.service.ts
// Service Console Administration (`/admin` uniquement) : Catalogue Maître Couche 2 (locked_fields), Comptes, Quotas, Maintenance & Logs.

import crypto from 'node:crypto';
import { normalizeTextKey } from '../../shared/bibliographic/text-normalize.util';
import type { BookMainCategory } from '../../shared/types/domain.types';
import type { DatabaseAdapter } from '../db/database.adapter';
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
  private readonly catalogRepo: CatalogRepository;
  private readonly userRepo: UserRepository;
  private readonly logRepo: LogRepository;
  private readonly coverService: CoverService;
  private readonly cronScheduler: CronScheduler;

  constructor(deps: {
    db: DatabaseAdapter;
    catalogRepo: CatalogRepository;
    userRepo: UserRepository;
    logRepo: LogRepository;
    coverService: CoverService;
    cronScheduler: CronScheduler;
  }) {
    this.db = deps.db;
    this.catalogRepo = deps.catalogRepo;
    this.userRepo = deps.userRepo;
    this.logRepo = deps.logRepo;
    this.coverService = deps.coverService;
    this.cronScheduler = deps.cronScheduler;
  }

  getOverview() {
    const count = (table: string) =>
      Number(this.db.get<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM ${table}`)?.cnt ?? 0);
    const coverBytes = Number(
      this.db.get<{ total: number }>('SELECT COALESCE(SUM(byte_size), 0) AS total FROM covers')?.total ?? 0
    );
    const cronRuns = this.db.all<{ job_name: string; last_run_key: string; last_run_at: string; status: string }>(
      'SELECT job_name, last_run_key, last_run_at, status FROM cron_runs ORDER BY job_name ASC'
    );

    return {
      usersCount: count('users'),
      librariesCount: count('libraries'),
      booksCount: count('books'),
      editionsCount: count('book_editions'),
      seriesCount: count('series'),
      franchisesCount: count('franchises'),
      coversCount: count('covers'),
      coversTotalBytes: coverBytes,
      jobsCount: count('background_jobs'),
      logsCount: count('pipeline_logs'),
      cronRuns
    };
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

    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (input.search?.trim()) {
      const needle = `%${normalizeTextKey(input.search)}%`;
      clauses.push(
        '(b.normalized_title LIKE ? OR lower(b.authors_json) LIKE ? OR lower(COALESCE(s.canonical_name, \'\')) LIKE ? OR EXISTS (SELECT 1 FROM book_editions be WHERE be.book_id = b.id AND be.isbn13 LIKE ?))'
      );
      params.push(needle, needle, needle, `%${input.search.trim()}%`);
    }
    if (input.filter === 'no_cover') {
      clauses.push('b.cover_key IS NULL');
    } else if (input.filter === 'no_series') {
      clauses.push('b.series_id IS NULL');
    }
    if (input.category?.trim()) {
      clauses.push('b.main_category = ?');
      params.push(input.category.trim());
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM books b LEFT JOIN series s ON s.id = b.series_id ${whereSql}`,
      params
    );

    const rows = this.db.all<{
      id: string;
      title: string;
      series_id: string | null;
      series_name: string | null;
      volume_number: number | null;
      authors_json: string;
      publisher: string | null;
      publish_year: string | null;
      main_category: BookMainCategory;
      subgenres_json: string;
      cover_key: string | null;
      locked_fields_json: string;
      updated_at: string;
    }>(
      `SELECT b.id, b.title, b.series_id, s.canonical_name AS series_name, b.volume_number,
              b.authors_json, b.publisher, b.publish_year, b.main_category, b.subgenres_json,
              b.cover_key, b.locked_fields_json, b.updated_at
       FROM books b
       LEFT JOIN series s ON s.id = b.series_id
       ${whereSql}
       ORDER BY b.updated_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

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

    return {
      total: Number(totalRow?.cnt ?? 0),
      page,
      pageSize,
      items
    };
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

        const sets: string[] = [];
        const vals: Array<string | number | null> = [];

        if (patch.title !== undefined) {
          sets.push('title = ?', 'normalized_title = ?');
          vals.push(patch.title.trim(), normalizeTextKey(patch.title));
        }
        if (patch.authors !== undefined) {
          sets.push('authors_json = ?');
          vals.push(JSON.stringify(patch.authors));
        }
        if (resolvedSeriesId !== undefined) {
          sets.push('series_id = ?');
          vals.push(resolvedSeriesId);
        }
        if (patch.volumeNumber !== undefined) {
          sets.push('volume_number = ?', 'volume_label = ?', 'sort_order = ?');
          vals.push(
            patch.volumeNumber,
            patch.volumeNumber !== null ? String(patch.volumeNumber) : null,
            patch.volumeNumber
          );
        }
        if (patch.publisher !== undefined) {
          sets.push('publisher = ?');
          vals.push(patch.publisher);
        }
        if (patch.publishYear !== undefined) {
          sets.push('publish_year = ?');
          vals.push(patch.publishYear);
        }
        if (patch.mainCategory !== undefined) {
          sets.push('main_category = ?');
          vals.push(patch.mainCategory);
        }
        if (patch.subgenres !== undefined) {
          sets.push('subgenres_json = ?');
          vals.push(JSON.stringify(patch.subgenres));
        }
        if (patch.coverKey !== undefined) {
          sets.push('cover_key = ?');
          vals.push(patch.coverKey);
        }

        const mergedLocked = Array.from(new Set([...parseJsonArray(existing.locked_fields_json), ...lockedToAdd]));
        sets.push('locked_fields_json = ?', 'updated_at = ?');
        vals.push(JSON.stringify(mergedLocked), now, bookId);

        this.db.run(`UPDATE books SET ${sets.join(', ')} WHERE id = ?`, vals);
        updatedCount++;
      }
    });

    return { updatedCount, lockedFieldsAdded: lockedToAdd };
  }

  listUsers() {
    const monthKey = new Date().toISOString().slice(0, 7);
    return this.db
      .all<{
        id: string;
        username: string;
        email: string;
        is_admin: number;
        created_at: string;
        library_name: string | null;
        month_key: string | null;
        month_used: number | null;
        total_used: number | null;
      }>(
        `SELECT u.id, u.username, u.email, u.is_admin, u.created_at,
                l.name AS library_name,
                ai.month_key, ai.month_used, ai.total_used
         FROM users u
         LEFT JOIN library_members lm ON lm.user_id = u.id
         LEFT JOIN libraries l ON l.id = lm.library_id
         LEFT JOIN user_ai_usage ai ON ai.user_id = u.id
         ORDER BY u.created_at DESC`
      )
      .map((u) => ({
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
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (input.stage?.trim()) {
      clauses.push('stage = ?');
      params.push(input.stage.trim());
    }
    if (input.status?.trim()) {
      clauses.push('status = ?');
      params.push(input.status.trim());
    }
    if (input.query?.trim()) {
      const pat = `%${input.query.trim()}%`;
      clauses.push('(trace_id LIKE ? OR summary LIKE ?)');
      params.push(pat, pat);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.all<{
      id: number;
      trace_id: string;
      channel: string;
      stage: string;
      step: string;
      status: string;
      duration_ms: number | null;
      summary: string;
      payload_json: string | null;
      created_at: string;
    }>(`SELECT * FROM pipeline_logs ${whereSql} ORDER BY id DESC LIMIT ?`, [...params, limit]);
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
    const count = Number(
      this.db.get<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM book_editions')?.cnt ?? 0
    );
    return { editionsIndexed: count };
  }
}
