<!-- src/client/components/base/AppHeader.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { BookOpen, Home, Library, Search, User, Users } from '@lucide/vue';
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
  { to: '/dashboard', label: t('nav.dashboard'), icon: Home },
  { to: '/collection', label: t('nav.collection'), icon: Library },
  { to: '/scan', label: t('nav.scanShort'), icon: Search },
  { to: '/social', label: t('nav.socialShort'), icon: Users },
  { to: '/profile', label: t('nav.profileShort'), icon: User }
]);

function isLinkActive(to: string): boolean {
  return route.path === to || route.path.startsWith(`${to}/`);
}
</script>

<template>
  <header class="app-header">
    <router-link to="/dashboard" class="app-header__brand">
      <BookOpen :size="20" :stroke-width="2.1" class="app-header__brand-icon" aria-hidden="true" />
      <span>{{ t('app.title') }}</span>
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
      <component :is="tab.icon" :size="21" :stroke-width="isLinkActive(tab.to) ? 2.2 : 1.8" aria-hidden="true" />
      <span>{{ tab.label }}</span>
    </router-link>
  </nav>
</template>

<style scoped>
.app-header__brand-icon {
  color: var(--accent);
  flex-shrink: 0;
}

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
</style>
