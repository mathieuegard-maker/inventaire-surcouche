<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { databaseService } from '../../core/database/database.service';
import { syncOrchestrator } from '../../core/orchestrators/sync.orchestrator';
import { imageUtil } from '../../core/utils/image.util';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import { TEXTS } from '../locales/fr';
import { statsService } from '../../core/services/stats.service';
import { scannerState } from '../../state/scanner';
import { connectionState } from '../../state/connection';
import { pendingScansStore } from '../../state/pendingScans';
import { seriesReleaseService } from '../../core/services/series-release.service';
import { saveBookNavigationOrder } from '../../state/bookNavigation';
import type { HumanizedBook } from '../../core/types';

const router = useRouter();

const errorMessage = ref<string | null>(null);
const offlineNoticeMessage = ref<string | null>(null);
const pendingScans = pendingScansStore.pendingScans;
const releaseAlerts = seriesReleaseService.alerts;
const isOffline = connectionState.isOffline;

const previewCollection = ref<HumanizedBook[]>([]);
const previewWishlist = ref<HumanizedBook[]>([]);
const previewLoans = ref<HumanizedBook[]>([]);
const counts = ref({ owned: 0, wishlist: 0, loans: 0 });

const openPendingScan = (isbn: string) => {
  if (isOffline.value) {
    offlineNoticeMessage.value = 'Toujours sans réseau : réessayez dès que la connexion Internet revient.';
    return;
  }
  saveBookNavigationOrder([isbn, `isbn:${isbn}`], 'direct');
  router.push(`/book/${encodeURIComponent(isbn)}`);
};

const formatScanTime = (ts: number) =>
  new Date(ts).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });

let hasRequestedBackgroundHydration = false;

const loadDashboardData = async () => {
  try {
    const [statsRes, cachedBooks, loans, invRegistry, wishRegistry] = await Promise.all([
      statsService.getDashboardStats(30),
      databaseService.getAllBooksFromCache().catch(() => [] as HumanizedBook[]),
      databaseService.getAllLoans().catch(() => []),
      databaseService.getAllRegistryUris('inventory').catch(() => [] as string[]),
      databaseService.getAllRegistryUris('wishlist').catch(() => [] as string[])
    ]);

    const cachedOwnedCount = cachedBooks.filter((b) => b.ownershipStatus === 'owned').length;
    const cachedWishCount = cachedBooks.filter((b) => b.ownershipStatus === 'wish').length;
    if (
      !hasRequestedBackgroundHydration &&
      !isOffline.value &&
      (invRegistry.length > cachedOwnedCount || wishRegistry.length > cachedWishCount)
    ) {
      hasRequestedBackgroundHydration = true;
      syncOrchestrator.hydrateCacheInBackground().catch(() => {});
    }

    counts.value = {
      owned: statsRes.totalOwned,
      wishlist: statsRes.totalWishlist,
      loans: statsRes.totalLoans
    };

    const byRecent = (list: HumanizedBook[]) =>
      [...list]
        .filter((b) => Boolean(b.localCover || b.coverUrl))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.title.localeCompare(b.title))
        .slice(0, 5);

    const sameUriList = (a: HumanizedBook[], b: HumanizedBook[]) =>
      a.length === b.length && a.every((item, idx) => item.uri === b[idx]?.uri);

    const nextCollection = byRecent(cachedBooks.filter((b) => b.ownershipStatus === 'owned'));
    const nextWishlist = byRecent(cachedBooks.filter((b) => b.ownershipStatus === 'wish'));
    const loanUris = new Set(loans.map((l) => l.uri));
    const nextLoans = byRecent(cachedBooks.filter((b) => loanUris.has(b.uri)));

    if (!sameUriList(previewCollection.value, nextCollection)) {
      previewCollection.value = nextCollection;
    }
    if (!sameUriList(previewWishlist.value, nextWishlist)) {
      previewWishlist.value = nextWishlist;
    }
    if (!sameUriList(previewLoans.value, nextLoans)) {
      previewLoans.value = nextLoans;
    }
  } catch (e) {
    console.error('Erreur chargement tableau de bord :', e);
  }
};

const openBook = (uri: string) => {
  saveBookNavigationOrder([uri], 'direct');
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

    <div v-if="offlineNoticeMessage" class="offline-info-banner">
      {{ offlineNoticeMessage }}
    </div>

    <div v-if="errorMessage" class="error-banner">
      {{ errorMessage }}
    </div>

    <!-- Scans mémorisés hors réseau en attente de connexion -->
    <div v-if="pendingScans.length > 0" class="pending-scans-card">
      <div class="pending-scans-header">
        <strong>Scans hors-ligne mémorisés ({{ pendingScans.length }})</strong>
        <button type="button" class="pending-clear-btn" @click="pendingScansStore.clearAll()">
          Tout effacer
        </button>
      </div>
      <p class="pending-scans-hint">
        {{
          isOffline
            ? 'Pas de réseau actuellement : ces codes-barres restent gardés en mémoire pour consultation ultérieure.'
            : 'Connexion rétablie : vous pouvez maintenant ouvrir et consulter la fiche de ces livres.'
        }}
      </p>
      <div class="pending-scans-list">
        <div v-for="scan in pendingScans" :key="scan.isbn" class="pending-scan-row">
          <div class="pending-scan-meta">
            <code class="pending-isbn">{{ scan.isbn }}</code>
            <span class="pending-date">{{ formatScanTime(scan.scannedAt) }}</span>
          </div>
          <div class="pending-scan-actions">
            <button
              type="button"
              class="pending-open-btn"
              :disabled="isOffline"
              @click="openPendingScan(scan.isbn)"
            >
              {{ isOffline ? 'En attente de réseau' : 'Consulter la fiche' }}
            </button>
            <button
              type="button"
              class="pending-remove-btn"
              aria-label="Retirer"
              @click="pendingScansStore.removePendingScan(scan.isbn)"
            >
              ✕
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Accès rapides sobres : Ma Collection, Ma Wishlist, Mes Prêts, Mes Nouveautés -->
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

      <div class="home-space-card">
        <button type="button" class="home-space-link" @click="router.push({ name: 'ReleasesView' })">
          <span>MES NOUVEAUTÉS</span>
          <span class="home-space-count">{{ releaseAlerts.length }}</span>
        </button>
        <div v-if="releaseAlerts.length" class="home-covers-strip">
          <img
            v-for="alert in releaseAlerts.slice(0, 5)"
            :key="alert.id"
            :src="imageUtil.resolveCoverUrl({ coverUrl: alert.coverUrl, isbn13: alert.isbn13 } as any)"
            :alt="alert.volumeTitle"
            :title="`${alert.seriesTitle}${alert.seriesNumber ? ' T.' + alert.seriesNumber : ''}`"
            class="home-preview-cover"
            @error="imageUtil.handleImageError($event, { isbn: alert.isbn13 })"
            @click="router.push({ name: 'ReleasesView' })"
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

.offline-info-banner {
  margin-top: 0.75rem;
  padding: 0.75rem 1rem;
  border-radius: var(--radius-md, 10px);
  border: 1px solid #fcd34d;
  background: #fefce8;
  color: #854d0e;
  font-size: 0.875rem;
  line-height: 1.45;
  font-weight: 500;
}

.pending-scans-card {
  margin-top: 0.85rem;
  padding: 0.9rem 1rem;
  border: 1px solid #c7d2fe;
  border-radius: var(--radius-md, 12px);
  background: #eef2ff;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.pending-scans-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.88rem;
  color: #312e81;
}

.pending-clear-btn {
  border: none;
  background: transparent;
  color: #4f46e5;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  padding: 0.2rem 0.4rem;
}

.pending-scans-hint {
  margin: 0;
  font-size: 0.8rem;
  color: #3730a3;
  line-height: 1.4;
}

.pending-scans-list {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.pending-scan-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  background: #ffffff;
  border: 1px solid #c7d2fe;
  border-radius: var(--radius-sm, 8px);
  padding: 0.45rem 0.65rem;
}

.pending-scan-meta {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  flex-wrap: wrap;
}

.pending-isbn {
  font-weight: 700;
  font-size: 0.84rem;
  color: #0f172a;
}

.pending-date {
  font-size: 0.75rem;
  color: var(--color-text-muted, #64748b);
}

.pending-scan-actions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.pending-open-btn {
  border: 1px solid var(--color-primary, #4f46e5);
  background: var(--color-primary, #4f46e5);
  color: #ffffff;
  border-radius: var(--radius-sm, 8px);
  padding: 0.35rem 0.75rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}

.pending-open-btn:disabled {
  background: #cbd5e1;
  border-color: #cbd5e1;
  color: #475569;
  cursor: not-allowed;
}

.pending-remove-btn {
  border: 1px solid var(--color-border, #e2e8f0);
  background: var(--color-bg-alt, #f8fafc);
  color: var(--color-text-muted, #64748b);
  border-radius: var(--radius-sm, 8px);
  width: 30px;
  height: 30px;
  font-weight: 700;
  cursor: pointer;
}

.release-alerts-card {
  margin-top: 0.85rem;
  padding: 0.9rem 1rem;
  border: 1px solid #a7f3d0;
  border-radius: var(--radius-md, 12px);
  background: #ecfdf5;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.release-alerts-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.88rem;
  color: #065f46;
}

.release-alerts-list {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.release-alert-row {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  background: #ffffff;
  border: 1px solid #a7f3d0;
  border-radius: var(--radius-sm, 8px);
  padding: 0.45rem 0.65rem;
}

.release-alert-cover {
  width: 34px;
  height: 48px;
  object-fit: cover;
  border-radius: 4px;
  border: 1px solid var(--color-border, #e2e8f0);
  flex-shrink: 0;
}

.release-alert-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.release-alert-series {
  font-size: 0.78rem;
  font-weight: 700;
  color: #065f46;
}

.release-alert-title {
  font-size: 0.82rem;
  color: #0f172a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.home-space-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
}

.home-space-title-static {
  cursor: default;
  width: auto;
}

.news-header-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.release-wish-btn {
  border: 1px solid #059669;
  background: #ecfdf5;
  color: #065f46;
  border-radius: var(--radius-sm, 8px);
  padding: 0.35rem 0.65rem;
  font-size: 0.78rem;
  font-weight: 700;
  cursor: pointer;
}

.release-wish-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.news-empty-row {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.news-empty-text {
  font-size: 0.82rem;
  color: var(--color-text-muted, #64748b);
  line-height: 1.4;
}

.news-empty-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.news-action-btn {
  border: 1px solid var(--color-border, #e2e8f0);
  background: var(--color-bg-alt, #f8fafc);
  color: var(--color-text-main, #0f172a);
  border-radius: var(--radius-sm, 8px);
  padding: 0.35rem 0.75rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}

.news-action-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
