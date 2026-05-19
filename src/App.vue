<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { connectionService } from './core/orchestrators/connection.orchestrator';
import { TEXTS } from './ui/locales/fr';
import PwaReloadPrompt from './ui/components/PwaReloadPrompt.vue';

const isInitializing = ref(true);
const router = useRouter(); // Permet de manipuler la navigation

onMounted(async () => {
  try {
    // On lance la mécanique lourde du Middle-End
    const isConnected = await connectionService.initializeApp();
    
    // Routage intelligent selon la réponse de l'orchestrateur
    if (isConnected) {
      router.push('/dashboard');
    } else {
      router.push('/login');
    }
  } catch (error) {
    console.error("[VUE] Erreur lors de l'initialisation :", error);
    // Sécurité : en cas de plantage, on renvoie à la page de connexion
    router.push('/login');
  } finally {
    // Le chargement est terminé, on fait disparaître le Splash Screen
    isInitializing.value = false;
  }
});
</script>

<template>
  <div v-if="isInitializing" class="splash-screen">
    <h1>{{ TEXTS.app.name }}</h1>
    <p>{{ TEXTS.status.initializing }}</p>
  </div>

  <router-view v-else></router-view>
  
  <PwaReloadPrompt />
</template>

<style>
/* Style global de base */
body {
  margin: 0;
  font-family: sans-serif;
  background-color: #f4f4f9;
  color: #333;
}

.splash-screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100vh;
  text-align: center;
}

h1 {
  color: #5bc31b;
}
</style>