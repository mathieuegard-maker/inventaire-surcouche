// src/server/repositories/admin.repo.ts
// Repository SQL standard dédié aux requêtes d'administration (Console Admin Couche 2, vue d'ensemble, comptes, logs).

import type { BookMainCategory } from '../../shared/types/domain.types';
import type { DatabaseAdapter } from '../db/database.adapter';
import type { BackgroundJobRow } from './job.repo';

export interface AdminOverviewRow {
  usersCount: number;
  librariesCount: number;
  booksCount: number;
  editionsCount: number;
  seriesCount: number;
  franchisesCount: number;
  coversCount: number;
  coversTotalBytes: number;
  jobsCount: number;
  logsCount: number;
  cronRuns: Array<{ job_name: string; last_run_key: string; last_run_at: string; status: string }>;
}

export interface AdminCatalogBookRow {
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
}

export interface AdminUserRow {
  id: string;
  username: string;
  email: string;
  is_admin: number;
  created_at: string;
  library_name: string | null;
  month_key: string | null;
  month_used: number | null;
  total_used: number | null;
}

export interface AdminPipelineLogRow {
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
}

export interface AdminCatalogBookPatchFields {
  title?: string;
  normalizedTitle?: string;
  authorsJson?: string;
  seriesId?: string | null;
  volumeNumber?: number | null;
  volumeLabel?: string | null;
  sortOrder?: number | null;
  publisher?: string | null;
  publishYear?: string | null;
  mainCategory?: BookMainCategory;
  subgenresJson?: string;
  coverKey?: string | null;
  lockedFieldsJson: string;
  updatedAt: string;
}

export class AdminRepository {
  private readonly db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.db = db;
  }

  getOverviewCounts(): AdminOverviewRow {
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

  countEditions(): number {
    return Number(this.db.get<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM book_editions')?.cnt ?? 0);
  }

  listCatalogBooks(input: {
    searchNormalized?: string;
    searchRaw?: string;
    filter?: 'all' | 'no_cover' | 'no_series';
    category?: string;
    limit: number;
    offset: number;
  }): { total: number; rows: AdminCatalogBookRow[] } {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (input.searchNormalized && input.searchRaw) {
      const needle = `%${input.searchNormalized}%`;
      clauses.push(
        "(b.normalized_title LIKE ? OR lower(b.authors_json) LIKE ? OR lower(COALESCE(s.canonical_name, '')) LIKE ? OR EXISTS (SELECT 1 FROM book_editions be WHERE be.book_id = b.id AND be.isbn13 LIKE ?))"
      );
      params.push(needle, needle, needle, `%${input.searchRaw}%`);
    }
    if (input.filter === 'no_cover') {
      clauses.push('b.cover_key IS NULL');
    } else if (input.filter === 'no_series') {
      clauses.push('b.series_id IS NULL');
    }
    if (input.category) {
      clauses.push('b.main_category = ?');
      params.push(input.category);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM books b LEFT JOIN series s ON s.id = b.series_id ${whereSql}`,
      params
    );

    const rows = this.db.all<AdminCatalogBookRow>(
      `SELECT b.id, b.title, b.series_id, s.canonical_name AS series_name, b.volume_number,
              b.authors_json, b.publisher, b.publish_year, b.main_category, b.subgenres_json,
              b.cover_key, b.locked_fields_json, b.updated_at
       FROM books b
       LEFT JOIN series s ON s.id = b.series_id
       ${whereSql}
       ORDER BY b.updated_at DESC
       LIMIT ? OFFSET ?`,
      [...params, input.limit, input.offset]
    );

    return { total: Number(totalRow?.cnt ?? 0), rows };
  }

  updateCatalogBookLocked(bookId: string, fields: AdminCatalogBookPatchFields): void {
    const sets: string[] = [];
    const vals: Array<string | number | null> = [];

    if (fields.title !== undefined && fields.normalizedTitle !== undefined) {
      sets.push('title = ?', 'normalized_title = ?');
      vals.push(fields.title, fields.normalizedTitle);
    }
    if (fields.authorsJson !== undefined) {
      sets.push('authors_json = ?');
      vals.push(fields.authorsJson);
    }
    if (fields.seriesId !== undefined) {
      sets.push('series_id = ?');
      vals.push(fields.seriesId);
    }
    if (fields.volumeNumber !== undefined) {
      sets.push('volume_number = ?', 'volume_label = ?', 'sort_order = ?');
      vals.push(fields.volumeNumber, fields.volumeLabel ?? null, fields.sortOrder ?? null);
    }
    if (fields.publisher !== undefined) {
      sets.push('publisher = ?');
      vals.push(fields.publisher);
    }
    if (fields.publishYear !== undefined) {
      sets.push('publish_year = ?');
      vals.push(fields.publishYear);
    }
    if (fields.mainCategory !== undefined) {
      sets.push('main_category = ?');
      vals.push(fields.mainCategory);
    }
    if (fields.subgenresJson !== undefined) {
      sets.push('subgenres_json = ?');
      vals.push(fields.subgenresJson);
    }
    if (fields.coverKey !== undefined) {
      sets.push('cover_key = ?');
      vals.push(fields.coverKey);
    }

    sets.push('locked_fields_json = ?', 'updated_at = ?');
    vals.push(fields.lockedFieldsJson, fields.updatedAt, bookId);

    this.db.run(`UPDATE books SET ${sets.join(', ')} WHERE id = ?`, vals);
  }

  listUsersWithLibraryAndAi(): AdminUserRow[] {
    return this.db.all<AdminUserRow>(
      `SELECT u.id, u.username, u.email, u.is_admin, u.created_at,
              l.name AS library_name,
              ai.month_key, ai.month_used, ai.total_used
       FROM users u
       LEFT JOIN library_members lm ON lm.user_id = u.id
       LEFT JOIN libraries l ON l.id = lm.library_id
       LEFT JOIN user_ai_usage ai ON ai.user_id = u.id
       ORDER BY u.created_at DESC`
    );
  }

  listPipelineLogs(input: { stage?: string; status?: string; query?: string; limit: number }): AdminPipelineLogRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (input.stage) {
      clauses.push('stage = ?');
      params.push(input.stage);
    }
    if (input.status) {
      clauses.push('status = ?');
      params.push(input.status);
    }
    if (input.query) {
      const pat = `%${input.query}%`;
      clauses.push('(trace_id LIKE ? OR summary LIKE ?)');
      params.push(pat, pat);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.all<AdminPipelineLogRow>(
      `SELECT * FROM pipeline_logs ${whereSql} ORDER BY id DESC LIMIT ?`,
      [...params, input.limit]
    );
  }

  listCollectionImportJobs(limit = 20): BackgroundJobRow[] {
    return this.db.all<BackgroundJobRow>(
      `SELECT * FROM background_jobs
       WHERE type = 'collection_import'
       ORDER BY created_at DESC
       LIMIT ?`,
      [limit]
    );
  }

  countActiveSeriesBackgroundJobs(): number {
    const row = this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM background_jobs
       WHERE type IN ('series_expand', 'series_enrich_volumes', 'book_enrich')
         AND status IN ('pending', 'running')`
    );
    return Number(row?.cnt ?? 0);
  }

  /**
   * Vide intégralement les tables livres / séries / couvertures / jobs / cache externe / logs
   * tout en préservant les comptes utilisateurs, sessions, foyers, amis et préférences.
   * Horodate `catalog_reset` dans `cron_runs` pour purger automatiquement les caches IndexedDB clients.
   */
  clearBookCatalogKeepingAccounts(nowIso: string): { deletedBooks: number; deletedSeries: number } {
    this.db.run('DELETE FROM wishlist_reservations');
    this.db.run('DELETE FROM series_release_alerts');
    this.db.run('DELETE FROM loans');
    this.db.run('DELETE FROM user_reading_states');
    this.db.run('DELETE FROM library_books');
    this.db.run('DELETE FROM book_editions');
    const deletedBooks = this.db.run('DELETE FROM books').changes;
    const deletedSeries = this.db.run('DELETE FROM series').changes;
    this.db.run('DELETE FROM franchises');
    this.db.run('DELETE FROM covers');
    this.db.run('DELETE FROM background_jobs');
    this.db.run('DELETE FROM external_cache');
    this.db.run('DELETE FROM pipeline_logs');

    this.db.run(
      `INSERT INTO cron_runs (job_name, last_run_key, last_run_at, status, summary_json)
       VALUES ('catalog_reset', ?, ?, 'ok', ?)
       ON CONFLICT(job_name) DO UPDATE SET
         last_run_key = excluded.last_run_key,
         last_run_at = excluded.last_run_at,
         status = excluded.status,
         summary_json = excluded.summary_json`,
      [
        `reset_${nowIso}`,
        nowIso,
        JSON.stringify({ reason: 'admin_benchmark_reset', deletedBooks, deletedSeries })
      ]
    );

    return { deletedBooks, deletedSeries };
  }
}
