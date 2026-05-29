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
      if (isOffline.value) {
        isOffline.value = false;
        console.log("[NETWORK] Reconnexion détectée via requête réussie.");
      }
    }
    return response;
  } catch (error: any) {
    const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as Request).url);
    const isGateway = urlStr && urlStr.includes('/api/gateway');

    // On attrape l'annulation du contrôleur (timeout) ou une erreur réseau brute du navigateur (TypeError / Failed to fetch)
    if (error.name === 'AbortError' || error.message?.includes('Failed to fetch') || error.message?.includes('network error') || error.message?.includes('NetworkError')) {
      console.warn(`[NETWORK] Échec de la requête vers ${urlStr} (Timeout/Erreur Réseau)`);
      if (isGateway && !isOffline.value) {
        isOffline.value = true;
        console.warn("[NETWORK] Passage en mode hors-ligne forcé (serveur local inaccessible).");
      }
    }
    throw error;
  } finally {
    clearTimeout(id);
  }
}

