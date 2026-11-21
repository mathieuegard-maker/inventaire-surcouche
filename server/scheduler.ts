// server/scheduler.ts
// Planificateur interne Node.js en deux rythmes :
// - Passe horaire légère (file d'enrichissement, digests horaires, purge des logs)
// - Passe nocturne complète (02h00 locale : veille de toutes les séries + découverte des éditions sœurs)

import type { AppBackendEnv } from '../src/core/adapters/storage-db.interface';
import { PipelineTracer, purgeOldPipelineLogs } from '../src/core/services/pipeline-logger.service';
import { runCentralizedSeriesReleaseSweep, runHourlyDigestDispatch } from '../src/core/services/series-digest.service';
import { drainEnrichmentQueueBatch, runSilentEditionDiscoveryPass } from '../src/core/services/v4-pipeline.service';

export interface SelfHostedSchedulerOptions {
  intervalMinutes?: number;
  initialDelaySeconds?: number;
  enrichmentBatchSize?: number;
  nightlyHour?: number;
  nightlyDelayMs?: number;
}

export function startSelfHostedScheduler(
  env: AppBackendEnv,
  options: SelfHostedSchedulerOptions = {}
): { stop: () => void; runNow: () => Promise<void>; runNightlyNow: () => Promise<void> } {
  const intervalMs = Math.max(5, options.intervalMinutes ?? 60) * 60 * 1000;
  const initialDelayMs = Math.max(5, options.initialDelaySeconds ?? 90) * 1000;
  const enrichmentBatchSize = options.enrichmentBatchSize ?? 15;
  const nightlyHour = Math.min(23, Math.max(0, options.nightlyHour ?? 2));
  const nightlyDelayMs = Math.max(0, options.nightlyDelayMs ?? 300);

  let isHourlyRunning = false;
  let isNightlyRunning = false;
  let lastNightlyDate = '';

  const runNightlyTick = async () => {
    if (isNightlyRunning) return;
    isNightlyRunning = true;
    const start = Date.now();
    const tracer = new PipelineTracer({ sourceChannel: 'cron_enrichment' });
    try {
      const sweepRes = await runCentralizedSeriesReleaseSweep(env.DB, {
        limit: 500,
        staleDays: 1,
        delayMs: nightlyDelayMs
      }).catch(() => ({
        checkedCount: 0,
        alertsCreated: 0
      }));

      const silentRes = await runSilentEditionDiscoveryPass(env.DB, {
        limit: 500,
        staleDays: 7,
        delayMs: nightlyDelayMs
      }).catch(() => ({
        checkedBooks: 0,
        newIsbnsIndexed: 0
      }));

      tracer.record(
        'CRON',
        'self_hosted_cron_nightly',
        'ok',
        `CRON nocturne complet : ${sweepRes.checkedCount} série(s) (+${sweepRes.alertsCreated} alertes), ${silentRes.checkedBooks} livre(s) (+${silentRes.newIsbnsIndexed} ISBN sœurs)`,
        { sweepRes, silentRes },
        Date.now() - start
      );
      await tracer.flush(env.DB).catch(() => {});
      console.log(
        `[CRON NOCTURNE] Terminé en ${Date.now() - start}ms — séries: ${sweepRes.checkedCount} (+${sweepRes.alertsCreated} alertes), sœurs: ${silentRes.checkedBooks} (+${silentRes.newIsbnsIndexed} ISBN)`
      );
    } catch (err) {
      console.error('[CRON NOCTURNE] Erreur pendant la passe nocturne :', err);
    } finally {
      isNightlyRunning = false;
    }
  };

  const runHourlyTick = async () => {
    if (isHourlyRunning) return;
    isHourlyRunning = true;
    const start = Date.now();
    const tracer = new PipelineTracer({ sourceChannel: 'cron_enrichment' });
    try {
      const queueRes = await drainEnrichmentQueueBatch(env.DB, enrichmentBatchSize).catch((err) => ({
        processed: 0,
        succeeded: 0,
        failed: 1,
        error: err instanceof Error ? err.message : String(err)
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
        `CRON horaire : queue ${queueRes.succeeded}/${queueRes.processed}, digests ${digestRes.usersNotified} util., purge logs:${purgeRes.deletedOk + purgeRes.deletedWarnErr}`,
        { queueRes, digestRes, purgeRes },
        Date.now() - start
      );
      await tracer.flush(env.DB).catch(() => {});
      console.log(
        `[CRON] Passe horaire terminée en ${Date.now() - start}ms — queue: ${queueRes.succeeded}/${queueRes.processed}, digests: ${digestRes.usersNotified}`
      );

      // Déclenchement de la passe nocturne complète une fois par nuit à l'heure configurée (défaut 02h00)
      const nowDate = new Date();
      const todayKey = nowDate.toISOString().slice(0, 10);
      if (nowDate.getHours() === nightlyHour && lastNightlyDate !== todayKey) {
        lastNightlyDate = todayKey;
        await runNightlyTick();
      }
    } catch (err) {
      console.error('[CRON] Erreur pendant la passe horaire :', err);
    } finally {
      isHourlyRunning = false;
    }
  };

  const initialTimer = setTimeout(() => {
    void runHourlyTick();
  }, initialDelayMs);

  const recurringTimer = setInterval(() => {
    void runHourlyTick();
  }, intervalMs);

  return {
    runNow: runHourlyTick,
    runNightlyNow: runNightlyTick,
    stop: () => {
      clearTimeout(initialTimer);
      clearInterval(recurringTimer);
    }
  };
}
