<!-- src/client/views/AdminView.vue -->
<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import BaseModal from '../components/base/BaseModal.vue';
import PaginationBar from '../components/base/PaginationBar.vue';
import AdminBenchmarkTab from '../components/admin/AdminBenchmarkTab.vue';
import { apiRequest, ApiClientError } from '../api/client';
import { useUiStore } from '../stores/ui.store';
import { t } from '../../shared/locales';
import type { BookMainCategory } from '../../shared/types/domain.types';

type AdminTab = 'stats' | 'catalog' | 'users' | 'logs' | 'benchmark';

interface AdminOverview {
  usersCount: number;
  librariesCount: number;
  booksCount: number;
  editionsCount: number;
  seriesCount: number;
  franchisesCount: number;
  coversCount: number;
  coversTotalBytes: number;
  jobsCount: number;
  logsCount: number;
  cronRuns: Array<{
    job_name: string;
    last_run_key: string;
    last_run_at: string;
    status: string;
  }>;
}

interface AdminCatalogItem {
  id: string;
  title: string;
  seriesId: string | null;
  seriesName: string | null;
  volumeNumber: number | null;
  authors: string[];
  publisher: string | null;
  publishYear: string | null;
  mainCategory: BookMainCategory;
  subgenres: string[];
  coverKey: string | null;
  coverUrl: string | null;
  lockedFields: string[];
  primaryIsbn13: string | null;
  updatedAt: string;
}

interface AdminUserItem {
  id: string;
  username: string;
  email: string;
  isAdmin: boolean;
  createdAt: string;
  libraryName: string | null;
  aiMonthUsed: number;
  aiTotalUsed: number;
}

interface AdminLogItem {
  id: number;
  trace_id: string;
  channel: string;
  stage: string;
  step: string;
  status: string;
  duration_ms: number | null;
  summary: string;
  payload_json: string | null;
  created_at: string;
}

const MAIN_CATEGORIES: BookMainCategory[] = [
  'BD',
  'Manga',
  'Comics',
  'Roman',
  'Jeunesse',
  'Essai',
  'Poésie / Théâtre',
  'Pratique',
  'Art / Beau livre',
  'Autre'
];

const uiStore = useUiStore();
const activeTab = ref<AdminTab>('stats');

// Overview
const overview = ref<AdminOverview | null>(null);
const overviewLoading = ref(false);

async function loadOverview(): Promise<void> {
  overviewLoading.value = true;
  try {
    const res = await apiRequest<{ ok: true; overview: AdminOverview }>('/api/admin/overview');
    overview.value = res.overview;
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    overviewLoading.value = false;
  }
}

// Catalog
const catalogItems = ref<AdminCatalogItem[]>([]);
const catalogTotal = ref(0);
const catalogPage = ref(1);
const catalogPageSize = ref(24);
const catalogSearch = ref('');
const catalogFilter = ref<'all' | 'no_cover' | 'no_series'>('all');
const catalogCategory = ref('');
const catalogLoading = ref(false);
const selectedBookIds = ref<string[]>([]);

const catalogTotalPages = computed(() => Math.max(1, Math.ceil(catalogTotal.value / catalogPageSize.value)));

async function loadCatalog(): Promise<void> {
  catalogLoading.value = true;
  try {
    const params = new URLSearchParams();
    params.set('page', String(catalogPage.value));
    params.set('pageSize', String(catalogPageSize.value));
    params.set('filter', catalogFilter.value);
    if (catalogSearch.value.trim()) params.set('search', catalogSearch.value.trim());
    if (catalogCategory.value) params.set('category', catalogCategory.value);
    const res = await apiRequest<{
      ok: true;
      total: number;
      page: number;
      pageSize: number;
      items: AdminCatalogItem[];
    }>(`/api/admin/catalog?${params.toString()}`);
    catalogItems.value = res.items;
    catalogTotal.value = res.total;
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    catalogLoading.value = false;
  }
}

function toggleSelectBook(bookId: string): void {
  if (selectedBookIds.value.includes(bookId)) {
    selectedBookIds.value = selectedBookIds.value.filter((id) => id !== bookId);
  } else {
    selectedBookIds.value = [...selectedBookIds.value, bookId];
  }
}

function toggleSelectAllCatalog(): void {
  if (selectedBookIds.value.length === catalogItems.value.length) {
    selectedBookIds.value = [];
  } else {
    selectedBookIds.value = catalogItems.value.map((b) => b.id);
  }
}

// Bulk Edit Modal (Couche 2 locked_fields)
const bulkModalOpen = ref(false);
const bulkSaving = ref(false);
const bulkTargetIds = ref<string[]>([]);

const bulkForm = reactive({
  enableTitle: false,
  title: '',
  enableAuthors: false,
  authors: '',
  enableSeriesName: false,
  seriesName: '',
  enableVolumeNumber: false,
  volumeNumber: '',
  enablePublisher: false,
  publisher: '',
  enablePublishYear: false,
  publishYear: '',
  enableMainCategory: false,
  mainCategory: 'BD' as BookMainCategory
});

function openBulkModal(ids: string[], prefill?: AdminCatalogItem): void {
  bulkTargetIds.value = [...ids];
  bulkForm.enableTitle = Boolean(prefill);
  bulkForm.title = prefill?.title ?? '';
  bulkForm.enableAuthors = false;
  bulkForm.authors = prefill ? prefill.authors.join(', ') : '';
  bulkForm.enableSeriesName = false;
  bulkForm.seriesName = prefill?.seriesName ?? '';
  bulkForm.enableVolumeNumber = false;
  bulkForm.volumeNumber = prefill?.volumeNumber !== null && prefill?.volumeNumber !== undefined ? String(prefill.volumeNumber) : '';
  bulkForm.enablePublisher = false;
  bulkForm.publisher = prefill?.publisher ?? '';
  bulkForm.enablePublishYear = false;
  bulkForm.publishYear = prefill?.publishYear ?? '';
  bulkForm.enableMainCategory = false;
  bulkForm.mainCategory = prefill?.mainCategory ?? 'BD';
  bulkModalOpen.value = true;
}

async function submitBulkEdit(): Promise<void> {
  if (bulkTargetIds.value.length === 0) return;
  const patch: Record<string, unknown> = {};
  if (bulkForm.enableTitle && bulkForm.title.trim()) patch.title = bulkForm.title.trim();
  if (bulkForm.enableAuthors) {
    patch.authors = bulkForm.authors
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (bulkForm.enableSeriesName) patch.seriesName = bulkForm.seriesName.trim() || null;
  if (bulkForm.enableVolumeNumber) {
    const parsed = bulkForm.volumeNumber.trim() === '' ? null : Number(bulkForm.volumeNumber);
    patch.volumeNumber = parsed !== null && Number.isFinite(parsed) ? parsed : null;
  }
  if (bulkForm.enablePublisher) patch.publisher = bulkForm.publisher.trim() || null;
  if (bulkForm.enablePublishYear) patch.publishYear = bulkForm.publishYear.trim() || null;
  if (bulkForm.enableMainCategory) patch.mainCategory = bulkForm.mainCategory;

  if (Object.keys(patch).length === 0) {
    bulkModalOpen.value = false;
    return;
  }

  bulkSaving.value = true;
  try {
    const res = await apiRequest<{ ok: true; updatedCount: number }>('/api/admin/catalog/bulk', {
      method: 'PATCH',
      body: { bookIds: bulkTargetIds.value, patch }
    });
    bulkModalOpen.value = false;
    selectedBookIds.value = [];
    uiStore.pushToast(t('admin.bulkSavedToast', { count: res.updatedCount }), 'success');
    await loadCatalog();
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    bulkSaving.value = false;
  }
}

// Users & Maintenance
const users = ref<AdminUserItem[]>([]);
const usersLoading = ref(false);
const maintenanceBusy = ref(false);

async function loadUsers(): Promise<void> {
  usersLoading.value = true;
  try {
    const res = await apiRequest<{ ok: true; users: AdminUserItem[] }>('/api/admin/users');
    users.value = res.users;
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    usersLoading.value = false;
  }
}

async function handleResetAiQuota(userId: string): Promise<void> {
  try {
    await apiRequest(`/api/admin/users/${encodeURIComponent(userId)}/reset-ai-quota`, { method: 'POST' });
    uiStore.pushToast(t('admin.quotaResetToast'), 'success');
    await loadUsers();
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  }
}

async function runMaintenance(task: 'release_sweep' | 'purge_orphan_covers' | 'purge_logs'): Promise<void> {
  maintenanceBusy.value = true;
  try {
    await apiRequest(`/api/admin/maintenance/${task}`, { method: 'POST' });
    uiStore.pushToast(t('admin.maintenanceDoneToast'), 'success');
    await loadOverview();
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    maintenanceBusy.value = false;
  }
}

// Logs
const logs = ref<AdminLogItem[]>([]);
const logsLoading = ref(false);
const logStage = ref('');
const logStatus = ref('');
const logQuery = ref('');

async function loadLogs(): Promise<void> {
  logsLoading.value = true;
  try {
    const params = new URLSearchParams();
    if (logStage.value.trim()) params.set('stage', logStage.value.trim());
    if (logStatus.value.trim()) params.set('status', logStatus.value.trim());
    if (logQuery.value.trim()) params.set('query', logQuery.value.trim());
    const res = await apiRequest<{ ok: true; logs: AdminLogItem[] }>(`/api/admin/logs?${params.toString()}`);
    logs.value = res.logs;
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    logsLoading.value = false;
  }
}

function exportLogsJson(): void {
  const blob = new Blob([JSON.stringify(logs.value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pipeline-logs-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function handlePurgeLogs(): Promise<void> {
  try {
    const res = await apiRequest<{ ok: true; purgedCount: number }>('/api/admin/logs?days=30', {
      method: 'DELETE'
    });
    uiStore.pushToast(t('admin.logsPurgedToast', { count: res.purgedCount }), 'info');
    await loadLogs();
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  }
}

watch(activeTab, (tab) => {
  if (tab === 'stats') void loadOverview();
  else if (tab === 'catalog') void loadCatalog();
  else if (tab === 'users') void loadUsers();
  else if (tab === 'logs') void loadLogs();
});

onMounted(() => {
  void loadOverview();
});
</script>

<template>
  <section class="ds-stack">
    <h1>{{ t('admin.title') }}</h1>

    <div class="ds-tabs" role="tablist">
      <button
        type="button"
        class="ds-tab"
        :class="{ 'ds-tab--active': activeTab === 'stats' }"
        @click="activeTab = 'stats'"
      >
        {{ t('admin.tabStats') }}
      </button>
      <button
        type="button"
        class="ds-tab"
        :class="{ 'ds-tab--active': activeTab === 'catalog' }"
        @click="activeTab = 'catalog'"
      >
        {{ t('admin.tabCatalog') }}
      </button>
      <button
        type="button"
        class="ds-tab"
        :class="{ 'ds-tab--active': activeTab === 'users' }"
        @click="activeTab = 'users'"
      >
        {{ t('admin.tabUsers') }}
      </button>
      <button
        type="button"
        class="ds-tab"
        :class="{ 'ds-tab--active': activeTab === 'logs' }"
        @click="activeTab = 'logs'"
      >
        {{ t('admin.tabLogs') }}
      </button>
      <button
        type="button"
        class="ds-tab"
        :class="{ 'ds-tab--active': activeTab === 'benchmark' }"
        @click="activeTab = 'benchmark'"
      >
        {{ t('admin.tabBenchmark') }}
      </button>
    </div>

    <!-- Onglet 1 : Statistiques & CRON -->
    <div v-if="activeTab === 'stats'" class="ds-stack">
      <p v-if="overviewLoading && !overview" class="ds-card ds-text-muted">{{ t('app.loading') }}</p>
      <template v-else-if="overview">
        <div class="admin-kpi-grid">
          <div class="ds-card admin-kpi">
            <span class="ds-text-muted">{{ t('admin.overviewUsers') }}</span>
            <strong>{{ overview.usersCount }}</strong>
          </div>
          <div class="ds-card admin-kpi">
            <span class="ds-text-muted">{{ t('admin.overviewLibraries') }}</span>
            <strong>{{ overview.librariesCount }}</strong>
          </div>
          <div class="ds-card admin-kpi">
            <span class="ds-text-muted">{{ t('admin.overviewBooks') }}</span>
            <strong>{{ overview.booksCount }}</strong>
          </div>
          <div class="ds-card admin-kpi">
            <span class="ds-text-muted">{{ t('admin.overviewEditions') }}</span>
            <strong>{{ overview.editionsCount }}</strong>
          </div>
          <div class="ds-card admin-kpi">
            <span class="ds-text-muted">{{ t('admin.overviewSeries') }}</span>
            <strong>{{ overview.seriesCount }}</strong>
          </div>
          <div class="ds-card admin-kpi">
            <span class="ds-text-muted">{{ t('admin.overviewCovers') }}</span>
            <strong>{{ overview.coversCount }}</strong>
          </div>
          <div class="ds-card admin-kpi">
            <span class="ds-text-muted">{{ t('admin.overviewLogs') }}</span>
            <strong>{{ overview.logsCount }}</strong>
          </div>
        </div>

        <div class="ds-card ds-stack">
          <h2>{{ t('admin.cronStatusTitle') }}</h2>
          <p v-if="overview.cronRuns.length === 0" class="ds-text-muted">{{ t('admin.cronEmpty') }}</p>
          <div v-else class="ds-stack">
            <div
              v-for="run in overview.cronRuns"
              :key="run.job_name"
              class="ds-panel ds-row ds-row--between"
            >
              <div>
                <strong>{{ run.job_name }}</strong>
                <div class="ds-text-muted">{{ run.last_run_at }} ({{ run.last_run_key }})</div>
              </div>
              <span class="ds-badge ds-badge--accent">{{ run.status }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- Onglet 2 : Catalogue Maître (Couche 2 locked_fields) -->
    <div v-else-if="activeTab === 'catalog'" class="ds-stack">
      <form class="ds-card ds-row admin-filter-bar" @submit.prevent="catalogPage = 1; loadCatalog()">
        <input
          v-model="catalogSearch"
          type="search"
          class="ds-input admin-search-input"
          :placeholder="t('admin.catalogSearchPlaceholder')"
        />
        <select v-model="catalogFilter" class="ds-input admin-select" @change="catalogPage = 1; loadCatalog()">
          <option value="all">{{ t('admin.filterAll') }}</option>
          <option value="no_cover">{{ t('admin.filterNoCover') }}</option>
          <option value="no_series">{{ t('admin.filterNoSeries') }}</option>
        </select>
        <select v-model="catalogCategory" class="ds-input admin-select" @change="catalogPage = 1; loadCatalog()">
          <option value="">{{ t('social.allCategories') }}</option>
          <option v-for="cat in MAIN_CATEGORIES" :key="cat" :value="cat">{{ cat }}</option>
        </select>
        <select
          v-model.number="catalogPageSize"
          class="ds-input admin-select"
          :aria-label="t('admin.pageSizeLabel')"
          @change="catalogPage = 1; loadCatalog()"
        >
          <option :value="12">12</option>
          <option :value="24">24</option>
          <option :value="48">48</option>
          <option :value="60">60</option>
        </select>
        <button type="submit" class="ds-btn ds-btn--primary">{{ t('app.search') }}</button>
      </form>

      <div class="ds-row ds-row--between">
        <button type="button" class="ds-btn ds-btn--sm" @click="toggleSelectAllCatalog">
          {{ t('collection.selectAll') }}
        </button>
        <button
          v-if="selectedBookIds.length > 0"
          type="button"
          class="ds-btn ds-btn--primary ds-btn--sm"
          @click="openBulkModal(selectedBookIds)"
        >
          {{ t('admin.bulkEditBtn', { count: selectedBookIds.length }) }}
        </button>
      </div>

      <p v-if="catalogLoading" class="ds-card ds-text-muted">{{ t('app.loading') }}</p>
      <p v-else-if="catalogItems.length === 0" class="ds-card ds-text-muted">{{ t('admin.catalogEmpty') }}</p>

      <div v-else class="ds-stack">
        <div
          v-for="item in catalogItems"
          :key="item.id"
          class="ds-card ds-row ds-row--between admin-book-row"
        >
          <div class="ds-row admin-book-main">
            <input
              type="checkbox"
              :checked="selectedBookIds.includes(item.id)"
              :aria-label="t('collection.selectItem', { title: item.title })"
              @change="toggleSelectBook(item.id)"
            />
            <div class="ds-stack admin-book-info">
              <strong>{{ item.title }}</strong>
              <span class="ds-text-muted">
                {{ item.authors.join(', ') || t('app.unknownAuthor') }}
                <template v-if="item.seriesName"> · {{ item.seriesName }}</template>
                <template v-if="item.volumeNumber !== null"> #{{ item.volumeNumber }}</template>
                <template v-if="item.primaryIsbn13"> · {{ item.primaryIsbn13 }}</template>
              </span>
              <div class="ds-chips">
                <span class="ds-chip">{{ item.mainCategory }}</span>
                <span v-if="item.lockedFields.length > 0" class="ds-badge ds-badge--accent">
                  {{ t('admin.lockedBadge', { count: item.lockedFields.length }) }}
                </span>
              </div>
            </div>
          </div>

          <button type="button" class="ds-btn ds-btn--sm" @click="openBulkModal([item.id], item)">
            {{ t('app.edit') }}
          </button>
        </div>
      </div>

      <PaginationBar
        :page="catalogPage"
        :total-pages="catalogTotalPages"
        @update:page="catalogPage = $event; loadCatalog()"
      />
    </div>

    <!-- Onglet 3 : Comptes & Maintenance -->
    <div v-else-if="activeTab === 'users'" class="ds-stack">
      <div class="ds-card ds-stack">
        <h2>{{ t('admin.maintenanceTitle') }}</h2>
        <div class="ds-row admin-filter-bar">
          <button
            type="button"
            class="ds-btn ds-btn--primary"
            :disabled="maintenanceBusy"
            @click="runMaintenance('release_sweep')"
          >
            {{ t('admin.runNightlySweepBtn') }}
          </button>
          <button
            type="button"
            class="ds-btn"
            :disabled="maintenanceBusy"
            @click="runMaintenance('purge_orphan_covers')"
          >
            {{ t('admin.purgeCoversBtn') }}
          </button>
          <button
            type="button"
            class="ds-btn"
            :disabled="maintenanceBusy"
            @click="runMaintenance('purge_logs')"
          >
            {{ t('admin.purgeLogsBtn') }}
          </button>
        </div>
      </div>

      <div class="ds-card ds-stack">
        <h2>{{ t('admin.usersTableTitle', { count: users.length }) }}</h2>
        <p v-if="usersLoading" class="ds-text-muted">{{ t('app.loading') }}</p>
        <div v-else class="ds-stack">
          <div v-for="u in users" :key="u.id" class="ds-panel ds-row ds-row--between admin-book-row">
            <div>
              <strong>{{ u.username }}</strong>
              <span v-if="u.isAdmin" class="ds-badge ds-badge--accent">{{ t('profile.adminBadge') }}</span>
              <div class="ds-text-muted">{{ u.email }} · {{ u.libraryName }}</div>
              <div class="ds-text-muted">
                {{ t('admin.usersAiUsage', { month: u.aiMonthUsed, total: u.aiTotalUsed }) }}
              </div>
            </div>
            <button type="button" class="ds-btn ds-btn--sm" @click="handleResetAiQuota(u.id)">
              {{ t('admin.resetAiQuotaBtn') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Onglet 4 : Logs Pipeline -->
    <div v-else-if="activeTab === 'logs'" class="ds-stack">
      <form class="ds-card ds-row admin-filter-bar" @submit.prevent="loadLogs">
        <input
          v-model="logStage"
          type="text"
          class="ds-input admin-select"
          :placeholder="t('admin.logsFilterStage')"
        />
        <input
          v-model="logStatus"
          type="text"
          class="ds-input admin-select"
          :placeholder="t('admin.logsFilterStatus')"
        />
        <input
          v-model="logQuery"
          type="search"
          class="ds-input admin-search-input"
          :placeholder="t('admin.logsSearchPlaceholder')"
        />
        <button type="submit" class="ds-btn ds-btn--primary">{{ t('app.search') }}</button>
        <button type="button" class="ds-btn" @click="exportLogsJson">{{ t('admin.exportLogsBtn') }}</button>
        <button type="button" class="ds-btn ds-btn--danger" @click="handlePurgeLogs">
          {{ t('admin.purgeLogsBtn') }}
        </button>
      </form>

      <p v-if="logsLoading" class="ds-card ds-text-muted">{{ t('app.loading') }}</p>
      <p v-else-if="logs.length === 0" class="ds-card ds-text-muted">{{ t('admin.logsEmpty') }}</p>

      <div v-else class="ds-stack">
        <details v-for="log in logs" :key="log.id" class="ds-card">
          <summary class="ds-row ds-row--between admin-log-summary">
            <span>
              <span class="ds-badge">{{ log.stage }}</span>
              <span class="ds-badge ds-badge--accent">{{ log.status }}</span>
              {{ log.summary }}
            </span>
            <span class="ds-text-muted">{{ log.created_at }}</span>
          </summary>
          <pre v-if="log.payload_json" class="admin-log-pre">{{ log.payload_json }}</pre>
        </details>
      </div>
    </div>

    <!-- Onglet 5 : Labo Tests CSV (outil temporaire de recette admin) -->
    <AdminBenchmarkTab v-else-if="activeTab === 'benchmark'" />

    <!-- Modale Édition Catalogue Maître (Couche 2 locked_fields) -->
    <BaseModal
      :open="bulkModalOpen"
      :title="t('admin.bulkModalTitle', { count: bulkTargetIds.length })"
      @close="bulkModalOpen = false"
    >
      <div class="ds-stack">
        <p class="ds-text-muted">{{ t('admin.bulkModalHint') }}</p>

        <div class="ds-field">
          <label class="ds-row">
            <input v-model="bulkForm.enableTitle" type="checkbox" />
            <span>{{ t('scan.fieldTitle') }}</span>
          </label>
          <input v-if="bulkForm.enableTitle" v-model="bulkForm.title" type="text" class="ds-input" />
        </div>

        <div class="ds-field">
          <label class="ds-row">
            <input v-model="bulkForm.enableAuthors" type="checkbox" />
            <span>{{ t('book.authorsLabel') }}</span>
          </label>
          <input v-if="bulkForm.enableAuthors" v-model="bulkForm.authors" type="text" class="ds-input" />
        </div>

        <div class="ds-field">
          <label class="ds-row">
            <input v-model="bulkForm.enableSeriesName" type="checkbox" />
            <span>{{ t('scan.fieldSeries') }}</span>
          </label>
          <input v-if="bulkForm.enableSeriesName" v-model="bulkForm.seriesName" type="text" class="ds-input" />
        </div>

        <div class="ds-field">
          <label class="ds-row">
            <input v-model="bulkForm.enableVolumeNumber" type="checkbox" />
            <span>{{ t('scan.fieldVolume') }}</span>
          </label>
          <input v-if="bulkForm.enableVolumeNumber" v-model="bulkForm.volumeNumber" type="number" step="0.5" class="ds-input" />
        </div>

        <div class="ds-field">
          <label class="ds-row">
            <input v-model="bulkForm.enablePublisher" type="checkbox" />
            <span>{{ t('book.publisherLabel') }}</span>
          </label>
          <input v-if="bulkForm.enablePublisher" v-model="bulkForm.publisher" type="text" class="ds-input" />
        </div>

        <div class="ds-field">
          <label class="ds-row">
            <input v-model="bulkForm.enablePublishYear" type="checkbox" />
            <span>{{ t('book.publishYearLabel') }}</span>
          </label>
          <input v-if="bulkForm.enablePublishYear" v-model="bulkForm.publishYear" type="text" class="ds-input" />
        </div>

        <div class="ds-field">
          <label class="ds-row">
            <input v-model="bulkForm.enableMainCategory" type="checkbox" />
            <span>{{ t('book.categoryLabel') }}</span>
          </label>
          <select v-if="bulkForm.enableMainCategory" v-model="bulkForm.mainCategory" class="ds-input">
            <option v-for="cat in MAIN_CATEGORIES" :key="cat" :value="cat">{{ cat }}</option>
          </select>
        </div>
      </div>

      <template #footer>
        <button type="button" class="ds-btn" :disabled="bulkSaving" @click="bulkModalOpen = false">
          {{ t('app.cancel') }}
        </button>
        <button type="button" class="ds-btn ds-btn--primary" :disabled="bulkSaving" @click="submitBulkEdit">
          {{ bulkSaving ? t('app.loading') : t('app.save') }}
        </button>
      </template>
    </BaseModal>
  </section>
</template>

<style scoped>
.admin-kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--space-3);
}

.admin-kpi {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.admin-kpi strong {
  font-size: 1.5rem;
  color: var(--accent);
}

.admin-filter-bar {
  flex-wrap: wrap;
}

.admin-search-input {
  flex: 1;
  min-width: 200px;
}

.admin-select {
  width: auto;
  min-width: 140px;
}

.admin-book-row {
  flex-wrap: wrap;
  gap: var(--space-3);
}

.admin-book-main {
  align-items: flex-start;
  flex: 1;
  min-width: 240px;
}

.admin-book-info {
  gap: var(--space-1);
}

.admin-log-summary {
  cursor: pointer;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.admin-log-pre {
  margin-top: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  overflow-x: auto;
  font-size: 0.8rem;
}
</style>
