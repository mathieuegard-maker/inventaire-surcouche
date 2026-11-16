<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import WireframePagination from '../components/WireframePagination.vue';
import { userService } from '../../core/services/user.service';
import { imageUtil } from '../../core/utils/image.util';

const activeTab = ref<'stats' | 'catalog' | 'users'>('stats');
const loading = ref(true);
const errorMsg = ref('');
const actionFeedback = ref('');

const overview = ref<any>(null);

// Explorateur du catalogue commun (sans aucune donnée de possession privée)
const catalogItems = ref<any[]>([]);
const catalogTotal = ref(0);
const catalogPage = ref(1);
const catalogPageSize = 24;
const catalogQuery = ref('');
const catalogType = ref('edition');
const catalogFilter = ref('all');
const catalogLoading = ref(false);

// Comptes & maintenance
const usersList = ref<any[]>([]);
const usersLoading = ref(false);
const maintBusy = ref(false);
const rehydrateOffset = ref(0);

const catalogTotalPages = computed(() =>
  Math.max(1, Math.ceil(catalogTotal.value / catalogPageSize))
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
      pageSize: catalogPageSize
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

const switchTab = async (tab: 'stats' | 'catalog' | 'users') => {
  activeTab.value = tab;
  if (tab === 'catalog' && catalogItems.value.length === 0) {
    await loadCatalog();
  } else if (tab === 'users' && usersList.value.length === 0) {
    await loadUsers();
  }
};

const searchCatalog = () => {
  catalogPage.value = 1;
  loadCatalog();
};

watch([catalogType, catalogFilter], () => {
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
      </div>

      <!-- TAB 1 : STATISTIQUES GÉNÉRALES -->
      <div v-if="activeTab === 'stats'" class="stats-grid">
        <div class="admin-card">
          <h3>Utilisateurs &amp; Foyers</h3>
          <ul class="stat-list">
            <li><span>Comptes créés</span><strong>{{ overview.users.total }}</strong></li>
            <li><span>Nouveaux (7 derniers jours)</span><strong>{{ overview.users.recent7d }}</strong></li>
            <li><span>Bibliothèques / Foyers</span><strong>{{ overview.users.totalLibraries }}</strong></li>
            <li><span>Digests actifs (Push/Email)</span><strong>{{ overview.users.activeNotifUsers }}</strong></li>
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
          <button type="button" class="wireframe-btn primary" @click="searchCatalog">
            Rechercher
          </button>
        </div>

        <p class="count-line">{{ catalogTotal }} fiche(s) trouvée(s)</p>

        <div v-if="catalogLoading" class="loading-line">Chargement...</div>

        <div v-else class="catalog-list">
          <div v-for="item in catalogItems" :key="item.uri" class="catalog-row">
            <img
              v-if="item.image_url"
              :src="imageUtil.resolveExternalUrl(item.image_url)"
              alt=""
              class="catalog-thumb"
              loading="lazy"
            />
            <div v-else class="catalog-thumb placeholder">?</div>
            <div class="catalog-meta">
              <strong>{{ item.label }}</strong>
              <div class="catalog-sub">
                <span>{{ item.uri }}</span>
                <span v-if="item.publisher">• {{ item.publisher }}</span>
                <span v-if="item.publication_date">• {{ item.publication_date }}</span>
                <span v-if="item.main_category">• {{ item.main_category }}</span>
                <span v-if="item.series_number">• Tome {{ item.series_number }}</span>
              </div>
            </div>
          </div>
        </div>

        <WireframePagination
          v-if="catalogTotalPages > 1"
          :current-page="catalogPage"
          :total-pages="catalogTotalPages"
          @update:current-page="(p) => (catalogPage = p)"
        />
      </div>

      <!-- TAB 3 : COMPTES & MAINTENANCE -->
      <div v-if="activeTab === 'users'" class="users-section">
        <div class="admin-card">
          <h3>Maintenance serveur</h3>
          <div class="maint-actions">
            <button
              type="button"
              class="wireframe-btn primary"
              :disabled="maintBusy"
              @click="handleReleaseSweep"
            >
              Vérifier 6 séries (Nouveautés)
            </button>
            <button
              type="button"
              class="wireframe-btn"
              :disabled="maintBusy"
              @click="handleRehydrate"
            >
              Ré-hydrater 20 fiches catalogue
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
                  <th>Digest</th>
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
    </template>
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
</style>
