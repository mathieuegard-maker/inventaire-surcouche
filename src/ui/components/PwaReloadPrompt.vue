<script setup lang="ts">
import { useRegisterSW } from 'virtual:pwa-register/vue';
import { TEXTS } from '../locales/fr';

// Utilisation du composable fourni par le plugin Vite PWA
const {
  offlineReady,
  needRefresh,
  updateServiceWorker,
} = useRegisterSW({
  onRegistered(r) {
    console.log('[PWA] Service Worker correctement enregistré.', r);
  },
  onRegisterError(error) {
    console.error('[PWA] Échec lors de l\'enregistrement du Service Worker:', error);
  },
});

const closeToast = async () => {
  offlineReady.value = false;
  needRefresh.value = false;
};
</script>

<template>
  <div v-if="offlineReady || needRefresh" class="pwa-toast">
    <div class="pwa-message">
      <span v-if="offlineReady">{{ TEXTS.pwa.offlineReady }}</span>
      <span v-else>{{ TEXTS.pwa.updateReady }}</span>
    </div>
    
    <div class="pwa-actions">
      <button v-if="needRefresh" @click="updateServiceWorker()" class="btn-pwa-update">
        {{ TEXTS.pwa.btnReload }}
      </button>
      
      <button @click="closeToast" class="btn-pwa-close">
        {{ TEXTS.pwa.btnClose }}
      </button>
    </div>
  </div>
</template>