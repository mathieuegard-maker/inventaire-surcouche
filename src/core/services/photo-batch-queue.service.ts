// src/core/services/photo-batch-queue.service.ts
// File persistante de capture photo en rafale + traitement asynchrone en arrière-plan
// tant que l'application reste ouverte, avec suivi détaillé (photos IA, recherches, sûrs/doutes/non-trouvés).

import { computed, ref } from 'vue';
import { databaseService, type PhotoScanJobRecord } from '../database/database.service';
import { byokVisionService } from './byok-vision.service';
import {
  photoBookResolutionService,
  type PhotoBatchResolutionResult,
  type ResolvedPhotoItem
} from './photo-book-resolution.service';
import { normalizeTextKey } from '../resolvers/bnf.resolver';

const jobs = ref<PhotoScanJobRecord[]>([]);
const isProcessing = ref(false);
const currentStatusMessage = ref('');
const wakeLockActive = ref(false);
let workerLoopPromise: Promise<void> | null = null;
let wakeLockSentinel: { release?: () => Promise<void> } | null = null;

async function acquireWakeLock(): Promise<void> {
  try {
    const nav = typeof navigator !== 'undefined' ? (navigator as any) : null;
    if (nav?.wakeLock?.request) {
      wakeLockSentinel = await nav.wakeLock.request('screen');
      wakeLockActive.value = true;
    }
  } catch {
    wakeLockActive.value = false;
  }
}

async function releaseWakeLock(): Promise<void> {
  try {
    if (wakeLockSentinel?.release) {
      await wakeLockSentinel.release();
    }
  } catch {
    // Ignore
  } finally {
    wakeLockSentinel = null;
    wakeLockActive.value = false;
  }
}

async function refreshJobs(): Promise<void> {
  jobs.value = await databaseService.getPhotoScanJobs();
}

export interface PhotoQueueStats {
  totalPhotos: number;
  aiDonePhotos: number;
  donePhotos: number;
  errorPhotos: number;
  pendingPhotos: number;
  totalBooksDetected: number;
  totalExternalLookups: number;
  sureCount: number;
  doubtCount: number;
  unresolvedCount: number;
  seriesExtraCount: number;
}

const stats = computed<PhotoQueueStats>(() => {
  let aiDonePhotos = 0;
  let donePhotos = 0;
  let errorPhotos = 0;
  let pendingPhotos = 0;
  let totalBooksDetected = 0;
  let totalExternalLookups = 0;
  let sureCount = 0;
  let doubtCount = 0;
  let unresolvedCount = 0;
  let seriesExtraCount = 0;

  for (const job of jobs.value) {
    if (job.status === 'pending' || job.status === 'ai_running') {
      pendingPhotos++;
    } else if (job.status === 'resolving') {
      aiDonePhotos++;
      pendingPhotos++;
    } else if (job.status === 'done') {
      aiDonePhotos++;
      donePhotos++;
    } else if (job.status === 'error') {
      errorPhotos++;
    }

    totalBooksDetected += job.candidatesCount || 0;
    totalExternalLookups += job.externalLookupsCount || 0;

    if (job.result) {
      for (const item of job.result.detectedItems) {
        if (item.status === 'resolved') sureCount++;
        else if (item.status === 'doubt') doubtCount++;
        else unresolvedCount++;
      }
      seriesExtraCount += job.result.seriesExtraItems.length;
    }
  }

  return {
    totalPhotos: jobs.value.length,
    aiDonePhotos,
    donePhotos,
    errorPhotos,
    pendingPhotos,
    totalBooksDetected,
    totalExternalLookups,
    sureCount,
    doubtCount,
    unresolvedCount,
    seriesExtraCount
  };
});

async function runWorkerLoop(): Promise<void> {
  if (isProcessing.value) return;
  isProcessing.value = true;
  await acquireWakeLock();

  try {
    while (true) {
      await refreshJobs();
      const nextJob = jobs.value.find((j) => j.status === 'pending');
      if (!nextJob || typeof nextJob.id !== 'number') break;

      const jobId = nextJob.id;
      const doneIdx = jobs.value.filter((j) => j.status === 'done' || j.status === 'error').length + 1;
      const total = jobs.value.length;

      try {
        await databaseService.updatePhotoScanJob(jobId, {
          status: 'ai_running',
          errorMessage: undefined,
          updatedAt: Date.now()
        });
        await refreshJobs();

        currentStatusMessage.value = `Photo ${doneIdx}/${total} : lecture visuelle par l'IA...`;
        const candidates = await byokVisionService.analyzePhoto(
          nextJob.imageDataUrl,
          nextJob.mode,
          (msg) => {
            currentStatusMessage.value = `Photo ${doneIdx}/${total} : ${msg}`;
          }
        );

        let jobLookups = 0;
        await databaseService.updatePhotoScanJob(jobId, {
          status: 'resolving',
          candidatesCount: candidates.length,
          externalLookupsCount: 0,
          updatedAt: Date.now()
        });
        await refreshJobs();

        let result: PhotoBatchResolutionResult;
        if (candidates.length === 0) {
          result = { detectedItems: [], seriesExtraItems: [], detectedSeriesNames: [] };
        } else {
          result = await photoBookResolutionService.resolveCandidatesAndDiscoverSeries(
            candidates,
            (msg) => {
              currentStatusMessage.value = `Photo ${doneIdx}/${total} : ${msg}`;
            },
            (delta) => {
              jobLookups += delta;
              const live = jobs.value.find((j) => j.id === jobId);
              if (live) live.externalLookupsCount = jobLookups;
            }
          );
        }

        await databaseService.updatePhotoScanJob(jobId, {
          status: 'done',
          candidatesCount: candidates.length,
          externalLookupsCount: jobLookups,
          result,
          updatedAt: Date.now()
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Erreur lors du traitement de la photo.';
        await databaseService.updatePhotoScanJob(jobId, {
          status: 'error',
          errorMessage: msg,
          updatedAt: Date.now()
        });
      }
      await refreshJobs();
    }

    currentStatusMessage.value =
      stats.value.donePhotos > 0
        ? `Traitement terminé : ${stats.value.donePhotos} photo(s) prête(s) à valider.`
        : '';
  } finally {
    isProcessing.value = false;
    await releaseWakeLock();
    workerLoopPromise = null;
  }
}

export const photoBatchQueueService = {
  jobs,
  stats,
  isProcessing,
  currentStatusMessage,
  wakeLockActive,

  async initAndResume(): Promise<void> {
    await refreshJobs();
    // Si un onglet a été fermé en plein traitement, remettre ces photos en pending
    for (const job of jobs.value) {
      if ((job.status === 'ai_running' || job.status === 'resolving') && typeof job.id === 'number') {
        await databaseService.updatePhotoScanJob(job.id, {
          status: 'pending',
          updatedAt: Date.now()
        });
      }
    }
    await refreshJobs();
    if (jobs.value.some((j) => j.status === 'pending')) {
      this.ensureProcessing();
    }
  },

  ensureProcessing(): void {
    if (!workerLoopPromise) {
      workerLoopPromise = runWorkerLoop();
    }
  },

  async enqueuePhotos(files: File[], mode: 'cover' | 'shelf'): Promise<number> {
    if (files.length === 0) return 0;
    currentStatusMessage.value = `Compression de ${files.length} photo(s) en WebP...`;

    let added = 0;
    for (const file of files) {
      const imageDataUrl = await byokVisionService.compressForMode(file, mode);
      await databaseService.addPhotoScanJob({
        mode,
        imageDataUrl,
        status: 'pending',
        candidatesCount: 0,
        externalLookupsCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      added++;
    }

    await refreshJobs();
    this.ensureProcessing();
    return added;
  },

  async retryFailedJobs(): Promise<void> {
    await refreshJobs();
    for (const job of jobs.value) {
      if (job.status === 'error' && typeof job.id === 'number') {
        await databaseService.updatePhotoScanJob(job.id, {
          status: 'pending',
          errorMessage: undefined,
          updatedAt: Date.now()
        });
      }
    }
    await refreshJobs();
    this.ensureProcessing();
  },

  async removeJob(id: number): Promise<void> {
    await databaseService.deletePhotoScanJob(id);
    await refreshJobs();
  },

  async clearCompletedJobs(): Promise<void> {
    await refreshJobs();
    for (const job of jobs.value) {
      if (job.status === 'done' && typeof job.id === 'number') {
        await databaseService.deletePhotoScanJob(job.id);
      }
    }
    await refreshJobs();
    if (jobs.value.length === 0) {
      currentStatusMessage.value = '';
    }
  },

  async clearAllJobs(): Promise<void> {
    await databaseService.clearPhotoScanJobs();
    await refreshJobs();
    currentStatusMessage.value = '';
  },

  getAggregatedResults(): {
    sureItems: ResolvedPhotoItem[];
    doubtItems: ResolvedPhotoItem[];
    unresolvedItems: ResolvedPhotoItem[];
    seriesExtraItems: ResolvedPhotoItem[];
    detectedSeriesNames: string[];
  } {
    const seenSureIsbns = new Set<string>();
    const seenExtraIsbns = new Set<string>();
    const seenSeriesKeys = new Set<string>();

    const sureItems: ResolvedPhotoItem[] = [];
    const doubtItems: ResolvedPhotoItem[] = [];
    const unresolvedItems: ResolvedPhotoItem[] = [];
    const seriesExtraItems: ResolvedPhotoItem[] = [];
    const detectedSeriesNames: string[] = [];

    for (const job of jobs.value) {
      if (job.status !== 'done' || !job.result) continue;

      for (const item of job.result.detectedItems) {
        if (item.status === 'resolved') {
          if (item.isbn13 && seenSureIsbns.has(item.isbn13)) continue;
          if (item.isbn13) seenSureIsbns.add(item.isbn13);
          sureItems.push(item);
        } else if (item.status === 'doubt') {
          doubtItems.push(item);
        } else {
          unresolvedItems.push(item);
        }
      }

      for (const sName of job.result.detectedSeriesNames) {
        const sk = normalizeTextKey(sName);
        if (sk && !seenSeriesKeys.has(sk)) {
          seenSeriesKeys.add(sk);
          detectedSeriesNames.push(sName);
        }
      }

      for (const extra of job.result.seriesExtraItems) {
        if (extra.isbn13 && (seenSureIsbns.has(extra.isbn13) || seenExtraIsbns.has(extra.isbn13))) {
          continue;
        }
        if (extra.isbn13) seenExtraIsbns.add(extra.isbn13);
        seriesExtraItems.push(extra);
      }
    }

    return { sureItems, doubtItems, unresolvedItems, seriesExtraItems, detectedSeriesNames };
  }
};
