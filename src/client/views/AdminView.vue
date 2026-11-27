<!-- src/client/views/AdminView.vue -->
<!-- Administration V2.6 : KPIs cliquables, miniatures couvertures + PaginationBar (20/50/100) + BatchActionBar flottante,
     infobulles ? sur la maintenance, bannissement réversible (soft delete) et suppression de l'onglet temporaire Labo CSV. -->
<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import {
  Ban,
  ChevronRight,
  Download,
  Edit3,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  UserCheck
} from '@lucide/vue';
import BaseModal from '../components/base/BaseModal.vue';
import HelpTooltip from '../components/base/HelpTooltip.vue';
import PaginationBar from '../components/base/PaginationBar.vue';
import BatchActionBar from '../components/books/BatchActionBar.vue';
import { apiRequest, ApiClientError } from '../api/client';
import { useAuthStore } from '../stores/auth.store';
import { useUiStore } from '../stores/ui.store';
import { t } from '../../shared/locales';
import { APP_VERSION, APP_VERSION_LABEL } from '../../shared/version';
import type { BookMainCategory } from '../../shared/types/domain.types';

type AdminTab = 'stats' | 'catalog' | 'users' | 'logs';

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
  bannedAt: string | null;
  isBanned: boolean;
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

const authStore = useAuthStore();
const uiStore = useUiStore();
const activeTab = ref<AdminTab>('stats');

// Version client vs serveur & mise à jour manuelle PWA
const serverVersion = ref<string | null>(null);
const checkingUpdate = ref(false);
const hasVersionMismatch = computed(
  () => Boolean(serverVersion.value && serverVersion.value !== APP_VERSION)
);

async function loadServerHealth(): Promise<void> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return;
    const data = (await res.json()) as { version?: string };
    if (typeof data.version === 'string' && data.version.trim()) {
      serverVersion.value = data.version.trim();
    }
  } catch {
    // ignore si hors-ligne
  }
}

async function handleCheckOrForceUpdate(): Promise<void> {
  if (checkingUpdate.value) return;
  checkingUpdate.value = true;
  try {
    await loadServerHealth();
    let activatedWaiting = false;

    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.update().catch(() => {});
        const waiting = reg.waiting;
        if (waiting) {
          activatedWaiting = true;
          uiStore.pushToast(t('admin.updatingAppToast'), 'info');
          navigator.serviceWorker.addEventListener(
            'controllerchange',
            () => window.location.reload(),
            { once: true }
          );
          waiting.postMessage({ type: 'SKIP_WAITING' });
          window.setTimeout(() => window.location.reload(), 1200);
          return;
        }
      }
    }

    if (hasVersionMismatch.value) {
      uiStore.pushToast(t('admin.updatingAppToast'), 'info');
      window.location.reload();
      return;
    }

    if (!activatedWaiting) {
      uiStore.pushToast(t('admin.alreadyUpToDateToast', { version: APP_VERSION_LABEL }), 'success');
    }
  } finally {
    checkingUpdate.value = false;
  }
}

// ==================== OVERVIEW (KPIS CLIQUABLES) ====================
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

function jumpFromKpi(target: 'users' | 'catalog_all' | 'catalog_no_cover' | 'logs'): void {
  if (target === 'users') {
    activeTab.value = 'users';
  } else if (target === 'logs') {
    activeTab.value = 'logs';
  } else if (target === 'catalog_no_cover') {
    catalogFilter.value = 'no_cover';
    catalogPage.value = 1;
    activeTab.value = 'catalog';
  } else {
    catalogFilter.value = 'all';
    catalogPage.value = 1;
    activeTab.value = 'catalog';
  }
}

// ==================== CATALOGUE MAÎTRE ====================
const catalogItems = ref<AdminCatalogItem[]>([]);
const catalogTotal = ref(0);
const catalogPage = ref(1);
const catalogPageSize = ref(20);
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
  if (selectedBookIds.value.length === catalogItems.value.length && catalogItems.value.length > 0) {
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
  bulkForm.volumeNumber =
    prefill?.volumeNumber !== null && prefill?.volumeNumber !== undefined ? String(prefill.volumeNumber) : '';
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

// ==================== COMPTES & MAINTENANCE ====================
const users = ref<AdminUserItem[]>([]);
const usersLoading = ref(false);
const maintenanceBusy = ref(false);
const banConfirmUser = ref<AdminUserItem | null>(null);
const banBusy = ref(false);

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

async function confirmBanUser(): Promise<void> {
  if (!banConfirmUser.value) return;
  banBusy.value = true;
  const target = banConfirmUser.value;
  try {
    await apiRequest(`/api/admin/users/${encodeURIComponent(target.id)}/ban`, { method: 'POST' });
    banConfirmUser.value = null;
    uiStore.pushToast(t('admin.userBannedToast', { name: target.username }), 'info');
    await loadUsers();
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    banBusy.value = false;
  }
}

async function handleUnbanUser(user: AdminUserItem): Promise<void> {
  banBusy.value = true;
  try {
    await apiRequest(`/api/admin/users/${encodeURIComponent(user.id)}/unban`, { method: 'POST' });
    uiStore.pushToast(t('admin.userUnbannedToast', { name: user.username }), 'success');
    await loadUsers();
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    banBusy.value = false;
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

// ==================== LOGS PIPELINE ====================
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
  void loadServerHealth();
});
</script>

<template>
  <section class="ds-stack">
    <div class="ds-page-head">
      <h1>{{ t('admin.title') }}</h1>
      <div class="ds-row">
        <span
          class="ds-badge"
          :class="hasVersionMismatch ? 'admin-version-badge--outdated' : 'ds-badge--accent'"
        >
          {{
            hasVersionMismatch && serverVersion
              ? t('admin.versionMismatchBadge', { client: APP_VERSION_LABEL, server: `v${serverVersion}` })
              : t('admin.versionBadge', { version: APP_VERSION_LABEL })
          }}
        </span>
        <button
          type="button"
          class="ds-btn ds-btn--sm"
          :class="{ 'ds-btn--primary': hasVersionMismatch }"
          :disabled="checkingUpdate"
          @click="handleCheckOrForceUpdate"
        >
          <RefreshCw :size="14" aria-hidden="true" />
          {{
            checkingUpdate
              ? t('app.loading')
              : hasVersionMismatch
                ? t('admin.forceUpdateBtn')
                : t('admin.checkUpdateBtn')
          }}
        </button>
      </div>
    </div>

    <div class="admin-tabs-grid" role="tablist">
      <button
        type="button"
        role="tab"
        class="admin-tab-btn"
        :class="{ 'admin-tab-btn--active': activeTab === 'stats' }"
        :aria-selected="activeTab === 'stats'"
        @click="activeTab = 'stats'"
      >
        {{ t('admin.tabStats') }}
      </button>
      <button
        type="button"
        role="tab"
        class="admin-tab-btn"
        :class="{ 'admin-tab-btn--active': activeTab === 'catalog' }"
        :aria-selected="activeTab === 'catalog'"
        @click="activeTab = 'catalog'"
      >
        {{ t('admin.tabCatalog') }}
      </button>
      <button
        type="button"
        role="tab"
        class="admin-tab-btn"
        :class="{ 'admin-tab-btn--active': activeTab === 'users' }"
        :aria-selected="activeTab === 'users'"
        @click="activeTab = 'users'"
      >
        {{ t('admin.tabUsers') }}
      </button>
      <button
        type="button"
        role="tab"
        class="admin-tab-btn"
        :class="{ 'admin-tab-btn--active': activeTab === 'logs' }"
        :aria-selected="activeTab === 'logs'"
        @click="activeTab = 'logs'"
      >
        {{ t('admin.tabLogs') }}
      </button>
    </div>

    <!-- ==================== ONGLET 1 : STATISTIQUES & CRON (KPIS CLIQUABLES) ==================== -->
    <div v-if="activeTab === 'stats'" class="ds-stack">
      <p v-if="overviewLoading && !overview" class="ds-card ds-text-muted">{{ t('app.loading') }}</p>
      <template v-else-if="overview">
        <div class="admin-kpi-grid">
          <button type="button" class="ds-card admin-kpi admin-kpi--clickable" @click="jumpFromKpi('users')">
            <span class="admin-kpi__head">
              <span class="ds-text-muted">{{ t('admin.overviewUsers') }}</span>
              <ChevronRight :size="15" class="admin-kpi__arrow" aria-hidden="true" />
            </span>
            <strong>{{ overview.usersCount }}</strong>
          </button>

          <button type="button" class="ds-card admin-kpi admin-kpi--clickable" @click="jumpFromKpi('users')">
            <span class="admin-kpi__head">
              <span class="ds-text-muted">{{ t('admin.overviewLibraries') }}</span>
              <ChevronRight :size="15" class="admin-kpi__arrow" aria-hidden="true" />
            </span>
            <strong>{{ overview.librariesCount }}</strong>
          </button>

          <button type="button" class="ds-card admin-kpi admin-kpi--clickable" @click="jumpFromKpi('catalog_all')">
            <span class="admin-kpi__head">
              <span class="ds-text-muted">{{ t('admin.overviewBooks') }}</span>
              <ChevronRight :size="15" class="admin-kpi__arrow" aria-hidden="true" />
            </span>
            <strong>{{ overview.booksCount }}</strong>
          </button>

          <button type="button" class="ds-card admin-kpi admin-kpi--clickable" @click="jumpFromKpi('catalog_all')">
            <span class="admin-kpi__head">
              <span class="ds-text-muted">{{ t('admin.overviewEditions') }}</span>
              <ChevronRight :size="15" class="admin-kpi__arrow" aria-hidden="true" />
            </span>
            <strong>{{ overview.editionsCount }}</strong>
          </button>

          <button type="button" class="ds-card admin-kpi admin-kpi--clickable" @click="jumpFromKpi('catalog_all')">
            <span class="admin-kpi__head">
              <span class="ds-text-muted">{{ t('admin.overviewSeries') }}</span>
              <ChevronRight :size="15" class="admin-kpi__arrow" aria-hidden="true" />
            </span>
            <strong>{{ overview.seriesCount }}</strong>
          </button>

          <button type="button" class="ds-card admin-kpi admin-kpi--clickable" @click="jumpFromKpi('catalog_no_cover')">
            <span class="admin-kpi__head">
              <span class="ds-text-muted">{{ t('admin.overviewCovers') }}</span>
              <ChevronRight :size="15" class="admin-kpi__arrow" aria-hidden="true" />
            </span>
            <strong>{{ overview.coversCount }}</strong>
          </button>

          <button type="button" class="ds-card admin-kpi admin-kpi--clickable" @click="jumpFromKpi('logs')">
            <span class="admin-kpi__head">
              <span class="ds-text-muted">{{ t('admin.overviewLogs') }}</span>
              <ChevronRight :size="15" class="admin-kpi__arrow" aria-hidden="true" />
            </span>
            <strong>{{ overview.logsCount }}</strong>
          </button>
        </div>

        <div class="ds-card ds-stack">
          <h2>{{ t('admin.cronStatusTitle') }}</h2>
          <p v-if="overview.cronRuns.length === 0" class="ds-text-muted">{{ t('admin.cronEmpty') }}</p>
          <div v-else class="ds-stack--sm">
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

    <!-- ==================== ONGLET 2 : CATALOGUE MAÎTRE (MINIATURES + PAGINATION 20/50/100 + BARRE FLOTTANTE) ==================== -->
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
        <button type="submit" class="ds-btn ds-btn--primary">
          <Search :size="15" aria-hidden="true" />
          {{ t('app.search') }}
        </button>
      </form>

      <div class="ds-row ds-row--between">
        <button type="button" class="ds-btn ds-btn--sm" @click="toggleSelectAllCatalog">
          {{ t('collection.selectAll') }}
        </button>
        <span class="ds-text-muted">{{ t('collection.booksCount', { count: catalogTotal }) }}</span>
      </div>

      <p v-if="catalogLoading" class="ds-card ds-text-muted">{{ t('app.loading') }}</p>
      <p v-else-if="catalogItems.length === 0" class="ds-card ds-text-muted">{{ t('admin.catalogEmpty') }}</p>

      <div v-else class="ds-stack--sm">
        <div
          v-for="item in catalogItems"
          :key="item.id"
          class="ds-card ds-row ds-row--between admin-book-row"
        >
          <div class="ds-row admin-book-main">
            <label class="admin-book-check" @click.stop>
              <input
                type="checkbox"
                :checked="selectedBookIds.includes(item.id)"
                :aria-label="t('collection.selectItem', { title: item.title })"
                @change="toggleSelectBook(item.id)"
              />
            </label>

            <span class="admin-book-cover">
              <img
                v-if="item.coverUrl"
                :src="item.coverUrl"
                :alt="item.title"
                loading="lazy"
              />
              <span v-else class="admin-book-cover__placeholder">
                {{ item.title.slice(0, 2).toUpperCase() }}
              </span>
            </span>

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
            <Edit3 :size="14" aria-hidden="true" />
            {{ t('app.edit') }}
          </button>
        </div>
      </div>

      <PaginationBar
        :page="catalogPage"
        :total-pages="catalogTotalPages"
        :page-size="catalogPageSize"
        :total-items="catalogTotal"
        @update:page="catalogPage = $event; loadCatalog()"
        @update:page-size="catalogPageSize = $event; catalogPage = 1; loadCatalog()"
      />

      <BatchActionBar :custom-count="selectedBookIds.length" @clear="selectedBookIds = []">
        <template #actions>
          <button
            type="button"
            class="ds-btn ds-btn--primary ds-btn--sm"
            @click="openBulkModal(selectedBookIds)"
          >
            <Edit3 :size="14" aria-hidden="true" />
            {{ t('admin.bulkEditBtn', { count: selectedBookIds.length }) }}
          </button>
        </template>
      </BatchActionBar>
    </div>

    <!-- ==================== ONGLET 3 : COMPTES & MAINTENANCE ==================== -->
    <div v-else-if="activeTab === 'users'" class="ds-stack">
      <div class="ds-card ds-stack">
        <h2>{{ t('admin.maintenanceTitle') }}</h2>
        <div class="admin-maintenance-list">
          <div class="admin-maintenance-item">
            <button
              type="button"
              class="ds-btn ds-btn--primary"
              :disabled="maintenanceBusy"
              @click="runMaintenance('release_sweep')"
            >
              {{ t('admin.runNightlySweepBtn') }}
            </button>
            <HelpTooltip :title="t('admin.runNightlySweepBtn')" :text="t('admin.runNightlySweepHelp')" />
          </div>

          <div class="admin-maintenance-item">
            <button
              type="button"
              class="ds-btn"
              :disabled="maintenanceBusy"
              @click="runMaintenance('purge_orphan_covers')"
            >
              {{ t('admin.purgeCoversBtn') }}
            </button>
            <HelpTooltip :title="t('admin.purgeCoversBtn')" :text="t('admin.purgeCoversHelp')" />
          </div>

          <div class="admin-maintenance-item">
            <button
              type="button"
              class="ds-btn"
              :disabled="maintenanceBusy"
              @click="runMaintenance('purge_logs')"
            >
              {{ t('admin.purgeLogsBtn') }}
            </button>
            <HelpTooltip :title="t('admin.purgeLogsBtn')" :text="t('admin.purgeLogsHelp')" />
          </div>
        </div>
      </div>

      <div class="ds-card ds-stack">
        <h2>{{ t('admin.usersTableTitle', { count: users.length }) }}</h2>
        <p v-if="usersLoading" class="ds-text-muted">{{ t('app.loading') }}</p>
        <div v-else class="ds-stack--sm">
          <div v-for="u in users" :key="u.id" class="ds-panel ds-row ds-row--between admin-book-row">
            <div>
              <div class="ds-row">
                <strong>{{ u.username }}</strong>
                <span v-if="u.isAdmin" class="ds-badge ds-badge--accent">{{ t('profile.adminBadge') }}</span>
                <span v-if="u.isBanned" class="ds-badge ds-badge--danger">{{ t('admin.userBannedBadge') }}</span>
              </div>
              <div class="ds-text-muted">{{ u.email }} · {{ u.libraryName }}</div>
              <div class="ds-text-muted">
                {{ t('admin.usersAiUsage', { month: u.aiMonthUsed, total: u.aiTotalUsed }) }}
              </div>
            </div>

            <div class="ds-row">
              <button type="button" class="ds-btn ds-btn--sm" @click="handleResetAiQuota(u.id)">
                <RotateCcw :size="14" aria-hidden="true" />
                {{ t('admin.resetAiQuotaBtn') }}
              </button>

              <template v-if="u.id !== authStore.profile?.user.id">
                <button
                  v-if="u.isBanned"
                  type="button"
                  class="ds-btn ds-btn--soft ds-btn--sm"
                  :disabled="banBusy"
                  @click="handleUnbanUser(u)"
                >
                  <UserCheck :size="14" aria-hidden="true" />
                  {{ t('admin.unbanUserBtn') }}
                </button>
                <button
                  v-else
                  type="button"
                  class="ds-btn ds-btn--danger-soft ds-btn--sm"
                  :disabled="banBusy"
                  @click="banConfirmUser = u"
                >
                  <Ban :size="14" aria-hidden="true" />
                  {{ t('admin.banUserBtn') }}
                </button>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== ONGLET 4 : LOGS PIPELINE ==================== -->
    <div v-else class="ds-stack">
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
        <button type="submit" class="ds-btn ds-btn--primary">
          <Search :size="15" aria-hidden="true" />
          {{ t('app.search') }}
        </button>
        <button type="button" class="ds-btn" @click="exportLogsJson">
          <Download :size="15" aria-hidden="true" />
          {{ t('admin.exportLogsBtn') }}
        </button>
        <button type="button" class="ds-btn ds-btn--danger-soft" @click="handlePurgeLogs">
          <Trash2 :size="15" aria-hidden="true" />
          {{ t('admin.purgeLogsBtn') }}
        </button>
      </form>

      <p v-if="logsLoading" class="ds-card ds-text-muted">{{ t('app.loading') }}</p>
      <p v-else-if="logs.length === 0" class="ds-card ds-text-muted">{{ t('admin.logsEmpty') }}</p>

      <div v-else class="ds-stack--sm">
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

    <!-- Modale Confirmation Bannissement (Soft delete) -->
    <BaseModal
      :open="banConfirmUser !== null"
      :title="t('admin.banUserConfirmTitle', { name: banConfirmUser?.username ?? '' })"
      max-width="440px"
      @close="banConfirmUser = null"
    >
      <p>{{ t('admin.banUserConfirmDesc') }}</p>
      <template #footer>
        <button type="button" class="ds-btn" :disabled="banBusy" @click="banConfirmUser = null">
          {{ t('app.cancel') }}
        </button>
        <button type="button" class="ds-btn ds-btn--danger" :disabled="banBusy" @click="confirmBanUser">
          {{ banBusy ? t('app.loading') : t('admin.banUserBtn') }}
        </button>
      </template>
    </BaseModal>
  </section>
</template>

<style scoped>
.admin-tabs-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

@media (min-width: 640px) {
  .admin-tabs-grid {
    display: flex;
    flex-wrap: wrap;
  }
}

.admin-tab-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  min-block-size: 40px;
  padding: 0.45rem 0.75rem;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-strong);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 0.85rem;
  font-weight: 600;
  line-height: 1.25;
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.admin-tab-btn:hover {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent);
}

.admin-tab-btn--active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--text-on-accent);
}

.admin-tab-btn--active:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
  color: var(--text-on-accent);
}

.admin-kpi-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

@media (min-width: 640px) {
  .admin-kpi-grid {
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  }
}

.admin-kpi {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  text-align: left;
}

.admin-kpi--clickable {
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease, transform 0.12s ease;
}

.admin-kpi--clickable:hover {
  border-color: var(--accent-border);
  background: var(--accent-soft);
}

.admin-kpi__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
  width: 100%;
}

.admin-kpi__arrow {
  color: var(--text-muted);
  flex-shrink: 0;
}

.admin-kpi strong {
  font-size: 1.6rem;
  color: var(--accent);
}

.admin-filter-bar {
  flex-wrap: wrap;
}

.admin-search-input {
  flex: 1;
  min-width: 180px;
}

.admin-select {
  width: auto;
  min-width: 130px;
}

.admin-book-row {
  flex-wrap: wrap;
  gap: var(--space-3);
}

.admin-book-main {
  align-items: center;
  flex: 1;
  min-width: 220px;
  gap: var(--space-3);
}

.admin-book-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-inline-size: 38px;
  min-block-size: 38px;
  cursor: pointer;
  flex-shrink: 0;
}

.admin-book-check input {
  width: 18px;
  height: 18px;
  accent-color: var(--accent);
}

.admin-book-cover {
  width: 46px;
  min-width: 46px;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  background: var(--bg-subtle);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.admin-book-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.admin-book-cover__placeholder {
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--text-muted);
}

.admin-book-info {
  gap: var(--space-1);
  min-width: 0;
}

.admin-maintenance-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.admin-maintenance-item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.admin-log-summary {
  cursor: pointer;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.admin-version-badge--outdated {
  background: var(--warning-bg);
  color: var(--warning-text);
  border-color: var(--warning-text);
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
