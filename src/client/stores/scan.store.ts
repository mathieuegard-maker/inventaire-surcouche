// src/client/stores/scan.store.ts
// Store Pinia persistant pour l'acquisition 4 onglets : Photo IA (serveur), Rafale, Scan simple et Recherche textuelle.

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { apiRequest } from '../api/client';
import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import type { BackgroundJobView, BookView, OwnershipStatus, SeriesView } from '../../shared/types/domain.types';
import { useJobsStore } from './jobs.store';
import { useLibraryStore } from './library.store';
import { useAuthStore } from './auth.store';

export type ScanTab = 'photo' | 'burst' | 'simple' | 'search';

export interface PhotoCandidateOption {
  isbn13: string;
  title: string;
  seriesName: string | null;
  volumeNumber: string | null;
  authors: string[];
  publisher: string | null;
  publishYear: string | null;
  coverUrl: string | null;
  source: string;
}

export interface PhotoJobItem {
  id: string;
  spineIndex?: number;
  totalSpines?: number;
  hint: {
    spineIndex?: number;
    rawText?: string;
    title: string;
    series?: string;
    volumeNumber?: string;
    author?: string;
    publisher?: string;
    isbn?: string;
    confidence: 'high' | 'medium' | 'low';
  };
  status: 'identified' | 'doubt' | 'unresolved';
  options: PhotoCandidateOption[];
  fallbackCoverUrl?: string | null;
  selectedOptionIsbn13: string | null;
  selected: boolean;
  ignored: boolean;
  alreadyStatus: OwnershipStatus;
  isIntegral: boolean;
  includedVolumes: string[];
  committedBookId: string | null;
}

export interface PhotoJobResultPayload {
  mode: 'shelf' | 'cover';
  previewCoverKey: string | null;
  previewUrl: string | null;
  items: PhotoJobItem[];
}

export interface BurstScannedItem {
  isbn13: string;
  status: 'resolving' | 'found' | 'not_found';
  book: BookView | null;
  scannedAt: string;
}

export interface ExternalSearchHit {
  isbn13: string;
  title: string;
  seriesName: string | null;
  volumeNumber: string | null;
  authors: string[];
  publisher: string | null;
  collectionName: string | null;
  publishYear: string | null;
  coverUrl: string | null;
  source: string;
}

export interface SearchFormFields {
  title: string;
  series: string;
  volumeNumber: string;
  author: string;
  collection: string;
  publisher: string;
  isbn: string;
}

export const useScanStore = defineStore('scan', () => {
  const activeTab = ref<ScanTab>('photo');

  // Mode Rafale persistant entre navigations
  const burstItems = ref<BurstScannedItem[]>([]);

  // Recherche textuelle persistante (7 champs + résultats)
  const searchForm = ref<SearchFormFields>({
    title: '',
    series: '',
    volumeNumber: '',
    author: '',
    collection: '',
    publisher: '',
    isbn: ''
  });
  const searchLoading = ref(false);
  const hasSearched = ref(false);
  const searchSeries = ref<SeriesView[]>([]);
  const searchBooks = ref<BookView[]>([]);
  const searchExternalBooks = ref<ExternalSearchHit[]>([]);

  // ==================== PHOTO IA (100 % SERVEUR) ====================

  async function submitPhotoJob(input: {
    mode: 'shelf' | 'cover';
    imageDataUrl: string;
    mimeType: string;
  }): Promise<BackgroundJobView> {
    const res = await apiRequest<{
      ok: true;
      job: BackgroundJobView;
      quota: { monthKey: string; used: number; limit: number; remaining: number };
    }>('/api/jobs/photo', {
      method: 'POST',
      body: input,
      timeoutMs: 45000
    });

    const jobsStore = useJobsStore();
    jobsStore.upsertJob(res.job);

    const authStore = useAuthStore();
    if (authStore.profile) {
      authStore.profile = { ...authStore.profile, aiQuota: res.quota };
    }
    return res.job;
  }

  async function updatePhotoItem(
    jobId: string,
    itemId: string,
    patch: {
      selected?: boolean;
      ignored?: boolean;
      selectedOptionIsbn13?: string | null;
      isIntegral?: boolean;
      includedVolumes?: string[];
    }
  ): Promise<BackgroundJobView> {
    const res = await apiRequest<{ ok: true; job: BackgroundJobView }>(
      `/api/jobs/photo/${encodeURIComponent(jobId)}/items/${encodeURIComponent(itemId)}`,
      {
        method: 'PATCH',
        body: patch
      }
    );
    useJobsStore().upsertJob(res.job);
    return res.job;
  }

  async function retryPhotoItemBnf(
    jobId: string,
    itemId: string,
    hints: {
      title?: string;
      series?: string;
      volumeNumber?: string;
      author?: string;
      publisher?: string;
      isbn?: string;
    }
  ): Promise<{ job: BackgroundJobView; item: PhotoJobItem }> {
    const res = await apiRequest<{ ok: true; job: BackgroundJobView; item: PhotoJobItem }>(
      `/api/jobs/photo/${encodeURIComponent(jobId)}/items/${encodeURIComponent(itemId)}/retry-bnf`,
      {
        method: 'POST',
        body: hints,
        timeoutMs: 45000
      }
    );
    useJobsStore().upsertJob(res.job);
    return { job: res.job, item: res.item };
  }

  async function retryPhotoJobFailed(jobId: string): Promise<BackgroundJobView> {
    const res = await apiRequest<{ ok: true; job: BackgroundJobView }>(
      `/api/jobs/photo/${encodeURIComponent(jobId)}/retry-failed`,
      { method: 'POST' }
    );
    useJobsStore().upsertJob(res.job);
    return res.job;
  }

  async function commitPhotoJob(jobId: string, targetStatus: 'owned' | 'wish'): Promise<number> {
    const res = await apiRequest<{ ok: true; committedCount: number; job: BackgroundJobView }>(
      `/api/jobs/photo/${encodeURIComponent(jobId)}/commit`,
      {
        method: 'POST',
        body: { targetStatus }
      }
    );
    useJobsStore().upsertJob(res.job);
    await useLibraryStore().syncNow();
    return res.committedCount;
  }

  async function deletePhotoJob(jobId: string): Promise<void> {
    await apiRequest(`/api/jobs/photo/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
    const jobsStore = useJobsStore();
    jobsStore.jobs = jobsStore.jobs.filter((j) => j.id !== jobId);
  }

  // ==================== RAFALE (CODE-BARRES) ====================

  function captureBurstIsbn(rawIsbn: string): { status: 'added' | 'duplicate' | 'invalid'; isbn13: string } {
    const isbn13 = isbnUtil.normalizeToIsbn13(rawIsbn);
    if (!isbn13) return { status: 'invalid', isbn13: rawIsbn };

    if (burstItems.value.some((it) => it.isbn13 === isbn13)) {
      return { status: 'duplicate', isbn13 };
    }

    const entry: BurstScannedItem = {
      isbn13,
      status: 'resolving',
      book: null,
      scannedAt: new Date().toISOString()
    };
    burstItems.value.unshift(entry);
    void resolveBurstEntry(isbn13);
    return { status: 'added', isbn13 };
  }

  async function resolveBurstEntry(isbn13: string): Promise<void> {
    const libraryStore = useLibraryStore();
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const book = await libraryStore.resolveIsbnPreview(isbn13);
        const target = burstItems.value.find((it) => it.isbn13 === isbn13);
        if (!target) return;
        if (book) {
          target.status = 'found';
          target.book = book;
        } else {
          target.status = 'not_found';
        }
        return;
      } catch {
        if (attempt === 1) {
          // Si la 1re tentative a expiré pendant un job IA lourd, retenter 1 fois (le serveur aura souvent déjà mis en cache l'ISBN)
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        const target = burstItems.value.find((it) => it.isbn13 === isbn13);
        if (target) target.status = 'not_found';
      }
    }
  }

  function removeBurstItem(isbn13: string): void {
    burstItems.value = burstItems.value.filter((it) => it.isbn13 !== isbn13);
  }

  function clearBurstItems(): void {
    burstItems.value = [];
  }

  // ==================== RECHERCHE TEXTUELLE MULTI-CRITÈRES ====================

  async function runCatalogSearch(): Promise<void> {
    const f = searchForm.value;
    const hasAny = Object.values(f).some((v) => v.trim().length > 0);
    if (!hasAny) return;

    searchLoading.value = true;
    hasSearched.value = true;
    try {
      const res = await apiRequest<{
        ok: true;
        series: SeriesView[];
        books: BookView[];
        externalBooks: ExternalSearchHit[];
      }>('/api/search/catalog', {
        method: 'POST',
        body: {
          title: f.title.trim() || undefined,
          series: f.series.trim() || undefined,
          volumeNumber: f.volumeNumber.trim() || undefined,
          author: f.author.trim() || undefined,
          collection: f.collection.trim() || undefined,
          publisher: f.publisher.trim() || undefined,
          isbn: f.isbn.trim() || undefined
        },
        timeoutMs: 45000
      });
      searchSeries.value = res.series;
      searchBooks.value = res.books;
      searchExternalBooks.value = res.externalBooks;
    } finally {
      searchLoading.value = false;
    }
  }

  function clearSearchForm(): void {
    searchForm.value = {
      title: '',
      series: '',
      volumeNumber: '',
      author: '',
      collection: '',
      publisher: '',
      isbn: ''
    };
    hasSearched.value = false;
    searchSeries.value = [];
    searchBooks.value = [];
    searchExternalBooks.value = [];
  }

  return {
    activeTab,
    burstItems,
    searchForm,
    searchLoading,
    hasSearched,
    searchSeries,
    searchBooks,
    searchExternalBooks,
    submitPhotoJob,
    updatePhotoItem,
    retryPhotoItemBnf,
    retryPhotoJobFailed,
    commitPhotoJob,
    deletePhotoJob,
    captureBurstIsbn,
    removeBurstItem,
    clearBurstItems,
    runCatalogSearch,
    clearSearchForm
  };
});
