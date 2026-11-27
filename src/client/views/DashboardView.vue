<!-- src/client/views/DashboardView.vue -->
<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeftRight, Library, ScanBarcode, Sparkles, Star, X } from '@lucide/vue';
import { useAuthStore } from '../stores/auth.store';
import { useLibraryStore } from '../stores/library.store';
import { t } from '../../shared/locales';

const QuickCheckModal = defineAsyncComponent(
  () => import('../components/modals/QuickCheckModal.vue')
);

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const libraryStore = useLibraryStore();

const quickCheckOpen = ref(false);

watch(
  () => [route.name, route.query.quickCheck],
  ([name, q]) => {
    if (name === 'quick-check' || q === '1') {
      quickCheckOpen.value = true;
    }
  },
  { immediate: true }
);

function closeQuickCheck(): void {
  quickCheckOpen.value = false;
  if (route.name === 'quick-check' || route.query.quickCheck === '1') {
    void router.replace('/dashboard');
  }
}

const spaceCards = computed(() => [
  { to: '/collection', title: t('dashboard.myCollection'), icon: Library, count: libraryStore.ownedBooks.length },
  { to: '/wishlist', title: t('dashboard.myWishlist'), icon: Star, count: libraryStore.wishedBooks.length },
  { to: '/loans', title: t('dashboard.myLoans'), icon: ArrowLeftRight, count: libraryStore.lentBooks.length },
  {
    to: '/releases',
    title: t('dashboard.myReleases'),
    icon: Sparkles,
    count: authStore.profile?.unreadAlertsCount ?? 0
  }
]);

function openBook(bookId: string): void {
  libraryStore.setNavigationList(libraryStore.recentOwnedBooks.map((b) => b.id));
  void router.push(`/book/${encodeURIComponent(bookId)}`);
}
</script>

<template>
  <section class="ds-stack">
    <div v-if="libraryStore.outboxCount > 0" class="ds-banner ds-banner--warning">
      {{ t('dashboard.outboxPending', { count: libraryStore.outboxCount }) }}
    </div>

    <!-- Raccourci immédiat : vérifier si l'on possède déjà une œuvre en librairie -->
    <button type="button" class="ds-card dashboard-quick-check" @click="quickCheckOpen = true">
      <span class="dashboard-quick-check__icon" aria-hidden="true">
        <ScanBarcode :size="24" :stroke-width="2" />
      </span>
      <span class="dashboard-quick-check__text">
        <strong>{{ t('dashboard.quickCheckBtn') }}</strong>
        <span class="ds-text-muted">{{ t('dashboard.quickCheckSubtitle') }}</span>
      </span>
    </button>

    <!-- 4 tuiles carrées/compactes en grille 2x2 -->
    <div class="dashboard-kpi-grid">
      <router-link v-for="card in spaceCards" :key="card.to" :to="card.to" class="ds-card dashboard-kpi">
        <div class="dashboard-kpi__top">
          <span class="dashboard-kpi__icon-wrap" aria-hidden="true">
            <component :is="card.icon" :size="19" :stroke-width="2" />
          </span>
          <strong class="dashboard-kpi__count">{{ card.count }}</strong>
        </div>
        <span class="dashboard-kpi__title">{{ card.title }}</span>
      </router-link>
    </div>

    <!-- Scans hors-ligne mémorisés -->
    <div v-if="libraryStore.pendingOfflineScans.length > 0" class="ds-card ds-stack">
      <div class="ds-row ds-row--between">
        <h2>{{ t('dashboard.pendingOfflineScans', { count: libraryStore.pendingOfflineScans.length }) }}</h2>
        <button type="button" class="ds-btn ds-btn--ghost ds-btn--sm" @click="libraryStore.clearPendingOfflineScans()">
          {{ t('dashboard.clearAll') }}
        </button>
      </div>

      <div class="ds-stack--sm">
        <div
          v-for="scan in libraryStore.pendingOfflineScans"
          :key="scan.isbn13"
          class="ds-panel ds-row ds-row--between"
        >
          <div>
            <strong>{{ scan.resolvedTitle || scan.isbn13 }}</strong>
            <p class="ds-text-muted">{{ scan.isbn13 }}</p>
          </div>
          <div class="ds-row">
            <button
              v-if="scan.resolvedBookId"
              type="button"
              class="ds-btn ds-btn--primary ds-btn--sm"
              @click="openBook(scan.resolvedBookId)"
            >
              {{ t('dashboard.openSheet') }}
            </button>
            <span v-else class="ds-badge">{{ t('dashboard.waitingNetwork') }}</span>
            <button
              type="button"
              class="ds-btn ds-btn--ghost ds-btn--sm"
              :aria-label="t('app.delete')"
              @click="libraryStore.removePendingOfflineScan(scan.isbn13)"
            >
              <X :size="16" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Mes derniers ajouts -->
    <div v-if="libraryStore.recentOwnedBooks.length > 0" class="ds-card ds-stack">
      <h2 class="recent-heading">{{ t('dashboard.recentAddedTitle') }}</h2>
      <div class="recent-strip">
        <button
          v-for="book in libraryStore.recentOwnedBooks"
          :key="book.id"
          type="button"
          class="recent-tile"
          @click="openBook(book.id)"
        >
          <div class="recent-tile__cover">
            <img v-if="book.coverUrl" :src="book.coverUrl" :alt="book.title" loading="lazy" />
            <span v-else class="recent-tile__placeholder">{{ book.title.slice(0, 2).toUpperCase() }}</span>
          </div>
          <span class="recent-tile__title">{{ book.title }}</span>
        </button>
      </div>
    </div>

    <QuickCheckModal v-if="quickCheckOpen" :open="quickCheckOpen" @close="closeQuickCheck" />
  </section>
</template>

<style scoped>
.dashboard-quick-check {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-3) var(--space-4);
  text-align: left;
  cursor: pointer;
  border-color: var(--accent-border);
  background: var(--bg-surface);
  transition: border-color 0.15s ease, background-color 0.15s ease, transform 0.1s ease;
}

.dashboard-quick-check:hover {
  background: var(--bg-subtle);
  border-color: var(--accent);
}

.dashboard-quick-check:active {
  transform: scale(0.99);
}

.dashboard-quick-check__icon {
  flex: 0 0 44px;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  background: var(--accent);
  color: var(--accent-contrast);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.dashboard-quick-check__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-inline-size: 0;
}

.dashboard-quick-check__text strong {
  font-size: 0.98rem;
  color: var(--text-primary);
}

.dashboard-quick-check__text .ds-text-muted {
  font-size: 0.8rem;
  line-height: 1.3;
}

.dashboard-kpi-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

@media (min-width: 720px) {
  .dashboard-kpi-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.dashboard-kpi {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  color: var(--text-primary);
  text-decoration: none;
  transition: border-color 0.15s ease, background-color 0.15s ease, transform 0.1s ease;
}

.dashboard-kpi:hover {
  border-color: var(--accent-border);
  background: var(--bg-subtle);
  text-decoration: none;
}

.dashboard-kpi:active {
  transform: scale(0.98);
}

.dashboard-kpi__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.dashboard-kpi__icon-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  background: var(--accent-soft);
  color: var(--accent);
}

.dashboard-kpi__count {
  font-size: clamp(1.35rem, 1.15rem + 0.8vw, 1.7rem);
  font-weight: 700;
  line-height: 1.1;
  color: var(--text-primary);
}

.dashboard-kpi__title {
  font-weight: 600;
  color: var(--text-secondary);
  font-size: 0.88rem;
  line-height: 1.25;
}

.recent-heading {
  margin-bottom: 0;
}

.recent-strip {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: var(--space-3);
}

.recent-tile {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: 0;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.recent-tile__cover {
  aspect-ratio: 2 / 3;
  width: 100%;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
  display: flex;
  align-items: center;
  justify-content: center;
}

.recent-tile__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.recent-tile__placeholder {
  font-weight: 700;
  color: var(--text-muted);
}

.recent-tile__title {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
