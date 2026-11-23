<!-- src/client/views/DashboardView.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import { useAuthStore } from '../stores/auth.store';
import { t } from '../../shared/locales';

const authStore = useAuthStore();

const username = computed(() => authStore.profile?.user.username ?? '');
const libraryName = computed(() => authStore.profile?.library.name ?? '');
const memberCount = computed(() => authStore.profile?.library.members.length ?? 1);
const aiRemaining = computed(() => authStore.profile?.aiQuota.remaining ?? 0);
const aiLimit = computed(() => authStore.profile?.aiQuota.limit ?? 50);

const spaceCards = computed(() => [
  { to: '/collection', title: t('dashboard.myCollection'), icon: '▤' },
  { to: '/wishlist', title: t('dashboard.myWishlist'), icon: '★' },
  { to: '/loans', title: t('dashboard.myLoans'), icon: '⇄' },
  { to: '/releases', title: t('dashboard.myReleases'), icon: '✦' }
]);
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
        <span class="ds-badge ds-badge--accent">
          {{ t('dashboard.aiQuotaSummary', { remaining: aiRemaining, limit: aiLimit }) }}
        </span>
      </div>
      <p class="ds-text-muted">{{ t('dashboard.v2ReadyHint') }}</p>
    </div>

    <div class="ds-grid-2">
      <router-link v-for="card in spaceCards" :key="card.to" :to="card.to" class="ds-card dashboard-card">
        <span class="dashboard-card__icon" aria-hidden="true">{{ card.icon }}</span>
        <span class="dashboard-card__title">{{ card.title }}</span>
      </router-link>
    </div>
  </section>
</template>

<style scoped>
.dashboard-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
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
  font-size: 1.4rem;
  color: var(--accent);
}

.dashboard-card__title {
  font-weight: 700;
  font-size: 1.05rem;
}
</style>
