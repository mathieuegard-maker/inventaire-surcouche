<!-- src/client/views/SeriesDetailView.vue -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ChevronDown,
  ChevronUp,
  GitMerge,
  Layers,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Split,
  Unlink
} from '@lucide/vue';
import BookCard from '../components/books/BookCard.vue';
import SeriesCard from '../components/books/SeriesCard.vue';
import BatchActionBar from '../components/books/BatchActionBar.vue';
import BaseModal from '../components/base/BaseModal.vue';
import ListControlBar from '../components/base/ListControlBar.vue';
import PaginationBar from '../components/base/PaginationBar.vue';
import IntegralFields from '../components/books/IntegralFields.vue';
import ConfirmDeleteModal from '../components/modals/ConfirmDeleteModal.vue';
import LendModal from '../components/modals/LendModal.vue';
import BatchGenreModal from '../components/modals/BatchGenreModal.vue';
import SeriesAttachModal from '../components/modals/SeriesAttachModal.vue';
import { apiRequest, ApiClientError } from '../api/client';
import { useLibraryStore } from '../stores/library.store';
import { useAuthStore } from '../stores/auth.store';
import { useUiStore } from '../stores/ui.store';
import { useJobsStore } from '../stores/jobs.store';
import { filterEligibleBooksForBatchAction, type BatchActionType } from '../../shared/bibliographic/batch-actions.util';
import {
  applyBookListFilters,
  createEmptyListFilters,
  extractFilterFacets,
  type CompositeListFilters
} from '../../shared/bibliographic/list-filter.util';
import type { BookView, SeriesView } from '../../shared/types/domain.types';
import { t } from '../../shared/locales';

interface SeriesDetailResponse {
  ok: true;
  series: SeriesView;
  franchiseName: string | null;
  siblingCuts: SeriesView[];
  books: BookView[];
}

const route = useRoute();
const router = useRouter();
const libraryStore = useLibraryStore();
const authStore = useAuthStore();
const uiStore = useUiStore();
const jobsStore = useJobsStore();

const currentSeriesId = computed(() => (typeof route.params.seriesId === 'string' ? route.params.seriesId : ''));

const activeSeriesJob = computed(() => {
  const sid = currentSeriesId.value;
  if (!sid) return null;
  const matching = jobsStore.jobs.filter(
    (j) =>
      (j.type === 'series_expand' ||
        j.type === 'series_enrich_volumes' ||
        j.type === 'series_apply_edition_covers') &&
      (j.status === 'pending' || j.status === 'running') &&
      (!j.targetSeriesId || j.targetSeriesId === sid)
  );
  return matching.find((j) => j.status === 'running') ?? matching[0] ?? null;
});

const latestCompletedSeriesJobSig = computed(() => {
  const sid = currentSeriesId.value;
  if (!sid) return '';
  const matching = jobsStore.jobs.filter(
    (j) =>
      (j.type === 'series_expand' ||
        j.type === 'series_enrich_volumes' ||
        j.type === 'series_apply_edition_covers') &&
      (!j.targetSeriesId || j.targetSeriesId === sid)
  );
  return matching.map((j) => `${j.id}:${j.status}:${j.progressDone}`).join('|');
});

const loading = ref(true);
const expanding = ref(false);
const series = ref<SeriesView | null>(null);
const siblingCuts = ref<SeriesView[]>([]);
const books = ref<BookView[]>([]);

const filterMode = ref<'all' | 'owned' | 'unowned'>('all');
const filters = ref<CompositeListFilters>(createEmptyListFilters());
const page = ref(1);
const pageSize = ref(20);
const selectedIds = ref<Set<string>>(new Set());

const actionsMenuOpen = ref(false);
const actionsMenuRef = ref<HTMLElement | null>(null);
const siblingCutsModalOpen = ref(false);
const excludeConfirmOpen = ref(false);

const deleteOpen = ref(false);
const lendOpen = ref(false);
const genreOpen = ref(false);
const attachOpen = ref(false);
const mergeEntireMode = ref(false);
const modalBusy = ref(false);

// Section Intégrales en bas (après la dernière BD de la série)
const integralsExpanded = ref(false);
const addIntegralOpen = ref(false);
const newIntegralVolumes = ref<string[]>([]);
const newIntegralTitle = ref('');
const newIntegralIsbn = ref('');
const newIntegralStatus = ref<'owned' | 'wish'>('owned');

function onDocClick(event: MouseEvent): void {
  if (!actionsMenuOpen.value) return;
  if (actionsMenuRef.value && !actionsMenuRef.value.contains(event.target as Node)) {
    actionsMenuOpen.value = false;
  }
}

onMounted(() => {
  document.addEventListener('click', onDocClick);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
});

function openMergeWholeSeries(): void {
  actionsMenuOpen.value = false;
  mergeEntireMode.value = true;
  attachOpen.value = true;
}

function openAttachSelected(): void {
  mergeEntireMode.value = false;
  attachOpen.value = true;
}

async function handleSeriesAttached(targetSeriesId: string): Promise<void> {
  if (mergeEntireMode.value && targetSeriesId && targetSeriesId !== series.value?.id) {
    await router.replace(`/series/${encodeURIComponent(targetSeriesId)}`);
    return;
  }
  await loadSeries();
}

let silentReloadInFlight = false;
let lastJobReloadDone = -1;

async function loadSeries(options?: { silent?: boolean }): Promise<void> {
  const id = currentSeriesId.value;
  if (!id) return;
  const silent = Boolean(options?.silent);
  if (silent) {
    if (silentReloadInFlight) return;
    silentReloadInFlight = true;
  } else {
    loading.value = true;
    selectedIds.value = new Set();
    page.value = 1;
  }
  try {
    const res = await apiRequest<SeriesDetailResponse>(`/api/series/${encodeURIComponent(id)}`);
    series.value = res.series;
    siblingCuts.value = res.siblingCuts;
    books.value = res.books;
  } catch {
    if (!silent) series.value = null;
  } finally {
    if (silent) silentReloadInFlight = false;
    else loading.value = false;
  }
}

watch(
  () => route.params.seriesId,
  () => {
    lastJobReloadDone = -1;
    actionsMenuOpen.value = false;
    void loadSeries();
  },
  { immediate: true }
);

watch(latestCompletedSeriesJobSig, (nextSig, prevSig) => {
  if (!nextSig || nextSig === prevSig || !series.value) return;
  const sid = currentSeriesId.value;
  const matching = jobsStore.jobs.filter(
    (j) =>
      (j.type === 'series_expand' ||
        j.type === 'series_enrich_volumes' ||
        j.type === 'series_apply_edition_covers') &&
      (!j.targetSeriesId || j.targetSeriesId === sid)
  );
  const hadActiveBefore = Boolean(prevSig && (prevSig.includes(':running:') || prevSig.includes(':pending:')));
  const hasActiveNow = matching.some((j) => j.status === 'running' || j.status === 'pending');
  const justFinished =
    matching.some((j) => j.status === 'done' && prevSig && !prevSig.includes(`${j.id}:done:`)) ||
    (hadActiveBefore && !hasActiveNow);
  const runningProgress = matching.find(
    (j) => (j.type === 'series_enrich_volumes' || j.type === 'series_apply_edition_covers') && j.status === 'running'
  );
  const step = runningProgress?.type === 'series_apply_edition_covers' ? 2 : 4;
  if (justFinished) {
    lastJobReloadDone = -1;
    void loadSeries({ silent: true });
  } else if (
    runningProgress &&
    runningProgress.progressDone > 0 &&
    runningProgress.progressDone !== lastJobReloadDone &&
    runningProgress.progressDone % step === 0
  ) {
    lastJobReloadDone = runningProgress.progressDone;
    void loadSeries({ silent: true });
  }
});

const unitaryBooks = computed(() => books.value.filter((b) => !b.isIntegral));
const integralBooks = computed(() => books.value.filter((b) => b.isIntegral));
const ownedIntegralsCount = computed(() =>
  integralBooks.value.filter((b) => b.ownershipStatus === 'owned').length
);

const ownedBooks = computed(() =>
  unitaryBooks.value.filter((b) => b.ownershipStatus === 'owned' || Boolean(b.ownedViaIntegral))
);
const unownedBooks = computed(() =>
  unitaryBooks.value.filter((b) => b.ownershipStatus !== 'owned' && !b.ownedViaIntegral)
);

const facets = computed(() => extractFilterFacets(unitaryBooks.value, authStore.profile?.defaultGenres ?? []));

const visibleBooks = computed(() => {
  const base =
    filterMode.value === 'owned'
      ? ownedBooks.value
      : filterMode.value === 'unowned'
        ? unownedBooks.value
        : unitaryBooks.value;
  return applyBookListFilters(base, filters.value);
});

const totalPages = computed(() => Math.max(1, Math.ceil(visibleBooks.value.length / pageSize.value)));

watch([filterMode, filters, pageSize], () => {
  page.value = 1;
}, { deep: true });

const paginatedBooks = computed(() => {
  const start = (page.value - 1) * pageSize.value;
  return visibleBooks.value.slice(start, start + pageSize.value);
});

const selectedBooks = computed(() => books.value.filter((b) => selectedIds.value.has(b.id)));

const progressTotal = computed(() =>
  unitaryBooks.value.length > 0 ? unitaryBooks.value.length : books.value.length
);
const progressPercent = computed(() => {
  const total = Math.max(1, progressTotal.value);
  return Math.min(100, Math.round((ownedBooks.value.length / total) * 100));
});

function openAddIntegralModal(): void {
  actionsMenuOpen.value = false;
  newIntegralVolumes.value = [];
  newIntegralTitle.value = '';
  newIntegralIsbn.value = '';
  newIntegralStatus.value = 'owned';
  addIntegralOpen.value = true;
}

async function submitAddIntegral(): Promise<void> {
  if (!series.value) return;
  if (newIntegralVolumes.value.length === 0) {
    uiStore.pushToast(t('book.integralVolumesRequiredError'), 'warning');
    return;
  }
  modalBusy.value = true;
  try {
    await apiRequest(`/api/series/${encodeURIComponent(series.value.id)}/integrals`, {
      method: 'POST',
      body: {
        includedVolumes: newIntegralVolumes.value,
        title: newIntegralTitle.value.trim() || undefined,
        isbn13: newIntegralIsbn.value.trim() || undefined,
        ownershipStatus: newIntegralStatus.value
      }
    });
    addIntegralOpen.value = false;
    integralsExpanded.value = true;
    await loadSeries();
    await libraryStore.syncNow();
    uiStore.pushToast(t('book.integralSeparateCreatedToast'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    modalBusy.value = false;
  }
}

function toggleSelect(bookId: string): void {
  const next = new Set(selectedIds.value);
  if (next.has(bookId)) next.delete(bookId);
  else next.add(bookId);
  selectedIds.value = next;
}

function toggleSelectAllPage(): void {
  const pageIds = paginatedBooks.value.map((b) => b.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.value.has(id));
  const next = new Set(selectedIds.value);
  if (allSelected) {
    for (const id of pageIds) next.delete(id);
  } else {
    for (const id of pageIds) next.add(id);
  }
  selectedIds.value = next;
}

async function handleExpandNow(): Promise<void> {
  if (!series.value) return;
  actionsMenuOpen.value = false;
  expanding.value = true;
  try {
    const res = await apiRequest<{
      ok: true;
      report: { addedCount: number; totalVolumes: number };
      detail: { series: SeriesView; siblingCuts: SeriesView[]; books: BookView[] };
    }>(`/api/series/${encodeURIComponent(series.value.id)}/expand`, { method: 'POST' });

    series.value = res.detail.series;
    siblingCuts.value = res.detail.siblingCuts;
    books.value = res.detail.books;
    await libraryStore.syncNow();

    uiStore.pushToast(
      res.report.addedCount > 0
        ? t('series.enrichAddedResult', { added: res.report.addedCount, total: res.report.totalVolumes })
        : t('series.enrichNoNewResult', { total: res.report.totalVolumes }),
      'success'
    );
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    expanding.value = false;
  }
}

async function confirmExcludeSelected(): Promise<void> {
  if (!series.value || selectedIds.value.size === 0) return;
  modalBusy.value = true;
  try {
    const res = await apiRequest<{ ok: true; excludedCount: number }>(
      `/api/series/${encodeURIComponent(series.value.id)}/exclude`,
      {
        method: 'POST',
        body: { bookIds: Array.from(selectedIds.value) }
      }
    );
    excludeConfirmOpen.value = false;
    uiStore.pushToast(t('series.excludedSuccessToast', { count: res.excludedCount }), 'info');
    await loadSeries();
    await libraryStore.syncNow();
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    modalBusy.value = false;
  }
}

async function handleBatchAction(action: BatchActionType): Promise<void> {
  const eligible = filterEligibleBooksForBatchAction(selectedBooks.value, action);
  if (eligible.length === 0) return;
  if (action === 'DELETE') {
    deleteOpen.value = true;
    return;
  }
  if (action === 'LEND') {
    lendOpen.value = true;
    return;
  }
  if (action === 'RETURN') {
    await libraryStore.returnBooks(eligible.map((b) => b.id));
    uiStore.pushToast(t('loans.returnedToast'), 'success');
    await loadSeries();
    return;
  }
  const targetStatus = action === 'ADD_OWNED' ? 'owned' : 'wish';
  await libraryStore.applyBatchStatus({ bookIds: eligible.map((b) => b.id), status: targetStatus });
  uiStore.pushToast(t('batch.statusUpdatedToast'), 'success');
  await loadSeries();
}

async function confirmDelete(payload: {
  bookIds: string[];
  lentDecisions: Record<string, 'keep' | 'return_and_delete'>;
}): Promise<void> {
  modalBusy.value = true;
  try {
    await libraryStore.applyBatchStatus({
      bookIds: payload.bookIds,
      status: 'none',
      lentDecisions: payload.lentDecisions
    });
    deleteOpen.value = false;
    await loadSeries();
    uiStore.pushToast(t('batch.statusUpdatedToast'), 'success');
  } finally {
    modalBusy.value = false;
  }
}

async function confirmLend(payload: { borrowerName: string; notes?: string }): Promise<void> {
  const eligible = filterEligibleBooksForBatchAction(selectedBooks.value, 'LEND');
  if (eligible.length === 0) return;
  modalBusy.value = true;
  try {
    await libraryStore.lendBooks({
      bookIds: eligible.map((b) => b.id),
      borrowerName: payload.borrowerName,
      notes: payload.notes
    });
    lendOpen.value = false;
    await loadSeries();
    uiStore.pushToast(t('loans.lentToast', { name: payload.borrowerName }), 'success');
  } finally {
    modalBusy.value = false;
  }
}

function openSeriesBook(bookId: string): void {
  libraryStore.setNavigationList(visibleBooks.value.map((b) => b.id));
  void router.push(`/book/${encodeURIComponent(bookId)}`);
}

function openIntegralBook(bookId: string): void {
  libraryStore.setNavigationList(integralBooks.value.map((b) => b.id));
  void router.push(`/book/${encodeURIComponent(bookId)}`);
}

async function confirmGenres(genres: string[]): Promise<void> {
  const ids = selectedBooks.value.map((b) => b.id);
  if (ids.length === 0) return;
  modalBusy.value = true;
  try {
    await libraryStore.applyBatchGenres(ids, genres);
    genreOpen.value = false;
    await loadSeries();
    uiStore.pushToast(t('batch.genresAppliedToast'), 'success');
  } finally {
    modalBusy.value = false;
  }
}
</script>

<template>
  <section class="ds-stack">
    <div v-if="loading" class="ds-card ds-text-muted">{{ t('app.loading') }}</div>
    <div v-else-if="!series" class="ds-card ds-text-muted">{{ t('series.notFound') }}</div>

    <template v-else>
      <!-- En-tête épuré : Titre, Auteurs, Progression + menu unique « Actions » -->
      <div class="ds-card ds-stack--sm">
        <div class="series-head">
          <div class="series-head__titles">
            <h1>{{ series.canonicalName }}</h1>
            <p v-if="series.primaryAuthors.length > 0" class="ds-text-muted series-head__authors">
              {{ series.primaryAuthors.join(', ') }}
            </p>
          </div>

          <div ref="actionsMenuRef" class="ds-menu-wrap">
            <button
              type="button"
              class="ds-btn ds-btn--sm"
              :aria-expanded="actionsMenuOpen"
              @click.stop="actionsMenuOpen = !actionsMenuOpen"
            >
              <MoreHorizontal :size="16" aria-hidden="true" />
              <span>{{ t('app.actions') }}</span>
            </button>

            <div v-if="actionsMenuOpen" class="ds-menu-popover" role="menu">
              <button
                v-if="!activeSeriesJob"
                type="button"
                class="ds-menu-item"
                role="menuitem"
                :disabled="expanding"
                @click="handleExpandNow"
              >
                <span>{{ expanding ? t('app.loading') : series.isCompleteExpanded ? t('series.refreshSeriesBtn') : t('series.enrichNowBtn') }}</span>
                <RefreshCw :size="15" aria-hidden="true" />
              </button>

              <button
                type="button"
                class="ds-menu-item"
                role="menuitem"
                @click="openMergeWholeSeries"
              >
                <span>{{ t('series.mergeWholeSeriesBtn') }}</span>
                <GitMerge :size="15" aria-hidden="true" />
              </button>

              <button
                v-if="siblingCuts.length > 0"
                type="button"
                class="ds-menu-item"
                role="menuitem"
                @click="actionsMenuOpen = false; siblingCutsModalOpen = true"
              >
                <span>{{ t('series.otherEditionsOfFranchise') }} ({{ siblingCuts.length }})</span>
                <Split :size="15" aria-hidden="true" />
              </button>

              <button
                type="button"
                class="ds-menu-item"
                role="menuitem"
                @click="openAddIntegralModal"
              >
                <span>{{ t('series.addIntegralBtn') }}</span>
                <Plus :size="15" aria-hidden="true" />
              </button>

              <button
                v-if="selectedIds.size > 0"
                type="button"
                class="ds-menu-item ds-menu-item--danger"
                role="menuitem"
                @click="actionsMenuOpen = false; excludeConfirmOpen = true"
              >
                <span>{{ t('series.excludeSelectedBtn', { count: selectedIds.size }) }}</span>
                <Unlink :size="15" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        <div class="series-progress-meta">
          <span class="ds-badge ds-badge--accent">
            {{ t('collection.ownedProgress', { owned: ownedBooks.length, total: progressTotal }) }}
          </span>
          <span class="ds-text-muted">{{ progressPercent }} %</span>
        </div>

        <div class="series-progress-bar" role="progressbar" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100">
          <div class="series-progress-bar__fill" :style="{ width: `${progressPercent}%` }" />
        </div>

        <p v-if="activeSeriesJob" class="ds-banner ds-banner--warning series-job-banner" role="status">
          {{
            activeSeriesJob.type === 'series_expand'
              ? activeSeriesJob.status === 'running'
                ? t('series.expandingBanner')
                : t('series.expandingQueuedBanner')
              : activeSeriesJob.type === 'series_apply_edition_covers'
                ? activeSeriesJob.status === 'running'
                  ? t('series.applyingEditionCoversBanner', {
                      done: activeSeriesJob.progressDone,
                      total: Math.max(1, activeSeriesJob.progressTotal)
                    })
                  : t('series.applyingEditionCoversQueuedBanner', {
                      total: Math.max(1, activeSeriesJob.progressTotal)
                    })
                : activeSeriesJob.status === 'running'
                  ? t('series.enrichingCoversBanner', {
                      done: activeSeriesJob.progressDone,
                      total: Math.max(1, activeSeriesJob.progressTotal)
                    })
                  : t('series.enrichingCoversQueuedBanner', {
                      total: Math.max(1, activeSeriesJob.progressTotal)
                    })
          }}
        </p>
      </div>

      <!-- Filtres Tout / Possédés / Non possédés en vrais boutons segmentés sur 1 ligne -->
      <div class="ds-segmented" role="tablist">
        <button
          type="button"
          role="tab"
          class="ds-segmented__btn"
          :class="{ 'ds-segmented__btn--active': filterMode === 'all' }"
          @click="filterMode = 'all'"
        >
          {{ t('series.filterAll', { count: unitaryBooks.length }) }}
        </button>
        <button
          type="button"
          role="tab"
          class="ds-segmented__btn"
          :class="{ 'ds-segmented__btn--active': filterMode === 'owned' }"
          @click="filterMode = 'owned'"
        >
          {{ t('series.filterOwned', { count: ownedBooks.length }) }}
        </button>
        <button
          type="button"
          role="tab"
          class="ds-segmented__btn"
          :class="{ 'ds-segmented__btn--active': filterMode === 'unowned' }"
          @click="filterMode = 'unowned'"
        >
          {{ t('series.filterUnowned', { count: unownedBooks.length }) }}
        </button>
      </div>

      <ListControlBar
        :filters="filters"
        :facets="facets"
        :enabled-facets="['volumeNumber', 'publisher', 'readingStatus', 'loanState']"
        :placeholder="t('series.searchPlaceholder')"
        :show-select-all="paginatedBooks.length > 0"
        @update:filters="(next) => (filters = next)"
        @select-all="toggleSelectAllPage"
      />

      <p v-if="visibleBooks.length === 0" class="ds-card ds-text-muted">{{ t('collection.empty') }}</p>
      <div v-else class="ds-grid-2">
        <BookCard
          v-for="book in paginatedBooks"
          :key="book.id"
          :book="book"
          selectable
          :selected="selectedIds.has(book.id)"
          @toggle-select="toggleSelect"
          @open="openSeriesBook"
        />
      </div>

      <PaginationBar
        :page="page"
        :total-pages="totalPages"
        :page-size="pageSize"
        :total-items="visibleBooks.length"
        @update:page="(p) => (page = p)"
        @update:page-size="(s) => (pageSize = s)"
      />

      <!-- Section Intégrales placée en bas, juste après la dernière BD de la série -->
      <div class="ds-card ds-stack--sm series-integrals-card">
        <div class="series-integrals-header">
          <button
            type="button"
            class="series-integrals-trigger"
            :aria-expanded="integralsExpanded"
            @click="integralsExpanded = !integralsExpanded"
          >
            <Layers :size="18" class="series-integrals-trigger__icon" aria-hidden="true" />
            <span class="series-integrals-trigger__text">
              <strong>{{ t('series.integralsCardTitle', { count: integralBooks.length }) }}</strong>
              <span class="ds-text-muted">
                {{ integralBooks.length > 0 ? t('series.integralsCardHint') : t('series.integralsCardEmpty') }}
              </span>
            </span>
            <span v-if="ownedIntegralsCount > 0" class="ds-badge ds-badge--accent series-integrals-trigger__badge">
              {{ t('series.integralsOwnedBadge', { owned: ownedIntegralsCount }) }}
            </span>
            <ChevronUp v-if="integralsExpanded" :size="18" class="series-integrals-trigger__chev" aria-hidden="true" />
            <ChevronDown v-else :size="18" class="series-integrals-trigger__chev" aria-hidden="true" />
          </button>

          <button type="button" class="ds-btn ds-btn--soft ds-btn--sm series-integrals-add-btn" @click="openAddIntegralModal">
            <Plus :size="15" aria-hidden="true" />
            <span>{{ t('series.addIntegralBtn') }}</span>
          </button>
        </div>

        <template v-if="integralsExpanded">
          <p v-if="integralBooks.length === 0" class="ds-text-muted">{{ t('series.integralsEmpty') }}</p>
          <div v-else class="ds-grid-2">
            <BookCard
              v-for="intBook in integralBooks"
              :key="intBook.id"
              :book="intBook"
              selectable
              :selected="selectedIds.has(intBook.id)"
              @toggle-select="toggleSelect"
              @open="openIntegralBook"
            />
          </div>
        </template>
      </div>

      <BatchActionBar
        :selected-books="selectedBooks"
        show-attach-series
        @action="handleBatchAction"
        @open-genres="genreOpen = true"
        @open-attach-series="openAttachSelected"
        @clear="selectedIds = new Set()"
      />

      <!-- Modale « Autres découpages de la saga » (rangée dans Actions) -->
      <BaseModal
        :open="siblingCutsModalOpen"
        :title="t('series.otherEditionsModalTitle')"
        max-width="520px"
        @close="siblingCutsModalOpen = false"
      >
        <div class="ds-stack--sm">
          <SeriesCard
            v-for="cut in siblingCuts"
            :key="cut.id"
            :series="cut"
            @open="(id) => { siblingCutsModalOpen = false; router.push(`/series/${encodeURIComponent(id)}`); }"
          />
        </div>
      </BaseModal>

      <!-- Confirmation exclusion de la sélection -->
      <BaseModal
        :open="excludeConfirmOpen"
        :title="t('book.excludeFromSeriesConfirmTitle')"
        max-width="420px"
        @close="excludeConfirmOpen = false"
      >
        <p>{{ t('book.excludeFromSeriesConfirmDesc', { series: series.canonicalName }) }}</p>
        <template #footer>
          <button type="button" class="ds-btn" :disabled="modalBusy" @click="excludeConfirmOpen = false">
            {{ t('app.cancel') }}
          </button>
          <button type="button" class="ds-btn ds-btn--danger" :disabled="modalBusy" @click="confirmExcludeSelected">
            {{ t('app.confirm') }}
          </button>
        </template>
      </BaseModal>

      <SeriesAttachModal
        :open="attachOpen"
        :book-ids="mergeEntireMode ? [] : Array.from(selectedIds)"
        :source-series-id="series.id"
        :source-series-name="series.canonicalName"
        :source-franchise-id="series.franchiseId"
        :default-merge-entire="mergeEntireMode"
        @close="attachOpen = false"
        @attached="handleSeriesAttached"
      />

      <ConfirmDeleteModal
        :open="deleteOpen"
        :books="selectedBooks"
        :busy="modalBusy"
        @close="deleteOpen = false"
        @confirm="confirmDelete"
      />

      <LendModal
        :open="lendOpen"
        :book-count="filterEligibleBooksForBatchAction(selectedBooks, 'LEND').length"
        :contacts="libraryStore.contacts"
        :busy="modalBusy"
        @close="lendOpen = false"
        @confirm="confirmLend"
      />

      <BatchGenreModal
        :open="genreOpen"
        :book-count="selectedBooks.length"
        :default-genres="authStore.profile?.defaultGenres ?? []"
        :busy="modalBusy"
        @close="genreOpen = false"
        @confirm="confirmGenres"
        @add-default-genre="(g) => authStore.updateDefaultGenres('add', g)"
      />

      <BaseModal
        :open="addIntegralOpen"
        :title="t('series.addIntegralModalTitle', { name: series.canonicalName })"
        @close="addIntegralOpen = false"
      >
        <div class="ds-stack">
          <IntegralFields
            :is-integral="true"
            v-model:included-volumes="newIntegralVolumes"
          />
          <div class="ds-field">
            <label class="ds-label" for="series-int-title">{{ t('series.addIntegralTitleLabel') }}</label>
            <input
              id="series-int-title"
              v-model="newIntegralTitle"
              type="text"
              class="ds-input"
              :placeholder="t('series.addIntegralTitlePlaceholder')"
            />
          </div>
          <div class="ds-field">
            <label class="ds-label" for="series-int-isbn">{{ t('series.addIntegralIsbnLabel') }}</label>
            <input id="series-int-isbn" v-model="newIntegralIsbn" type="text" class="ds-input" />
          </div>
          <div class="ds-segmented">
            <button
              type="button"
              class="ds-segmented__btn"
              :class="{ 'ds-segmented__btn--active': newIntegralStatus === 'owned' }"
              @click="newIntegralStatus = 'owned'"
            >
              {{ t('series.addIntegralStatusOwned') }}
            </button>
            <button
              type="button"
              class="ds-segmented__btn"
              :class="{ 'ds-segmented__btn--active': newIntegralStatus === 'wish' }"
              @click="newIntegralStatus = 'wish'"
            >
              {{ t('series.addIntegralStatusWish') }}
            </button>
          </div>
        </div>
        <template #footer>
          <button type="button" class="ds-btn" :disabled="modalBusy" @click="addIntegralOpen = false">
            {{ t('app.cancel') }}
          </button>
          <button type="button" class="ds-btn ds-btn--primary" :disabled="modalBusy" @click="submitAddIntegral">
            {{ modalBusy ? t('app.loading') : t('app.save') }}
          </button>
        </template>
      </BaseModal>
    </template>
  </section>
</template>

<style scoped>
.series-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.series-head__titles {
  flex: 1;
  min-inline-size: 0;
}

.series-head__titles h1 {
  margin: 0 0 2px;
}

.series-head__authors {
  margin: 0;
}

.series-progress-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.series-job-banner {
  margin-bottom: 0;
}

.series-progress-bar {
  height: 8px;
  width: 100%;
  border-radius: var(--radius-pill);
  background: var(--bg-elevated);
  overflow: hidden;
}

.series-progress-bar__fill {
  height: 100%;
  background: var(--accent);
  border-radius: var(--radius-pill);
  transition: width 0.25s ease;
}

.series-integrals-card {
  border-style: dashed;
}

.series-integrals-header {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-3);
}

@media (min-width: 640px) {
  .series-integrals-header {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
}

.series-integrals-trigger {
  flex: 1;
  min-inline-size: 0;
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
  color: var(--text-primary);
  text-align: left;
}

.series-integrals-trigger__icon,
.series-integrals-trigger__badge,
.series-integrals-trigger__chev {
  flex-shrink: 0;
}

.series-integrals-trigger__icon {
  color: var(--accent);
}

.series-integrals-trigger__text {
  flex: 1;
  min-inline-size: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-wrap: break-word;
}

.series-integrals-add-btn {
  align-self: flex-start;
  flex-shrink: 0;
}

@media (min-width: 640px) {
  .series-integrals-add-btn {
    align-self: center;
  }
}
</style>
