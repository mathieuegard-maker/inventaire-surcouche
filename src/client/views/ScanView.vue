<!-- src/client/views/ScanView.vue -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BookCard from '../components/books/BookCard.vue';
import SeriesCard from '../components/books/SeriesCard.vue';
import BatchActionBar from '../components/books/BatchActionBar.vue';
import PhotoLightboxModal from '../components/base/PhotoLightboxModal.vue';
import CameraBarcodeModal from '../components/modals/CameraBarcodeModal.vue';
import PhotoItemModal from '../components/modals/PhotoItemModal.vue';
import ConfirmDeleteModal from '../components/modals/ConfirmDeleteModal.vue';
import LendModal from '../components/modals/LendModal.vue';
import BatchGenreModal from '../components/modals/BatchGenreModal.vue';
import { useScanStore, type PhotoJobItem, type PhotoJobResultPayload, type ScanTab } from '../stores/scan.store';
import { useJobsStore } from '../stores/jobs.store';
import { useLibraryStore } from '../stores/library.store';
import { useAuthStore } from '../stores/auth.store';
import { useUiStore } from '../stores/ui.store';
import { filterEligibleBooksForBatchAction, type BatchActionType } from '../../shared/bibliographic/batch-actions.util';
import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import { ApiClientError } from '../api/client';
import { t } from '../../shared/locales';

const route = useRoute();
const router = useRouter();
const scanStore = useScanStore();
const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();
const authStore = useAuthStore();
const uiStore = useUiStore();

const validTabs: ScanTab[] = ['photo', 'burst', 'simple', 'search'];

// Modales caméra déclarées avant le watcher d'onglets pour ouverture directe au clic sur Rafale / Scan simple
const burstCameraOpen = ref(false);
const simpleCameraOpen = ref(false);

function openCameraForTab(tab: ScanTab): void {
  if (tab === 'burst') {
    simpleCameraOpen.value = false;
    burstCameraOpen.value = true;
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
      scanStore.activeTab = nextTab;
      openCameraForTab(nextTab);
    }
  },
  { immediate: true }
);

function selectTab(tab: ScanTab): void {
  scanStore.activeTab = tab;
  openCameraForTab(tab);
  void router.replace({ path: '/scan', query: { tab } });
}

// ==================== ONGLET 1 : PHOTO IA 100 % SERVEUR ====================
const photoMode = ref<'shelf' | 'cover'>('shelf');
const cameraPhotoInputRef = ref<HTMLInputElement | null>(null);
const galleryPhotoInputRef = ref<HTMLInputElement | null>(null);
const photoUploading = ref(false);
const photoRetryingOcr = ref(false);
const photoCommitting = ref(false);
const activePhotoItemId = ref<string | null>(null);
const previewLightboxOpen = ref(false);

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

function getPhotoItemPositionShort(item: PhotoJobItem): string {
  const idx = item.spineIndex ?? item.hint.spineIndex;
  const total = item.totalSpines ?? photoResult.value?.items.length ?? 0;
  if (!idx || total <= 1) return '';
  const fromRight = Math.max(1, total - idx + 1);
  return t('scan.photoPositionShort', { left: idx, right: fromRight });
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

const latestPhotoJob = computed(() => jobsStore.latestPhotoJob);
const photoResult = computed<PhotoJobResultPayload | null>(() => {
  const raw = latestPhotoJob.value?.result;
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<PhotoJobResultPayload>;
  return {
    mode: obj.mode === 'cover' ? 'cover' : 'shelf',
    previewCoverKey: obj.previewCoverKey ?? null,
    previewUrl: obj.previewUrl ?? (obj.previewCoverKey ? `/api/covers/${obj.previewCoverKey}` : null),
    items: Array.isArray(obj.items) ? obj.items : []
  };
});

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

async function compressPhotoForUpload(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const img = new Image();
      img.onload = () => {
        const maxDim = photoMode.value === 'shelf' ? 1800 : 1400;
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
        resolve(canvas.toDataURL('image/webp', 0.86));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    };
    reader.onerror = () => reject(new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}

async function handlePhotoSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  photoUploading.value = true;
  try {
    const imageDataUrl = await compressPhotoForUpload(file);
    await scanStore.submitPhotoJob({
      mode: photoMode.value,
      imageDataUrl,
      mimeType: 'image/webp'
    });
    uiStore.pushToast(t('scan.photoJobCreatedToast'), 'info');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    photoUploading.value = false;
    input.value = '';
  }
}

async function togglePhotoItemSelected(item: PhotoJobItem): Promise<void> {
  if (!latestPhotoJob.value) return;
  try {
    await scanStore.updatePhotoItem(latestPhotoJob.value.id, item.id, { selected: !item.selected });
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  }
}

async function handleRetryFailed(): Promise<void> {
  if (!latestPhotoJob.value) return;
  try {
    await scanStore.retryPhotoJobFailed(latestPhotoJob.value.id);
    uiStore.pushToast(t('scan.photoRetryBnfSuccess'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  }
}

async function handleRetryOcr(): Promise<void> {
  if (!latestPhotoJob.value) return;
  photoRetryingOcr.value = true;
  try {
    await scanStore.retryPhotoJobOcr(latestPhotoJob.value.id);
    uiStore.pushToast(t('scan.photoRetryOcrToast'), 'info');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    photoRetryingOcr.value = false;
  }
}

async function handleCommitPhoto(target: 'owned' | 'wish'): Promise<void> {
  if (!latestPhotoJob.value || selectedPhotoCount.value === 0) return;
  photoCommitting.value = true;
  try {
    const outcome = await scanStore.commitPhotoJob(latestPhotoJob.value.id, target);
    if (outcome.queued) {
      uiStore.pushToast(t('scan.photoCommitStartedToast', { count: outcome.targetCount }), 'info');
    } else {
      uiStore.pushToast(t('scan.photoCommittedToast', { count: outcome.committedCount }), 'success');
    }
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    photoCommitting.value = false;
  }
}

async function handleDeletePhotoJob(): Promise<void> {
  if (!latestPhotoJob.value) return;
  try {
    await scanStore.deletePhotoJob(latestPhotoJob.value.id);
    activePhotoItemId.value = null;
    uiStore.pushToast(t('scan.photoDeletedToast'), 'info');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  }
}

// ==================== ONGLET 2 : MODE RAFALE ====================
const burstFlash = ref<'none' | 'added' | 'duplicate'>('none');
const burstManualInput = ref('');
const burstSelectedIds = ref<Set<string>>(new Set());
const burstDeleteOpen = ref(false);
const burstLendOpen = ref(false);
const burstGenreOpen = ref(false);
const burstBusy = ref(false);

const burstFoundBooks = computed(() =>
  scanStore.burstItems
    .map((it) => it.book)
    .filter((b): b is NonNullable<typeof b> => Boolean(b))
);

const burstSelectedBooks = computed(() =>
  burstFoundBooks.value.filter((b) => burstSelectedIds.value.has(b.id))
);

function triggerBurstFlash(state: 'added' | 'duplicate'): void {
  burstFlash.value = state;
  window.setTimeout(() => {
    burstFlash.value = 'none';
  }, 450);
}

function handleBurstCapture(rawIsbn: string): void {
  const res = scanStore.captureBurstIsbn(rawIsbn);
  if (res.status === 'added') {
    triggerBurstFlash('added');
    uiStore.pushToast(t('scan.burstCapturedToast', { isbn: res.isbn13 }), 'success', 2000);
  } else if (res.status === 'duplicate') {
    triggerBurstFlash('duplicate');
    uiStore.pushToast(t('scan.burstDuplicateToast', { isbn: res.isbn13 }), 'warning', 2000);
  }
}

function submitBurstManual(): void {
  if (!burstManualInput.value.trim()) return;
  handleBurstCapture(burstManualInput.value.trim());
  burstManualInput.value = '';
}

function toggleBurstSelect(bookId: string): void {
  const next = new Set(burstSelectedIds.value);
  if (next.has(bookId)) next.delete(bookId);
  else next.add(bookId);
  burstSelectedIds.value = next;
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
    burstSelectedIds.value = new Set();
    uiStore.pushToast(t('loans.returnedToast'), 'success');
    return;
  }
  const target = action === 'ADD_OWNED' ? 'owned' : 'wish';
  await libraryStore.applyBatchStatus({ bookIds: eligible.map((b) => b.id), status: target });
  burstSelectedIds.value = new Set();
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
    burstSelectedIds.value = new Set();
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
    burstSelectedIds.value = new Set();
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
    burstSelectedIds.value = new Set();
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
    <div class="ds-row ds-row--between">
      <h1>{{ t('nav.scan') }}</h1>
      <router-link to="/book/create" class="ds-btn ds-btn--sm">
        {{ t('book.manualCreateBtn') }}
      </router-link>
    </div>

    <div class="ds-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        class="ds-tab"
        :class="{ 'ds-tab--active': scanStore.activeTab === 'photo' }"
        @click="selectTab('photo')"
      >
        {{ t('scan.tabPhoto') }}
      </button>
      <button
        type="button"
        role="tab"
        class="ds-tab"
        :class="{ 'ds-tab--active': scanStore.activeTab === 'burst' }"
        @click="selectTab('burst')"
      >
        {{ t('scan.tabBurst') }}
      </button>
      <button
        type="button"
        role="tab"
        class="ds-tab"
        :class="{ 'ds-tab--active': scanStore.activeTab === 'simple' }"
        @click="selectTab('simple')"
      >
        {{ t('scan.tabSimple') }}
      </button>
      <button
        type="button"
        role="tab"
        class="ds-tab"
        :class="{ 'ds-tab--active': scanStore.activeTab === 'search' }"
        @click="selectTab('search')"
      >
        {{ t('scan.tabSearch') }}
      </button>
    </div>

    <!-- ONGLET 1 : PHOTO IA 100 % SERVEUR -->
    <div v-if="scanStore.activeTab === 'photo'" class="ds-stack">
      <div class="ds-card ds-stack">
        <div class="ds-row ds-row--between">
          <span class="ds-badge ds-badge--accent">
            {{
              t('scan.quotaBanner', {
                remaining: authStore.profile?.aiQuota.remaining ?? 0,
                limit: authStore.profile?.aiQuota.limit ?? 30
              })
            }}
          </span>

          <div class="ds-row">
            <button
              type="button"
              class="ds-btn ds-btn--sm"
              :class="{ 'ds-btn--primary': photoMode === 'shelf' }"
              @click="photoMode = 'shelf'"
            >
              {{ t('scan.photoModeShelf') }}
            </button>
            <button
              type="button"
              class="ds-btn ds-btn--sm"
              :class="{ 'ds-btn--primary': photoMode === 'cover' }"
              @click="photoMode = 'cover'"
            >
              {{ t('scan.photoModeCover') }}
            </button>
          </div>
        </div>

        <input
          ref="cameraPhotoInputRef"
          type="file"
          accept="image/*"
          capture="environment"
          class="scan-hidden-input"
          @change="handlePhotoSelected"
        />
        <input
          ref="galleryPhotoInputRef"
          type="file"
          accept="image/*"
          class="scan-hidden-input"
          @change="handlePhotoSelected"
        />

        <div class="ds-row">
          <button
            type="button"
            class="ds-btn ds-btn--primary"
            :disabled="photoUploading"
            @click="cameraPhotoInputRef?.click()"
          >
            {{ photoUploading ? t('app.loading') : t('scan.takePhoto') }}
          </button>
          <button
            type="button"
            class="ds-btn"
            :disabled="photoUploading"
            @click="galleryPhotoInputRef?.click()"
          >
            {{ t('scan.pickGallery') }}
          </button>
        </div>
      </div>

      <div v-if="!latestPhotoJob" class="ds-card ds-text-muted">
        {{ t('scan.photoNoActiveJob') }}
      </div>

      <template v-else>
        <div class="ds-panel ds-row ds-row--between">
          <strong>
            {{
              latestPhotoJob.status === 'error'
                ? t('scan.photoBannerError')
                : latestPhotoJob.status === 'done'
                  ? t('scan.photoBannerDone', {
                      done: latestPhotoJob.progressDone,
                      total: latestPhotoJob.progressTotal
                    })
                  : t('scan.photoBannerRunning', {
                      done: latestPhotoJob.progressDone,
                      total: latestPhotoJob.progressTotal
                    })
            }}
          </strong>

          <div class="ds-row">
            <button
              v-if="latestPhotoJob.status === 'error'"
              type="button"
              class="ds-btn ds-btn--primary ds-btn--sm"
              :disabled="photoRetryingOcr"
              @click="handleRetryOcr"
            >
              {{ photoRetryingOcr ? t('app.loading') : t('scan.photoRetryOcrBtn') }}
            </button>
            <button
              v-if="unresolvedItems.length > 0"
              type="button"
              class="ds-btn ds-btn--sm"
              @click="handleRetryFailed"
            >
              {{ t('scan.retryAllFailed', { count: unresolvedItems.length }) }}
            </button>
            <button type="button" class="ds-btn ds-btn--ghost ds-btn--sm" @click="handleDeletePhotoJob">
              {{ t('scan.clearBatch') }}
            </button>
          </div>
        </div>

        <div v-if="latestPhotoJob.errorMessage" class="ds-banner ds-banner--danger ds-row ds-row--between" role="alert">
          <span>{{ latestPhotoJob.errorMessage }}</span>
          <button
            v-if="latestPhotoJob.status === 'error'"
            type="button"
            class="ds-btn ds-btn--sm"
            :disabled="photoRetryingOcr"
            @click="handleRetryOcr"
          >
            {{ photoRetryingOcr ? t('app.loading') : t('scan.photoRetryOcrBtn') }}
          </button>
        </div>

        <div v-if="jobsStore.activePhotoCommitJob" class="ds-banner ds-banner--info" role="status">
          {{
            t('scan.photoCommitBannerRunning', {
              done: jobsStore.activePhotoCommitJob.progressDone,
              total: jobsStore.activePhotoCommitJob.progressTotal
            })
          }}
        </div>

        <!-- Aperçu cliquable de la photo analysée (ouvre la visionneuse plein écran zoom 2 doigts) -->
        <div v-if="photoResult?.previewUrl" class="ds-card ds-row ds-row--between photo-analyzed-bar">
          <div class="ds-row">
            <button
              type="button"
              class="photo-analyzed-thumb"
              :aria-label="t('scan.photoOpenFullscreenBtn')"
              @click="previewLightboxOpen = true"
            >
              <img :src="photoResult.previewUrl" :alt="t('scan.photoAnalyzedPreviewTitle')" />
            </button>
            <div class="ds-stack photo-analyzed-meta">
              <strong>{{ t('scan.photoAnalyzedPreviewTitle') }}</strong>
              <span class="ds-text-muted">{{ t('scan.photoTapToExpandHint') }}</span>
            </div>
          </div>
          <button type="button" class="ds-btn ds-btn--sm" @click="previewLightboxOpen = true">
            {{ t('scan.photoOpenFullscreenBtn') }}
          </button>
        </div>

        <!-- Identifiés -->
        <div v-if="identifiedItems.length > 0" class="ds-card ds-stack">
          <h2>{{ t('scan.identifiedSection', { count: identifiedItems.length }) }}</h2>
          <div class="ds-stack">
            <div v-for="item in identifiedItems" :key="item.id" class="ds-panel photo-item-row">
              <input
                type="checkbox"
                :checked="item.selected"
                :disabled="item.ignored || !item.selectedOptionIsbn13"
                @change="togglePhotoItemSelected(item)"
              />
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
                  <span v-if="getPhotoItemPositionShort(item)" class="ds-badge photo-item-pos">
                    {{ getPhotoItemPositionShort(item) }}
                  </span>
                  <strong>{{ getPhotoItemDisplayTitle(item) }}</strong>
                  <span class="ds-text-muted">
                    {{ getPhotoItemSubtitle(item) }}
                    <template v-if="item.ignored"> · {{ t('scan.photoIgnoredBadge') }}</template>
                  </span>
                </span>
              </button>
            </div>
          </div>
        </div>

        <!-- À vérifier -->
        <div v-if="doubtItems.length > 0" class="ds-card ds-stack">
          <h2>{{ t('scan.doubtSection', { count: doubtItems.length }) }}</h2>
          <div class="ds-stack">
            <div v-for="item in doubtItems" :key="item.id" class="ds-panel photo-item-row">
              <input
                type="checkbox"
                :checked="item.selected"
                :disabled="item.ignored || !item.selectedOptionIsbn13"
                @change="togglePhotoItemSelected(item)"
              />
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
                  <span v-if="getPhotoItemPositionShort(item)" class="ds-badge photo-item-pos">
                    {{ getPhotoItemPositionShort(item) }}
                  </span>
                  <strong>{{ getPhotoItemDisplayTitle(item) }}</strong>
                  <span class="ds-text-muted">{{ getPhotoItemSubtitle(item) }}</span>
                </span>
              </button>
            </div>
          </div>
        </div>

        <!-- Non identifiés -->
        <div v-if="unresolvedItems.length > 0" class="ds-card ds-stack">
          <h2>{{ t('scan.unresolvedSection', { count: unresolvedItems.length }) }}</h2>
          <div class="ds-stack">
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
                  <span v-if="getPhotoItemPositionShort(item)" class="ds-badge photo-item-pos">
                    {{ getPhotoItemPositionShort(item) }}
                  </span>
                  <strong>{{ item.hint.title }}</strong>
                  <span class="ds-text-muted">
                    {{ getPhotoItemSubtitle(item) !== '—' ? getPhotoItemSubtitle(item) : t('scan.wrongReferenceBtn') }}
                    <template v-if="item.fallbackCoverUrl"> · {{ t('scan.photoFallbackCoverHint') }}</template>
                  </span>
                </span>
              </button>
            </div>
          </div>
        </div>

        <PhotoLightboxModal
          :open="previewLightboxOpen"
          :src="photoResult?.previewUrl ?? null"
          :alt="t('scan.photoAnalyzedPreviewTitle')"
          @close="previewLightboxOpen = false"
        />

        <div v-if="selectedPhotoCount > 0" class="ds-row">
          <button
            type="button"
            class="ds-btn ds-btn--primary"
            :disabled="photoCommitting || Boolean(jobsStore.activePhotoCommitJob)"
            @click="handleCommitPhoto('owned')"
          >
            {{ t('scan.photoCommitOwnedBtn', { count: selectedPhotoCount }) }}
          </button>
          <button
            type="button"
            class="ds-btn"
            :disabled="photoCommitting || Boolean(jobsStore.activePhotoCommitJob)"
            @click="handleCommitPhoto('wish')"
          >
            {{ t('scan.photoCommitWishBtn', { count: selectedPhotoCount }) }}
          </button>
        </div>

        <PhotoItemModal
          :open="Boolean(activePhotoItem)"
          :job-id="latestPhotoJob.id"
          :item="activePhotoItem"
          :preview-url="photoResult?.previewUrl ?? null"
          @close="activePhotoItemId = null"
        />
      </template>
    </div>

    <!-- ONGLET 2 : MODE RAFALE -->
    <div v-else-if="scanStore.activeTab === 'burst'" class="ds-stack">
      <div class="ds-card ds-stack">
        <div class="ds-row ds-row--between">
          <button type="button" class="ds-btn ds-btn--primary" @click="burstCameraOpen = true">
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

      <div v-else class="ds-stack">
        <div class="ds-grid-2">
          <template v-for="entry in scanStore.burstItems" :key="entry.isbn13">
            <BookCard
              v-if="entry.book"
              :book="entry.book"
              selectable
              :selected="burstSelectedIds.has(entry.book.id)"
              @toggle-select="toggleBurstSelect"
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
                  ✕
                </button>
              </div>
            </div>
          </template>
        </div>
      </div>

      <BatchActionBar
        :selected-books="burstSelectedBooks"
        @action="handleBurstBatchAction"
        @open-genres="burstGenreOpen = true"
        @clear="burstSelectedIds = new Set()"
      />

      <CameraBarcodeModal
        :open="burstCameraOpen"
        mode="burst"
        :flash-state="burstFlash"
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

    <!-- ONGLET 3 : SCAN SIMPLE -->
    <div v-else-if="scanStore.activeTab === 'simple'" class="ds-card ds-stack">
      <button type="button" class="ds-btn ds-btn--primary" @click="simpleCameraOpen = true">
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

    <!-- ONGLET 4 : RECHERCHE TEXTUELLE MULTI-CRITÈRES (7 CHAMPS PERSISTANTS) -->
    <div v-else class="ds-stack">
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
          <div class="ds-grid-2">
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
          <div class="ds-grid-2">
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
          <div class="ds-stack">
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
  </section>
</template>

<style scoped>
.scan-hidden-input {
  display: none;
}

.scan-grow-input {
  flex: 1;
  min-width: 180px;
}

.photo-analyzed-bar {
  flex-wrap: wrap;
  gap: var(--space-3);
}

.photo-analyzed-thumb {
  width: 64px;
  height: 64px;
  padding: 0;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
  cursor: zoom-in;
  flex-shrink: 0;
}

.photo-analyzed-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.photo-analyzed-meta {
  gap: 2px;
}

.photo-item-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
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
  width: 44px;
  min-width: 44px;
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
  gap: 2px;
  min-width: 0;
}

.photo-item-pos {
  font-size: 0.72rem;
}
</style>
