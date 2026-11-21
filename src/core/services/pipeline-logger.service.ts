// src/core/services/pipeline-logger.service.ts
// Traceur d'observabilité non-bloquant (C1 -> C5, CRON) persisté dans D1 `pipeline_logs`
// avec assainissement automatique des secrets et purge TTL.

import type { DatabaseBinding } from '../adapters/storage-db.interface';

export type PipelineLayer = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'CRON';
export type PipelineStepStatus = 'ok' | 'warn' | 'error';

export interface PipelineLogStepInput {
  layer: PipelineLayer;
  stepName: string;
  status: PipelineStepStatus;
  summary: string;
  payload?: unknown;
  durationMs?: number;
}

export interface PipelineLogRow {
  id: number;
  trace_id: string;
  user_id: string | null;
  source_channel: string | null;
  layer: string;
  step_name: string;
  status: PipelineStepStatus;
  duration_ms: number | null;
  summary: string;
  payload_json: string | null;
  created_at: string;
}

export interface GroupedPipelineTrace {
  traceId: string;
  sourceChannel: string | null;
  userId: string | null;
  startedAt: string;
  maxStatus: PipelineStepStatus;
  totalDurationMs: number;
  steps: PipelineLogRow[];
}

const SENSITIVE_KEY_RE = /(token|password|hash|secret|cookie|apikey|api_key|authorization)/i;

export function sanitizeLogPayload(input: unknown, depth = 0): unknown {
  if (input === null || input === undefined) return input;
  if (depth > 4) return '[TRUNCATED]';
  if (typeof input === 'string') {
    return input.length > 1200 ? `${input.slice(0, 1200)}…[+${input.length - 1200} chars]` : input;
  }
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) {
    return input.slice(0, 40).map((item) => sanitizeLogPayload(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = sanitizeLogPayload(v, depth + 1);
    }
  }
  return out;
}

export function generateTraceId(prefix = 'tr'): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${rand}`;
}

export class PipelineTracer {
  readonly traceId: string;
  readonly userId: string | null;
  readonly sourceChannel: string | null;
  private readonly steps: Array<PipelineLogStepInput & { createdAt: string }> = [];

  constructor(params: { traceId?: string; userId?: string | null; sourceChannel?: string | null } = {}) {
    this.traceId = params.traceId || generateTraceId();
    this.userId = params.userId || null;
    this.sourceChannel = params.sourceChannel || null;
  }

  record(
    layer: PipelineLayer,
    stepName: string,
    status: PipelineStepStatus,
    summary: string,
    payload?: unknown,
    durationMs?: number
  ): void {
    this.steps.push({
      layer,
      stepName,
      status,
      summary: summary.slice(0, 400),
      payload,
      durationMs: typeof durationMs === 'number' ? Math.max(0, Math.round(durationMs)) : undefined,
      createdAt: new Date().toISOString()
    });
  }

  getStepsCount(): number {
    return this.steps.length;
  }

  async flush(db?: DatabaseBinding | null): Promise<void> {
    if (!db || this.steps.length === 0) return;
    try {
      const stmts = this.steps.map((s) => {
        const safePayload =
          s.payload !== undefined ? JSON.stringify(sanitizeLogPayload(s.payload)) : null;
        return db
          .prepare(
            `INSERT INTO pipeline_logs
              (trace_id, user_id, source_channel, layer, step_name, status, duration_ms, summary, payload_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            this.traceId,
            this.userId,
            this.sourceChannel,
            s.layer,
            s.stepName,
            s.status,
            s.durationMs ?? null,
            s.summary,
            safePayload,
            s.createdAt
          );
      });
      await db.batch(stmts);
    } catch {
      // Ne jamais faire échouer le pipeline métier si le logging échoue
    }
  }
}

export async function queryPipelineLogs(
  db: DatabaseBinding,
  options: {
    status?: string;
    layer?: string;
    q?: string;
    limit?: number;
  } = {}
): Promise<GroupedPipelineTrace[]> {
  const limit = Math.min(200, Math.max(20, Math.trunc(options.limit || 120)));
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (options.status && options.status !== 'all') {
    conditions.push('status = ?');
    bindings.push(options.status);
  }
  if (options.layer && options.layer !== 'all') {
    conditions.push('layer = ?');
    bindings.push(options.layer);
  }
  if (options.q?.trim()) {
    const q = `%${options.q.trim().toLowerCase()}%`;
    conditions.push("(LOWER(trace_id) LIKE ? OR LOWER(summary) LIKE ? OR LOWER(COALESCE(payload_json, '')) LIKE ?)");
    bindings.push(q, q, q);
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await db
    .prepare(
      `SELECT id, trace_id, user_id, source_channel, layer, step_name, status, duration_ms, summary, payload_json, created_at
       FROM pipeline_logs
       ${whereSql}
       ORDER BY id DESC
       LIMIT ?`
    )
    .bind(...bindings, limit)
    .all<PipelineLogRow>();

  const groups = new Map<string, GroupedPipelineTrace>();
  const rankStatus = (s: PipelineStepStatus) => (s === 'error' ? 3 : s === 'warn' ? 2 : 1);

  for (const row of (rows.results || []).slice().reverse()) {
    let g = groups.get(row.trace_id);
    if (!g) {
      g = {
        traceId: row.trace_id,
        sourceChannel: row.source_channel,
        userId: row.user_id,
        startedAt: row.created_at,
        maxStatus: row.status,
        totalDurationMs: 0,
        steps: []
      };
      groups.set(row.trace_id, g);
    }
    if (rankStatus(row.status) > rankStatus(g.maxStatus)) {
      g.maxStatus = row.status;
    }
    g.totalDurationMs += row.duration_ms || 0;
    g.steps.push(row);
  }

  return Array.from(groups.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function purgeOldPipelineLogs(db: DatabaseBinding): Promise<{ deletedOk: number; deletedWarnErr: number }> {
  const cutoffOk = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const cutoffWarnErr = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  try {
    await db.prepare("DELETE FROM pipeline_logs WHERE status = 'ok' AND created_at < ?").bind(cutoffOk).run();
    await db
      .prepare("DELETE FROM pipeline_logs WHERE status IN ('warn', 'error') AND created_at < ?")
      .bind(cutoffWarnErr)
      .run();
    return { deletedOk: 1, deletedWarnErr: 1 };
  } catch {
    return { deletedOk: 0, deletedWarnErr: 0 };
  }
}
