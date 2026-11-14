<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { connectionService } from './core/orchestrators/connection.orchestrator';
import { queueService } from './core/orchestrators/queue.orchestrator';
import { backgroundCreationOrchestrator } from './core/orchestrators/background-creation.orchestrator';
import { TEXTS } from './ui/locales/fr';
import PwaReloadPrompt from './ui/components/PwaReloadPrompt.vue';
import ScannerOverlayModal from './ui/components/ScannerOverlayModal.vue';
import { connectionState } from './state/connection';
import { scannerState } from './state/scanner';

const isOffline = computed(() => connectionState.isOffline.value);
const bgStatus = backgroundCreationOrchestrator.status;
const isInitializing = ref(true);
const router = useRouter();
const route = useRoute();

// Surveillance réactive du retour réseau
watch(isOffline, async (newOfflineVal) => {
  if (!newOfflineVal && !route.path.startsWith('/shared/')) {
    const hasValidSession = await connectionService.checkSessionOnReconnection();
    if (!hasValidSession) {
      router.push('/login');
    } else {
      queueService.processQueue();
      backgroundCreationOrchestrator.resumePendingJobs();
      if (route.path === '/login') {
        router.push('/dashboard');
      }
    }
  }
});

// Arrêt automatique du scanner lors d'un changement de page
watch(
  () => route.path,
  () => {
    if (scannerState.isScanningActive.value) {
      scannerState.stopScan();
    }
  }
);

onMounted(async () => {
  try {
    if (window.location.pathname.startsWith('/shared/')) {
      isInitializing.value = false;
      return;
    }

    const isConnected = await connectionService.initializeApp();

    if (isConnected) {
      backgroundCreationOrchestrator.resumePendingJobs();
      if (route.path === '/login' || route.path === '/') {
        router.push('/dashboard');
      }
    } else {
      router.push({ path: '/login', query: route.query });
    }
  } catch (error) {
    console.error("[VUE] Erreur lors de l'initialisation :", error);
    router.push('/login');
  } finally {
    isInitializing.value = false;
  }
});
</script>

<template>
  <div v-if="isInitializing" class="splash-screen">
    <h1 class="app-title">{{ TEXTS.app.name }}</h1>
    <p>{{ TEXTS.status.initializing }}</p>
  </div>

  <div v-else class="app-main-layout">
    <div v-if="isOffline" class="offline-global-banner">
      ⚠️ {{ TEXTS.app?.offlineGlobalBanner || 'MODE HORS-LIGNE ACTIF (SYNCHRO DIFFÉRÉE)' }}
    </div>

    <div
      v-if="bgStatus.isActive || bgStatus.lastError"
      style="margin: 8px 16px 0; padding: 10px 14px; border-radius: 8px; font-size: 13px; display: flex; align-items: center; justify-content: space-between; gap: 12px;"
      :style="
        bgStatus.lastError && !bgStatus.isActive
          ? 'background:#fef2f2;color:#991b1b;border:1px solid #fecaca;'
          : 'background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe;'
      "
    >
      <span>
        <template v-if="bgStatus.isActive">
          ⏳ {{ bgStatus.stepLabel || 'Enrichissement en cours...' }}
          <strong v-if="bgStatus.pendingCount > 1">({{ bgStatus.pendingCount }} en file)</strong>
        </template>
        <template v-else-if="bgStatus.lastError">
          ⚠️ {{ bgStatus.lastError }}
        </template>
      </span>
      <button
        v-if="!bgStatus.isActive && bgStatus.lastError"
        @click="bgStatus.lastError = null"
        style="background:none;border:none;cursor:pointer;font-weight:bold;color:inherit;"
        aria-label="Fermer"
      >
        ✕
      </button>
    </div>

    <!-- Scanner 3 Modes (Vérif Magasin <1s, Mode Rafale continu, Photo Couverture/Étagère BYOK) -->
    <ScannerOverlayModal />

    <router-view></router-view>
  </div>

  <PwaReloadPrompt />
</template>
