<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { connectionService } from './core/orchestrators/connection.orchestrator';
import { TEXTS } from './ui/locales/fr';
import PwaReloadPrompt from './ui/components/PwaReloadPrompt.vue';
import { connectionState } from './state/connection';
import { scannerState } from './state/scanner';

const isOffline = computed(() => connectionState.isOffline.value);
const isInitializing = ref(true);
const router = useRouter(); 
const route = useRoute(); // Permet de lire l'URL actuelle demandée

// Surveillance réactive du retour réseau
watch(isOffline, async (newOfflineVal) => {
  if (!newOfflineVal) {
    console.log("[App] Le réseau est de retour. Vérification de la validité de la session...");
    const hasValidSession = await connectionService.checkSessionOnReconnection();
    if (!hasValidSession) {
      router.push('/login');
    } else if (route.path === '/login') {
      router.push('/dashboard');
    }
  }
});

// Arrêt automatique du scanner lors d'un changement de page
watch(() => route.path, () => {
  if (scannerState.isScanningActive.value) {
    scannerState.stopScan();
  }
});

onMounted(async () => {
  try {
    const isConnected = await connectionService.initializeApp();
    
    if (isConnected) {
      // On ne force le retour à l'accueil que si l'utilisateur arrive de la racine ou du login
      if (route.path === '/login' || route.path === '/') {
        router.push('/dashboard');
      }
      // Sinon, on le laisse tranquille sur sa page (ex: /debug, /series/...)
    } else {
      router.push('/login');
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
      ⚠️ {{ TEXTS.app?.offlineGlobalBanner || 'MODE HORS-LIGNE ACTIF (CONSULTATION UNIQUEMENT)' }}
    </div>

    <!-- Volet de Scan Global -->
    <div v-show="scannerState.isScanningActive.value" class="global-scanner-box">
      <div class="scanner-viewport-wrapper">
        <div id="global-barcode-scanner-viewport" class="scanner-viewport"></div>
        <div v-if="!scannerState.isSearching.value" class="scanner-placeholder">
          <p>{{ TEXTS.scanner?.searching || 'En attente d\'un code-barres...' }}</p>
        </div>
      </div>
      <div v-if="scannerState.errorMessage.value" class="error-banner">
        {{ scannerState.errorMessage.value }}
      </div>
    </div>

    <router-view></router-view>
  </div>
  
  <PwaReloadPrompt />
</template>