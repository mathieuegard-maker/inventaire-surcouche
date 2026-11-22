<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import { userService } from '../../core/services/user.service';
import { imageUtil } from '../../core/utils/image.util';

const activeTab = ref<'stats' | 'catalog' | 'users' | 'logs'>('stats');
const loading = ref(true);
const errorMsg = ref('');
const actionFeedback = ref('');

const overview = ref<any>(null);

// Explorateur du catalogue commun (sans aucune donnée de possession privée)
const catalogItems = ref<any[]>([]);
const catalogTotal = ref(0);
const catalogPage = ref(1);
const catalogPageSize = ref(24);
const catalogQuery = ref('');
const catalogType = ref('edition');
const catalogFilter = ref('all');
const catalogLoading = ref(false);

// Édition directe d'une fiche maître du catalogue serveur (Admin uniquement)
const editingCatalogItem = ref<any | null>(null);
const editCatalogForm = ref({
  uri: '',
  label: '',
  image_url: '',
  main_category: '',
  series_number: '',
  publisher: '',
  publication_date: ''
});
const savingCatalogEdit = ref(false);

// Sélection multiple et modification groupée dans le catalogue Admin
const selectedCatalogUris = ref<string[]>([]);
const showBulkEditModal = ref(false);
const savingBulkEdit = ref(false);
const bulkEditForm = ref({
  applyPublisher: false,
  publisher: '',
  applyMainCategory: false,
  main_category: '',
  applySeriesName: false,
  series_name: '',
  applyAuthors: false,
  authors: '',
  applySubgenres: false,
  subgenres: '',
  applyPublicationDate: false,
  publication_date: ''
});

const ADMIN_MAIN_CATEGORIES = [
  'BD',
  'Comics',
  'Manga',
  'Roman',
  'Roman graphique',
  'Jeunesse',
  'Essai',
  'Autre'
];

const isCatalogItemSelected = (uri: string): boolean => selectedCatalogUris.value.includes(uri);

const toggleCatalogItemSelection = (uri: string) => {
  if (!uri) return;
  if (selectedCatalogUris.value.includes(uri)) {
    selectedCatalogUris.value = selectedCatalogUris.value.filter((u) => u !== uri);
  } else {
    selectedCatalogUris.value = [...selectedCatalogUris.value, uri];
  }
};

const allCurrentPageSelected = computed(() => {
  if (catalogItems.value.length === 0) return false;
  return catalogItems.value.every((item) => selectedCatalogUris.value.includes(item.uri));
});

const toggleSelectAllCurrentPage = (checked: boolean) => {
  const pageUris = catalogItems.value.map((item) => item.uri).filter(Boolean);
  if (checked) {
    selectedCatalogUris.value = Array.from(new Set([...selectedCatalogUris.value, ...pageUris]));
  } else {
    const pageSet = new Set(pageUris);
    selectedCatalogUris.value = selectedCatalogUris.value.filter((u) => !pageSet.has(u));
  }
};

const clearCatalogSelection = () => {
  selectedCatalogUris.value = [];
};

const hasAnyBulkFieldSelected = computed(
  () =>
    bulkEditForm.value.applyPublisher ||
    bulkEditForm.value.applyMainCategory ||
    bulkEditForm.value.applySeriesName ||
    bulkEditForm.value.applyAuthors ||
    bulkEditForm.value.applySubgenres ||
    bulkEditForm.value.applyPublicationDate
);

const openBulkEditModal = () => {
  if (selectedCatalogUris.value.length === 0) return;
  bulkEditForm.value = {
    applyPublisher: false,
    publisher: '',
    applyMainCategory: false,
    main_category: '',
    applySeriesName: false,
    series_name: '',
    applyAuthors: false,
    authors: '',
    applySubgenres: false,
    subgenres: '',
    applyPublicationDate: false,
    publication_date: ''
  };
  showBulkEditModal.value = true;
};

const saveAdminBulkCatalogEdit = async () => {
  if (selectedCatalogUris.value.length === 0 || !hasAnyBulkFieldSelected.value || savingBulkEdit.value) return;
  savingBulkEdit.value = true;
  errorMsg.value = '';
  actionFeedback.value = '';
  try {
    const patch: {
      publisher?: string | null;
      main_category?: string | null;
      series_name?: string | null;
      authors?: string[];
      subgenres?: string[];
      publication_date?: string | null;
    } = {};

    if (bulkEditForm.value.applyPublisher) {
      patch.publisher = bulkEditForm.value.publisher.trim() || null;
    }
    if (bulkEditForm.value.applyMainCategory) {
      patch.main_category = bulkEditForm.value.main_category.trim() || null;
    }
    if (bulkEditForm.value.applySeriesName) {
      patch.series_name = bulkEditForm.value.series_name.trim() || null;
    }
    if (bulkEditForm.value.applyAuthors) {
      patch.authors = bulkEditForm.value.authors
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean);
    }
    if (bulkEditForm.value.applySubgenres) {
      patch.subgenres = bulkEditForm.value.subgenres
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);
    }
    if (bulkEditForm.value.applyPublicationDate) {
      patch.publication_date = bulkEditForm.value.publication_date.trim() || null;
    }

    const res = await userService.bulkUpdateAdminCatalogItems({
      uris: selectedCatalogUris.value,
      patch
    });
    showBulkEditModal.value = false;
    selectedCatalogUris.value = [];
    actionFeedback.value = `Modification groupée appliquée : ${res.updatedCount} fiche(s) mise(s) à jour sur le catalogue serveur (${res.updatedV4Count} synchronisée(s) V4).`;
    await loadCatalog();
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : 'Erreur lors de la modification groupée.';
  } finally {
    savingBulkEdit.value = false;
  }
};

const openAdminCatalogEditor = (item: any) => {
  editingCatalogItem.value = item;
  editCatalogForm.value = {
    uri: item.uri || '',
    label: item.label || '',
    image_url: item.image_url || '',
    main_category: item.main_category || '',
    series_number: item.series_number || '',
    publisher: item.publisher || '',
    publication_date: item.publication_date || ''
  };
};

const saveAdminCatalogEditor = async () => {
  if (!editCatalogForm.value.uri || !editCatalogForm.value.label.trim() || savingCatalogEdit.value) return;
  savingCatalogEdit.value = true;
  errorMsg.value = '';
  actionFeedback.value = '';
  try {
    await userService.updateAdminCatalogItem({
      uri: editCatalogForm.value.uri,
      label: editCatalogForm.value.label.trim(),
      image_url: editCatalogForm.value.image_url.trim() || null,
      main_category: editCatalogForm.value.main_category.trim() || null,
      series_number: editCatalogForm.value.series_number.trim() || null,
      publisher: editCatalogForm.value.publisher.trim() || null,
      publication_date: editCatalogForm.value.publication_date.trim() || null
    });
    actionFeedback.value = `Fiche catalogue serveur « ${editCatalogForm.value.label.trim()} » mise à jour.`;
    editingCatalogItem.value = null;
    await loadCatalog();
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : 'Erreur lors de la sauvegarde catalogue.';
  } finally {
    savingCatalogEdit.value = false;
  }
};

// Comptes & maintenance
const usersList = ref<any[]>([]);
const usersLoading = ref(false);
const maintBusy = ref(false);
const rehydrateOffset = ref(0);

// Logs & diagnostic pipeline V4
const logsTraces = ref<any[]>([]);
const logsLoading = ref(false);
const logsStatusFilter = ref<'all' | 'ok' | 'warn' | 'error'>('all');
const logsLayerFilter = ref<'all' | 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'CRON'>('all');
const logsQuery = ref('');
const expandedTraceIds = ref<Record<string, boolean>>({});

const catalogTotalPages = computed(() =>
  Math.max(1, Math.ceil(catalogTotal.value / catalogPageSize.value))
);

const formatBytes = (bytes: number) => {
  if (!bytes) return '0 Mo';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;
};

const loadOverview = async () => {
  loading.value = true;
  errorMsg.value = '';
  try {
    overview.value = await userService.fetchAdminOverview();
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : 'Accès refusé.';
  } finally {
    loading.value = false;
  }
};

const loadCatalog = async () => {
  catalogLoading.value = true;
  try {
    const res = await userService.fetchAdminCatalog({
      q: catalogQuery.value.trim(),
      type: catalogType.value,
      filter: catalogFilter.value,
      page: catalogPage.value,
      pageSize: catalogPageSize.value
    });
    catalogItems.value = res.items || [];
    catalogTotal.value = res.total || 0;
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : 'Erreur chargement catalogue.';
  } finally {
    catalogLoading.value = false;
  }
};

const loadUsers = async () => {
  usersLoading.value = true;
  try {
    usersList.value = await userService.fetchAdminUsers();
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : 'Erreur chargement utilisateurs.';
  } finally {
    usersLoading.value = false;
  }
};

const loadLogs = async () => {
  logsLoading.value = true;
  errorMsg.value = '';
  try {
    const res = await userService.fetchAdminPipelineLogs({
      status: logsStatusFilter.value,
      layer: logsLayerFilter.value,
      q: logsQuery.value.trim(),
      limit: 160
    });
    logsTraces.value = res.traces || [];
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : 'Erreur chargement logs pipeline.';
  } finally {
    logsLoading.value = false;
  }
};

const toggleTraceExpanded = (traceId: string) => {
  expandedTraceIds.value = {
    ...expandedTraceIds.value,
    [traceId]: !expandedTraceIds.value[traceId]
  };
};

const formatLogPayload = (raw: string | null): string => {
  if (!raw) return '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

const exportLogsJson = () => {
  const blob = new Blob([JSON.stringify(logsTraces.value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pipeline-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

const handlePurgeLogs = async () => {
  maintBusy.value = true;
  actionFeedback.value = '';
  try {
    await userService.purgeAdminPipelineLogs();
    actionFeedback.value = 'Purge TTL appliquée (ok > 7j, warn/error > 30j).';
    await loadLogs();
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : 'Erreur purge des logs.';
  } finally {
    maintBusy.value = false;
  }
};

const switchTab = async (tab: 'stats' | 'catalog' | 'users' | 'logs') => {
  activeTab.value = tab;
  if (tab === 'catalog' && catalogItems.value.length === 0) {
    await loadCatalog();
  } else if (tab === 'users' && usersList.value.length === 0) {
    await loadUsers();
  } else if (tab === 'logs' && logsTraces.value.length === 0) {
    await loadLogs();
  }
};

watch([logsStatusFilter, logsLayerFilter], () => {
  if (activeTab.value === 'logs') loadLogs();
});

const searchCatalog = () => {
  catalogPage.value = 1;
  loadCatalog();
};

watch([catalogType, catalogFilter, catalogPageSize], () => {
  catalogPage.value = 1;
  if (activeTab.value === 'catalog') loadCatalog();
});

watch(catalogPage, () => {
  if (activeTab.value === 'catalog') loadCatalog();
});

const handleResetAiQuota = async (userId: string, name: string) => {
  actionFeedback.value = '';
  try {
    await userService.resetUserAiQuota(userId);
    actionFeedback.value = `Quota IA réinitialisé pour ${name}.`;
    await loadUsers();
    await loadOverview();
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : 'Erreur réinitialisation.';
  }
};

const handleReleaseSweep = async () => {
  maintBusy.value = true;
  actionFeedback.value = '';
  try {
    const res = await userService.runAdminReleaseSweep();
    actionFeedback.value = `Vérification terminée : ${res.checkedCount} série(s) contrôlée(s), ${res.alertsCreated} alerte(s) ajoutée(s).`;
    await loadOverview();
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : 'Erreur lors de la vérification.';
  } finally {
    maintBusy.value = false;
  }
};

const handleRehydrate = async () => {
  maintBusy.value = true;
  actionFeedback.value = '';
  try {
    const res = await userService.runAdminRehydrate(rehydrateOffset.value, 20);
    rehydrateOffset.value = res.nextOffset || 0;
    actionFeedback.value = `Ré-hydratation : ${res.updated ?? 0} fiche(s) mise(s) à jour (prochain offset : ${rehydrateOffset.value}).`;
    await loadOverview();
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : 'Erreur ré-hydratation.';
  } finally {
    maintBusy.value = false;
  }
};

onMounted(() => {
  loadOverview();
});
</script>

<template>
  <div class="view-container">
    <BaseHeader />
    <BaseTitle text="Administration" level="h2" />

    <div v-if="errorMsg" class="error-banner">{{ errorMsg }}</div>
    <div v-if="actionFeedback" class="success-banner">{{ actionFeedback }}</div>

    <div v-if="loading" class="admin-card">Chargement des données administrateur...</div>

    <template v-else-if="overview">
      <div class="admin-tabs">
        <button
          type="button"
          class="wireframe-btn"
          :class="{ primary: activeTab === 'stats' }"
          @click="switchTab('stats')"
        >
          Statistiques
        </button>
        <button
          type="button"
          class="wireframe-btn"
          :class="{ primary: activeTab === 'catalog' }"
          @click="switchTab('catalog')"
        >
          Catalogue ({{ overview.catalog.editions }})
        </button>
        <button
          type="button"
          class="wireframe-btn"
          :class="{ primary: activeTab === 'users' }"
          @click="switchTab('users')"
        >
          Comptes ({{ overview.users.total }}) &amp; Maintenance
        </button>
        <button
          type="button"
          class="wireframe-btn"
          :class="{ primary: activeTab === 'logs' }"
          @click="switchTab('logs')"
        >
          Logs &amp; Diagnostic
        </button>
      </div>

      <!-- TAB 1 : STATISTIQUES GÉNÉRALES -->
      <div v-if="activeTab === 'stats'" class="stats-grid">
        <div class="admin-card">
          <h3>Utilisateurs &amp; Foyers</h3>
          <ul class="stat-list">
            <li><span>Comptes créés</span><strong>{{ overview.users.total }}</strong></li>
            <li><span>Nouveaux (7 derniers jours)</span><strong>{{ overview.users.recent7d }}</strong></li>
            <li><span>Bibliothèques / Foyers</span><strong>{{ overview.users.totalLibraries }}</strong></li>
            <li><span>Notifications actives (Push/Email)</span><strong>{{ overview.users.activeNotifUsers }}</strong></li>
          </ul>
        </div>

        <div class="admin-card">
          <h3>Catalogue commun (anonymisé)</h3>
          <ul class="stat-list">
            <li><span>Éditions (BD / Livres)</span><strong>{{ overview.catalog.editions }}</strong></li>
            <li><span>Œuvres</span><strong>{{ overview.catalog.works }}</strong></li>
            <li><span>Séries</span><strong>{{ overview.catalog.series }}</strong></li>
            <li><span>Auteurs</span><strong>{{ overview.catalog.authors }}</strong></li>
            <li>
              <span>Couvertures en cache</span>
              <strong>{{ overview.catalog.coversCount }} ({{ formatBytes(overview.catalog.coversBytes) }})</strong>
            </li>
          </ul>
        </div>

        <div class="admin-card">
          <h3>IA Photo (Gemini)</h3>
          <ul class="stat-list">
            <li><span>Analyses ce mois ({{ overview.ai.monthKey }})</span><strong>{{ overview.ai.monthUsed }}</strong></li>
            <li><span>Total historique</span><strong>{{ overview.ai.allTimeUsed }}</strong></li>
            <li><span>Quota dynamique / utilisateur</span><strong>{{ overview.ai.monthlyQuotaPerUser }} / mois</strong></li>
          </ul>
        </div>

        <div class="admin-card">
          <h3>Nouveautés &amp; Séries</h3>
          <ul class="stat-list">
            <li><span>Séries suivies en base</span><strong>{{ overview.releases.totalSeries }}</strong></li>
            <li><span>Séries déjà vérifiées</span><strong>{{ overview.releases.checkedSeries }}</strong></li>
            <li><span>Alertes sorties actives</span><strong>{{ overview.releases.activeAlerts }}</strong></li>
          </ul>
        </div>
      </div>

      <!-- TAB 2 : EXPLORATEUR DU CATALOGUE COMMUN -->
      <div v-if="activeTab === 'catalog'" class="admin-card">
        <p class="privacy-note">
          Vue globale du catalogue partagé (aucune information de possession ou bibliothèque privée n'est affichée).
        </p>

        <div class="catalog-toolbar">
          <input
            v-model="catalogQuery"
            type="search"
            class="search-input"
            placeholder="Rechercher par titre ou ISBN..."
            @keyup.enter="searchCatalog"
          />
          <select v-model="catalogType" class="filter-select">
            <option value="edition">Éditions ({{ overview.catalog.editions }})</option>
            <option value="work">Œuvres ({{ overview.catalog.works }})</option>
            <option value="serie">Séries ({{ overview.catalog.series }})</option>
            <option value="human">Auteurs ({{ overview.catalog.authors }})</option>
            <option value="all">Tout</option>
          </select>
          <select v-model="catalogFilter" class="filter-select">
            <option value="all">Toutes les fiches</option>
            <option value="no_cover">Sans couverture</option>
            <option value="no_series">Sans série</option>
          </select>
          <select v-model.number="catalogPageSize" class="filter-select" aria-label="Entrées par page">
            <option :value="12">12 / page</option>
            <option :value="24">24 / page</option>
            <option :value="48">48 / page</option>
            <option :value="60">60 / page</option>
          </select>
          <button type="button" class="wireframe-btn primary" @click="searchCatalog">
            Rechercher
          </button>
        </div>

        <div class="catalog-select-bar">
          <label class="catalog-select-all-label">
            <input
              type="checkbox"
              class="wireframe-checkbox"
              :checked="allCurrentPageSelected"
              :disabled="catalogItems.length === 0"
              @change="toggleSelectAllCurrentPage(($event.target as HTMLInputElement).checked)"
            />
            <span>Tout sélectionner sur cette page ({{ catalogItems.length }})</span>
          </label>
          <span class="count-line-inline">
            {{ catalogTotal }} fiche(s) trouvée(s)
          </span>
        </div>

        <div v-if="selectedCatalogUris.length > 0" class="admin-bulk-bar">
          <strong class="admin-bulk-count">
            {{ selectedCatalogUris.length }} œuvre(s) sélectionnée(s)
          </strong>
          <div class="admin-bulk-actions">
            <button
              type="button"
              class="wireframe-btn btn-primary admin-bulk-btn"
              @click="openBulkEditModal"
            >
              Modifier la sélection ({{ selectedCatalogUris.length }})
            </button>
            <button
              type="button"
              class="wireframe-btn admin-bulk-btn"
              @click="clearCatalogSelection"
            >
              Tout désélectionner
            </button>
          </div>
        </div>

        <div v-if="catalogLoading" class="loading-line">Chargement...</div>

        <div v-else class="catalog-list">
          <div
            v-for="item in catalogItems"
            :key="item.uri"
            role="button"
            tabindex="0"
            class="catalog-row catalog-row-clickable"
            :class="{ 'catalog-row-selected': isCatalogItemSelected(item.uri) }"
            @click="openAdminCatalogEditor(item)"
            @keydown.enter.prevent="openAdminCatalogEditor(item)"
          >
            <label class="catalog-row-check-wrap" @click.stop>
              <input
                type="checkbox"
                class="wireframe-checkbox"
                :checked="isCatalogItemSelected(item.uri)"
                :aria-label="`Sélectionner ${item.label}`"
                @change="toggleCatalogItemSelection(item.uri)"
              />
            </label>
            <img
              v-if="item.image_url"
              :src="imageUtil.resolveExternalUrl(item.image_url, item.uri?.startsWith('isbn:') ? item.uri.slice(5) : undefined)"
              :data-cover-isbn="item.uri?.startsWith('isbn:') ? item.uri.slice(5) : undefined"
              alt=""
              class="catalog-thumb"
              loading="lazy"
              @error="imageUtil.handleImageError"
            />
            <div v-else class="catalog-thumb placeholder">?</div>
            <div class="catalog-meta">
              <strong>{{ item.label }}</strong>
              <div class="catalog-sub">
                <span>{{ item.uri }}</span>
                <span v-if="item.series_name">• {{ item.series_name }}</span>
                <span v-if="item.publisher">• {{ item.publisher }}</span>
                <span v-if="item.publication_date">• {{ item.publication_date }}</span>
                <span v-if="item.main_category">• {{ item.main_category }}</span>
                <span v-if="item.series_number">• Tome {{ item.series_number }}</span>
              </div>
            </div>
            <span class="catalog-edit-pill">Modifier</span>
          </div>
        </div>

        <div
          v-if="catalogTotalPages > 1"
          class="catalog-pagination-bar"
          style="display: flex; align-items: center; justify-content: center; gap: 0.75rem; margin-top: 1rem;"
        >
          <button
            type="button"
            class="wireframe-btn"
            :disabled="catalogPage <= 1"
            @click="catalogPage = Math.max(1, catalogPage - 1)"
          >
            ‹ Précédent
          </button>
          <span style="font-size: 0.85rem; font-weight: 600;">
            Page {{ catalogPage }} / {{ catalogTotalPages }}
          </span>
          <button
            type="button"
            class="wireframe-btn"
            :disabled="catalogPage >= catalogTotalPages"
            @click="catalogPage = Math.min(catalogTotalPages, catalogPage + 1)"
          >
            Suivant ›
          </button>
        </div>
      </div>

      <!-- TAB 3 : COMPTES & MAINTENANCE -->
      <div v-if="activeTab === 'users'" class="users-section">
        <div class="admin-card">
          <h3>Maintenance serveur (déclenchement manuel des tâches CRON)</h3>
          <div class="maint-actions">
            <button
              type="button"
              class="wireframe-btn primary"
              :disabled="maintBusy"
              @click="handleReleaseSweep"
            >
              Lancer maintenant : veille nouveautés (6 séries)
            </button>
            <button
              type="button"
              class="wireframe-btn"
              :disabled="maintBusy"
              @click="handleRehydrate"
            >
              Lancer maintenant : ré-hydratation catalogue (20 fiches)
            </button>
          </div>
        </div>

        <div class="admin-card">
          <h3>Comptes enregistrés ({{ usersList.length }})</h3>
          <div v-if="usersLoading" class="loading-line">Chargement...</div>
          <div v-else class="users-table-wrap">
            <table class="users-table">
              <thead>
                <tr>
                  <th>Utilisateur</th>
                  <th>E-mail récup.</th>
                  <th>IA ce mois</th>
                  <th>Notifications</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="u in usersList" :key="u.id">
                  <td>
                    <strong>{{ u.displayName }}</strong>
                    <span v-if="u.isAdmin" class="admin-badge">Admin</span>
                  </td>
                  <td>{{ u.maskedEmail || 'Non renseigné' }}</td>
                  <td>{{ u.aiMonthUsed }}</td>
                  <td>{{ u.digestFrequency }} ({{ u.digestChannel }})</td>
                  <td>
                    <button
                      type="button"
                      class="wireframe-btn small-btn"
                      @click="handleResetAiQuota(u.id, u.displayName)"
                    >
                      RAZ quota IA
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- TAB 4 : LOGS & DIAGNOSTIC PIPELINE V4 -->
      <div v-if="activeTab === 'logs'" class="admin-card">
        <div class="logs-toolbar">
          <select v-model="logsLayerFilter" class="logs-input" aria-label="Filtrer par couche">
            <option value="all">Toutes couches</option>
            <option value="C1">C1 (Front / OCR)</option>
            <option value="C2">C2 (Index O(1))</option>
            <option value="C3">C3 (APIs Externes)</option>
            <option value="C4">C4 (Consolidation)</option>
            <option value="C5">C5 (Série / Queue)</option>
            <option value="CRON">CRON (Arrière-plan)</option>
          </select>

          <select v-model="logsStatusFilter" class="logs-input" aria-label="Filtrer par statut">
            <option value="all">Tous statuts</option>
            <option value="ok">OK uniquement</option>
            <option value="warn">Avertissements (warn)</option>
            <option value="error">Erreurs (error)</option>
          </select>

          <input
            v-model="logsQuery"
            type="search"
            class="logs-input logs-search"
            placeholder="Rechercher ISBN, titre, trace_id..."
            @keyup.enter="loadLogs"
          />

          <button type="button" class="wireframe-btn small-btn" :disabled="logsLoading" @click="loadLogs">
            {{ logsLoading ? 'Chargement...' : 'Rafraîchir' }}
          </button>
          <button
            type="button"
            class="wireframe-btn small-btn"
            :disabled="logsTraces.length === 0"
            @click="exportLogsJson"
          >
            Exporter JSON
          </button>
          <button
            type="button"
            class="wireframe-btn small-btn"
            :disabled="maintBusy"
            @click="handlePurgeLogs"
          >
            Purger TTL
          </button>
        </div>

        <div v-if="logsLoading && logsTraces.length === 0" class="logs-empty">
          Chargement des traces pipeline...
        </div>
        <div v-else-if="logsTraces.length === 0" class="logs-empty">
          Aucune trace enregistrée pour ces filtres.
        </div>

        <div v-else class="traces-list">
          <div v-for="trace in logsTraces" :key="trace.traceId" class="trace-card">
            <button
              type="button"
              class="trace-header"
              @click="toggleTraceExpanded(trace.traceId)"
            >
              <span class="trace-status-dot" :class="`status-${trace.maxStatus}`">{{ trace.maxStatus.toUpperCase() }}</span>
              <code class="trace-id">{{ trace.traceId }}</code>
              <span v-if="trace.sourceChannel" class="trace-channel">{{ trace.sourceChannel }}</span>
              <span class="trace-meta">
                {{ trace.steps.length }} étape(s) · {{ trace.totalDurationMs }} ms ·
                {{ new Date(trace.startedAt).toLocaleString('fr-FR') }}
              </span>
              <span class="trace-chevron">{{ expandedTraceIds[trace.traceId] ? '▼' : '▶' }}</span>
            </button>

            <div class="trace-summary-preview">
              {{ trace.steps[trace.steps.length - 1]?.summary || trace.steps[0]?.summary }}
            </div>

            <div v-if="expandedTraceIds[trace.traceId]" class="trace-steps">
              <div v-for="step in trace.steps" :key="step.id" class="trace-step-row">
                <div class="step-top">
                  <span class="step-layer">{{ step.layer }}</span>
                  <span class="trace-status-dot" :class="`status-${step.status}`">{{ step.status }}</span>
                  <strong>{{ step.step_name }}</strong>
                  <span v-if="step.duration_ms !== null" class="step-duration">{{ step.duration_ms }} ms</span>
                </div>
                <div class="step-summary">{{ step.summary }}</div>
                <pre v-if="step.payload_json" class="step-payload">{{ formatLogPayload(step.payload_json) }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Modale de modification groupée (sélection multiple Admin) -->
    <Teleport to="body">
      <div v-if="showBulkEditModal" class="modal-overlay" @click.self="showBulkEditModal = false">
        <div class="modal-box" role="dialog" aria-modal="true" aria-label="Modification groupée du catalogue">
          <h2>Modifier {{ selectedCatalogUris.length }} œuvre(s)</h2>
          <p class="modal-text">
            Cochez uniquement les champs que vous souhaitez appliquer à l’ensemble des fiches sélectionnées. Les champs non cochés resteront intacts sur chaque œuvre.
          </p>

          <datalist id="admin-main-category-options">
            <option v-for="cat in ADMIN_MAIN_CATEGORIES" :key="cat" :value="cat" />
          </datalist>

          <div class="admin-edit-fields">
            <div class="bulk-field-card" :class="{ active: bulkEditForm.applyPublisher }">
              <label class="bulk-field-toggle">
                <input v-model="bulkEditForm.applyPublisher" type="checkbox" class="wireframe-checkbox" />
                <span>Éditeur</span>
              </label>
              <input
                v-if="bulkEditForm.applyPublisher"
                v-model="bulkEditForm.publisher"
                type="text"
                class="ds-input"
                placeholder="Ex : Urban Comics, Dargaud, Dupuis... (vide pour effacer)"
              />
            </div>

            <div class="bulk-field-card" :class="{ active: bulkEditForm.applyMainCategory }">
              <label class="bulk-field-toggle">
                <input v-model="bulkEditForm.applyMainCategory" type="checkbox" class="wireframe-checkbox" />
                <span>Catégorie principale</span>
              </label>
              <input
                v-if="bulkEditForm.applyMainCategory"
                v-model="bulkEditForm.main_category"
                type="text"
                list="admin-main-category-options"
                class="ds-input"
                placeholder="Ex : BD, Comics, Manga, Roman..."
              />
            </div>

            <div class="bulk-field-card" :class="{ active: bulkEditForm.applySeriesName }">
              <label class="bulk-field-toggle">
                <input v-model="bulkEditForm.applySeriesName" type="checkbox" class="wireframe-checkbox" />
                <span>Série</span>
              </label>
              <input
                v-if="bulkEditForm.applySeriesName"
                v-model="bulkEditForm.series_name"
                type="text"
                class="ds-input"
                placeholder="Ex : Fables (laisser vide pour détacher de la série)"
              />
            </div>

            <div class="bulk-field-card" :class="{ active: bulkEditForm.applyAuthors }">
              <label class="bulk-field-toggle">
                <input v-model="bulkEditForm.applyAuthors" type="checkbox" class="wireframe-checkbox" />
                <span>Auteurs (séparés par des virgules)</span>
              </label>
              <input
                v-if="bulkEditForm.applyAuthors"
                v-model="bulkEditForm.authors"
                type="text"
                class="ds-input"
                placeholder="Ex : Bill Willingham, Mark Buckingham"
              />
            </div>

            <div class="bulk-field-card" :class="{ active: bulkEditForm.applySubgenres }">
              <label class="bulk-field-toggle">
                <input v-model="bulkEditForm.applySubgenres" type="checkbox" class="wireframe-checkbox" />
                <span>Sous-genres / Genres secondaires (virgules)</span>
              </label>
              <input
                v-if="bulkEditForm.applySubgenres"
                v-model="bulkEditForm.subgenres"
                type="text"
                class="ds-input"
                placeholder="Ex : Fantastique, Aventure"
              />
            </div>

            <div class="bulk-field-card" :class="{ active: bulkEditForm.applyPublicationDate }">
              <label class="bulk-field-toggle">
                <input v-model="bulkEditForm.applyPublicationDate" type="checkbox" class="wireframe-checkbox" />
                <span>Date / Année de publication</span>
              </label>
              <input
                v-if="bulkEditForm.applyPublicationDate"
                v-model="bulkEditForm.publication_date"
                type="text"
                class="ds-input"
                placeholder="Ex : 2012"
              />
            </div>
          </div>

          <div class="modal-actions">
            <button
              type="button"
              class="btn-action"
              :disabled="savingBulkEdit || !hasAnyBulkFieldSelected"
              @click="saveAdminBulkCatalogEdit"
            >
              {{ savingBulkEdit ? 'Application en cours...' : `Appliquer à ${selectedCatalogUris.length} fiche(s)` }}
            </button>
            <button
              type="button"
              class="btn-close"
              :disabled="savingBulkEdit"
              @click="showBulkEditModal = false"
            >
              Annuler
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Modale d'édition directe de la fiche maître catalogue serveur (Admin) -->
    <Teleport to="body">
      <div v-if="editingCatalogItem" class="modal-overlay" @click.self="editingCatalogItem = null">
        <div class="modal-box" role="dialog" aria-modal="true" aria-label="Modifier la fiche catalogue serveur">
          <h2>Éditer la fiche maître serveur</h2>
          <p class="modal-text">
            URI : <code>{{ editCatalogForm.uri }}</code><br />
            Les modifications s’appliquent directement au catalogue central commun.
          </p>
          <div class="admin-edit-fields">
            <label class="ds-field">
              <span>Titre / Libellé</span>
              <input v-model="editCatalogForm.label" type="text" class="ds-input" />
            </label>
            <label class="ds-field">
              <span>Catégorie principale / Genre</span>
              <input v-model="editCatalogForm.main_category" type="text" class="ds-input" placeholder="Ex: Bande dessinée, Roman..." />
            </label>
            <label class="ds-field">
              <span>Numéro de tome</span>
              <input v-model="editCatalogForm.series_number" type="text" class="ds-input" placeholder="Ex: 1, HS, Int. 1-3" />
            </label>
            <label class="ds-field">
              <span>Éditeur</span>
              <input v-model="editCatalogForm.publisher" type="text" class="ds-input" />
            </label>
            <label class="ds-field">
              <span>Date / Année de publication</span>
              <input v-model="editCatalogForm.publication_date" type="text" class="ds-input" />
            </label>
            <label class="ds-field">
              <span>URL de couverture</span>
              <input v-model="editCatalogForm.image_url" type="text" class="ds-input" />
            </label>
          </div>
          <div class="modal-actions">
            <button
              type="button"
              class="btn-action"
              :disabled="savingCatalogEdit || !editCatalogForm.label.trim()"
              @click="saveAdminCatalogEditor"
            >
              {{ savingCatalogEdit ? 'Enregistrement...' : 'Enregistrer sur le serveur' }}
            </button>
            <button
              type="button"
              class="btn-close"
              :disabled="savingCatalogEdit"
              @click="editingCatalogItem = null"
            >
              Annuler
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.admin-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 1rem;
}

.admin-card {
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-md, 12px);
  padding: 1.15rem;
  box-shadow: var(--shadow-sm);
  margin-bottom: 1rem;
}

.admin-card h3 {
  margin: 0 0 0.75rem;
  font-size: 1rem;
}

.catalog-row-clickable {
  cursor: pointer;
  transition: background-color 0.12s ease, border-color 0.12s ease;
}

.catalog-row-clickable:hover {
  background: #f8fafc;
}

.catalog-row-selected {
  border-color: var(--color-primary, #4f46e5) !important;
  background: #eef2ff;
}

.catalog-row-check-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.2rem;
  flex-shrink: 0;
  cursor: pointer;
}

.catalog-select-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin: 0.35rem 0 0.65rem;
}

.catalog-select-all-label {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

.count-line-inline {
  font-size: 0.84rem;
  color: #64748b;
}

.admin-bulk-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.65rem 0.85rem;
  margin-bottom: 0.85rem;
  border-radius: 10px;
  border: 1px solid #c7d2fe;
  background: #eef2ff;
}

.admin-bulk-count {
  font-size: 0.88rem;
  color: #3730a3;
}

.admin-bulk-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.admin-bulk-btn {
  width: auto !important;
  height: auto !important;
  min-block-size: 36px;
  padding: 0.35rem 0.8rem !important;
  font-size: 0.82rem !important;
}

.bulk-field-card {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.55rem 0.7rem;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
}

.bulk-field-card.active {
  border-color: #c7d2fe;
  background: #eef2ff;
}

.bulk-field-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.86rem;
  font-weight: 700;
  color: #0f172a;
  cursor: pointer;
}

.catalog-edit-pill {
  margin-left: auto;
  padding: 0.25rem 0.6rem;
  border-radius: 999px;
  background: #eef2ff;
  color: #3730a3;
  font-size: 0.76rem;
  font-weight: 700;
  white-space: nowrap;
}

.admin-edit-fields {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.stat-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.stat-list li {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.9rem;
  border-bottom: 1px dashed #e2e8f0;
  padding-bottom: 0.35rem;
}

.privacy-note {
  margin: 0 0 0.85rem;
  font-size: 0.84rem;
  color: #64748b;
}

.catalog-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.search-input,
.filter-select {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 8px;
  min-block-size: 38px;
  padding: 0.4rem 0.65rem;
  font-size: 0.88rem;
  background: #fff;
}

.search-input {
  flex: 1 1 200px;
}

.count-line,
.loading-line {
  font-size: 0.84rem;
  color: #64748b;
  margin: 0.4rem 0 0.75rem;
}

.catalog-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.catalog-row {
  display: flex;
  gap: 0.65rem;
  align-items: center;
  padding: 0.5rem;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
}

.catalog-thumb {
  width: 44px;
  height: 62px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
  background: #f1f5f9;
}

.catalog-thumb.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #94a3b8;
  font-weight: 700;
}

.catalog-meta {
  min-width: 0;
  font-size: 0.85rem;
}

.catalog-meta strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.catalog-sub {
  font-size: 0.75rem;
  color: #64748b;
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.maint-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
}

.users-table-wrap {
  overflow-x: auto;
}

.users-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.86rem;
}

.users-table th,
.users-table td {
  text-align: left;
  padding: 0.55rem 0.5rem;
  border-bottom: 1px solid #e2e8f0;
}

.admin-badge {
  display: inline-block;
  margin-left: 0.35rem;
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
  background: #eef2ff;
  color: #4f46e5;
  font-size: 0.72rem;
  font-weight: 700;
}

.small-btn {
  padding: 0.25rem 0.55rem;
  font-size: 0.78rem;
}

.error-banner {
  background: #fee2e2;
  color: #991b1b;
  border-radius: 8px;
  padding: 0.7rem 0.9rem;
  margin-bottom: 1rem;
  font-weight: 600;
}

.success-banner {
  background: #dcfce7;
  color: #166534;
  border-radius: 8px;
  padding: 0.7rem 0.9rem;
  margin-bottom: 1rem;
  font-weight: 600;
}

.logs-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 1rem;
}

.logs-input {
  padding: 0.4rem 0.6rem;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  font-size: 0.85rem;
  background: #fff;
}

.logs-search {
  flex: 1 1 200px;
}

.logs-empty {
  padding: 1.5rem;
  text-align: center;
  color: #64748b;
}

.traces-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.trace-card {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  overflow: hidden;
  background: #f8fafc;
}

.trace-header {
  width: 100%;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.65rem 0.85rem;
  border: none;
  background: #f1f5f9;
  cursor: pointer;
  text-align: left;
}

.trace-status-dot {
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 700;
}

.trace-status-dot.status-ok {
  background: #dcfce7;
  color: #166534;
}

.trace-status-dot.status-warn {
  background: #fef3c7;
  color: #92400e;
}

.trace-status-dot.status-error {
  background: #fee2e2;
  color: #991b1b;
}

.trace-id {
  font-size: 0.8rem;
  color: #0f172a;
}

.trace-channel {
  background: #e0e7ff;
  color: #3730a3;
  padding: 0.1rem 0.45rem;
  border-radius: 6px;
  font-size: 0.74rem;
  font-weight: 600;
}

.trace-meta {
  font-size: 0.78rem;
  color: #475569;
  margin-left: auto;
}

.trace-chevron {
  font-size: 0.78rem;
  color: #475569;
}

.trace-summary-preview {
  padding: 0.45rem 0.85rem;
  font-size: 0.84rem;
  color: #334155;
  background: #fff;
  border-top: 1px solid #e2e8f0;
}

.trace-steps {
  padding: 0.65rem 0.85rem;
  background: #fff;
  border-top: 1px solid #e2e8f0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.trace-step-row {
  border-left: 3px solid #cbd5e1;
  padding-left: 0.65rem;
}

.step-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.82rem;
}

.step-layer {
  background: #0f172a;
  color: #fff;
  padding: 0.08rem 0.4rem;
  border-radius: 4px;
  font-size: 0.72rem;
  font-weight: 700;
}

.step-duration {
  margin-left: auto;
  color: #64748b;
  font-size: 0.75rem;
}

.step-summary {
  margin-top: 0.2rem;
  font-size: 0.83rem;
  color: #1e293b;
}

.step-payload {
  margin: 0.35rem 0 0;
  padding: 0.5rem;
  background: #0f172a;
  color: #e2e8f0;
  border-radius: 6px;
  font-size: 0.75rem;
  max-height: 220px;
  overflow: auto;
}
</style>
