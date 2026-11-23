<!-- src/client/views/ReleasesView.vue -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import BookCard from '../components/books/BookCard.vue';
import BatchActionBar from '../components/books/BatchActionBar.vue';
import { apiRequest, ApiClientError } from '../api/client';
import { useLibraryStore } from '../stores/library.store';
import { useAuthStore } from '../stores/auth.store';
import { useUiStore } from '../stores/ui.store';
import { filterEligibleBooksForBatchAction, type BatchActionType } from '../../shared/bibliographic/batch-actions.util';
import { normalizeTextKey } from '../../shared/bibliographic/text-normalize.util';
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
const query = ref('');
const sortBy = ref<'dateDesc' | 'dateAsc' | 'alphaAsc' | 'alphaDesc'>('dateDesc');
const selectedBookIds = ref<Set<string>>(new Set());

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
  const needle = normalizeTextKey(query.value);
  const list = alerts.value.filter((a) => {
    if (!needle) return true;
    return normalizeTextKey([a.seriesName, a.book.title, ...a.book.authors].join(' ')).includes(needle);
  });

  return [...list].sort((a, b) => {
    if (sortBy.value === 'dateAsc') return a.detectedAt.localeCompare(b.detectedAt);
    if (sortBy.value === 'alphaAsc') return a.book.title.localeCompare(b.book.title, 'fr');
    if (sortBy.value === 'alphaDesc') return b.book.title.localeCompare(a.book.title, 'fr');
    return b.detectedAt.localeCompare(a.detectedAt);
  });
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
    <div class="ds-row ds-row--between">
      <h1>{{ t('releases.title') }}</h1>
      <div class="ds-row">
        <button type="button" class="ds-btn ds-btn--primary ds-btn--sm" :disabled="checking" @click="handleCheckNow">
          {{ checking ? t('releases.checkingBtn') : t('releases.checkNowBtn') }}
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

    <div class="ds-panel ds-row">
      <input
        v-model="query"
        type="search"
        class="ds-input releases-search-input"
        :placeholder="t('releases.searchPlaceholder')"
      />
      <select v-model="sortBy" class="ds-input releases-sort-select" :aria-label="t('releases.sortDateDesc')">
        <option value="dateDesc">{{ t('releases.sortDateDesc') }}</option>
        <option value="dateAsc">{{ t('releases.sortDateAsc') }}</option>
        <option value="alphaAsc">{{ t('releases.sortAlphaAsc') }}</option>
        <option value="alphaDesc">{{ t('releases.sortAlphaDesc') }}</option>
      </select>
    </div>

    <div v-if="loading" class="ds-card ds-text-muted">{{ t('app.loading') }}</div>
    <div v-else-if="filteredAlerts.length === 0" class="ds-card ds-text-muted">{{ t('releases.empty') }}</div>

    <div v-else class="ds-grid-2">
      <BookCard
        v-for="alert in filteredAlerts"
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

    <BatchActionBar
      :selected-books="selectedBooks"
      @action="handleBatchAction"
      @open-genres="() => undefined"
      @clear="selectedBookIds = new Set()"
    />
  </section>
</template>

<style scoped>
.releases-search-input {
  flex: 1;
  min-width: 200px;
}

.releases-sort-select {
  width: auto;
  min-width: 180px;
}
</style>
