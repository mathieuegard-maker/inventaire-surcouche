// server/scheduler.ts
// Planificateur interne Node.js remplaçant le Worker CRON Cloudflare (`workers/release-cron`).

import type { AppBackendEnv } from '../src/core/adapters/storage-db.interface';
import { PipelineTracer, purgeOldPipelineLogs } from '../src/core/services/pipeline-logger.service';
import { runCentralizedSeriesReleaseSweep, runHourlyDigestDispatch } from '../src/core/services/series-digest.service';
import { drainEnrichmentQueueBatch, runSilentEditionDiscoveryPass } from '../src/core/services/v4-pipeline.service';

export interface SelfHostedSchedulerOptions {
  intervalMinutes?: number;
  initialDelaySeconds?: number;
  enrichmentBatchSize?: number;
  silentDiscoveryBatchSize?: number;
}

export function startSelfHostedScheduler(
  env: AppBackendEnv,
  options: SelfHostedSchedulerOptions = {}
): { stop: () => void; runNow: () => Promise<void> } {
  const intervalMs = Math.max(5, options.intervalMinutes ?? 60) * 60 * 1000;
  const initialDelayMs = Math.max(5, options.initialDelaySeconds ?? 90) * 1000;
  const enrichmentBatchSize = options.enrichmentBatchSize ?? 15;
  const silentDiscoveryBatchSize = options.silentDiscoveryBatchSize ?? 6;

  let isRunning = false;

  const runTick = async () => {
    if (isRunning) return;
    isRunning = true;
    const start = Date.now();
    const tracer = new PipelineTracer({ sourceChannel: 'cron_enrichment' });
    try {
      const queueRes = await drainEnrichmentQueueBatch(env.DB, enrichmentBatchSize).catch((err) => ({
        processed: 0,
        succeeded: 0,
        failed: 1,
        error: err instanceof Error ? err.message : String(err)
      }));

      const sweepRes = await runCentralizedSeriesReleaseSweep(env.DB, {
        limit: 25,
        staleDays: 1
      }).catch(() => ({
        checkedCount: 0,
        alertsCreated: 0
      }));

      const silentRes = await runSilentEditionDiscoveryPass(env.DB, silentDiscoveryBatchSize).catch(() => ({
        checkedBooks: 0,
        newIsbnsIndexed: 0
      }));

      const digestRes = await runHourlyDigestDispatch(env.DB, env).catch(() => ({
        usersNotified: 0
      }));

      const purgeRes = await purgeOldPipelineLogs(env.DB).catch(() => ({
        deletedOk: 0,
        deletedWarnErr: 0
      }));

      tracer.record(
        'CRON',
        'self_hosted_cron_tick',
        'ok',
        `CRON local: queue ${queueRes.succeeded}/${queueRes.processed}, séries ${sweepRes.checkedCount} (+${sweepRes.alertsCreated} alertes), sœurs +${silentRes.newIsbnsIndexed} ISBN, digests ${digestRes.usersNotified} util., purge logs:${purgeRes.deletedOk + purgeRes.deletedWarnErr}`,
        { queueRes, sweepRes, silentRes, digestRes, purgeRes },
        Date.now() - start
      );
      await tracer.flush(env.DB).catch(() => {});
      console.log(
        `[CRON] Passe terminée en ${Date.now() - start}ms — queue: ${queueRes.succeeded}/${queueRes.processed}, séries: ${sweepRes.checkedCount}`
      );
    } catch (err) {
      console.error('[CRON] Erreur pendant la passe planifiée :', err);
    } finally {
      isRunning = false;
    }
  };

  const initialTimer = setTimeout(() => {
    void runTick();
  }, initialDelayMs);

  const recurringTimer = setInterval(() => {
    void runTick();
  }, intervalMs);

  return {
    runNow: runTick,
    stop: () => {
      clearTimeout(initialTimer);
      clearInterval(recurringTimer);
    }
  };
}
