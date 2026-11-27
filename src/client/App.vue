<!-- src/client/App.vue -->
<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';
import AppHeader from './components/base/AppHeader.vue';
import ActivityBanner from './components/base/ActivityBanner.vue';
import PwaReloadPrompt from './components/base/PwaReloadPrompt.vue';
import NotificationOnboardingModal from './components/modals/NotificationOnboardingModal.vue';
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
    <ActivityBanner />

    <main class="app-main">
      <router-view />
    </main>

    <PwaReloadPrompt />
    <NotificationOnboardingModal
      :open="Boolean(authStore.isAuthenticated && authStore.profile && !authStore.profile.user.onboardingNotifSeen)"
    />
  </div>
</template>
