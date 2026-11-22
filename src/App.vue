<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { connectionService } from './core/orchestrators/connection.orchestrator';
import { queueService } from './core/orchestrators/queue.orchestrator';
import { backgroundCreationOrchestrator } from './core/orchestrators/background-creation.orchestrator';
import { TEXTS } from './ui/locales/fr';
import PwaReloadPrompt from './ui/components/PwaReloadPrompt.vue';
import CameraBarcodeModal from './ui/components/CameraBarcodeModal.vue';
import { connectionState } from './state/connection';
import { scannerState } from './state/scanner';
import { photoBatchQueueService } from './core/services/photo-batch-queue.service';
import { seriesReleaseService } from './core/services/series-release.service';

const isOffline = computed(() => connectionState.isOffline.value);
const bgStatus = backgroundCreationOrchestrator.status;
const photoStats = photoBatchQueueService.stats;
const photoProcessing = photoBatchQueueService.isProcessing;
const photoMsg = photoBatchQueueService.currentStatusMessage;
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
      photoBatchQueueService.initAndResume();
      void seriesReleaseService.checkNewReleasesOnOpen();
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
      photoBatchQueueService.initAndResume();
      void seriesReleaseService.checkNewReleasesOnOpen();
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
      {{ TEXTS.app?.offlineGlobalBanner || 'MODE HORS-LIGNE ACTIF (SYNCHRO DIFFÉRÉE)' }}
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
          {{ bgStatus.stepLabel || 'Enrichissement en cours...' }}
          <strong v-if="bgStatus.pendingCount > 1">({{ bgStatus.pendingCount }} en file)</strong>
        </template>
        <template v-else-if="bgStatus.lastError">
          {{ bgStatus.lastError }}
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

    <div
      v-if="photoStats.totalPhotos > 0"
      role="button"
      tabindex="0"
      class="photo-global-banner"
      :class="photoProcessing ? 'is-processing' : 'is-ready'"
      @click="scannerState.startScan(router, 'photo')"
      @keydown.enter.prevent="scannerState.startScan(router, 'photo')"
      @keydown.space.prevent="scannerState.startScan(router, 'photo')"
    >
      <div class="photo-global-banner__content">
        <strong class="photo-global-banner__title">
          <template v-if="photoProcessing">
            Analyse photo en cours ({{ photoStats.aiDonePhotos }}/{{ photoStats.totalPhotos }}) — traitement serveur en arrière-plan
          </template>
          <template v-else>
            Lot photo prêt à valider ({{ photoStats.donePhotos }}/{{ photoStats.totalPhotos }}) — toucher pour ouvrir
          </template>
        </strong>
        <div class="photo-global-banner__meta">
          {{ photoStats.totalBooksDetected }} livre(s) détecté(s) • {{ photoStats.sureCount }} sûr(s) •
          {{ photoStats.doubtCount }} doute(s) • {{ photoStats.unresolvedCount }} non trouvé(s)
          <template v-if="photoProcessing && photoMsg"> • {{ photoMsg }}</template>
        </div>
      </div>
      <div v-if="photoStats.errorPhotos > 0" class="photo-global-banner__actions">
        <button
          type="button"
          class="wireframe-btn photo-global-banner__retry"
          @click.stop="photoBatchQueueService.retryFailedJobs()"
        >
          Relancer ({{ photoStats.errorPhotos }})
        </button>
      </div>
    </div>

    <!-- Modale Caméra dédiée uniquement à la lecture vidéo de codes-barres -->
    <CameraBarcodeModal />

    <router-view></router-view>
  </div>

  <PwaReloadPrompt />
</template>

<style scoped>
.photo-global-banner {
  margin: 8px 16px 0;
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  cursor: pointer;
  transition: transform 0.12s ease, box-shadow 0.15s ease;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
}

.photo-global-banner:hover {
  box-shadow: 0 3px 8px rgba(15, 23, 42, 0.1);
}

.photo-global-banner:active {
  transform: scale(0.995);
}

.photo-global-banner.is-processing {
  border: 1.5px solid #f59e0b;
  background: #fef3c7;
  color: #78350f;
}

.photo-global-banner.is-ready {
  border: 1.5px solid #16a34a;
  background: #dcfce7;
  color: #14532d;
}

.photo-global-banner__content {
  flex: 1;
  min-width: 220px;
}

.photo-global-banner__title {
  display: block;
  font-size: 13px;
  line-height: 1.3;
}

.photo-global-banner__meta {
  font-size: 12px;
  opacity: 0.9;
  margin-top: 2px;
}

.photo-global-banner__retry {
  width: auto;
  padding: 5px 10px;
  background: #fef2f2;
  color: #991b1b;
  border-color: #fecaca;
  font-weight: 700;
  font-size: 12px;
}
</style>
