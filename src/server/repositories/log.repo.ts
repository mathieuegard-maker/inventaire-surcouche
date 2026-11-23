// src/server/repositories/log.repo.ts
// Repository SQL pur pour pipeline_logs (observabilité et diagnostic Admin).

import type { DatabaseAdapter } from '../db/database.adapter';

export interface PipelineLogRow {
  id: number;
  trace_id: string;
  user_id: string | null;
  channel: string;
  stage: string;
  step: string;
  status: string;
  duration_ms: number | null;
  summary: string;
  payload_json: string | null;
  created_at: string;
}

export class LogRepository {
  private readonly db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.db = db;
  }

  append(entry: {
    traceId: string;
    userId?: string | null;
    channel: string;
    stage: string;
    step: string;
    status: 'ok' | 'warn' | 'error' | 'skip';
    durationMs?: number | null;
    summary: string;
    payload?: unknown;
    now?: string;
  }): void {
    this.db.run(
      `INSERT INTO pipeline_logs (
         trace_id, user_id, channel, stage, step, status, duration_ms, summary, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.traceId,
        entry.userId ?? null,
        entry.channel,
        entry.stage,
        entry.step,
        entry.status,
        entry.durationMs ?? null,
        entry.summary,
        entry.payload !== undefined ? JSON.stringify(entry.payload) : null,
        entry.now ?? new Date().toISOString()
      ]
    );
  }

  listRecent(limit = 100): PipelineLogRow[] {
    return this.db.all<PipelineLogRow>(
      'SELECT * FROM pipeline_logs ORDER BY id DESC LIMIT ?',
      [limit]
    );
  }

  purgeOlderThan(cutoffIso: string): number {
    return this.db.run('DELETE FROM pipeline_logs WHERE created_at < ?', [cutoffIso]).changes;
  }
}
