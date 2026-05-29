import { ref } from 'vue';

const isTestEnv = typeof (globalThis as any).process !== 'undefined' && (globalThis as any).process.env?.VITEST;

// En mode test, on simule par défaut que l'on est en ligne pour ne pas perturber les tests unitaires existants
const isOffline = ref(isTestEnv ? false : (typeof navigator !== 'undefined' ? !navigator.onLine : false));

let heartbeatInterval: any = null;

const startHeartbeat = () => {
  if (heartbeatInterval || isTestEnv) return;
  console.log("[NETWORK] Lancement du heartbeat de surveillance (10s) pour détecter la reconnexion au serveur...");
  heartbeatInterval = setInterval(async () => {
    if (!isOffline.value) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
      return;
    }
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 2000);
      const response = await fetch('/api/gateway?action=user-get', { signal: controller.signal });
      clearTimeout(id);
      if (response.ok) {
        setOfflineState(false);
        console.log("[NETWORK] Reconnexion au serveur détectée via heartbeat. Statut ONLINE rétabli.");
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
    } catch (e) {
      // Le serveur est toujours injoignable, on ignore silencieusement
    }
  }, 10000); // 10 secondes
};

const stopHeartbeat = () => {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
};

function setOfflineState(state: boolean) {
  if (isOffline.value === state) return;
  isOffline.value = state;
  console.log(`[NETWORK] Changement de statut réseau réactif : ${state ? 'OFFLINE' : 'ONLINE'}`);
  if (state) {
    startHeartbeat();
  } else {
    stopHeartbeat();
  }
}

const updateOnlineStatus = () => {
  if (isTestEnv) return;
  if (typeof navigator !== 'undefined') {
    setOfflineState(!navigator.onLine);
  }
};

if (typeof window !== 'undefined' && !isTestEnv) {
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
}

// Lancer le heartbeat dès le démarrage si l'application commence hors-ligne
if (isOffline.value) {
  startHeartbeat();
}

export const connectionState = {
  isOffline,
  updateOnlineStatus
};

/**
 * Wrapper intelligent de fetch avec timeout intégré et basculement automatique en mode hors-ligne.
 * Si le serveur de développement local ou la passerelle /api/gateway est inaccessible (erreur réseau ou timeout),
 * le mode hors-ligne est activé immédiatement.
 */
export async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit & { timeout?: number }): Promise<Response> {
  const timeout = init?.timeout ?? 4000; // 4 secondes par défaut
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal
    });
    
    // Si la requête réussit vers notre passerelle locale, on sait qu'on est connecté.
    const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as Request).url);
    if (urlStr && urlStr.includes('/api/gateway')) {
      setOfflineState(false);
    }
    return response;
  } catch (error: any) {
    const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as Request).url);
    const isGateway = urlStr && urlStr.includes('/api/gateway');

    // On attrape l'annulation du contrôleur (timeout) ou une erreur réseau brute du navigateur (TypeError / Failed to fetch)
    if (error.name === 'AbortError' || error.message?.includes('Failed to fetch') || error.message?.includes('network error') || error.message?.includes('NetworkError')) {
      console.warn(`[NETWORK] Échec de la requête vers ${urlStr} (Timeout/Erreur Réseau)`);
      if (isGateway) {
        setOfflineState(true);
      }
    }
    throw error;
  } finally {
    clearTimeout(id);
  }
}

