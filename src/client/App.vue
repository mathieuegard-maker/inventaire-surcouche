<!-- src/client/App.vue -->
<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';
import AppHeader from './components/base/AppHeader.vue';
import ToastHost from './components/base/ToastHost.vue';
import PwaReloadPrompt from './components/base/PwaReloadPrompt.vue';
import { useAuthStore } from './stores/auth.store';
import { useUiStore } from './stores/ui.store';
import { useJobsStore } from './stores/jobs.store';
import { useLibraryStore } from './stores/library.store';
import { t } from '../shared/locales';

const authStore = useAuthStore();
const uiStore = useUiStore();
const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();

watch(
  () => authStore.isAuthenticated,
  async (loggedIn) => {
    if (loggedIn) {
      await libraryStore.hydrateFromLocalCache();
      void libraryStore.syncNow();
      jobsStore.connectStream();
    } else {
      jobsStore.disconnectStream();
    }
  },
  { immediate: true }
);

// Reprise automatique PUSH -> PULL dès le retour du réseau
watch(
  () => uiStore.isOffline,
  async (offline, wasOffline) => {
    if (wasOffline && !offline && authStore.isAuthenticated) {
      uiStore.pushToast(t('app.onlineRestored'), 'info', 2500);
      await libraryStore.syncNow();
    }
  }
);

onBeforeUnmount(() => {
  jobsStore.disconnectStream();
});
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
