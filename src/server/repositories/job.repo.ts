// src/server/repositories/job.repo.ts
// Repository SQL pur pour background_jobs, external_cache et cron_runs (Espace 4).

import type { DatabaseAdapter } from '../db/database.adapter';
import type { BackgroundJobStatus, BackgroundJobType } from '../../shared/types/domain.types';

export interface BackgroundJobRow {
  id: string;
  type: BackgroundJobType;
  user_id: string | null;
  library_id: string | null;
  status: BackgroundJobStatus;
  progress_done: number;
  progress_total: number;
  payload_json: string;
  result_json: string | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export interface ExternalCacheRow {
  cache_key: string;
  source: string;
  response_json: string;
  expires_at: string;
}

export interface CronRunRow {
  job_name: string;
  last_run_key: string;
  last_run_at: string;
  status: string;
  summary_json: string;
}

export class JobRepository {
  private readonly db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.db = db;
  }

  // ==================== BACKGROUND JOBS ====================

  createJob(input: {
    id: string;
    type: BackgroundJobType;
    userId: string | null;
    libraryId: string | null;
    payload: unknown;
    progressTotal?: number;
    now: string;
  }): BackgroundJobRow {
    this.db.run(
      `INSERT INTO background_jobs (
         id, type, user_id, library_id, status, progress_done, progress_total,
         payload_json, attempts, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, 0, ?, ?)`,
      [
        input.id,
        input.type,
        input.userId,
        input.libraryId,
        input.progressTotal ?? 0,
        JSON.stringify(input.payload ?? {}),
        input.now,
        input.now
      ]
    );
    return this.findJobById(input.id)!;
  }

  findJobById(id: string): BackgroundJobRow | null {
    return this.db.get<BackgroundJobRow>('SELECT * FROM background_jobs WHERE id = ? LIMIT 1', [id]);
  }

  findActiveJobByTypeAndPayloadKey(type: BackgroundJobType, payloadSubstring: string): BackgroundJobRow | null {
    return this.db.get<BackgroundJobRow>(
      `SELECT * FROM background_jobs
       WHERE type = ? AND status IN ('pending', 'running') AND payload_json LIKE ?
       LIMIT 1`,
      [type, `%${payloadSubstring}%`]
    );
  }

  listJobsForUser(userId: string, libraryId: string, limit = 30): BackgroundJobRow[] {
    // Inclut SYSTÉMATIQUEMENT tous les jobs actifs (running puis pending) pour ne jamais les éjecter
    // lors d'un import créant de nombreux jobs, puis complète avec les `limit` derniers jobs terminés.
    const active = this.db.all<BackgroundJobRow>(
      `SELECT * FROM background_jobs
       WHERE (user_id = ? OR library_id = ?) AND status IN ('running', 'pending')
       ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END ASC, created_at DESC`,
      [userId, libraryId]
    );
    const activeIds = new Set(active.map((r) => r.id));
    const recentFinished = this.db.all<BackgroundJobRow>(
      `SELECT * FROM background_jobs
       WHERE (user_id = ? OR library_id = ?) AND status NOT IN ('running', 'pending')
       ORDER BY created_at DESC
       LIMIT ?`,
      [userId, libraryId, limit]
    );
    const merged = [...active];
    for (const row of recentFinished) {
      if (!activeIds.has(row.id)) merged.push(row);
    }
    return merged;
  }

  promotePendingJobPriority(id: string, now: string): BackgroundJobRow | null {
    const row = this.findJobById(id);
    if (!row || row.status !== 'pending') return row;
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.payload_json || '{}');
      if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
    payload.priority = 'high';
    this.db.run(
      `UPDATE background_jobs SET payload_json = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
      [JSON.stringify(payload), now, id]
    );
    return this.findJobById(id);
  }

  resetInterruptedRunningJobs(now: string): number {
    const res = this.db.run(
      `UPDATE background_jobs SET status = 'pending', updated_at = ?
       WHERE status = 'running'`,
      [now]
    );
    return res.changes;
  }

  claimNextPendingJob(now: string, allowedTypes?: BackgroundJobType[]): BackgroundJobRow | null {
    return this.db.transaction(() => {
      let candidates: BackgroundJobRow[];
      if (allowedTypes && allowedTypes.length > 0) {
        const placeholders = allowedTypes.map(() => '?').join(', ');
        candidates = this.db.all<BackgroundJobRow>(
          `SELECT * FROM background_jobs
           WHERE status = 'pending' AND type IN (${placeholders})
           ORDER BY created_at ASC
           LIMIT 25`,
          allowedTypes
        );
      } else {
        candidates = this.db.all<BackgroundJobRow>(
          `SELECT * FROM background_jobs
           WHERE status = 'pending'
           ORDER BY created_at ASC
           LIMIT 25`
        );
      }

      const eligible = candidates.filter((row) => {
        if (!row.payload_json || !row.payload_json.includes('runAfter')) return true;
        try {
          const parsed = JSON.parse(row.payload_json) as { runAfter?: unknown };
          if (typeof parsed?.runAfter === 'string' && parsed.runAfter > now) {
            return false;
          }
        } catch {
          // payload illisible -> éligible
        }
        return true;
      });

      const next =
        eligible.find((row) => row.payload_json?.includes('"priority":"high"')) ??
        eligible[0] ??
        null;

      if (!next) return null;
      this.db.run(
        `UPDATE background_jobs
         SET status = 'running', attempts = attempts + 1, updated_at = ?
         WHERE id = ?`,
        [now, next.id]
      );
      return this.findJobById(next.id);
    });
  }

  updateJobProgress(id: string, progressDone: number, progressTotal: number, now: string, result?: unknown): void {
    if (result !== undefined) {
      this.db.run(
        `UPDATE background_jobs
         SET progress_done = ?, progress_total = ?, result_json = ?, updated_at = ?
         WHERE id = ?`,
        [progressDone, progressTotal, JSON.stringify(result), now, id]
      );
    } else {
      this.db.run(
        `UPDATE background_jobs
         SET progress_done = ?, progress_total = ?, updated_at = ?
         WHERE id = ?`,
        [progressDone, progressTotal, now, id]
      );
    }
  }

  completeJob(id: string, result: unknown, progressTotal: number, now: string): BackgroundJobRow | null {
    this.db.run(
      `UPDATE background_jobs
       SET status = 'done', progress_done = ?, progress_total = ?, result_json = ?, error_message = NULL, updated_at = ?
       WHERE id = ?`,
      [progressTotal, progressTotal, JSON.stringify(result ?? {}), now, id]
    );
    return this.findJobById(id);
  }

  failJob(id: string, errorMessage: string, now: string): BackgroundJobRow | null {
    this.db.run(
      `UPDATE background_jobs
       SET status = 'error', error_message = ?, updated_at = ?
       WHERE id = ?`,
      [errorMessage, now, id]
    );
    return this.findJobById(id);
  }

  requeueJob(id: string, now: string): BackgroundJobRow | null {
    this.db.run(
      `UPDATE background_jobs
       SET status = 'pending', progress_done = 0, progress_total = 1, error_message = NULL, updated_at = ?
       WHERE id = ?`,
      [now, id]
    );
    return this.findJobById(id);
  }

  deleteJob(id: string): void {
    this.db.run('DELETE FROM background_jobs WHERE id = ?', [id]);
  }

  // ==================== EXTERNAL CACHE ====================

  getExternalCache<T = unknown>(cacheKey: string, nowIso: string): T | null {
    const row = this.db.get<ExternalCacheRow>(
      'SELECT * FROM external_cache WHERE cache_key = ? AND expires_at > ? LIMIT 1',
      [cacheKey, nowIso]
    );
    if (!row) return null;
    try {
      return JSON.parse(row.response_json) as T;
    } catch {
      return null;
    }
  }

  setExternalCache(cacheKey: string, source: string, payload: unknown, expiresAtIso: string): void {
    this.db.run(
      `INSERT INTO external_cache (cache_key, source, response_json, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         response_json = excluded.response_json,
         expires_at = excluded.expires_at`,
      [cacheKey, source, JSON.stringify(payload), expiresAtIso]
    );
  }

  purgeExpiredExternalCache(nowIso: string): number {
    return this.db.run('DELETE FROM external_cache WHERE expires_at <= ?', [nowIso]).changes;
  }

  /**
   * Purge les entrées expirées de `external_cache` puis borne la table aux `maxRows` entrées les plus récentes
   * afin de garantir une taille maîtrisée de `biblio.sqlite` sur la durée.
   */
  pruneExternalCache(nowIso: string, maxRows = 6000): number {
    let deleted = this.purgeExpiredExternalCache(nowIso);
    const total = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM external_cache')?.c ?? 0;
    if (total > maxRows) {
      const overflow = total - maxRows;
      deleted += this.db.run(
        `DELETE FROM external_cache
         WHERE cache_key IN (
           SELECT cache_key FROM external_cache
           ORDER BY expires_at ASC
           LIMIT ?
         )`,
        [overflow]
      ).changes;
    }
    return deleted;
  }

  // ==================== CRON RUNS ====================

  getCronRun(jobName: string): CronRunRow | null {
    return this.db.get<CronRunRow>('SELECT * FROM cron_runs WHERE job_name = ? LIMIT 1', [jobName]);
  }

  upsertCronRun(row: CronRunRow): void {
    this.db.run(
      `INSERT INTO cron_runs (job_name, last_run_key, last_run_at, status, summary_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(job_name) DO UPDATE SET
         last_run_key = excluded.last_run_key,
         last_run_at = excluded.last_run_at,
         status = excluded.status,
         summary_json = excluded.summary_json`,
      [row.job_name, row.last_run_key, row.last_run_at, row.status, row.summary_json]
    );
  }
}
