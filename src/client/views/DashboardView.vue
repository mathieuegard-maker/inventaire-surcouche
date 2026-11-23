<!-- src/client/views/DashboardView.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.store';
import { useLibraryStore } from '../stores/library.store';
import { useUiStore } from '../stores/ui.store';
import { t } from '../../shared/locales';

const router = useRouter();
const authStore = useAuthStore();
const libraryStore = useLibraryStore();
const uiStore = useUiStore();

const username = computed(() => authStore.profile?.user.username ?? '');
const libraryName = computed(() => authStore.profile?.library.name ?? '');
const memberCount = computed(() => authStore.profile?.library.members.length ?? 1);
const aiRemaining = computed(() => authStore.profile?.aiQuota.remaining ?? 0);
const aiLimit = computed(() => authStore.profile?.aiQuota.limit ?? 30);

const spaceCards = computed(() => [
  { to: '/collection', title: t('dashboard.myCollection'), icon: '▤', count: libraryStore.ownedBooks.length },
  { to: '/wishlist', title: t('dashboard.myWishlist'), icon: '★', count: libraryStore.wishedBooks.length },
  { to: '/loans', title: t('dashboard.myLoans'), icon: '⇄', count: libraryStore.lentBooks.length },
  {
    to: '/releases',
    title: t('dashboard.myReleases'),
    icon: '✦',
    count: authStore.profile?.unreadAlertsCount ?? 0
  }
]);

async function handleSync(): Promise<void> {
  await libraryStore.syncNow();
}

function openBook(bookId: string): void {
  void router.push(`/book/${encodeURIComponent(bookId)}`);
}
</script>

<template>
  <section class="ds-stack">
    <div class="ds-card ds-stack">
      <div class="ds-row ds-row--between">
        <div>
          <h1>{{ t('dashboard.welcome', { name: username }) }}</h1>
          <p class="ds-text-muted">
            {{ t('dashboard.librarySummary', { library: libraryName, count: memberCount }) }}
          </p>
        </div>

        <div class="ds-row">
          <span class="ds-badge ds-badge--accent">
            {{ t('dashboard.aiQuotaSummary', { remaining: aiRemaining, limit: aiLimit }) }}
          </span>
          <button
            type="button"
            class="ds-btn ds-btn--sm"
            :disabled="libraryStore.isSyncing || uiStore.isOffline"
            @click="handleSync"
          >
            {{ libraryStore.isSyncing ? t('dashboard.syncingLabel') : t('dashboard.syncNowBtn') }}
          </button>
        </div>
      </div>

      <div v-if="libraryStore.outboxCount > 0" class="ds-banner ds-banner--warning">
        {{ t('dashboard.outboxPending', { count: libraryStore.outboxCount }) }}
      </div>
    </div>

    <div class="ds-grid-2">
      <router-link v-for="card in spaceCards" :key="card.to" :to="card.to" class="ds-card dashboard-card">
        <span class="dashboard-card__icon" aria-hidden="true">{{ card.icon }}</span>
        <div class="dashboard-card__meta">
          <span class="dashboard-card__title">{{ card.title }}</span>
          <strong class="dashboard-card__count">{{ card.count }}</strong>
        </div>
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

      <div class="ds-stack">
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
              ✕
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 5 vignettes récentes -->
    <div v-if="libraryStore.recentOwnedBooks.length > 0" class="ds-card ds-stack">
      <h2>{{ t('dashboard.recentAddedTitle') }}</h2>
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

    <div class="ds-row dashboard-footer">
      <router-link to="/debug" class="ds-text-muted">
        {{ t('dashboard.debugCacheLink') }}
      </router-link>
    </div>
  </section>
</template>

<style scoped>
.dashboard-card {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  color: var(--text-primary);
  text-decoration: none;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.dashboard-card:hover {
  border-color: var(--accent);
  background: var(--bg-elevated);
  text-decoration: none;
}

.dashboard-card__icon {
  font-size: 1.6rem;
  color: var(--accent);
}

.dashboard-card__meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dashboard-card__title {
  font-weight: 600;
  color: var(--text-secondary);
  font-size: 0.92rem;
}

.dashboard-card__count {
  font-size: 1.5rem;
  color: var(--text-primary);
}

.recent-strip {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
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
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dashboard-footer {
  justify-content: flex-end;
}
</style>
