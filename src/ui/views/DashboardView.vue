<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { searchService } from '../../core/orchestrators/search.orchestrator';
import { isbnUtil } from '../../core/utils/isbn.util';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import SmartSearchBar from '../components/SmartSearchBar.vue';
import FamilyShareModal from '../components/FamilyShareModal.vue';
import { TEXTS } from '../locales/fr';
import { statsService, type DashboardStats } from '../../core/services/stats.service';
import { scannerState } from '../../state/scanner';

const router = useRouter();
const showFamilyModal = ref(false);

const searchQuery = ref('');
const errorMessage = ref<string | null>(null);

/**
 * Lance la résolution sémantique de l'ISBN via le service du cœur
 */
const handleSearch = async (isbn: string) => {
  if (!isbn) return;
  errorMessage.value = null;
  try {
    const cleanedIsbn = isbnUtil.normalize(isbn);
    const response = await searchService.searchByIsbn(cleanedIsbn);
    if (response) {
      if ('isUnknown' in response && (response as any).isUnknown) {
        router.push({ name: 'BookCreateUnknown', query: { isbn: (response as any).isbn } });
      } else if (response.mainBook?.uri) {
        router.push(`/book/${encodeURIComponent(response.mainBook.uri)}`);
      }
    } else {
      errorMessage.value = TEXTS.scanner.notFound;
    }
  } catch (err: any) {
    errorMessage.value = TEXTS.scanner.errorGeneral;
  }
};

/**
 * Redirige vers l'écran intermédiaire sémantique pour la recherche textuelle
 */
const handleKeywordsSearch = (query: string) => {
  router.push({ name: 'SearchResultView', query: { q: query } });
};

const stats = ref<DashboardStats | null>(null);
const selectedPeriod = ref(30); // 30 jours par défaut
const isStatsLoading = ref(true);

const loadStats = async () => {
  isStatsLoading.value = true;
  try {
    stats.value = await statsService.getDashboardStats(selectedPeriod.value);
  } catch (e) {
    console.error("Erreur chargement statistiques :", e);
  } finally {
    isStatsLoading.value = false;
  }
};

onMounted(async () => {
  await loadStats();
});

watch(
  () => scannerState.lastUpdatedTick.value,
  () => {
    loadStats();
  }
);
</script>

<template>
  <div class="view-container">
    <BaseHeader />

    <BaseTitle :text="TEXTS.home.title" level="h2" />
    
    <SmartSearchBar 
      v-model="searchQuery" 
      @isbn-detected="handleSearch" 
      @keywords-detected="handleKeywordsSearch" 
    />

    <!-- Barre d'actions rapides V2 : 4 Modes de Scan & Partage Familial -->
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 0.6rem; margin: 1rem 0;">
      <button
        type="button"
        class="wireframe-btn"
        style="background: #2563eb; color: #fff; font-weight: 800; padding: 0.65rem;"
        @click="scannerState.startScan(router, 'simple')"
      >
        📖 Scan Simple (Fiche &amp; Série)
      </button>
      <button
        type="button"
        class="wireframe-btn"
        style="background: #4f46e5; color: #fff; font-weight: 800; padding: 0.65rem;"
        @click="scannerState.startScan(router, 'check')"
      >
        🏪 Scan Magasin (&lt;1s)
      </button>
      <button
        type="button"
        class="wireframe-btn"
        style="background: #0f172a; color: #fff; font-weight: 800; padding: 0.65rem;"
        @click="scannerState.startScan(router, 'burst')"
      >
        ⚡ Scan en Rafale
      </button>
      <button
        type="button"
        class="wireframe-btn"
        style="background: #f8fafc; font-weight: 800; padding: 0.65rem;"
        @click="scannerState.startScan(router, 'photo')"
      >
        📸 Photo Étagère / Couv
      </button>
      <button
        type="button"
        class="wireframe-btn"
        style="background: #ecfdf5; color: #065f46; font-weight: 800; padding: 0.65rem;"
        @click="showFamilyModal = true"
      >
        👨‍👩‍👧‍👦 Foyer &amp; Partage
      </button>
      <button
        type="button"
        class="wireframe-btn"
        style="background: #f0f9ff; color: #0369a1; font-weight: 800; padding: 0.65rem;"
        @click="router.push('/friends')"
      >
        👥 Mes Amis
      </button>
    </div>

    <FamilyShareModal :show="showFamilyModal" @close="showFamilyModal = false" />

    <div v-if="errorMessage" class="error-banner">
      {{ errorMessage }}
    </div>

    <!-- Panneau de Statistiques de la Bibliothèque -->
    <div class="dashboard-stats-section">
      <div class="stats-header">
        <h3 class="stats-title">{{ TEXTS.dashboardStats.title }}</h3>
      </div>

      <div v-if="isStatsLoading" class="stats-info-msg">
        {{ TEXTS.dashboardStats.loading }}
      </div>

      <div v-else-if="!stats" class="stats-info-msg">
        {{ TEXTS.dashboardStats.noData }}
      </div>

      <template v-else>
        <!-- Grille des statistiques clés (Globaux) -->
        <div class="stats-grid">
          <div 
            class="stats-card card-owned" 
            role="button" 
            tabindex="0" 
            @click="router.push({ name: 'CollectionView', query: { mode: 'books' } })"
            @keydown.enter="router.push({ name: 'CollectionView', query: { mode: 'books' } })"
            @keydown.space.prevent="router.push({ name: 'CollectionView', query: { mode: 'books' } })"
          >
            <div class="stats-value">{{ stats.totalOwned }}</div>
            <div class="stats-label">{{ TEXTS.dashboardStats.totalOwned }}</div>
          </div>
          <div 
            class="stats-card card-series" 
            role="button" 
            tabindex="0" 
            @click="router.push({ name: 'CollectionView', query: { mode: 'series' } })"
            @keydown.enter="router.push({ name: 'CollectionView', query: { mode: 'series' } })"
            @keydown.space.prevent="router.push({ name: 'CollectionView', query: { mode: 'series' } })"
          >
            <div class="stats-value">{{ stats.totalSeries }}</div>
            <div class="stats-label">{{ TEXTS.dashboardStats.totalSeries }}</div>
          </div>
          <div 
            class="stats-card card-wishlist" 
            role="button" 
            tabindex="0" 
            @click="router.push({ name: 'WishlistView' })"
            @keydown.enter="router.push({ name: 'WishlistView' })"
            @keydown.space.prevent="router.push({ name: 'WishlistView' })"
          >
            <div class="stats-value">{{ stats.totalWishlist }}</div>
            <div class="stats-label">{{ TEXTS.dashboardStats.totalWishlist }}</div>
          </div>
          <div 
            class="stats-card card-loans" 
            role="button" 
            tabindex="0" 
            @click="router.push({ name: 'LoansView' })"
            @keydown.enter="router.push({ name: 'LoansView' })"
            @keydown.space.prevent="router.push({ name: 'LoansView' })"
          >
            <div class="stats-value">{{ stats.totalLoans }}</div>
            <div class="stats-label">
              {{ TEXTS.dashboardStats.loansWithRate.replace('{rate}', stats.loanRate.toString()) }}
            </div>
          </div>
        </div>

        <!-- Détails avancés (Activité, Genres, Auteurs) -->
        <div class="stats-extra-row">
          <!-- Carte d'Activité / Flux sur la période -->
          <div class="stats-extra-card">
            <div class="stats-card-header">
              <h4 class="stats-extra-title">{{ TEXTS.dashboardStats.activityTitle }}</h4>
              <div class="stats-period-selector">
                <select v-model="selectedPeriod" @change="loadStats" class="stats-select">
                  <option :value="30">{{ TEXTS.dashboardStats.period30 }}</option>
                  <option :value="90">{{ TEXTS.dashboardStats.period90 }}</option>
                  <option :value="365">{{ TEXTS.dashboardStats.period365 }}</option>
                  <option :value="-1">{{ TEXTS.dashboardStats.periodAll }}</option>
                </select>
              </div>
            </div>
            
            <div class="stats-flux-container">
              <div class="stats-flux-item">
                <div class="stats-flux-value">+{{ stats.acquiredInPeriod }}</div>
                <div class="stats-flux-label">{{ TEXTS.dashboardStats.acquiredInPeriod }}</div>
              </div>
              <div class="stats-flux-item">
                <div class="stats-flux-value">{{ stats.loansInPeriod }}</div>
                <div class="stats-flux-label">{{ TEXTS.dashboardStats.loansInPeriod }}</div>
              </div>
            </div>
          </div>

          <!-- Genres Favoris -->
          <div class="stats-extra-card">
            <h4 class="stats-extra-title">{{ TEXTS.dashboardStats.topGenres }}</h4>
            <ul class="stats-list" v-if="stats.topGenres.length > 0">
              <li v-for="g in stats.topGenres" :key="g.name" class="stats-list-item">
                <span class="stats-item-name">{{ g.name }}</span>
                <span class="stats-item-count">{{ g.count }}</span>
              </li>
            </ul>
            <p v-else class="stats-empty-msg">
              {{ TEXTS.dashboardStats.noData }}
            </p>
          </div>

          <!-- Auteurs Favoris -->
          <div class="stats-extra-card">
            <h4 class="stats-extra-title">{{ TEXTS.dashboardStats.topAuthors }}</h4>
            <ul class="stats-list" v-if="stats.topAuthors.length > 0">
              <li v-for="a in stats.topAuthors" :key="a.name" class="stats-list-item">
                <span class="stats-item-name">{{ a.name }}</span>
                <span class="stats-item-count">{{ a.count }}</span>
              </li>
            </ul>
            <p v-else class="stats-empty-msg">
              {{ TEXTS.dashboardStats.noData }}
            </p>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>