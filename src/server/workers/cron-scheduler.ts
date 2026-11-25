// src/server/workers/cron-scheduler.ts
// CRON calendaire idempotent basé sur `cron_runs` : digests horaires, veille nocturne + purge logs & couvertures orphelines (> 30j), avec rattrapage au démarrage.

import crypto from 'node:crypto';
import type { ServerConfig } from '../config';
import { runWithRequestPriority } from '../connectors/request-priority';
import type { CatalogRepository } from '../repositories/catalog.repo';
import type { JobRepository } from '../repositories/job.repo';
import type { LogRepository } from '../repositories/log.repo';
import type { NotificationRepository } from '../repositories/notification.repo';
import type { CoverService } from '../services/cover.service';
import type { NotificationService } from '../services/notification.service';

export interface HourlyCronReport {
  skipped: boolean;
  runKey: string;
  notifiedUsers: number;
  pushSent: number;
  emailsSent: number;
  expiredCachePurged: number;
}

export interface NightlyCronReport {
  skipped: boolean;
  runKey: string;
  librariesChecked: number;
  newAlertsCount: number;
  logsPurged: number;
  orphanCoversDeleted: number;
  coverCatchupJobsEnqueued: number;
}

export class CronScheduler {
  private readonly config: ServerConfig;
  private readonly jobRepo: JobRepository;
  private readonly logRepo: LogRepository;
  private readonly notifRepo: NotificationRepository;
  private readonly notificationService: NotificationService;
  private readonly coverService: CoverService;
  private readonly catalogRepo?: CatalogRepository;
  private readonly onJobEnqueued?: () => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: {
    config: ServerConfig;
    jobRepo: JobRepository;
    logRepo: LogRepository;
    notifRepo: NotificationRepository;
    notificationService: NotificationService;
    coverService: CoverService;
    catalogRepo?: CatalogRepository;
    onJobEnqueued?: () => void;
  }) {
    this.config = deps.config;
    this.jobRepo = deps.jobRepo;
    this.logRepo = deps.logRepo;
    this.notifRepo = deps.notifRepo;
    this.notificationService = deps.notificationService;
    this.coverService = deps.coverService;
    this.catalogRepo = deps.catalogRepo;
    this.onJobEnqueued = deps.onJobEnqueued;
  }

  /**
   * Passe horaire idempotente (`YYYY-MM-DDTHH`) : digests Push/E-mail + purge external_cache expiré.
   */
  async runHourlyPass(nowDate = new Date()): Promise<HourlyCronReport> {
    const runKey = nowDate.toISOString().slice(0, 13); // ex: 2026-11-23T14
    const existing = this.jobRepo.getCronRun('hourly_digest');
    if (existing && existing.last_run_key === runKey && existing.status === 'ok') {
      return {
        skipped: true,
        runKey,
        notifiedUsers: 0,
        pushSent: 0,
        emailsSent: 0,
        expiredCachePurged: 0
      };
    }

    const nowIso = nowDate.toISOString();
    const digest = await this.notificationService.runHourlyDigestDispatch(nowDate);
    const expiredCachePurged = this.jobRepo.purgeExpiredExternalCache(nowIso);

    const summary = { ...digest, expiredCachePurged };
    this.jobRepo.upsertCronRun({
      job_name: 'hourly_digest',
      last_run_key: runKey,
      last_run_at: nowIso,
      status: 'ok',
      summary_json: JSON.stringify(summary)
    });

    return { skipped: false, runKey, ...summary };
  }

  /**
   * Passe nocturne idempotente (`YYYY-MM-DD`, rattrapée après redémarrage si heure >= cronNightlyHour) :
   * - Veille nouveautés de tous les foyers
   * - Purge TTL des pipeline_logs (> 30 jours)
   * - Purge des couvertures orphelines sur disque `/data/covers/` (> 30 jours)
   */
  async runNightlyPass(nowDate = new Date(), options?: { force?: boolean }): Promise<NightlyCronReport> {
    const runKey = nowDate.toISOString().slice(0, 10); // ex: 2026-11-23
    const existing = this.jobRepo.getCronRun('nightly_sweep');

    if (!options?.force) {
      if (nowDate.getHours() < this.config.cronNightlyHour) {
        return {
          skipped: true,
          runKey,
          librariesChecked: 0,
          newAlertsCount: 0,
          logsPurged: 0,
          orphanCoversDeleted: 0,
          coverCatchupJobsEnqueued: 0
        };
      }
      if (existing && existing.last_run_key === runKey && existing.status === 'ok') {
        return {
          skipped: true,
          runKey,
          librariesChecked: 0,
          newAlertsCount: 0,
          logsPurged: 0,
          orphanCoversDeleted: 0,
          coverCatchupJobsEnqueued: 0
        };
      }
    }

    const nowIso = nowDate.toISOString();
    const libraryIds = this.notifRepo.listAllLibraryIds();
    let newAlertsCount = 0;

    await runWithRequestPriority('low', async () => {
      for (const libId of libraryIds) {
        const res = await this.notificationService.checkReleasesForLibrary(libId);
        newAlertsCount += res.newAlertsCount;
      }
    });

    const logsCutoff = new Date(nowDate.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const logsPurged = this.logRepo.purgeOlderThan(logsCutoff);
    const coverPurge = await this.coverService.purgeOrphanCovers(30, nowDate.getTime());

    // Filet de sécurité nocturne : reprogramme jusqu'à 3 séries ayant encore des tomes sans couverture
    let coverCatchupJobsEnqueued = 0;
    if (this.catalogRepo) {
      const seriesWithMissingCovers = this.catalogRepo.listSeriesIdsWithMissingCovers(3);
      for (const seriesId of seriesWithMissingCovers) {
        const activeExpand = this.jobRepo.findActiveJobByTypeAndPayloadKey('series_expand', seriesId);
        const activeEnrich = this.jobRepo.findActiveJobByTypeAndPayloadKey('series_enrich_volumes', seriesId);
        if (activeExpand || activeEnrich) continue;
        this.jobRepo.createJob({
          id: `job_${crypto.randomBytes(6).toString('hex')}`,
          type: 'series_enrich_volumes',
          userId: null,
          libraryId: null,
          payload: { seriesId, source: 'nightly_catchup' },
          progressTotal: 1,
          now: nowIso
        });
        coverCatchupJobsEnqueued++;
      }
      if (coverCatchupJobsEnqueued > 0) {
        this.onJobEnqueued?.();
      }
    }

    const summary = {
      librariesChecked: libraryIds.length,
      newAlertsCount,
      logsPurged,
      orphanCoversDeleted: coverPurge.deletedCount,
      coverCatchupJobsEnqueued
    };

    this.jobRepo.upsertCronRun({
      job_name: 'nightly_sweep',
      last_run_key: runKey,
      last_run_at: nowIso,
      status: 'ok',
      summary_json: JSON.stringify(summary)
    });

    this.logRepo.append({
      traceId: `cron_${runKey}`,
      channel: 'cron',
      stage: 'nightly_sweep',
      step: 'complete',
      status: 'ok',
      summary: `Veille nocturne : ${libraryIds.length} foyer(s), ${newAlertsCount} alerte(s), ${coverPurge.deletedCount} couverture(s) orpheline(s) purgée(s), ${coverCatchupJobsEnqueued} rattrapage(s) couverture programmé(s).`,
      payload: summary,
      now: nowIso
    });

    return { skipped: false, runKey, ...summary };
  }

  start(): void {
    if (!this.config.cronEnabled || this.timer) return;

    const tick = async () => {
      try {
        await this.runHourlyPass(new Date());
        await this.runNightlyPass(new Date());
      } catch {
        // journalisé au niveau interne, ne jamais crasher la boucle CRON
      }
    };

    // Rattrapage immédiat après redémarrage Docker, puis vérification toutes les 10 min (idempotent via cron_runs)
    void tick();
    this.timer = setInterval(() => {
      void tick();
    }, 10 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
