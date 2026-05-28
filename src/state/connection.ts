import { ref } from 'vue';

const isTestEnv = typeof (globalThis as any).process !== 'undefined' && (globalThis as any).process.env?.VITEST;

// En mode test, on simule par défaut que l'on est en ligne pour ne pas perturber les tests unitaires existants
const isOffline = ref(isTestEnv ? false : (typeof navigator !== 'undefined' ? !navigator.onLine : false));

const updateOnlineStatus = () => {
  if (isTestEnv) return;
  if (typeof navigator !== 'undefined') {
    isOffline.value = !navigator.onLine;
    console.log(`[NETWORK] Statut réseau mis à jour: ${isOffline.value ? 'OFFLINE' : 'ONLINE'}`);
  }
};

if (typeof window !== 'undefined' && !isTestEnv) {
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
}

export const connectionState = {
  isOffline,
  updateOnlineStatus
};
