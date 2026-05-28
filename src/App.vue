<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { connectionService } from './core/orchestrators/connection.orchestrator';
import { TEXTS } from './ui/locales/fr';
import PwaReloadPrompt from './ui/components/PwaReloadPrompt.vue';
import { connectionState } from './state/connection';

const isInitializing = ref(true);
const router = useRouter(); 
const route = useRoute(); // Permet de lire l'URL actuelle demandée

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
    <div v-if="connectionState.isOffline.value" class="offline-global-banner">
      ⚠️ {{ TEXTS.app?.offlineGlobalBanner || 'MODE HORS-LIGNE ACTIF (CONSULTATION UNIQUEMENT)' }}
    </div>
    <router-view></router-view>
  </div>
  
  <PwaReloadPrompt />
</template>