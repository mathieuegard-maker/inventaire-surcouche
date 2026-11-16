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
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import { scannerState } from '../../state/scanner';
import { connectionState } from '../../state/connection';
import { pendingScansStore } from '../../state/pendingScans';
import { seriesReleaseService, type SeriesReleaseAlert } from '../../core/services/series-release.service';
import { saveBookNavigationOrder } from '../../state/bookNavigation';
import type { HumanizedBook } from '../../core/types';

const router = useRouter();

const searchQuery = ref('');
const errorMessage = ref<string | null>(null);
const offlineNoticeMessage = ref<string | null>(null);
const pendingScans = pendingScansStore.pendingScans;
const releaseAlerts = seriesReleaseService.alerts;
const isCheckingReleases = seriesReleaseService.isChecking;
const isOffline = connectionState.isOffline;
const addingAlertId = ref<string | null>(null);

const previewCollection = ref<HumanizedBook[]>([]);
const previewWishlist = ref<HumanizedBook[]>([]);
const previewLoans = ref<HumanizedBook[]>([]);
const counts = ref({ owned: 0, wishlist: 0, loans: 0 });

const handleSearch = async (isbn: string) => {
  if (!isbn) return;
  errorMessage.value = null;
  offlineNoticeMessage.value = null;
  try {
    const cleanedIsbn = isbnUtil.normalize(isbn);
    const response = await searchService.searchByIsbn(cleanedIsbn);
    if ((response as any)?.isOfflineUnavailable || (!response && isOffline.value)) {
      pendingScansStore.addPendingScan(cleanedIsbn);
      offlineNoticeMessage.value = `Pas de réseau actuellement : ce livre n'est pas encore dans votre base locale. Le code-barres (${cleanedIsbn}) a été mémorisé ci-dessous pour pouvoir consulter sa fiche dès le retour du réseau.`;
      return;
    }
    if (response) {
      if ('isUnknown' in response && (response as any).isUnknown) {
        router.push({ name: 'BookCreateUnknown', query: { isbn: (response as any).isbn } });
      } else if (response.mainBook?.uri) {
        saveBookNavigationOrder([response.mainBook.uri], 'direct');
        router.push(`/book/${encodeURIComponent(response.mainBook.uri)}`);
      }
    } else {
      errorMessage.value = TEXTS.scanner.notFound;
    }
  } catch {
    errorMessage.value = TEXTS.scanner.errorGeneral;
  }
};

const openPendingScan = (isbn: string) => {
  if (isOffline.value) {
    offlineNoticeMessage.value = 'Toujours sans réseau : réessayez dès que la connexion Internet revient.';
    return;
  }
  saveBookNavigationOrder([isbn, `isbn:${isbn}`], 'direct');
  router.push(`/book/${encodeURIComponent(isbn)}`);
};

const openReleaseAlert = (alert: SeriesReleaseAlert) => {
  if (alert.id.startsWith('demo:') && alert.seriesUri === 'demo:series') {
    router.push(`/book/${encodeURIComponent(alert.isbn13 || alert.volumeUri)}`);
    return;
  }
  const target = alert.isbn13 || alert.volumeUri;
  saveBookNavigationOrder([target], 'direct');
  router.push(`/book/${encodeURIComponent(target)}`);
};

const addReleaseToWishlist = async (alert: SeriesReleaseAlert) => {
  if (alert.id.startsWith('demo:')) {
    offlineNoticeMessage.value = `Simulation : « ${alert.seriesTitle} — Tome ${alert.seriesNumber || '?'} » serait ajouté à votre Wishlist en un clic.`;
    await seriesReleaseService.dismissAlert(alert.id);
    return;
  }
  addingAlertId.value = alert.id;
  try {
    let targetUri = alert.volumeUri;
    if (alert.isbn13) {
      const resolved = await searchService.searchByIsbn(alert.isbn13);
      if (resolved && !('isUnknown' in resolved) && resolved.mainBook?.uri) {
        targetUri = resolved.mainBook.uri;
      }
    }
    await queueService.enqueueAction('ADD_WISHLIST', targetUri);
    await seriesReleaseService.dismissAlert(alert.id);
    await loadDashboardData();
  } catch {
    errorMessage.value = "Impossible d'ajouter ce tome à la wishlist pour le moment.";
  } finally {
    addingAlertId.value = null;
  }
};

const triggerDemoRelease = async () => {
  const cached = await databaseService.getAllBooksFromCache().catch(() => [] as HumanizedBook[]);
  const ownedSeriesBook = cached.find((b) => b.ownershipStatus === 'owned' && b.series);
  let nextNum = '41';
  if (ownedSeriesBook?.series) {
    const sameSeries = cached.filter(
      (b) => b.series?.toLowerCase() === ownedSeriesBook.series?.toLowerCase()
    );
    const maxNum = sameSeries.reduce((max, b) => {
      const n = parseInt(b.seriesNumber || '0', 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);
    if (maxNum > 0) nextNum = String(maxNum + 1);
  }
  seriesReleaseService.simulateDemoAlert(
    ownedSeriesBook
      ? {
          seriesUri: ownedSeriesBook.seriesId || ownedSeriesBook.series,
          seriesTitle: ownedSeriesBook.series,
          seriesNumber: nextNum,
          coverUrl: ownedSeriesBook.coverUrl
        }
      : undefined
  );
};

const formatScanTime = (ts: number) =>
  new Date(ts).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });

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

    <SmartSearchBar
      v-model="searchQuery"
      @isbn-detected="handleSearch"
      @keywords-detected="handleKeywordsSearch"
    />

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
        <div class="home-space-header-row">
          <span class="home-space-link home-space-title-static">MES NOUVEAUTÉS</span>
          <div class="news-header-right">
            <button
              v-if="releaseAlerts.length > 1"
              type="button"
              class="pending-clear-btn"
              @click="seriesReleaseService.dismissAlert()"
            >
              Tout masquer
            </button>
            <span class="home-space-count">{{ releaseAlerts.length }}</span>
          </div>
        </div>

        <div v-if="releaseAlerts.length > 0" class="release-alerts-list">
          <div v-for="alert in releaseAlerts" :key="alert.id" class="release-alert-row">
            <img
              v-if="alert.coverUrl || alert.isbn13"
              :src="imageUtil.resolveCoverUrl({ coverUrl: alert.coverUrl, isbn13: alert.isbn13 } as any)"
              :alt="alert.volumeTitle"
              class="release-alert-cover"
            />
            <div class="release-alert-info">
              <span class="release-alert-series">
                {{ alert.seriesTitle }}<template v-if="alert.seriesNumber"> — Tome {{ alert.seriesNumber }}</template>
              </span>
              <span class="release-alert-title">{{ alert.volumeTitle }}</span>
            </div>
            <div class="pending-scan-actions">
              <button
                type="button"
                class="release-wish-btn"
                :disabled="addingAlertId === alert.id || isOffline"
                @click="addReleaseToWishlist(alert)"
              >
                {{ addingAlertId === alert.id ? 'Ajout...' : '+ Wishlist' }}
              </button>
              <button type="button" class="pending-open-btn" @click="openReleaseAlert(alert)">
                Voir
              </button>
              <button
                type="button"
                class="pending-remove-btn"
                aria-label="Masquer"
                @click="seriesReleaseService.dismissAlert(alert.id)"
              >
                ✕
              </button>
            </div>
          </div>
        </div>

        <div v-else class="news-empty-row">
          <span class="news-empty-text">
            Aucune nouvelle sortie détectée récemment dans vos séries commencées.
          </span>
          <div class="news-empty-actions">
            <button
              type="button"
              class="news-action-btn"
              :disabled="isCheckingReleases || isOffline"
              @click="seriesReleaseService.checkNewReleasesOnOpen(true)"
            >
              {{ isCheckingReleases ? 'Vérification...' : 'Vérifier maintenant' }}
            </button>
            <button
              type="button"
              class="news-action-btn"
              @click="triggerDemoRelease"
            >
              Simuler une sortie
            </button>
          </div>
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
