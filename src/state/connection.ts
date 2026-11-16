import { ref } from 'vue';

const isTestEnv = typeof (globalThis as any).process !== 'undefined' && (globalThis as any).process.env?.VITEST;
const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

// En mode test ou Worker Cloudflare (sans window), on simule par défaut que l'on est en ligne
const isOffline = ref(isTestEnv || !isBrowser ? false : (typeof navigator !== 'undefined' && navigator.onLine !== undefined ? !navigator.onLine : false));

let heartbeatInterval: any = null;

const startHeartbeat = () => {
  if (heartbeatInterval || isTestEnv || !isBrowser) return;
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
 * Wrapper intelligent de fetch avec timeout intégré.
 * On évite de basculer en mode hors-ligne sur un simple timeout (ex: réponse BnF lente) :
 * le basculement hors-ligne ne survient que sur une vraie coupure réseau navigateur (`!navigator.onLine`)
 * ou une erreur réseau franche (`Failed to fetch` / `NetworkError`) sur la passerelle locale.
 */
export async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit & { timeout?: number }): Promise<Response> {
  const timeout = init?.timeout ?? 10000; // 10 secondes par défaut
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
    const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const isHardNetworkDrop =
      error?.message?.includes('Failed to fetch') ||
      error?.message?.includes('network error') ||
      error?.message?.includes('NetworkError');

    if (error?.name === 'AbortError' || isHardNetworkDrop || browserOffline) {
      console.warn(`[NETWORK] Échec de la requête vers ${urlStr} (${error?.name || 'Réseau'})`);
      if (isGateway && (browserOffline || isHardNetworkDrop)) {
        setOfflineState(true);
      }
    }
    throw error;
  } finally {
    clearTimeout(id);
  }
}

