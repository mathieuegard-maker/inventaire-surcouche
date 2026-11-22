// src/core/services/photo-batch-queue.service.ts
// Orchestrateur client des lots Photo IA :
// - Mode principal : exécution en tâche de fond côté serveur (/api/v2/photo-jobs) isolée par compte,
//   permettant de fermer l'application immédiatement après l'envoi des photos et de retrouver les résultats prêts à valider.
// - Polling léger (3 s) uniquement tant qu'au moins une photo est en cours de traitement côté serveur.

import { computed, ref } from 'vue';
import { connectionState, fetchWithTimeout } from '../../state/connection';
import { sessionStore } from '../../state/session';
import { databaseService, type PhotoScanJobRecord } from '../database/database.service';
import { byokVisionService } from './byok-vision.service';
import type { ResolvedPhotoItem } from './photo-book-resolution.service';
import type { ServerPhotoScanJob } from './photo-scan-jobs.service';
import { normalizeTextKey } from '../resolvers/bnf.resolver';

const jobs = ref<PhotoScanJobRecord[]>([]);
const isProcessing = ref(false);
const currentStatusMessage = ref('');
const wakeLockActive = ref(false);
let pollTimer: ReturnType<typeof setInterval> | null = null;

function mapServerJobToLocalRecord(job: ServerPhotoScanJob, idx: number): PhotoScanJobRecord {
  return {
    id: idx + 1,
    serverJobId: job.id,
    mode: job.mode,
    imageDataUrl: job.imageDataUrl,
    status: job.status,
    errorMessage: job.errorMessage,
    candidatesCount: job.candidatesCount,
    externalLookupsCount: job.externalLookupsCount,
    result: job.result,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
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

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function updateStatusMessageFromJobs() {
  const active = jobs.value.filter(
    (j) => j.status === 'pending' || j.status === 'ai_running' || j.status === 'resolving'
  );
  if (active.length > 0) {
    isProcessing.value = true;
    const first = active[0];
    if (first.status === 'resolving' && first.candidatesCount) {
      currentStatusMessage.value = `Traitement serveur : recherche BnF (${first.externalLookupsCount || 0}/${first.candidatesCount} livres)... Vous pouvez fermer l’application et revenir plus tard.`;
    } else {
      currentStatusMessage.value = `Traitement serveur : analyse IA en cours (${active.length} photo(s))... Vous pouvez fermer l’application et revenir plus tard.`;
    }
    return;
  }

  isProcessing.value = false;
  stopPolling();
  if (stats.value.donePhotos > 0) {
    currentStatusMessage.value = `Traitement terminé : ${stats.value.donePhotos} photo(s) prête(s) à valider.`;
  } else {
    currentStatusMessage.value = '';
  }
}

async function syncFromServer(): Promise<boolean> {
  if (connectionState.isOffline.value || typeof fetch !== 'function') return false;
  try {
    const savedUri = sessionStore.getUserUri() || '';
    const qs = savedUri ? `?userUri=${encodeURIComponent(savedUri)}` : '';
    const res = await fetchWithTimeout(`/api/v2/photo-jobs${qs}`, { timeout: 10000 });
    if (!res?.ok) return false;
    const data = (await res.json()) as { ok?: boolean; jobs?: ServerPhotoScanJob[] };
    if (!data?.ok || !Array.isArray(data.jobs)) return false;

    jobs.value = data.jobs.map((j, idx) => mapServerJobToLocalRecord(j, idx));
    updateStatusMessageFromJobs();
    if (isProcessing.value && !pollTimer) {
      pollTimer = setInterval(() => {
        void syncFromServer();
      }, 3000);
    }
    return true;
  } catch {
    return false;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void syncFromServer();
    }
  });
}

export const photoBatchQueueService = {
  jobs,
  stats,
  isProcessing,
  currentStatusMessage,
  wakeLockActive,

  async initAndResume(): Promise<void> {
    const synced = await syncFromServer();
    if (!synced) {
      jobs.value = await databaseService.getPhotoScanJobs().catch(() => []);
      updateStatusMessageFromJobs();
    }
  },

  ensureProcessing(): void {
    if (!pollTimer && isProcessing.value) {
      pollTimer = setInterval(() => {
        void syncFromServer();
      }, 3000);
    }
  },

  async enqueuePhotos(files: File[], mode: 'cover' | 'shelf'): Promise<number> {
    if (files.length === 0) return 0;
    currentStatusMessage.value = `Envoi de ${files.length} photo(s) au serveur...`;

    const savedUri = sessionStore.getUserUri() || undefined;
    let added = 0;

    for (const file of files) {
      const imageDataUrl = await byokVisionService.compressForMode(file, mode);
      const res = await fetchWithTimeout('/api/v2/photo-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 20000,
        body: JSON.stringify({
          mode,
          imageDataUrl,
          mimeType: 'image/webp',
          userUri: savedUri
        })
      });
      if (!res?.ok) {
        const errData = await res?.json().catch(() => ({}));
        throw new Error(errData?.error || 'Impossible d’envoyer la photo au serveur.');
      }
      added++;
    }

    await syncFromServer();
    return added;
  },

  async retryFailedJobs(): Promise<void> {
    const savedUri = sessionStore.getUserUri() || undefined;
    await fetchWithTimeout('/api/v2/photo-jobs/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
      body: JSON.stringify({ userUri: savedUri })
    }).catch(() => {});
    await syncFromServer();
  },

  async removeJob(id: number): Promise<void> {
    const target = jobs.value.find((j) => j.id === id);
    if (target?.serverJobId) {
      const savedUri = sessionStore.getUserUri() || '';
      const qs = savedUri ? `?userUri=${encodeURIComponent(savedUri)}` : '';
      await fetchWithTimeout(`/api/v2/photo-jobs/${encodeURIComponent(target.serverJobId)}${qs}`, {
        method: 'DELETE',
        timeout: 10000
      }).catch(() => {});
    } else {
      await databaseService.deletePhotoScanJob(id).catch(() => {});
    }
    await syncFromServer();
  },

  async clearCompletedJobs(): Promise<void> {
    const doneJobs = jobs.value.filter((j) => j.status === 'done');
    const savedUri = sessionStore.getUserUri() || '';
    const qs = savedUri ? `?userUri=${encodeURIComponent(savedUri)}` : '';
    for (const job of doneJobs) {
      if (job.serverJobId) {
        await fetchWithTimeout(`/api/v2/photo-jobs/${encodeURIComponent(job.serverJobId)}${qs}`, {
          method: 'DELETE',
          timeout: 10000
        }).catch(() => {});
      }
    }
    await syncFromServer();
  },

  async clearAllJobs(): Promise<void> {
    stopPolling();
    const savedUri = sessionStore.getUserUri() || '';
    const qs = savedUri ? `?userUri=${encodeURIComponent(savedUri)}` : '';
    await fetchWithTimeout(`/api/v2/photo-jobs${qs}`, {
      method: 'DELETE',
      timeout: 10000
    }).catch(() => {});
    await databaseService.clearPhotoScanJobs().catch(() => {});
    jobs.value = [];
    isProcessing.value = false;
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
        const taggedItem: ResolvedPhotoItem = { ...item, sourceJobId: item.sourceJobId ?? job.id };
        if (taggedItem.status === 'resolved') {
          if (taggedItem.isbn13 && seenSureIsbns.has(taggedItem.isbn13)) continue;
          if (taggedItem.isbn13) seenSureIsbns.add(taggedItem.isbn13);
          sureItems.push(taggedItem);
        } else if (taggedItem.status === 'doubt') {
          doubtItems.push(taggedItem);
        } else {
          unresolvedItems.push(taggedItem);
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
