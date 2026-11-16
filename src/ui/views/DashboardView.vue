<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { databaseService } from '../../core/database/database.service';
import { searchService } from '../../core/orchestrators/search.orchestrator';
import { isbnUtil } from '../../core/utils/isbn.util';
import { imageUtil } from '../../core/utils/image.util';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import SmartSearchBar from '../components/SmartSearchBar.vue';
import { TEXTS } from '../locales/fr';
import { statsService, type DashboardStats } from '../../core/services/stats.service';
import { scannerState } from '../../state/scanner';
import type { HumanizedBook } from '../../core/types';

const router = useRouter();

const searchQuery = ref('');
const errorMessage = ref<string | null>(null);

const previewCollection = ref<HumanizedBook[]>([]);
const previewWishlist = ref<HumanizedBook[]>([]);
const previewLoans = ref<HumanizedBook[]>([]);

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
  } catch {
    errorMessage.value = TEXTS.scanner.errorGeneral;
  }
};

const handleKeywordsSearch = (query: string) => {
  router.push({ name: 'SearchResultView', query: { q: query } });
};

const stats = ref<DashboardStats | null>(null);
const selectedPeriod = ref(30);
const isStatsLoading = ref(true);

const loadDashboardData = async () => {
  isStatsLoading.value = true;
  try {
    const [statsRes, cachedBooks, loans] = await Promise.all([
      statsService.getDashboardStats(selectedPeriod.value),
      databaseService.getAllBooksFromCache().catch(() => [] as HumanizedBook[]),
      databaseService.getAllLoans().catch(() => [])
    ]);
    stats.value = statsRes;

    const byRecent = (list: HumanizedBook[]) =>
      [...list]
        .filter((b) => Boolean(b.localCover || b.coverUrl))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 5);

    previewCollection.value = byRecent(cachedBooks.filter((b) => b.ownershipStatus === 'owned'));
    previewWishlist.value = byRecent(cachedBooks.filter((b) => b.ownershipStatus === 'wish'));

    const loanUris = new Set(loans.map((l) => l.uri));
    previewLoans.value = byRecent(cachedBooks.filter((b) => loanUris.has(b.uri)));
  } catch (e) {
    console.error('Erreur chargement tableau de bord :', e);
  } finally {
    isStatsLoading.value = false;
  }
};

const openBook = (uri: string) => {
  router.push(`/book/${encodeURIComponent(uri)}`);
};

onMounted(async () => {
  await loadDashboardData();
});

watch(
  () => scannerState.lastUpdatedTick.value,
  () => {
    loadDashboardData();
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

    <div v-if="errorMessage" class="error-banner">
      {{ errorMessage }}
    </div>

    <!-- Accès rapides : Ma Collection, Ma Wishlist, Mes Prêts avec aperçu couvertures -->
    <div class="home-spaces-grid">
      <div class="home-space-card">
        <button type="button" class="home-space-link" @click="router.push({ name: 'CollectionView', query: { mode: 'books' } })">
          <span>MA COLLECTION</span>
          <span class="home-space-count" v-if="stats">{{ stats.totalOwned }}</span>
        </button>
        <div v-if="previewCollection.length" class="home-covers-strip">
          <img
            v-for="book in previewCollection"
            :key="book.uri"
            :src="imageUtil.resolveCoverUrl(book)"
            :alt="book.title"
            :title="book.title"
            class="home-preview-cover"
            @click="openBook(book.uri)"
          />
        </div>
      </div>

      <div class="home-space-card">
        <button type="button" class="home-space-link" @click="router.push({ name: 'WishlistView' })">
          <span>MA WISHLIST</span>
          <span class="home-space-count" v-if="stats">{{ stats.totalWishlist }}</span>
        </button>
        <div v-if="previewWishlist.length" class="home-covers-strip">
          <img
            v-for="book in previewWishlist"
            :key="book.uri"
            :src="imageUtil.resolveCoverUrl(book)"
            :alt="book.title"
            :title="book.title"
            class="home-preview-cover"
            @click="openBook(book.uri)"
          />
        </div>
      </div>

      <div class="home-space-card">
        <button type="button" class="home-space-link" @click="router.push({ name: 'LoansView' })">
          <span>MES PRÊTS</span>
          <span class="home-space-count" v-if="stats">{{ stats.totalLoans }}</span>
        </button>
        <div v-if="previewLoans.length" class="home-covers-strip">
          <img
            v-for="book in previewLoans"
            :key="book.uri"
            :src="imageUtil.resolveCoverUrl(book)"
            :alt="book.title"
            :title="book.title"
            class="home-preview-cover"
            @click="openBook(book.uri)"
          />
        </div>
      </div>
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
          <div class="stats-extra-card">
            <div class="stats-card-header">
              <h4 class="stats-extra-title">{{ TEXTS.dashboardStats.activityTitle }}</h4>
              <div class="stats-period-selector">
                <select v-model="selectedPeriod" @change="loadDashboardData" class="stats-select">
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

<style scoped>
.home-spaces-grid {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  margin: 0.85rem 0 1.25rem;
}

.home-space-card {
  border: var(--border-width, 2px) solid var(--color-border, #000);
  background: var(--color-bg-main, #fff);
  padding: 0.55rem 0.7rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.home-space-link {
  background: none;
  border: none;
  padding: 0;
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-family: var(--font-main);
  font-size: 13px;
  font-weight: 800;
  text-transform: uppercase;
  color: var(--color-text-main, #000);
  cursor: pointer;
  text-align: left;
}

.home-space-count {
  font-size: 12px;
  padding: 1px 7px;
  border: 1.5px solid var(--color-border, #000);
  background: var(--color-bg-alt, #f1f5f9);
}

.home-covers-strip {
  display: flex;
  gap: 0.45rem;
  overflow-x: auto;
  padding-top: 2px;
}

.home-preview-cover {
  width: 44px;
  height: 62px;
  object-fit: cover;
  border: 1px solid var(--color-border, #000);
  cursor: pointer;
  flex-shrink: 0;
  background: #f1f5f9;
}
</style>
