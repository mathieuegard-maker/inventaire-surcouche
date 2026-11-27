<!-- src/client/views/ReleasesView.vue -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { RefreshCw } from '@lucide/vue';
import BookCard from '../components/books/BookCard.vue';
import BatchActionBar from '../components/books/BatchActionBar.vue';
import ListControlBar from '../components/base/ListControlBar.vue';
import PaginationBar from '../components/base/PaginationBar.vue';
import { apiRequest, ApiClientError } from '../api/client';
import { useLibraryStore } from '../stores/library.store';
import { useAuthStore } from '../stores/auth.store';
import { useUiStore } from '../stores/ui.store';
import { filterEligibleBooksForBatchAction, type BatchActionType } from '../../shared/bibliographic/batch-actions.util';
import {
  applyBookListFilters,
  createEmptyListFilters,
  extractFilterFacets,
  type CompositeListFilters
} from '../../shared/bibliographic/list-filter.util';
import type { BookView } from '../../shared/types/domain.types';
import { t } from '../../shared/locales';

interface ReleaseAlertItem {
  alertId: string;
  seriesId: string;
  seriesName: string;
  detectedAt: string;
  book: BookView;
}

const router = useRouter();
const libraryStore = useLibraryStore();
const authStore = useAuthStore();
const uiStore = useUiStore();

const loading = ref(true);
const checking = ref(false);
const alerts = ref<ReleaseAlertItem[]>([]);
const filters = ref<CompositeListFilters>(createEmptyListFilters());
const sortBy = ref<'dateDesc' | 'dateAsc' | 'alphaAsc' | 'alphaDesc'>('dateDesc');
const page = ref(1);
const pageSize = ref(20);
const selectedBookIds = ref<Set<string>>(new Set());

const sortOptions = computed(() => [
  { value: 'dateDesc', label: t('releases.sortDateDesc') },
  { value: 'dateAsc', label: t('releases.sortDateAsc') },
  { value: 'alphaAsc', label: t('releases.sortAlphaAsc') },
  { value: 'alphaDesc', label: t('releases.sortAlphaDesc') }
]);

const facets = computed(() =>
  extractFilterFacets(
    alerts.value.map((a) => a.book),
    authStore.profile?.defaultGenres ?? []
  )
);

function syncUnreadCount(count: number): void {
  if (authStore.profile) {
    authStore.profile = { ...authStore.profile, unreadAlertsCount: count };
  }
}

async function loadAlerts(): Promise<void> {
  loading.value = true;
  try {
    const res = await apiRequest<{ ok: true; alerts: ReleaseAlertItem[] }>('/api/releases');
    alerts.value = res.alerts;
    syncUnreadCount(res.alerts.length);
  } finally {
    loading.value = false;
  }
}

async function handleCheckNow(): Promise<void> {
  checking.value = true;
  try {
    const res = await apiRequest<{ ok: true; newAlertsCount: number; alerts: ReleaseAlertItem[] }>(
      '/api/releases/check',
      { method: 'POST' }
    );
    alerts.value = res.alerts;
    syncUnreadCount(res.alerts.length);
    uiStore.pushToast(t('releases.checkedToast', { count: res.newAlertsCount }), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    checking.value = false;
  }
}

async function dismissOne(alertId: string): Promise<void> {
  await apiRequest('/api/releases/dismiss', { method: 'POST', body: { alertId } });
  alerts.value = alerts.value.filter((a) => a.alertId !== alertId);
  syncUnreadCount(alerts.value.length);
  uiStore.pushToast(t('releases.dismissedToast'), 'info');
}

async function dismissAll(): Promise<void> {
  await apiRequest('/api/releases/dismiss', { method: 'POST', body: { all: true } });
  alerts.value = [];
  selectedBookIds.value = new Set();
  syncUnreadCount(0);
  uiStore.pushToast(t('releases.dismissedToast'), 'info');
}

const filteredAlerts = computed(() => {
  const matchedBookIds = new Set(
    applyBookListFilters(
      alerts.value.map((a) => a.book),
      filters.value
    ).map((b) => b.id)
  );
  const list = alerts.value.filter((a) => matchedBookIds.has(a.book.id));

  return [...list].sort((a, b) => {
    if (sortBy.value === 'dateAsc') return a.detectedAt.localeCompare(b.detectedAt);
    if (sortBy.value === 'alphaAsc') return a.book.title.localeCompare(b.book.title, 'fr');
    if (sortBy.value === 'alphaDesc') return b.book.title.localeCompare(a.book.title, 'fr');
    return b.detectedAt.localeCompare(a.detectedAt);
  });
});

const totalPages = computed(() => Math.max(1, Math.ceil(filteredAlerts.value.length / pageSize.value)));

watch([filters, sortBy, pageSize], () => {
  page.value = 1;
}, { deep: true });

const paginatedAlerts = computed(() => {
  const start = (page.value - 1) * pageSize.value;
  return filteredAlerts.value.slice(start, start + pageSize.value);
});

const selectedBooks = computed(() =>
  alerts.value.map((a) => a.book).filter((b) => selectedBookIds.value.has(b.id))
);

function toggleSelect(bookId: string): void {
  const next = new Set(selectedBookIds.value);
  if (next.has(bookId)) next.delete(bookId);
  else next.add(bookId);
  selectedBookIds.value = next;
}

function toggleSelectAllPage(): void {
  const pageIds = paginatedAlerts.value.map((a) => a.book.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedBookIds.value.has(id));
  const next = new Set(selectedBookIds.value);
  if (allSelected) {
    for (const id of pageIds) next.delete(id);
  } else {
    for (const id of pageIds) next.add(id);
  }
  selectedBookIds.value = next;
}

async function handleBatchAction(action: BatchActionType): Promise<void> {
  const eligible = filterEligibleBooksForBatchAction(selectedBooks.value, action);
  if (eligible.length === 0) return;
  if (action === 'ADD_OWNED' || action === 'ADD_WISH') {
    await libraryStore.applyBatchStatus({
      bookIds: eligible.map((b) => b.id),
      status: action === 'ADD_OWNED' ? 'owned' : 'wish'
    });
    selectedBookIds.value = new Set();
    uiStore.pushToast(t('batch.statusUpdatedToast'), 'success');
    await loadAlerts();
  }
}

onMounted(() => {
  void loadAlerts();
});
</script>

<template>
  <section class="ds-stack">
    <div class="ds-page-head">
      <h1>{{ t('releases.title') }}</h1>
      <div class="ds-row">
        <button type="button" class="ds-btn ds-btn--primary ds-btn--sm" :disabled="checking" @click="handleCheckNow">
          <RefreshCw :size="15" aria-hidden="true" />
          <span>{{ checking ? t('releases.checkingBtn') : t('releases.checkNowBtn') }}</span>
        </button>
        <button
          v-if="alerts.length > 0"
          type="button"
          class="ds-btn ds-btn--ghost ds-btn--sm"
          @click="dismissAll"
        >
          {{ t('releases.dismissAllBtn') }}
        </button>
      </div>
    </div>

    <ListControlBar
      :filters="filters"
      :facets="facets"
      :enabled-facets="['genre', 'author', 'publisher', 'series', 'volumeNumber']"
      :placeholder="t('releases.searchPlaceholder')"
      :sort-value="sortBy"
      :sort-options="sortOptions"
      :show-select-all="paginatedAlerts.length > 0"
      @update:filters="(next) => (filters = next)"
      @update:sort-value="(v) => (sortBy = v as 'dateDesc' | 'dateAsc' | 'alphaAsc' | 'alphaDesc')"
      @select-all="toggleSelectAllPage"
    />

    <div v-if="loading" class="ds-card ds-text-muted">{{ t('app.loading') }}</div>
    <div v-else-if="filteredAlerts.length === 0" class="ds-card ds-text-muted">{{ t('releases.empty') }}</div>

    <div v-else class="ds-grid-2">
      <BookCard
        v-for="alert in paginatedAlerts"
        :key="alert.alertId"
        :book="alert.book"
        selectable
        :selected="selectedBookIds.has(alert.book.id)"
        @toggle-select="toggleSelect"
        @open="(id) => router.push(`/book/${encodeURIComponent(id)}`)"
      >
        <template #actions>
          <button type="button" class="ds-btn ds-btn--ghost ds-btn--sm" @click="dismissOne(alert.alertId)">
            {{ t('releases.dismissOneBtn') }}
          </button>
        </template>
      </BookCard>
    </div>

    <PaginationBar
      :page="page"
      :total-pages="totalPages"
      :page-size="pageSize"
      :total-items="filteredAlerts.length"
      @update:page="(p) => (page = p)"
      @update:page-size="(s) => (pageSize = s)"
    />

    <BatchActionBar
      :selected-books="selectedBooks"
      @action="handleBatchAction"
      @open-genres="() => undefined"
      @clear="selectedBookIds = new Set()"
    />
  </section>
</template>
