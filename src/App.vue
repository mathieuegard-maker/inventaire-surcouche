<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { connectionService } from './core/orchestrators/connection.orchestrator';
import { TEXTS } from './ui/locales/fr';
import PwaReloadPrompt from './ui/components/PwaReloadPrompt.vue';

const isInitializing = ref(true);
const router = useRouter(); 

onMounted(async () => {
  try {
    const isConnected = await connectionService.initializeApp();
    
    if (isConnected) {
      router.push('/dashboard');
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

  <router-view v-else></router-view>
  
  <PwaReloadPrompt />
</template>