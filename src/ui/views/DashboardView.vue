<script setup lang="ts">
import { ref, nextTick, onUnmounted, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { barcodeIsbnProvider } from '../../plugins/barcode/barcode-isbn.provider';
import { searchService } from '../../core/orchestrators/search.orchestrator';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import SmartSearchBar from '../components/SmartSearchBar.vue';
import { TEXTS } from '../locales/fr';
import { statsService, type DashboardStats } from '../../core/services/stats.service';

const router = useRouter();

const searchQuery = ref('');
const isScanningActive = ref(false);
const isSearching = ref(false);
const errorMessage = ref<string | null>(null);

const scannerId = 'barcode-scanner-viewport';

/**
 * Lance la résolution sémantique de l'ISBN via le service du cœur
 */
const handleSearch = async (isbn: string) => {
  if (!isbn) return;
  errorMessage.value = null;
  try {
    const cleanedIsbn = isbn.replace(/-/g, '');
    const response = await searchService.searchByIsbn(cleanedIsbn);
    if (response && response.mainBook?.uri) {
      router.push(`/book/${encodeURIComponent(response.mainBook.uri)}`);
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

/**
 * Initialise le module de flux caméra matériel
 */
const startScanningSequence = async () => {
  errorMessage.value = null;
  isScanningActive.value = true;
  await nextTick();

  await barcodeIsbnProvider.startScanner(
    scannerId,
    (response) => {
      isScanningActive.value = false;
      isSearching.value = false;
      if (response && response.mainBook?.uri) {
        router.push(`/book/${encodeURIComponent(response.mainBook.uri)}`);
      } else {
        errorMessage.value = TEXTS.scanner.notFound;
      }
    },
    (errorMsg) => {
      isScanningActive.value = false;
      isSearching.value = false;
      errorMessage.value = errorMsg;
    },
    () => { isSearching.value = true; }
  );
};

/**
 * Interrompt proprement la capture optique
 */
const stopScanningSequence = async () => {
  await barcodeIsbnProvider.stopScanner();
  isScanningActive.value = false;
  isSearching.value = false;
};

/**
 * Gère l'état de bascule du scanner matériel
 */
const toggleScanSequence = () => {
  if (isScanningActive.value) {
    stopScanningSequence();
  } else {
    startScanningSequence();
  }
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

onUnmounted(async () => {
  await barcodeIsbnProvider.stopScanner();
});
</script>

<template>
  <div class="view-container">
    <BaseHeader />

    <BaseTitle :text="TEXTS.home.title" level="h2" />
    
    <SmartSearchBar 
      v-model="searchQuery" 
      :isScanningActive="isScanningActive" 
      @isbn-detected="handleSearch" 
      @keywords-detected="handleKeywordsSearch" 
      @toggle-scan="toggleScanSequence" 
    />

    <div v-show="isScanningActive" class="scanner-box">
      <BaseTitle :text="TEXTS.scanner.title" level="h3" />
      <div class="scanner-viewport-wrapper">
        <div :id="scannerId" class="scanner-viewport"></div>
        <div v-if="!isSearching" class="scanner-placeholder">
          <p>{{ TEXTS.scanner.searching }}</p>
        </div>
      </div>
    </div>

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
          <div class="stats-card">
            <div class="stats-value">{{ stats.totalOwned }}</div>
            <div class="stats-label">{{ TEXTS.dashboardStats.totalOwned }}</div>
          </div>
          <div class="stats-card">
            <div class="stats-value">{{ stats.totalSeries }}</div>
            <div class="stats-label">{{ TEXTS.dashboardStats.totalSeries }}</div>
          </div>
          <div class="stats-card">
            <div class="stats-value">{{ stats.totalWishlist }}</div>
            <div class="stats-label">{{ TEXTS.dashboardStats.totalWishlist }}</div>
          </div>
          <div class="stats-card">
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