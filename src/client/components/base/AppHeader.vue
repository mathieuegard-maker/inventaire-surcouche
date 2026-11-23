<!-- src/client/components/base/AppHeader.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '../../stores/auth.store';
import { t } from '../../../shared/locales';

const route = useRoute();
const authStore = useAuthStore();

const unreadAlerts = computed(() => authStore.profile?.unreadAlertsCount ?? 0);

const desktopLinks = computed(() => [
  { to: '/dashboard', label: t('nav.dashboard') },
  { to: '/collection', label: t('nav.collection') },
  { to: '/wishlist', label: t('nav.wishlist') },
  { to: '/loans', label: t('nav.loans') },
  { to: '/releases', label: t('nav.releases'), badge: unreadAlerts.value > 0 ? unreadAlerts.value : 0 },
  { to: '/social', label: t('nav.social') },
  { to: '/scan', label: t('nav.scan') },
  { to: '/profile', label: t('nav.profile') }
]);

const mobileTabs = computed(() => [
  { to: '/dashboard', label: t('nav.dashboard'), icon: '⌂' },
  { to: '/collection', label: t('nav.collection'), icon: '▤' },
  { to: '/scan', label: t('nav.scanShort'), icon: '⌕' },
  { to: '/social', label: t('nav.socialShort'), icon: '⇄' },
  { to: '/profile', label: t('nav.profileShort'), icon: '◉' }
]);

function isLinkActive(to: string): boolean {
  return route.path === to || route.path.startsWith(`${to}/`);
}
</script>

<template>
  <header class="app-header">
    <router-link to="/dashboard" class="app-header__brand">
      {{ t('app.title') }}
    </router-link>

    <nav class="app-header__nav" :aria-label="t('nav.menuOpen')">
      <router-link
        v-for="item in desktopLinks"
        :key="item.to"
        :to="item.to"
        class="app-header__link"
        :class="{ 'app-header__link--active': isLinkActive(item.to) }"
      >
        <span>{{ item.label }}</span>
        <span v-if="item.badge" class="app-header__badge">{{ item.badge }}</span>
      </router-link>
    </nav>
  </header>

  <nav class="app-tabbar" :aria-label="t('nav.menuOpen')">
    <router-link
      v-for="tab in mobileTabs"
      :key="tab.to"
      :to="tab.to"
      class="app-tabbar__item"
      :class="{ 'app-tabbar__item--active': isLinkActive(tab.to) }"
    >
      <span class="app-tabbar__icon" aria-hidden="true">{{ tab.icon }}</span>
      <span>{{ tab.label }}</span>
    </router-link>
  </nav>
</template>

<style scoped>
.app-header__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 var(--space-1);
  margin-left: var(--space-1);
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: 0.72rem;
  font-weight: 700;
}

.app-tabbar__icon {
  font-size: 1.1rem;
  line-height: 1;
}
</style>
