<!-- src/client/views/ScanView.vue -->
<!-- Hub d'acquisition unifié (V2.6 mobile-first) : Photo IA (multi-photos, notification push & historique 30j),
     Mode Rafale (sélection persistante), Scan simple, Recherche multi-critères, Importer et Création manuelle. -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  Bell,
  Camera,
  Clock,
  Image as ImageIcon,
  PlusCircle,
  QrCode,
  RefreshCw,
  ScanBarcode,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X
} from '@lucide/vue';
import BookCard from '../components/books/BookCard.vue';
import SeriesCard from '../components/books/SeriesCard.vue';
import BatchActionBar from '../components/books/BatchActionBar.vue';
import BaseModal from '../components/base/BaseModal.vue';
import CameraBarcodeModal from '../components/modals/CameraBarcodeModal.vue';
import PhotoItemModal from '../components/modals/PhotoItemModal.vue';
import ConfirmDeleteModal from '../components/modals/ConfirmDeleteModal.vue';
import LendModal from '../components/modals/LendModal.vue';
import BatchGenreModal from '../components/modals/BatchGenreModal.vue';
import CollectionImportPanel from '../components/import/CollectionImportPanel.vue';
import { useScanStore, type PhotoJobItem, type PhotoJobResultPayload, type ScanTab } from '../stores/scan.store';
import { useJobsStore } from '../stores/jobs.store';
import { useLibraryStore } from '../stores/library.store';
import { useAuthStore } from '../stores/auth.store';
import { useUiStore } from '../stores/ui.store';
import { filterEligibleBooksForBatchAction, type BatchActionType } from '../../shared/bibliographic/batch-actions.util';
import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import { apiRequest, ApiClientError } from '../api/client';
import type { BackgroundJobView } from '../../shared/types/domain.types';
import { t } from '../../shared/locales';

const route = useRoute();
const router = useRouter();
const scanStore = useScanStore();
const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();
const authStore = useAuthStore();
const uiStore = useUiStore();

const validTabs: ScanTab[] = ['photo', 'burst', 'simple', 'search', 'import'];

const burstCameraOpen = ref(false);
const simpleCameraOpen = ref(false);

function openCameraForTab(tab: ScanTab, explicitClick = false): void {
  if (tab === 'burst') {
    simpleCameraOpen.value = false;
    // N'ouvre pas automatiquement la caméra au retour arrière si la liste Rafale contient déjà des livres
    burstCameraOpen.value = explicitClick || scanStore.burstItems.length === 0;
  } else if (tab === 'simple') {
    burstCameraOpen.value = false;
    simpleCameraOpen.value = true;
  } else {
    burstCameraOpen.value = false;
    simpleCameraOpen.value = false;
  }
}

watch(
  () => route.query.tab,
  (raw) => {
    if (typeof raw === 'string' && validTabs.includes(raw as ScanTab)) {
      const nextTab = raw as ScanTab;
      const changed = scanStore.activeTab !== nextTab;
      scanStore.activeTab = nextTab;
      if (changed || nextTab === 'simple') {
        openCameraForTab(nextTab, false);
      }
      if (nextTab === 'photo') {
        void jobsStore.refreshPhotoHistory();
      }
    }
  },
  { immediate: true }
);

onMounted(() => {
  if (scanStore.activeTab === 'photo') {
    void jobsStore.refreshPhotoHistory();
  }
});

function selectTab(tab: ScanTab): void {
  scanStore.activeTab = tab;
  openCameraForTab(tab, true);
  if (tab === 'photo') {
    void jobsStore.refreshPhotoHistory();
  }
  void router.replace({ path: '/scan', query: { tab } });
}

// ==================== ONGLET 1 : PHOTO IA 100 % SERVEUR ====================
interface QueuedPhoto {
  id: string;
  dataUrl: string;
}

const cameraPhotoInputRef = ref<HTMLInputElement | null>(null);
const galleryPhotoInputRef = ref<HTMLInputElement | null>(null);
const queuedPhotos = ref<QueuedPhoto[]>([]);
const notifyOnComplete = ref(false);
const notifyModalOpen = ref(false);
const notifyEnabling = ref(false);
const notifyPermissionError = ref('');
const photoUploading = ref(false);
const photoSentBanner = ref(false);
const photoRetryingOcr = ref(false);
const photoCommitting = ref(false);
const activePhotoItemId = ref<string | null>(null);

// Navigation entre plusieurs photos actives ou consultation d'une photo de l'historique 30j
const selectedActiveJobId = ref<string | null>(null);
const viewingHistoryJobId = ref<string | null>(null);

const displayedPhotoJob = computed<BackgroundJobView | null>(() => {
  if (viewingHistoryJobId.value) {
    return (
      jobsStore.photoHistory.find((j) => j.id === viewingHistoryJobId.value) ??
      jobsStore.jobs.find((j) => j.id === viewingHistoryJobId.value) ??
      null
    );
  }
  if (selectedActiveJobId.value) {
    const found = jobsStore.activePhotoJobs.find((j) => j.id === selectedActiveJobId.value);
    if (found) return found;
  }
  return jobsStore.latestPhotoJob;
});

const isViewingHistory = computed(() => Boolean(viewingHistoryJobId.value && displayedPhotoJob.value));

function parsePhotoResult(job: BackgroundJobView | null): PhotoJobResultPayload | null {
  const raw = job?.result;
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<PhotoJobResultPayload>;
  return {
    mode: obj.mode === 'cover' ? 'cover' : obj.mode === 'shelf' ? 'shelf' : 'auto',
    previewCoverKey: obj.previewCoverKey ?? null,
    previewUrl: obj.previewUrl ?? (obj.previewCoverKey ? `/api/covers/${obj.previewCoverKey}` : null),
    notifyOnComplete: obj.notifyOnComplete,
    committedAt: obj.committedAt ?? null,
    items: Array.isArray(obj.items) ? obj.items : []
  };
}

const photoResult = computed<PhotoJobResultPayload | null>(() => parsePhotoResult(displayedPhotoJob.value));

const identifiedItems = computed(() =>
  (photoResult.value?.items ?? []).filter((it) => it.status === 'identified')
);
const doubtItems = computed(() =>
  (photoResult.value?.items ?? []).filter((it) => it.status === 'doubt')
);
const unresolvedItems = computed(() =>
  (photoResult.value?.items ?? []).filter((it) => it.status === 'unresolved')
);

const selectedPhotoCount = computed(() =>
  (photoResult.value?.items ?? []).filter((it) => it.selected && !it.ignored && Boolean(it.selectedOptionIsbn13)).length
);

const activePhotoItem = computed<PhotoJobItem | null>(() => {
  if (!activePhotoItemId.value || !photoResult.value) return null;
  return photoResult.value.items.find((it) => it.id === activePhotoItemId.value) ?? null;
});

function findSelectedPhotoOption(item: PhotoJobItem) {
  return (
    item.options.find(
      (o) =>
        o.isbn13 === item.selectedOptionIsbn13 ||
        (item.selectedOptionIsbn13 ? (o.siblingIsbns ?? []).includes(item.selectedOptionIsbn13) : false)
    ) ?? item.options[0]
  );
}

function getPhotoItemCoverUrl(item: PhotoJobItem): string | null {
  if (item.selectedCoverUrl) return item.selectedCoverUrl;
  if (item.selectedCoverKey) return `/api/covers/${item.selectedCoverKey}`;
  const chosen = findSelectedPhotoOption(item);
  return chosen?.coverUrl || item.fallbackCoverUrl || null;
}

function getPhotoItemDisplayTitle(item: PhotoJobItem): string {
  const chosen = findSelectedPhotoOption(item);
  return chosen?.title || item.hint.title;
}

function getPhotoItemSubtitle(item: PhotoJobItem): string {
  const chosen = findSelectedPhotoOption(item);
  const parts: string[] = [];
  const series = chosen?.seriesName || item.hint.series;
  const vol = chosen?.volumeNumber || item.hint.volumeNumber;
  const publisher = chosen?.publisher || item.hint.publisher;
  const author = (chosen?.authors.length ? chosen.authors.join(', ') : '') || item.hint.author;

  if (series) parts.push(series);
  if (vol) parts.push(`T.${vol}`);
  if (publisher) parts.push(publisher);
  else if (author) parts.push(author);
  if ((chosen?.editionCount ?? 1) > 1) {
    parts.push(t('scan.photoEditionsGroupedBadge', { count: chosen!.editionCount! }));
  } else if (item.selectedOptionIsbn13) {
    parts.push(item.selectedOptionIsbn13);
  }
  return parts.join(' · ') || '—';
}

function formatPhotoDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return iso;
  }
}

function summarizeHistoryJob(job: BackgroundJobView): {
  previewUrl: string | null;
  total: number;
  owned: number;
  wish: number;
  ignored: number;
} {
  const parsed = parsePhotoResult(job);
  const items = parsed?.items ?? [];
  const owned = items.filter((it) => it.committedAction === 'owned' || (!it.committedAction && it.committedBookId)).length;
  const wish = items.filter((it) => it.committedAction === 'wish').length;
  const ignored = items.filter((it) => it.ignored).length;
  return {
    previewUrl: parsed?.previewUrl ?? null,
    total: items.length,
    owned,
    wish,
    ignored
  };
}

async function compressPhotoForUpload(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const img = new Image();
      img.onload = () => {
        const maxDim = 2048;
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/webp', 0.88));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    };
    reader.onerror = () => reject(new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}

async function handlePhotoFilesAdded(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  if (files.length === 0) return;

  photoSentBanner.value = false;
  viewingHistoryJobId.value = null;

  for (const file of files) {
    try {
      const dataUrl = await compressPhotoForUpload(file);
      queuedPhotos.value.push({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        dataUrl
      });
    } catch {
      uiStore.pushToast(t('app.retry'), 'danger');
    }
  }
  input.value = '';
}

function removeQueuedPhoto(photoId: string): void {
  queuedPhotos.value = queuedPhotos.value.filter((p) => p.id !== photoId);
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
  return out;
}

async function handleToggleNotify(event: Event): Promise<void> {
  const checked = (event.target as HTMLInputElement).checked;
  if (!checked) {
    notifyOnComplete.value = false;
    return;
  }

  // Vérifie si le Push Web est déjà autorisé et abonné côté serveur
  try {
    const res = await apiRequest<{
      ok: true;
      prefs: { vapidPublicKey: string; hasPushSubscription: boolean };
    }>('/api/notifications/prefs');

    const browserGranted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
    if (browserGranted && res.prefs.hasPushSubscription) {
      notifyOnComplete.value = true;
      return;
    }

    if (!res.prefs.vapidPublicKey || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      notifyOnComplete.value = false;
      uiStore.pushToast(t('profile.notifPushNotSupported'), 'warning');
      return;
    }

    notifyPermissionError.value = '';
    notifyModalOpen.value = true;
  } catch {
    notifyOnComplete.value = true;
  }
}

async function authorizePushForPhoto(): Promise<void> {
  notifyEnabling.value = true;
  notifyPermissionError.value = '';
  try {
    const res = await apiRequest<{
      ok: true;
      prefs: { vapidPublicKey: string };
    }>('/api/notifications/prefs');

    if (!res.prefs.vapidPublicKey || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      notifyPermissionError.value = t('profile.notifPushNotSupported');
      return;
    }

    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        notifyPermissionError.value = t('scan.photoNotifyPermissionDenied');
        notifyOnComplete.value = false;
        return;
      }
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
      notifyPermissionError.value = t('scan.photoNotifyPermissionDenied');
      notifyOnComplete.value = false;
      return;
    }

    const reg = await navigator.serviceWorker.ready;
    const keyBytes = urlBase64ToUint8Array(res.prefs.vapidPublicKey);
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes.buffer as ArrayBuffer
    });
    const json = sub.toJSON();
    if (json.endpoint && json.keys?.p256dh && json.keys?.auth) {
      await apiRequest('/api/notifications/push', {
        method: 'POST',
        body: {
          endpoint: json.endpoint,
          keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }
        }
      });
      notifyOnComplete.value = true;
      notifyModalOpen.value = false;
      uiStore.pushToast(t('profile.notifPushEnabledToast'), 'success');
    }
  } catch {
    notifyPermissionError.value = t('profile.notifPushNotSupported');
    notifyOnComplete.value = false;
  } finally {
    notifyEnabling.value = false;
  }
}

async function handleLaunchPhotoBatch(): Promise<void> {
  if (queuedPhotos.value.length === 0 || photoUploading.value) return;
  photoUploading.value = true;
  const photosToSend = [...queuedPhotos.value];
  const wantsNotify = notifyOnComplete.value;
  let lastJob: BackgroundJobView | null = null;

  try {
    for (let i = 0; i < photosToSend.length; i++) {
      const isLast = i === photosToSend.length - 1;
      lastJob = await scanStore.submitPhotoJob({
        mode: 'auto',
        imageDataUrl: photosToSend[i].dataUrl,
        mimeType: 'image/webp',
        notifyOnComplete: wantsNotify && isLast
      });
    }
    queuedPhotos.value = [];
    photoSentBanner.value = true;
    viewingHistoryJobId.value = null;
    if (lastJob) {
      selectedActiveJobId.value = lastJob.id;
    }
    void jobsStore.refreshPhotoHistory();
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    photoUploading.value = false;
  }
}

async function togglePhotoItemSelected(item: PhotoJobItem): Promise<void> {
  if (!displayedPhotoJob.value) return;
  try {
    await scanStore.updatePhotoItem(displayedPhotoJob.value.id, item.id, { selected: !item.selected });
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  }
}

async function handleRetryFailed(): Promise<void> {
  if (!displayedPhotoJob.value) return;
  try {
    await scanStore.retryPhotoJobFailed(displayedPhotoJob.value.id);
    uiStore.pushToast(t('scan.photoRetryBnfSuccess'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  }
}

async function handleRetryOcr(): Promise<void> {
  if (!displayedPhotoJob.value) return;
  photoRetryingOcr.value = true;
  try {
    await scanStore.retryPhotoJobOcr(displayedPhotoJob.value.id);
    uiStore.pushToast(t('scan.photoRetryOcrToast'), 'info');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    photoRetryingOcr.value = false;
  }
}

async function handleCommitPhoto(target: 'owned' | 'wish'): Promise<void> {
  if (!displayedPhotoJob.value || selectedPhotoCount.value === 0) return;
  photoCommitting.value = true;
  const wasHistory = isViewingHistory.value;
  try {
    const outcome = await scanStore.commitPhotoJob(displayedPhotoJob.value.id, target, {
      archiveAfterCommit: true
    });
    if (outcome.queued) {
      uiStore.pushToast(t('scan.photoCommitStartedToast', { count: outcome.targetCount }), 'info');
    } else {
      uiStore.pushToast(t('scan.photoCommittedToast', { count: outcome.committedCount }), 'success');
    }
    if (!wasHistory) {
      selectedActiveJobId.value = null;
      photoSentBanner.value = false;
    }
    void jobsStore.refreshPhotoHistory();
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    photoCommitting.value = false;
  }
}

async function handleClearActivePhotoJob(): Promise<void> {
  if (!displayedPhotoJob.value) return;
  try {
    if (isViewingHistory.value) {
      await scanStore.deletePhotoJob(displayedPhotoJob.value.id);
      viewingHistoryJobId.value = null;
    } else {
      // Archive dans l'historique 30j et retire immédiatement de la zone active et du bandeau
      await scanStore.archivePhotoJob(displayedPhotoJob.value.id);
      selectedActiveJobId.value = null;
    }
    activePhotoItemId.value = null;
    uiStore.pushToast(t('scan.photoDeletedToast'), 'info');
    void jobsStore.refreshPhotoHistory();
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  }
}

function openHistoryJob(jobId: string): void {
  viewingHistoryJobId.value = jobId;
  activePhotoItemId.value = null;
  if (typeof window !== 'undefined') {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function closeHistoryJob(): void {
  viewingHistoryJobId.value = null;
  activePhotoItemId.value = null;
}

// ==================== ONGLET 2 : MODE RAFALE ====================
const burstFlash = ref<'none' | 'added' | 'duplicate'>('none');
const lastBurstLabel = ref('');
const burstManualInput = ref('');
const burstDeleteOpen = ref(false);
const burstLendOpen = ref(false);
const burstGenreOpen = ref(false);
const burstBusy = ref(false);

const burstFoundBooks = computed(() =>
  scanStore.burstItems
    .map((it) => it.book)
    .filter((b): b is NonNullable<typeof b> => Boolean(b))
);

const burstSelectedSet = computed(() => new Set(scanStore.burstSelectedBookIds));

const burstSelectedBooks = computed(() =>
  burstFoundBooks.value.filter((b) => burstSelectedSet.value.has(b.id))
);

function triggerBurstFlash(state: 'added' | 'duplicate'): void {
  burstFlash.value = state;
  window.setTimeout(() => {
    burstFlash.value = 'none';
  }, 550);
}

function handleBurstCapture(rawIsbn: string): void {
  const res = scanStore.captureBurstIsbn(rawIsbn);
  if (res.status === 'added') {
    triggerBurstFlash('added');
    lastBurstLabel.value = t('scan.burstModalLastScanned', { label: res.isbn13 });
  } else if (res.status === 'duplicate') {
    triggerBurstFlash('duplicate');
    lastBurstLabel.value = t('scan.burstDuplicateToast', { isbn: res.isbn13 });
  }
}

function submitBurstManual(): void {
  if (!burstManualInput.value.trim()) return;
  handleBurstCapture(burstManualInput.value.trim());
  burstManualInput.value = '';
}

async function handleBurstBatchAction(action: BatchActionType): Promise<void> {
  const eligible = filterEligibleBooksForBatchAction(burstSelectedBooks.value, action);
  if (eligible.length === 0) return;

  if (action === 'DELETE') {
    burstDeleteOpen.value = true;
    return;
  }
  if (action === 'LEND') {
    burstLendOpen.value = true;
    return;
  }
  if (action === 'RETURN') {
    await libraryStore.returnBooks(eligible.map((b) => b.id));
    scanStore.clearBurstSelection();
    uiStore.pushToast(t('loans.returnedToast'), 'success');
    return;
  }
  const target = action === 'ADD_OWNED' ? 'owned' : 'wish';
  await libraryStore.applyBatchStatus({ bookIds: eligible.map((b) => b.id), status: target });
  scanStore.clearBurstSelection();
  uiStore.pushToast(t('batch.statusUpdatedToast'), 'success');
}

async function confirmBurstDelete(payload: {
  bookIds: string[];
  lentDecisions: Record<string, 'keep' | 'return_and_delete'>;
}): Promise<void> {
  burstBusy.value = true;
  try {
    await libraryStore.applyBatchStatus({
      bookIds: payload.bookIds,
      status: 'none',
      lentDecisions: payload.lentDecisions
    });
    burstDeleteOpen.value = false;
    scanStore.clearBurstSelection();
    uiStore.pushToast(t('batch.statusUpdatedToast'), 'success');
  } finally {
    burstBusy.value = false;
  }
}

async function confirmBurstLend(payload: { borrowerName: string; notes?: string }): Promise<void> {
  const eligible = filterEligibleBooksForBatchAction(burstSelectedBooks.value, 'LEND');
  if (eligible.length === 0) return;
  burstBusy.value = true;
  try {
    await libraryStore.lendBooks({
      bookIds: eligible.map((b) => b.id),
      borrowerName: payload.borrowerName,
      notes: payload.notes
    });
    burstLendOpen.value = false;
    scanStore.clearBurstSelection();
    uiStore.pushToast(t('loans.lentToast', { name: payload.borrowerName }), 'success');
  } finally {
    burstBusy.value = false;
  }
}

async function confirmBurstGenres(genres: string[]): Promise<void> {
  const ids = burstSelectedBooks.value.map((b) => b.id);
  if (ids.length === 0) return;
  burstBusy.value = true;
  try {
    await libraryStore.applyBatchGenres(ids, genres);
    burstGenreOpen.value = false;
    scanStore.clearBurstSelection();
    uiStore.pushToast(t('batch.genresAppliedToast'), 'success');
  } finally {
    burstBusy.value = false;
  }
}

// ==================== ONGLET 3 : SCAN SIMPLE ====================
const simpleIsbnInput = ref('');
const simpleLoading = ref(false);

async function resolveAndOpenSimple(raw: string): Promise<void> {
  const isbn13 = isbnUtil.normalizeToIsbn13(raw);
  if (!isbn13) return;

  if (uiStore.isOffline) {
    await libraryStore.addPendingOfflineScan(isbn13);
    uiStore.pushToast(t('scan.simpleOfflineSaved', { isbn: isbn13 }), 'warning');
    simpleIsbnInput.value = '';
    return;
  }

  simpleLoading.value = true;
  try {
    const book = await libraryStore.resolveIsbnPreview(isbn13);
    simpleIsbnInput.value = '';
    if (book) {
      await router.push(`/book/${encodeURIComponent(book.id)}`);
    } else {
      await router.push({ path: '/book/create', query: { isbn: isbn13 } });
    }
  } finally {
    simpleLoading.value = false;
  }
}

// ==================== ONGLET 4 : RECHERCHE TEXTUELLE ====================
const importingExternalIsbn = ref<string | null>(null);

async function importExternalAndOpen(isbn13: string): Promise<void> {
  importingExternalIsbn.value = isbn13;
  try {
    const book = await libraryStore.resolveIsbnPreview(isbn13);
    if (book) {
      await router.push(`/book/${encodeURIComponent(book.id)}`);
    } else {
      await router.push({ path: '/book/create', query: { isbn: isbn13 } });
    }
  } finally {
    importingExternalIsbn.value = null;
  }
}
</script>

<template>
  <section class="ds-stack">
    <div class="ds-page-head">
      <h1>{{ t('nav.scan') }}</h1>
    </div>

    <!-- Modes d'acquisition homogènes (boutons tactiles uniformes incluant Importer & Créer manuellement) -->
    <div class="scan-modes-grid" role="tablist">
      <button
        type="button"
        role="tab"
        class="scan-mode-btn"
        :class="{ 'scan-mode-btn--active': scanStore.activeTab === 'photo' }"
        :aria-selected="scanStore.activeTab === 'photo'"
        @click="selectTab('photo')"
      >
        <Sparkles :size="17" aria-hidden="true" />
        <span>{{ t('scan.tabPhoto') }}</span>
      </button>

      <button
        type="button"
        role="tab"
        class="scan-mode-btn"
        :class="{ 'scan-mode-btn--active': scanStore.activeTab === 'burst' }"
        :aria-selected="scanStore.activeTab === 'burst'"
        @click="selectTab('burst')"
      >
        <ScanBarcode :size="17" aria-hidden="true" />
        <span>{{ t('scan.tabBurst') }}</span>
      </button>

      <button
        type="button"
        role="tab"
        class="scan-mode-btn"
        :class="{ 'scan-mode-btn--active': scanStore.activeTab === 'simple' }"
        :aria-selected="scanStore.activeTab === 'simple'"
        @click="selectTab('simple')"
      >
        <QrCode :size="17" aria-hidden="true" />
        <span>{{ t('scan.tabSimple') }}</span>
      </button>

      <button
        type="button"
        role="tab"
        class="scan-mode-btn"
        :class="{ 'scan-mode-btn--active': scanStore.activeTab === 'search' }"
        :aria-selected="scanStore.activeTab === 'search'"
        @click="selectTab('search')"
      >
        <Search :size="17" aria-hidden="true" />
        <span>{{ t('scan.tabSearch') }}</span>
      </button>

      <button
        type="button"
        role="tab"
        class="scan-mode-btn"
        :class="{ 'scan-mode-btn--active': scanStore.activeTab === 'import' }"
        :aria-selected="scanStore.activeTab === 'import'"
        @click="selectTab('import')"
      >
        <Upload :size="17" aria-hidden="true" />
        <span>{{ t('scan.tabImport') }}</span>
      </button>

      <router-link to="/book/create" class="scan-mode-btn">
        <PlusCircle :size="17" aria-hidden="true" />
        <span>{{ t('book.manualCreateBtn') }}</span>
      </router-link>
    </div>

    <!-- ==================== ONGLET 1 : PHOTO IA 100 % SERVEUR ==================== -->
    <div v-if="scanStore.activeTab === 'photo'" class="ds-stack">
      <!-- Zone de capture (masquée uniquement quand on consulte un lot historique pour garder la page épurée) -->
      <div v-if="!isViewingHistory" class="ds-card ds-stack">
        <div class="ds-row ds-row--between">
          <span class="ds-badge ds-badge--accent">
            {{
              t('scan.quotaBanner', {
                remaining: authStore.profile?.aiQuota.remaining ?? 0,
                limit: authStore.profile?.aiQuota.limit ?? 30
              })
            }}
          </span>
        </div>

        <input
          ref="cameraPhotoInputRef"
          type="file"
          accept="image/*"
          capture="environment"
          class="scan-hidden-input"
          @change="handlePhotoFilesAdded"
        />
        <input
          ref="galleryPhotoInputRef"
          type="file"
          accept="image/*"
          multiple
          class="scan-hidden-input"
          @change="handlePhotoFilesAdded"
        />

        <!-- Boutons côte à côte façon V1 -->
        <div class="photo-capture-grid">
          <button
            type="button"
            class="photo-capture-tile photo-capture-tile--primary"
            :disabled="photoUploading"
            @click="cameraPhotoInputRef?.click()"
          >
            <Camera :size="24" :stroke-width="1.9" aria-hidden="true" />
            <span>{{ queuedPhotos.length > 0 ? t('scan.photoAddAnotherCamera') : t('scan.takePhoto') }}</span>
          </button>

          <button
            type="button"
            class="photo-capture-tile"
            :disabled="photoUploading"
            @click="galleryPhotoInputRef?.click()"
          >
            <ImageIcon :size="24" :stroke-width="1.9" aria-hidden="true" />
            <span>{{ queuedPhotos.length > 0 ? t('scan.photoAddAnotherGallery') : t('scan.pickGallery') }}</span>
          </button>
        </div>

        <!-- File d'attente multi-photos avant lancement -->
        <div v-if="queuedPhotos.length > 0" class="photo-staging ds-panel ds-stack--sm">
          <strong>{{ t('scan.photoQueuedTitle', { count: queuedPhotos.length }) }}</strong>

          <div class="photo-staging__grid">
            <div v-for="photo in queuedPhotos" :key="photo.id" class="photo-staging__thumb">
              <img :src="photo.dataUrl" :alt="t('scan.tabPhoto')" />
              <button
                type="button"
                class="photo-staging__remove"
                :aria-label="t('scan.photoRemoveQueued')"
                @click="removeQueuedPhoto(photo.id)"
              >
                <X :size="14" aria-hidden="true" />
              </button>
            </div>
          </div>

          <label class="ds-checkbox photo-notify-toggle">
            <input
              type="checkbox"
              :checked="notifyOnComplete"
              @change="handleToggleNotify"
            />
            <Bell :size="15" aria-hidden="true" />
            <span>{{ t('scan.photoNotifyToggle') }}</span>
          </label>

          <button
            type="button"
            class="ds-btn ds-btn--primary ds-btn--lg photo-launch-btn"
            :disabled="photoUploading"
            @click="handleLaunchPhotoBatch"
          >
            <Sparkles :size="18" aria-hidden="true" />
            {{
              photoUploading
                ? t('scan.photoLaunchingBtn')
                : t('scan.photoLaunchBatchBtn', { count: queuedPhotos.length })
            }}
          </button>
        </div>

        <div v-if="photoSentBanner" class="ds-banner ds-banner--info" role="status">
          {{ t('scan.photoSentBackgroundHint') }}
        </div>

        <!-- Aide discrète dépliable -->
        <details class="ds-accordion">
          <summary>{{ t('scan.photoHelpSummary') }}</summary>
          <p class="ds-text-muted photo-help-details">{{ t('scan.photoHelpDetails') }}</p>
        </details>
      </div>

      <!-- Bandeau de retour si on consulte un lot historique -->
      <div v-if="isViewingHistory && displayedPhotoJob" class="ds-banner ds-banner--info ds-row ds-row--between">
        <span>
          {{ t('scan.photoHistoryViewingBanner', { date: formatPhotoDate(displayedPhotoJob.createdAt) }) }}
        </span>
        <button type="button" class="ds-btn ds-btn--sm" @click="closeHistoryJob">
          {{ t('scan.photoHistoryBackBtn') }}
        </button>
      </div>

      <!-- Sélecteur de photo si plusieurs lots Photo IA actifs non archivés en parallèle -->
      <div v-if="!isViewingHistory && jobsStore.activePhotoJobs.length > 1" class="ds-row photo-batch-switcher">
        <button
          v-for="(job, idx) in jobsStore.activePhotoJobs"
          :key="job.id"
          type="button"
          class="ds-btn ds-btn--sm"
          :class="{ 'ds-btn--primary': displayedPhotoJob?.id === job.id }"
          @click="selectedActiveJobId = job.id"
        >
          {{ t('scan.tabPhoto') }} #{{ jobsStore.activePhotoJobs.length - idx }}
        </button>
      </div>

      <!-- Résultats du lot Photo IA actif ou historique -->
      <template v-if="displayedPhotoJob">
        <div class="ds-panel ds-row ds-row--between photo-status-bar">
          <strong>
            {{
              displayedPhotoJob.status === 'error'
                ? t('scan.photoBannerError')
                : displayedPhotoJob.status === 'done'
                  ? t('scan.photoBannerDone', {
                      done: displayedPhotoJob.progressDone,
                      total: Math.max(1, displayedPhotoJob.progressTotal)
                    })
                  : t('scan.photoBannerRunning', {
                      done: displayedPhotoJob.progressDone,
                      total: Math.max(1, displayedPhotoJob.progressTotal)
                    })
            }}
          </strong>

          <div class="ds-row">
            <button
              v-if="displayedPhotoJob.status === 'error'"
              type="button"
              class="ds-btn ds-btn--primary ds-btn--sm"
              :disabled="photoRetryingOcr"
              @click="handleRetryOcr"
            >
              <RefreshCw :size="14" aria-hidden="true" />
              {{ photoRetryingOcr ? t('app.loading') : t('scan.photoRetryOcrBtn') }}
            </button>
            <button
              v-if="unresolvedItems.length > 0"
              type="button"
              class="ds-btn ds-btn--sm"
              @click="handleRetryFailed"
            >
              <RefreshCw :size="14" aria-hidden="true" />
              {{ t('scan.retryAllFailed', { count: unresolvedItems.length }) }}
            </button>
            <button
              type="button"
              class="ds-btn ds-btn--ghost ds-btn--sm"
              @click="handleClearActivePhotoJob"
            >
              <Trash2 :size="14" aria-hidden="true" />
              {{ isViewingHistory ? t('app.delete') : t('scan.clearBatch') }}
            </button>
          </div>
        </div>

        <div v-if="displayedPhotoJob.errorMessage" class="ds-banner ds-banner--danger ds-row ds-row--between" role="alert">
          <span>{{ displayedPhotoJob.errorMessage }}</span>
          <button
            v-if="displayedPhotoJob.status === 'error'"
            type="button"
            class="ds-btn ds-btn--sm"
            :disabled="photoRetryingOcr"
            @click="handleRetryOcr"
          >
            {{ photoRetryingOcr ? t('app.loading') : t('scan.photoRetryOcrBtn') }}
          </button>
        </div>

        <!-- Identifiés -->
        <div v-if="identifiedItems.length > 0" class="ds-card ds-stack">
          <h2>{{ t('scan.identifiedSection', { count: identifiedItems.length }) }}</h2>
          <div class="ds-stack--sm">
            <div v-for="item in identifiedItems" :key="item.id" class="ds-panel photo-item-row">
              <label class="photo-item-check" @click.stop>
                <input
                  type="checkbox"
                  :checked="item.selected"
                  :disabled="item.ignored || !item.selectedOptionIsbn13"
                  @change="togglePhotoItemSelected(item)"
                />
              </label>
              <button type="button" class="photo-item-btn" @click="activePhotoItemId = item.id">
                <span class="photo-item-cover">
                  <img
                    v-if="getPhotoItemCoverUrl(item)"
                    :src="getPhotoItemCoverUrl(item)!"
                    :alt="getPhotoItemDisplayTitle(item)"
                    loading="lazy"
                  />
                  <span v-else class="photo-item-cover__placeholder">
                    {{ getPhotoItemDisplayTitle(item).slice(0, 2).toUpperCase() }}
                  </span>
                </span>
                <span class="photo-item-text">
                  <strong>{{ getPhotoItemDisplayTitle(item) }}</strong>
                  <span class="ds-text-muted">{{ getPhotoItemSubtitle(item) }}</span>
                  <span class="ds-chips">
                    <span v-if="item.committedAction === 'owned'" class="ds-badge ds-badge--success">
                      {{ t('scan.photoActionBadgeOwned') }}
                    </span>
                    <span v-else-if="item.committedAction === 'wish'" class="ds-badge ds-badge--accent">
                      {{ t('scan.photoActionBadgeWish') }}
                    </span>
                    <span v-if="item.ignored" class="ds-badge">
                      {{ t('scan.photoIgnoredBadge') }}
                    </span>
                  </span>
                </span>
              </button>
            </div>
          </div>
        </div>

        <!-- À vérifier -->
        <div v-if="doubtItems.length > 0" class="ds-card ds-stack">
          <h2>{{ t('scan.doubtSection', { count: doubtItems.length }) }}</h2>
          <div class="ds-stack--sm">
            <div v-for="item in doubtItems" :key="item.id" class="ds-panel photo-item-row">
              <label class="photo-item-check" @click.stop>
                <input
                  type="checkbox"
                  :checked="item.selected"
                  :disabled="item.ignored || !item.selectedOptionIsbn13"
                  @change="togglePhotoItemSelected(item)"
                />
              </label>
              <button type="button" class="photo-item-btn" @click="activePhotoItemId = item.id">
                <span class="photo-item-cover">
                  <img
                    v-if="getPhotoItemCoverUrl(item)"
                    :src="getPhotoItemCoverUrl(item)!"
                    :alt="getPhotoItemDisplayTitle(item)"
                    loading="lazy"
                  />
                  <span v-else class="photo-item-cover__placeholder">
                    {{ item.hint.title.slice(0, 2).toUpperCase() }}
                  </span>
                </span>
                <span class="photo-item-text">
                  <strong>{{ getPhotoItemDisplayTitle(item) }}</strong>
                  <span class="ds-text-muted">{{ getPhotoItemSubtitle(item) }}</span>
                  <span v-if="item.committedAction || item.ignored" class="ds-chips">
                    <span v-if="item.committedAction === 'owned'" class="ds-badge ds-badge--success">
                      {{ t('scan.photoActionBadgeOwned') }}
                    </span>
                    <span v-else-if="item.committedAction === 'wish'" class="ds-badge ds-badge--accent">
                      {{ t('scan.photoActionBadgeWish') }}
                    </span>
                    <span v-if="item.ignored" class="ds-badge">
                      {{ t('scan.photoIgnoredBadge') }}
                    </span>
                  </span>
                </span>
              </button>
            </div>
          </div>
        </div>

        <!-- Non identifiés -->
        <div v-if="unresolvedItems.length > 0" class="ds-card ds-stack">
          <h2>{{ t('scan.unresolvedSection', { count: unresolvedItems.length }) }}</h2>
          <div class="ds-stack--sm">
            <div v-for="item in unresolvedItems" :key="item.id" class="ds-panel photo-item-row">
              <button type="button" class="photo-item-btn" @click="activePhotoItemId = item.id">
                <span class="photo-item-cover">
                  <img
                    v-if="getPhotoItemCoverUrl(item)"
                    :src="getPhotoItemCoverUrl(item)!"
                    :alt="item.hint.title"
                    loading="lazy"
                  />
                  <span v-else class="photo-item-cover__placeholder">
                    {{ item.hint.title.slice(0, 2).toUpperCase() }}
                  </span>
                </span>
                <span class="photo-item-text">
                  <strong>{{ item.hint.title }}</strong>
                  <span class="ds-text-muted">
                    {{ getPhotoItemSubtitle(item) !== '—' ? getPhotoItemSubtitle(item) : t('scan.wrongReferenceBtn') }}
                  </span>
                </span>
              </button>
            </div>
          </div>
        </div>

        <!-- Barre d'action flottante pour valider la sélection Photo IA (accessible même en scrollant) -->
        <BatchActionBar
          :custom-count="selectedPhotoCount"
          @clear="
            photoResult?.items.forEach((it) => {
              if (it.selected) void togglePhotoItemSelected(it);
            })
          "
        >
          <template #actions>
            <button
              type="button"
              class="ds-btn ds-btn--primary ds-btn--sm"
              :disabled="photoCommitting || Boolean(jobsStore.activePhotoCommitJob)"
              @click="handleCommitPhoto('owned')"
            >
              {{ t('scan.photoCommitOwnedBtn', { count: selectedPhotoCount }) }}
            </button>
            <button
              type="button"
              class="ds-btn ds-btn--sm"
              :disabled="photoCommitting || Boolean(jobsStore.activePhotoCommitJob)"
              @click="handleCommitPhoto('wish')"
            >
              {{ t('scan.photoCommitWishBtn', { count: selectedPhotoCount }) }}
            </button>
          </template>
        </BatchActionBar>

        <PhotoItemModal
          :open="Boolean(activePhotoItem)"
          :job-id="displayedPhotoJob.id"
          :item="activePhotoItem"
          :preview-url="photoResult?.previewUrl ?? null"
          @close="activePhotoItemId = null"
        />
      </template>

      <!-- Historique Photo IA (30 jours glissants) -->
      <div v-if="!isViewingHistory" class="ds-card ds-stack">
        <div class="ds-row ds-row--between">
          <div class="ds-row">
            <Clock :size="17" aria-hidden="true" />
            <h2>{{ t('scan.photoHistoryTitle') }}</h2>
          </div>
          <span class="ds-text-muted photo-history-retention">
            {{ t('scan.photoHistoryRetentionHint', { days: jobsStore.photoHistoryRetentionDays }) }}
          </span>
        </div>

        <p v-if="jobsStore.photoHistory.length === 0" class="ds-text-muted">
          {{ t('scan.photoHistoryEmpty') }}
        </p>

        <div v-else class="photo-history-list">
          <button
            v-for="job in jobsStore.photoHistory"
            :key="job.id"
            type="button"
            class="ds-panel photo-history-card"
            @click="openHistoryJob(job.id)"
          >
            <span class="photo-history-card__thumb">
              <img
                v-if="summarizeHistoryJob(job).previewUrl"
                :src="summarizeHistoryJob(job).previewUrl!"
                :alt="t('scan.tabPhoto')"
                loading="lazy"
              />
              <Camera v-else :size="20" aria-hidden="true" />
            </span>

            <span class="photo-history-card__info">
              <span class="ds-row ds-row--between">
                <strong>{{ formatPhotoDate(job.createdAt) }}</strong>
                <span
                  v-if="job.status === 'running' || job.status === 'pending'"
                  class="ds-badge ds-badge--accent"
                >
                  {{ job.progressDone }}/{{ Math.max(1, job.progressTotal) }}
                </span>
                <span v-else-if="job.status === 'error'" class="ds-badge ds-badge--danger">
                  {{ t('scan.photoBannerError') }}
                </span>
              </span>
              <span class="ds-text-muted photo-history-card__summary">
                {{
                  t('scan.photoHistorySummary', {
                    owned: summarizeHistoryJob(job).owned,
                    wish: summarizeHistoryJob(job).wish,
                    ignored: summarizeHistoryJob(job).ignored,
                    total: summarizeHistoryJob(job).total
                  })
                }}
              </span>
            </span>
          </button>
        </div>
      </div>

      <!-- Modale d'autorisation Web Push pour « Me notifier » -->
      <BaseModal
        :open="notifyModalOpen"
        :title="t('scan.photoNotifyPermissionTitle')"
        max-width="440px"
        @close="notifyModalOpen = false; notifyOnComplete = false"
      >
        <div class="ds-stack">
          <p>{{ t('scan.photoNotifyPermissionDesc') }}</p>
          <div v-if="notifyPermissionError" class="ds-banner ds-banner--warning" role="alert">
            {{ notifyPermissionError }}
          </div>
        </div>
        <template #footer>
          <button
            type="button"
            class="ds-btn"
            :disabled="notifyEnabling"
            @click="notifyModalOpen = false; notifyOnComplete = false"
          >
            {{ t('app.cancel') }}
          </button>
          <button
            type="button"
            class="ds-btn ds-btn--primary"
            :disabled="notifyEnabling"
            @click="authorizePushForPhoto"
          >
            {{ notifyEnabling ? t('app.loading') : t('scan.photoNotifyPermissionBtn') }}
          </button>
        </template>
      </BaseModal>
    </div>

    <!-- ==================== ONGLET 2 : MODE RAFALE ==================== -->
    <div v-else-if="scanStore.activeTab === 'burst'" class="ds-stack">
      <div class="ds-card ds-stack">
        <div class="ds-row ds-row--between">
          <button type="button" class="ds-btn ds-btn--primary" @click="burstCameraOpen = true">
            <ScanBarcode :size="17" aria-hidden="true" />
            {{ t('scan.burstOpenCameraBtn') }}
          </button>
          <button
            v-if="scanStore.burstItems.length > 0"
            type="button"
            class="ds-btn ds-btn--ghost ds-btn--sm"
            @click="scanStore.clearBurstItems()"
          >
            {{ t('scan.burstClearBtn') }}
          </button>
        </div>

        <form class="ds-row" @submit.prevent="submitBurstManual">
          <input
            v-model="burstManualInput"
            type="text"
            class="ds-input scan-grow-input"
            :placeholder="t('scan.burstManualInputPlaceholder')"
          />
          <button type="submit" class="ds-btn" :disabled="!burstManualInput.trim()">
            {{ t('scan.burstAddBtn') }}
          </button>
        </form>
      </div>

      <p v-if="scanStore.burstItems.length === 0" class="ds-card ds-text-muted">
        {{ t('scan.burstEmpty') }}
      </p>

      <div v-else class="ds-media-grid">
        <template v-for="entry in scanStore.burstItems" :key="entry.isbn13">
          <BookCard
            v-if="entry.book"
            :book="entry.book"
            selectable
            :selected="burstSelectedSet.has(entry.book.id)"
            @toggle-select="(id) => scanStore.toggleBurstBookSelection(id)"
            @open="(id) => router.push(`/book/${encodeURIComponent(id)}`)"
          />
          <div v-else class="ds-panel ds-row ds-row--between">
            <div>
              <strong>{{ entry.isbn13 }}</strong>
              <p class="ds-text-muted">
                {{ entry.status === 'resolving' ? t('app.loading') : t('scan.burstNotFoundLabel') }}
              </p>
            </div>
            <div class="ds-row">
              <router-link
                v-if="entry.status === 'not_found'"
                :to="{ path: '/book/create', query: { isbn: entry.isbn13 } }"
                class="ds-btn ds-btn--sm"
              >
                {{ t('book.manualCreateBtn') }}
              </router-link>
              <button
                type="button"
                class="ds-btn ds-btn--ghost ds-btn--sm"
                :aria-label="t('app.delete')"
                @click="scanStore.removeBurstItem(entry.isbn13)"
              >
                <X :size="15" aria-hidden="true" />
              </button>
            </div>
          </div>
        </template>
      </div>

      <BatchActionBar
        :selected-books="burstSelectedBooks"
        @action="handleBurstBatchAction"
        @open-genres="burstGenreOpen = true"
        @clear="scanStore.clearBurstSelection()"
      />

      <CameraBarcodeModal
        :open="burstCameraOpen"
        mode="burst"
        :flash-state="burstFlash"
        :scanned-count="scanStore.burstItems.length"
        :last-scanned-label="lastBurstLabel"
        @close="burstCameraOpen = false"
        @detected="handleBurstCapture"
      />

      <ConfirmDeleteModal
        :open="burstDeleteOpen"
        :books="burstSelectedBooks"
        :busy="burstBusy"
        @close="burstDeleteOpen = false"
        @confirm="confirmBurstDelete"
      />

      <LendModal
        :open="burstLendOpen"
        :book-count="filterEligibleBooksForBatchAction(burstSelectedBooks, 'LEND').length"
        :contacts="libraryStore.contacts"
        :busy="burstBusy"
        @close="burstLendOpen = false"
        @confirm="confirmBurstLend"
      />

      <BatchGenreModal
        :open="burstGenreOpen"
        :book-count="burstSelectedBooks.length"
        :default-genres="authStore.profile?.defaultGenres ?? []"
        :busy="burstBusy"
        @close="burstGenreOpen = false"
        @confirm="confirmBurstGenres"
        @add-default-genre="(g) => authStore.updateDefaultGenres('add', g)"
      />
    </div>

    <!-- ==================== ONGLET 3 : SCAN SIMPLE ==================== -->
    <div v-else-if="scanStore.activeTab === 'simple'" class="ds-card ds-stack">
      <button type="button" class="ds-btn ds-btn--primary ds-btn--lg" @click="simpleCameraOpen = true">
        <Camera :size="18" aria-hidden="true" />
        {{ t('scan.openSimpleCamera') }}
      </button>

      <form class="ds-row" @submit.prevent="resolveAndOpenSimple(simpleIsbnInput)">
        <input
          v-model="simpleIsbnInput"
          type="text"
          class="ds-input scan-grow-input"
          :placeholder="t('scan.simpleIsbnPlaceholder')"
        />
        <button type="submit" class="ds-btn ds-btn--primary" :disabled="simpleLoading || !simpleIsbnInput.trim()">
          {{ simpleLoading ? t('app.loading') : t('scan.simpleLookupBtn') }}
        </button>
      </form>

      <CameraBarcodeModal
        :open="simpleCameraOpen"
        mode="simple"
        @close="simpleCameraOpen = false"
        @detected="resolveAndOpenSimple"
      />
    </div>

    <!-- ==================== ONGLET 4 : RECHERCHE TEXTUELLE MULTI-CRITÈRES ==================== -->
    <div v-else-if="scanStore.activeTab === 'search'" class="ds-stack">
      <form class="ds-card ds-stack" @submit.prevent="scanStore.runCatalogSearch()">
        <div class="ds-grid-2">
          <div class="ds-field">
            <label class="ds-label" for="s-title">{{ t('scan.fieldTitle') }}</label>
            <input id="s-title" v-model="scanStore.searchForm.title" type="text" class="ds-input" />
          </div>
          <div class="ds-field">
            <label class="ds-label" for="s-series">{{ t('scan.fieldSeries') }}</label>
            <input id="s-series" v-model="scanStore.searchForm.series" type="text" class="ds-input" />
          </div>
        </div>

        <div class="ds-grid-3">
          <div class="ds-field">
            <label class="ds-label" for="s-vol">{{ t('scan.fieldVolume') }}</label>
            <input id="s-vol" v-model="scanStore.searchForm.volumeNumber" type="text" class="ds-input" />
          </div>
          <div class="ds-field">
            <label class="ds-label" for="s-author">{{ t('scan.fieldAuthor') }}</label>
            <input id="s-author" v-model="scanStore.searchForm.author" type="text" class="ds-input" />
          </div>
          <div class="ds-field">
            <label class="ds-label" for="s-collection">{{ t('scan.fieldCollection') }}</label>
            <input id="s-collection" v-model="scanStore.searchForm.collection" type="text" class="ds-input" />
          </div>
        </div>

        <div class="ds-grid-2">
          <div class="ds-field">
            <label class="ds-label" for="s-publisher">{{ t('scan.fieldPublisher') }}</label>
            <input id="s-publisher" v-model="scanStore.searchForm.publisher" type="text" class="ds-input" />
          </div>
          <div class="ds-field">
            <label class="ds-label" for="s-isbn">{{ t('scan.fieldIsbn') }}</label>
            <input id="s-isbn" v-model="scanStore.searchForm.isbn" type="text" class="ds-input" />
          </div>
        </div>

        <div class="ds-row ds-row--between">
          <button type="button" class="ds-btn" @click="scanStore.clearSearchForm()">
            {{ t('app.clear') }}
          </button>
          <button type="submit" class="ds-btn ds-btn--primary" :disabled="scanStore.searchLoading">
            <Search :size="16" aria-hidden="true" />
            {{ scanStore.searchLoading ? t('app.loading') : t('app.search') }}
          </button>
        </div>
      </form>

      <template v-if="scanStore.hasSearched && !scanStore.searchLoading">
        <p
          v-if="
            scanStore.searchSeries.length === 0 &&
            scanStore.searchBooks.length === 0 &&
            scanStore.searchExternalBooks.length === 0
          "
          class="ds-card ds-text-muted"
        >
          {{ t('scan.searchEmpty') }}
        </p>

        <div v-if="scanStore.searchSeries.length > 0" class="ds-stack">
          <h2>{{ t('scan.searchSeriesHeader', { count: scanStore.searchSeries.length }) }}</h2>
          <div class="ds-media-grid">
            <SeriesCard
              v-for="ser in scanStore.searchSeries"
              :key="ser.id"
              :series="ser"
              @open="(id) => router.push(`/series/${encodeURIComponent(id)}`)"
            />
          </div>
        </div>

        <div v-if="scanStore.searchBooks.length > 0" class="ds-stack">
          <h2>{{ t('scan.searchBooksHeader', { count: scanStore.searchBooks.length }) }}</h2>
          <div class="ds-media-grid">
            <BookCard
              v-for="book in scanStore.searchBooks"
              :key="book.id"
              :book="book"
              @open="(id) => router.push(`/book/${encodeURIComponent(id)}`)"
            />
          </div>
        </div>

        <div v-if="scanStore.searchExternalBooks.length > 0" class="ds-stack">
          <h2>{{ t('scan.searchExternalHeader', { count: scanStore.searchExternalBooks.length }) }}</h2>
          <div class="ds-stack--sm">
            <div
              v-for="hit in scanStore.searchExternalBooks"
              :key="hit.isbn13"
              class="ds-panel ds-row ds-row--between"
            >
              <div>
                <div class="ds-row">
                  <strong>{{ hit.title }}</strong>
                  <span v-if="hit.isIntegral" class="ds-badge ds-badge--accent">
                    {{
                      hit.includedVolumes && hit.includedVolumes.length > 0
                        ? t('book.integralRangeLabel', { range: hit.includedVolumes.join(', ') })
                        : t('book.integralLabel')
                    }}
                  </span>
                  <span v-if="(hit.editionCount ?? 1) > 1" class="ds-badge">
                    {{ t('scan.searchExternalEditionsCount', { count: hit.editionCount }) }}
                  </span>
                </div>
                <p class="ds-text-muted">
                  <span v-if="hit.seriesName">{{ hit.seriesName }}</span>
                  <span v-if="hit.volumeNumber && !hit.isIntegral"> T.{{ hit.volumeNumber }}</span>
                  <span v-if="hit.authors.length > 0"> · {{ hit.authors.join(', ') }}</span>
                  <span v-if="hit.publisher"> · {{ hit.publisher }}</span>
                  <span> · {{ hit.isbn13 }}</span>
                </p>
              </div>
              <button
                type="button"
                class="ds-btn ds-btn--sm"
                :disabled="importingExternalIsbn === hit.isbn13"
                @click="importExternalAndOpen(hit.isbn13)"
              >
                {{ importingExternalIsbn === hit.isbn13 ? t('app.loading') : t('scan.searchImportBtn') }}
              </button>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- ==================== ONGLET 5 : IMPORTER (CSV / JSON / XLSX) ==================== -->
    <div v-else class="ds-stack">
      <CollectionImportPanel id-prefix="scan-import" />
    </div>
  </section>
</template>

<style scoped>
.scan-modes-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

@media (min-width: 640px) {
  .scan-modes-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

.scan-mode-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-block-size: var(--target-size);
  padding: 0.55rem 0.75rem;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-strong);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 0.86rem;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.scan-mode-btn:hover {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent);
  text-decoration: none;
}

.scan-mode-btn--active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--text-on-accent);
}

.scan-mode-btn--active:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
  color: var(--text-on-accent);
}

.scan-hidden-input {
  display: none;
}

.scan-grow-input {
  flex: 1;
  min-width: 180px;
}

.photo-capture-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.photo-capture-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-3);
  min-block-size: 96px;
  border-radius: var(--radius-lg);
  border: 1.5px solid var(--border-strong);
  background: var(--bg-subtle);
  color: var(--text-primary);
  font-weight: 600;
  font-size: 0.88rem;
  text-align: center;
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease, transform 0.12s ease;
}

.photo-capture-tile:hover:not(:disabled) {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent);
}

.photo-capture-tile--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--text-on-accent);
}

.photo-capture-tile--primary:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
  color: var(--text-on-accent);
}

.photo-staging__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
  gap: var(--space-2);
}

.photo-staging__thumb {
  position: relative;
  aspect-ratio: 1;
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  background: var(--bg-surface);
}

.photo-staging__thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.photo-staging__remove {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-pill);
  border: none;
  background: var(--bg-backdrop);
  color: var(--text-on-accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.photo-notify-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 0.9rem;
  cursor: pointer;
}

.photo-launch-btn {
  width: 100%;
}

.photo-help-details {
  margin: var(--space-2) 0 0;
  font-size: 0.86rem;
}

.photo-batch-switcher {
  flex-wrap: wrap;
}

.photo-status-bar {
  flex-wrap: wrap;
  gap: var(--space-2);
}

.photo-item-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}

.photo-item-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-inline-size: 40px;
  min-block-size: 40px;
  cursor: pointer;
  flex-shrink: 0;
}

.photo-item-check input {
  width: 18px;
  height: 18px;
  accent-color: var(--accent);
}

.photo-item-btn {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  border: none;
  background: transparent;
  padding: 0;
  text-align: left;
  cursor: pointer;
  color: var(--text-primary);
  min-width: 0;
}

.photo-item-cover {
  width: 46px;
  min-width: 46px;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
  display: flex;
  align-items: center;
  justify-content: center;
}

.photo-item-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.photo-item-cover__placeholder {
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--text-muted);
}

.photo-item-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  min-width: 0;
}

.photo-history-retention {
  font-size: 0.8rem;
}

.photo-history-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.photo-history-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  text-align: left;
  cursor: pointer;
  color: var(--text-primary);
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.photo-history-card:hover {
  border-color: var(--accent-border);
  background: var(--accent-soft);
}

.photo-history-card__thumb {
  width: 52px;
  height: 52px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  flex-shrink: 0;
}

.photo-history-card__thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.photo-history-card__info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.photo-history-card__summary {
  font-size: 0.82rem;
}
</style>
