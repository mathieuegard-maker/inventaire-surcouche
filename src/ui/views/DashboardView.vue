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
import { statsService } from '../../core/services/stats.service';
import { scannerState } from '../../state/scanner';
import type { HumanizedBook } from '../../core/types';

const router = useRouter();

const searchQuery = ref('');
const errorMessage = ref<string | null>(null);

const previewCollection = ref<HumanizedBook[]>([]);
const previewWishlist = ref<HumanizedBook[]>([]);
const previewLoans = ref<HumanizedBook[]>([]);
const counts = ref({ owned: 0, wishlist: 0, loans: 0 });

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

const loadDashboardData = async () => {
  try {
    const [statsRes, cachedBooks, loans] = await Promise.all([
      statsService.getDashboardStats(30),
      databaseService.getAllBooksFromCache().catch(() => [] as HumanizedBook[]),
      databaseService.getAllLoans().catch(() => [])
    ]);
    counts.value = {
      owned: statsRes.totalOwned,
      wishlist: statsRes.totalWishlist,
      loans: statsRes.totalLoans
    };

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

    <!-- Accès rapides sobres : Ma Collection, Ma Wishlist, Mes Prêts -->
    <div class="home-spaces-grid">
      <div class="home-space-card">
        <button type="button" class="home-space-link" @click="router.push({ name: 'CollectionView', query: { mode: 'books' } })">
          <span>MA COLLECTION</span>
          <span class="home-space-count">{{ counts.owned }}</span>
        </button>
        <div v-if="previewCollection.length" class="home-covers-strip">
          <img
            v-for="book in previewCollection"
            :key="book.uri"
            :src="imageUtil.resolveCoverUrl(book)"
            :alt="book.title"
            :title="book.title"
            class="home-preview-cover"
            @error="imageUtil.handleImageError($event, { isbn: book.isbn13 || book.isbn10, fallbackUrls: book.coverFallbackUrls })"
            @click="openBook(book.uri)"
          />
        </div>
      </div>

      <div class="home-space-card">
        <button type="button" class="home-space-link" @click="router.push({ name: 'WishlistView' })">
          <span>MA WISHLIST</span>
          <span class="home-space-count">{{ counts.wishlist }}</span>
        </button>
        <div v-if="previewWishlist.length" class="home-covers-strip">
          <img
            v-for="book in previewWishlist"
            :key="book.uri"
            :src="imageUtil.resolveCoverUrl(book)"
            :alt="book.title"
            :title="book.title"
            class="home-preview-cover"
            @error="imageUtil.handleImageError($event, { isbn: book.isbn13 || book.isbn10, fallbackUrls: book.coverFallbackUrls })"
            @click="openBook(book.uri)"
          />
        </div>
      </div>

      <div class="home-space-card">
        <button type="button" class="home-space-link" @click="router.push({ name: 'LoansView' })">
          <span>MES PRÊTS</span>
          <span class="home-space-count">{{ counts.loans }}</span>
        </button>
        <div v-if="previewLoans.length" class="home-covers-strip">
          <img
            v-for="book in previewLoans"
            :key="book.uri"
            :src="imageUtil.resolveCoverUrl(book)"
            :alt="book.title"
            :title="book.title"
            class="home-preview-cover"
            @error="imageUtil.handleImageError($event, { isbn: book.isbn13 || book.isbn10, fallbackUrls: book.coverFallbackUrls })"
            @click="openBook(book.uri)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home-spaces-grid {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin: 1rem 0;
}

.home-space-card {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-md, 12px);
  background: var(--color-bg-main, #fff);
  box-shadow: var(--shadow-sm);
  padding: 0.8rem 0.95rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.home-space-link {
  background: none;
  border: none;
  padding: 0;
  inline-size: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-family: var(--font-main);
  font-size: 0.875rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--color-text-main, #0f172a);
  cursor: pointer;
  text-align: left;
}

.home-space-count {
  font-size: 0.8125rem;
  font-weight: 700;
  padding: 0.15rem 0.6rem;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 9999px;
  background: var(--color-primary-light, #eef2ff);
  color: var(--color-primary, #4f46e5);
}

.home-covers-strip {
  display: flex;
  gap: 0.5rem;
  overflow-x: auto;
  padding-top: 2px;
}

.home-preview-cover {
  width: 46px;
  height: 66px;
  object-fit: cover;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 6px;
  cursor: pointer;
  flex-shrink: 0;
  background: #f1f5f9;
}
</style>
