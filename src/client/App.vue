<!-- src/client/App.vue -->
<script setup lang="ts">
import AppHeader from './components/base/AppHeader.vue';
import ToastHost from './components/base/ToastHost.vue';
import PwaReloadPrompt from './components/base/PwaReloadPrompt.vue';
import { useAuthStore } from './stores/auth.store';
import { useUiStore } from './stores/ui.store';
import { t } from '../shared/locales';

const authStore = useAuthStore();
const uiStore = useUiStore();
</script>

<template>
  <div class="app-shell">
    <AppHeader v-if="authStore.isAuthenticated" />

    <div v-if="uiStore.isOffline" class="app-offline-bar" role="status">
      {{ t('app.offlineBanner') }}
    </div>

    <main class="app-main">
      <router-view />
    </main>

    <ToastHost />
    <PwaReloadPrompt />
  </div>
</template>

<style scoped>
.app-offline-bar {
  background: var(--warning-bg);
  color: var(--warning-text);
  text-align: center;
  padding: var(--space-2) var(--space-4);
  font-size: 0.875rem;
  font-weight: 600;
  border-bottom: 1px solid var(--border-subtle);
}
</style>
