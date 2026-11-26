<!-- src/client/views/SeriesDetailView.vue -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BookCard from '../components/books/BookCard.vue';
import SeriesCard from '../components/books/SeriesCard.vue';
import BatchActionBar from '../components/books/BatchActionBar.vue';
import BaseModal from '../components/base/BaseModal.vue';
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
import { normalizeTextKey } from '../../shared/bibliographic/text-normalize.util';
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
  // Priorise toujours la tâche en cours (`running`) avant une tâche en file d'attente (`pending`)
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
const searchQuery = ref('');
const selectedIds = ref<Set<string>>(new Set());

const deleteOpen = ref(false);
const lendOpen = ref(false);
const genreOpen = ref(false);
const attachOpen = ref(false);
const mergeEntireMode = ref(false);
const modalBusy = ref(false);

// Bloc repliable Intégrales + Modale ajout intégrale
const integralsExpanded = ref(false);
const addIntegralOpen = ref(false);
const newIntegralVolumes = ref<string[]>([]);
const newIntegralTitle = ref('');
const newIntegralIsbn = ref('');
const newIntegralStatus = ref<'owned' | 'wish'>('owned');

function openMergeWholeSeries(): void {
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
  }
  try {
    const res = await apiRequest<SeriesDetailResponse>(`/api/series/${encodeURIComponent(id)}`);
    series.value = res.series;
    siblingCuts.value = res.siblingCuts;
    books.value = res.books;
    // Déplier automatiquement la section Intégrales si l'utilisateur en possède déjà une dans cette série
    if (!silent && res.books.some((b) => b.isIntegral && b.ownershipStatus === 'owned')) {
      integralsExpanded.value = true;
    }
  } catch {
    if (!silent) series.value = null;
  } finally {
    if (silent) silentReloadInFlight = false;
    else loading.value = false;
  }
}

watch(() => route.params.seriesId, () => {
  lastJobReloadDone = -1;
  void loadSeries();
}, { immediate: true });

// Rafraîchissement silencieux en direct au fil de l'eau et à la fin de l'enrichissement / édition de la série
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

// Première intention : tomes unitaires ; les intégrales vivent dans leur propre section repliable
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

const visibleBooks = computed(() => {
  const base =
    filterMode.value === 'owned'
      ? ownedBooks.value
      : filterMode.value === 'unowned'
        ? unownedBooks.value
        : unitaryBooks.value;
  const needle = normalizeTextKey(searchQuery.value);
  if (!needle) return base;
  return base.filter((b) =>
    normalizeTextKey([b.title, b.volumeLabel ?? '', ...b.authors].join(' ')).includes(needle)
  );
});

const selectedBooks = computed(() =>
  books.value.filter((b) => selectedIds.value.has(b.id))
);

const progressTotal = computed(() =>
  unitaryBooks.value.length > 0 ? unitaryBooks.value.length : books.value.length
);
const progressPercent = computed(() => {
  const total = Math.max(1, progressTotal.value);
  return Math.min(100, Math.round((ownedBooks.value.length / total) * 100));
});

function openAddIntegralModal(): void {
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

async function handleExpandNow(): Promise<void> {
  if (!series.value) return;
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

async function handleExcludeSelected(): Promise<void> {
  if (!series.value || selectedIds.value.size === 0) return;
  try {
    const res = await apiRequest<{ ok: true; excludedCount: number }>(
      `/api/series/${encodeURIComponent(series.value.id)}/exclude`,
      {
        method: 'POST',
        body: { bookIds: Array.from(selectedIds.value) }
      }
    );
    uiStore.pushToast(t('series.excludedSuccessToast', { count: res.excludedCount }), 'info');
    await loadSeries();
    await libraryStore.syncNow();
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
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
    <div class="ds-row ds-row--between">
      <button type="button" class="ds-btn ds-btn--sm" @click="router.back()">
        ← {{ t('app.back') }}
      </button>
      <div v-if="series" class="ds-row">
        <button
          v-if="!activeSeriesJob"
          type="button"
          class="ds-btn ds-btn--sm"
          :disabled="expanding"
          @click="handleExpandNow"
        >
          {{ expanding ? t('app.loading') : series.isCompleteExpanded ? t('series.refreshSeriesBtn') : t('series.enrichNowBtn') }}
        </button>
        <button type="button" class="ds-btn ds-btn--sm" @click="openMergeWholeSeries">
          {{ t('series.mergeWholeSeriesBtn') }}
        </button>
        <button
          v-if="selectedIds.size > 0"
          type="button"
          class="ds-btn ds-btn--sm"
          @click="handleExcludeSelected"
        >
          {{ t('series.excludeSelectedBtn', { count: selectedIds.size }) }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="ds-card ds-text-muted">{{ t('app.loading') }}</div>
    <div v-else-if="!series" class="ds-card ds-text-muted">{{ t('series.notFound') }}</div>

    <template v-else>
      <div class="ds-card ds-stack">
        <div class="ds-row ds-row--between">
          <div>
            <h1>{{ series.canonicalName }}</h1>
            <p v-if="series.primaryAuthors.length > 0" class="ds-text-muted">
              {{ series.primaryAuthors.join(', ') }}
            </p>
          </div>
          <span class="ds-badge ds-badge--accent">
            {{ t('collection.ownedProgress', { owned: ownedBooks.length, total: progressTotal }) }}
          </span>
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

      <!-- Autres découpages éditoriaux de la même Franchise -->
      <div v-if="siblingCuts.length > 0" class="ds-card ds-stack">
        <h2>{{ t('series.otherEditionsOfFranchise') }}</h2>
        <div class="ds-grid-2">
          <SeriesCard
            v-for="cut in siblingCuts"
            :key="cut.id"
            :series="cut"
            @open="(id) => router.push(`/series/${encodeURIComponent(id)}`)"
          />
        </div>
      </div>

      <!-- Section repliable dédiée aux Intégrales (séparée des tomes unitaires) -->
      <div class="ds-card ds-stack series-integrals-box">
        <div class="ds-row ds-row--between">
          <button
            type="button"
            class="ds-btn ds-btn--ghost ds-btn--sm series-integrals-toggle"
            :aria-expanded="integralsExpanded"
            @click="integralsExpanded = !integralsExpanded"
          >
            <span>{{ integralsExpanded ? '▾' : '▸' }} {{ t('series.integralsAccordionTitle', { count: integralBooks.length }) }}</span>
            <span v-if="ownedIntegralsCount > 0" class="ds-badge ds-badge--accent">
              {{ t('series.integralsOwnedBadge', { owned: ownedIntegralsCount }) }}
            </span>
          </button>
          <button type="button" class="ds-btn ds-btn--sm" @click="openAddIntegralModal">
            {{ t('series.addIntegralBtn') }}
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
              @open="(id) => router.push(`/book/${encodeURIComponent(id)}`)"
            />
          </div>
        </template>
      </div>

      <div class="ds-tabs" role="tablist">
        <button
          type="button"
          class="ds-tab"
          :class="{ 'ds-tab--active': filterMode === 'all' }"
          @click="filterMode = 'all'"
        >
          {{ t('series.filterAll', { count: unitaryBooks.length }) }}
        </button>
        <button
          type="button"
          class="ds-tab"
          :class="{ 'ds-tab--active': filterMode === 'owned' }"
          @click="filterMode = 'owned'"
        >
          {{ t('series.filterOwned', { count: ownedBooks.length }) }}
        </button>
        <button
          type="button"
          class="ds-tab"
          :class="{ 'ds-tab--active': filterMode === 'unowned' }"
          @click="filterMode = 'unowned'"
        >
          {{ t('series.filterUnowned', { count: unownedBooks.length }) }}
        </button>
      </div>

      <div class="ds-panel">
        <input
          v-model="searchQuery"
          type="search"
          class="ds-input"
          :placeholder="t('series.searchPlaceholder')"
        />
      </div>

      <p v-if="visibleBooks.length === 0" class="ds-card ds-text-muted">{{ t('collection.empty') }}</p>
      <div v-else class="ds-grid-2">
        <BookCard
          v-for="book in visibleBooks"
          :key="book.id"
          :book="book"
          selectable
          :selected="selectedIds.has(book.id)"
          @toggle-select="toggleSelect"
          @open="(id) => router.push(`/book/${encodeURIComponent(id)}`)"
        />
      </div>

      <BatchActionBar
        :selected-books="selectedBooks"
        show-attach-series
        @action="handleBatchAction"
        @open-genres="genreOpen = true"
        @open-attach-series="openAttachSelected"
        @clear="selectedIds = new Set()"
      />

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
          <div class="ds-row">
            <button
              type="button"
              class="ds-btn ds-btn--sm"
              :class="{ 'ds-btn--primary': newIntegralStatus === 'owned' }"
              @click="newIntegralStatus = 'owned'"
            >
              {{ t('series.addIntegralStatusOwned') }}
            </button>
            <button
              type="button"
              class="ds-btn ds-btn--sm"
              :class="{ 'ds-btn--primary': newIntegralStatus === 'wish' }"
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
.series-job-banner {
  margin-bottom: 0;
}

.series-integrals-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-weight: 600;
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
}
</style>
