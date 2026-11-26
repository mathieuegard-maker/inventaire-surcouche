// src/server/workers/background-worker.ts
// Worker continu de dépilement `background_jobs` (reprise au démarrage + bus d'événements temps réel pour SSE).

import { EventEmitter } from 'node:events';
import type { BackgroundJobType, BackgroundJobView } from '../../shared/types/domain.types';
import { runWithRequestPriority, type RequestPriority } from '../connectors/request-priority';
import type { BackgroundJobRow, JobRepository } from '../repositories/job.repo';
import type { LogRepository } from '../repositories/log.repo';

export interface JobHandlerContext {
  job: BackgroundJobRow;
  payload: Record<string, unknown>;
  reportProgress: (done: number, total: number, partialResult?: unknown) => void;
}

export type JobHandler = (ctx: JobHandlerContext) => Promise<{ result: unknown; total?: number }>;

export function mapJobRowToView(row: BackgroundJobRow): BackgroundJobView {
  let result: unknown = null;
  if (row.result_json) {
    try {
      const parsed = JSON.parse(row.result_json);
      // Allège le flux SSE / GET /api/jobs sur les gros imports (ex. 1 080 lignes) :
      // la trace détaillée `items` est servie à la demande par `/api/admin/import-benchmarks`.
      if (row.type === 'collection_import' && parsed && typeof parsed === 'object' && 'items' in parsed) {
        const { items: _omitItems, ...summary } = parsed as Record<string, unknown>;
        result = summary;
      } else {
        result = parsed;
      }
    } catch {
      result = null;
    }
  }
  let targetSeriesId: string | null = null;
  if (
    row.payload_json &&
    (row.type === 'series_expand' ||
      row.type === 'series_enrich_volumes' ||
      row.type === 'series_apply_edition_covers')
  ) {
    try {
      const payload = JSON.parse(row.payload_json) as { seriesId?: unknown };
      if (typeof payload?.seriesId === 'string' && payload.seriesId.trim()) {
        targetSeriesId = payload.seriesId.trim();
      }
    } catch {
      targetSeriesId = null;
    }
  }
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    progressDone: row.progress_done,
    progressTotal: row.progress_total,
    targetSeriesId,
    errorMessage: row.error_message,
    result,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface JobUpdatedEvent {
  userId: string | null;
  libraryId: string | null;
  job: BackgroundJobView;
}

export const INTERACTIVE_LANE_TYPES: BackgroundJobType[] = [
  'photo_ocr',
  'photo_retry_item',
  'photo_commit',
  'collection_import'
];

export const CATALOG_LANE_TYPES: BackgroundJobType[] = [
  'series_expand',
  'series_enrich_volumes',
  'series_apply_edition_covers',
  'book_enrich'
];

export class BackgroundWorker {
  private readonly jobRepo: JobRepository;
  private readonly logRepo: LogRepository;
  private readonly handlers = new Map<BackgroundJobType, JobHandler>();
  private readonly afterCompleteListeners = new Map<
    BackgroundJobType,
    Array<(job: BackgroundJobRow) => Promise<void> | void>
  >();
  private readonly emitter = new EventEmitter();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly activeLanes = new Set<string>();
  private readonly pollIntervalMs: number;

  constructor(deps: { jobRepo: JobRepository; logRepo: LogRepository; pollIntervalMs?: number }) {
    this.jobRepo = deps.jobRepo;
    this.logRepo = deps.logRepo;
    this.pollIntervalMs = deps.pollIntervalMs ?? 2000;
    this.emitter.setMaxListeners(200);
  }

  registerHandler(type: BackgroundJobType, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  registerAfterComplete(type: BackgroundJobType, listener: (job: BackgroundJobRow) => Promise<void> | void): void {
    const list = this.afterCompleteListeners.get(type) ?? [];
    list.push(listener);
    this.afterCompleteListeners.set(type, list);
  }

  subscribe(listener: (event: JobUpdatedEvent) => void): () => void {
    this.emitter.on('job:updated', listener);
    return () => {
      this.emitter.off('job:updated', listener);
    };
  }

  notifyJobRow(row: BackgroundJobRow | null): void {
    this.emitRow(row);
  }

  private emitRow(row: BackgroundJobRow | null): void {
    if (!row) return;
    this.emitter.emit('job:updated', {
      userId: row.user_id,
      libraryId: row.library_id,
      job: mapJobRowToView(row)
    } satisfies JobUpdatedEvent);
  }

  /**
   * Démarre le worker continu et remet immédiatement en `pending` tout job interrompu en `running`.
   */
  start(): void {
    const recovered = this.jobRepo.resetInterruptedRunningJobs(new Date().toISOString());
    if (recovered > 0) {
      this.logRepo.append({
        traceId: 'worker_boot',
        channel: 'worker',
        stage: 'boot',
        step: 'recover_interrupted',
        status: 'warn',
        summary: `${recovered} job(s) interrompu(s) remis en attente au démarrage.`
      });
    }

    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.drainTick();
    }, this.pollIntervalMs);
    void this.drainTick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Réveille immédiatement le dépileur lorsqu'un nouveau job est inséré.
   */
  nudge(): void {
    if (!this.timer) return;
    void this.drainTick();
  }

  private drainTick(): void {
    void this.drainLane('interactive', INTERACTIVE_LANE_TYPES);
    void this.drainLane('catalog', CATALOG_LANE_TYPES);
  }

  private async drainLane(laneName: string, allowedTypes: BackgroundJobType[]): Promise<void> {
    if (this.activeLanes.has(laneName)) return;
    this.activeLanes.add(laneName);
    try {
      while (await this.processNextJob(allowedTypes)) {
        // dépile en continu sur cette voie sans bloquer l'autre voie
      }
    } finally {
      this.activeLanes.delete(laneName);
    }
  }

  /**
   * Dépile et exécute exactement un job `pending` (100 % testable de façon synchrone/déterministe).
   */
  async processNextJob(allowedTypes?: BackgroundJobType[]): Promise<boolean> {
    const now = new Date().toISOString();
    const job = this.jobRepo.claimNextPendingJob(now, allowedTypes);
    if (!job) return false;

    this.emitRow(job);

    const handler = this.handlers.get(job.type);
    if (!handler) {
      const failed = this.jobRepo.failJob(job.id, `Aucun handler enregistré pour le type "${job.type}".`, new Date().toISOString());
      this.emitRow(failed);
      return true;
    }

    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(job.payload_json);
      if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }

    const startedAt = Date.now();
    const lanePriority: RequestPriority = CATALOG_LANE_TYPES.includes(job.type) ? 'low' : 'high';
    try {
      const { result, total } = await runWithRequestPriority(lanePriority, () =>
        handler({
          job,
          payload,
          reportProgress: (done, nextTotal, partialResult) => {
            this.jobRepo.updateJobProgress(job.id, done, nextTotal, new Date().toISOString(), partialResult);
            this.emitRow(this.jobRepo.findJobById(job.id));
          }
        })
      );

      const finalTotal = total ?? Math.max(1, job.progress_total);
      const completed = this.jobRepo.completeJob(job.id, result, finalTotal, new Date().toISOString());
      this.emitRow(completed);

      if (completed) {
        const hooks = this.afterCompleteListeners.get(job.type) ?? [];
        for (const hook of hooks) {
          try {
            await hook(completed);
          } catch (hookErr) {
            console.warn(`[BackgroundWorker] afterComplete hook error for ${job.type}/${job.id}:`, hookErr);
          }
        }
      }

      this.logRepo.append({
        traceId: job.id,
        userId: job.user_id,
        channel: 'worker',
        stage: job.type,
        step: 'complete',
        status: 'ok',
        durationMs: Date.now() - startedAt,
        summary: `Job ${job.type} (${job.id}) terminé.`
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erreur interne worker.';
      const failed = this.jobRepo.failJob(job.id, message, new Date().toISOString());
      this.emitRow(failed);

      this.logRepo.append({
        traceId: job.id,
        userId: job.user_id,
        channel: 'worker',
        stage: job.type,
        step: 'error',
        status: 'error',
        durationMs: Date.now() - startedAt,
        summary: `Échec job ${job.type} (${job.id}) : ${message}`
      });
    }

    return true;
  }
}
