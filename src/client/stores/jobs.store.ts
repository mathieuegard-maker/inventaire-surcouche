// src/client/stores/jobs.store.ts
// Store Pinia global unique pour le suivi temps réel des tâches longues serveur (`background_jobs`) via SSE.

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { apiRequest } from '../api/client';
import { useLibraryStore } from './library.store';
import type { BackgroundJobView } from '../../shared/types/domain.types';

export const useJobsStore = defineStore('jobs', () => {
  const jobs = ref<BackgroundJobView[]>([]);
  const isStreamConnected = ref(false);

  let eventSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const activeJobs = computed(() =>
    jobs.value.filter((j) => j.status === 'pending' || j.status === 'running')
  );

  const hasRunningJobs = computed(() => activeJobs.value.length > 0);

  const latestPhotoJob = computed(() =>
    jobs.value.find((j) => j.type === 'photo_ocr') ?? null
  );

  const activePhotoCommitJob = computed(() =>
    jobs.value.find((j) => j.type === 'photo_commit' && (j.status === 'pending' || j.status === 'running')) ?? null
  );

  const latestCollectionImportJob = computed(() =>
    jobs.value.find((j) => j.type === 'collection_import') ?? null
  );

  const activeSeriesEnrichJob = computed(() =>
    jobs.value.find((j) => j.type === 'series_enrich_volumes' && (j.status === 'pending' || j.status === 'running')) ??
    null
  );

  function upsertJob(incoming: BackgroundJobView): void {
    const idx = jobs.value.findIndex((j) => j.id === incoming.id);
    const prevStatus = idx >= 0 ? jobs.value[idx].status : null;
    const prevDone = idx >= 0 ? jobs.value[idx].progressDone : 0;
    if (idx >= 0) {
      jobs.value[idx] = incoming;
    } else {
      jobs.value.unshift(incoming);
    }
    if (
      (incoming.type === 'photo_commit' ||
        incoming.type === 'series_expand' ||
        incoming.type === 'series_enrich_volumes' ||
        incoming.type === 'collection_import') &&
      incoming.status === 'done' &&
      prevStatus !== 'done'
    ) {
      void useLibraryStore().syncNow();
    } else if (
      incoming.type === 'series_enrich_volumes' &&
      incoming.status === 'running' &&
      incoming.progressDone > prevDone &&
      incoming.progressDone % 8 === 0
    ) {
      void useLibraryStore().syncNow();
    }
  }

  async function refreshJobs(): Promise<void> {
    try {
      const res = await apiRequest<{ ok: true; jobs: BackgroundJobView[] }>('/api/jobs');
      jobs.value = res.jobs;
    } catch {
      // ignore si offline ou non connecté
    }
  }

  function connectStream(): void {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    if (eventSource) return;

    const es = new EventSource('/api/jobs/stream', { withCredentials: true });
    eventSource = es;

    es.onopen = () => {
      isStreamConnected.value = true;
    };

    es.addEventListener('snapshot', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent<string>).data) as { jobs: BackgroundJobView[] };
        if (Array.isArray(parsed.jobs)) {
          jobs.value = parsed.jobs;
        }
      } catch {
        // ignore
      }
    });

    es.addEventListener('job', (event) => {
      try {
        const job = JSON.parse((event as MessageEvent<string>).data) as BackgroundJobView;
        if (job?.id) upsertJob(job);
      } catch {
        // ignore
      }
    });

    es.onerror = () => {
      isStreamConnected.value = false;
      es.close();
      eventSource = null;
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectStream();
        }, 5000);
      }
    };
  }

  function disconnectStream(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    isStreamConnected.value = false;
  }

  return {
    jobs,
    activeJobs,
    hasRunningJobs,
    latestPhotoJob,
    activePhotoCommitJob,
    latestCollectionImportJob,
    activeSeriesEnrichJob,
    isStreamConnected,
    upsertJob,
    refreshJobs,
    connectStream,
    disconnectStream
  };
});
