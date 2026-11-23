// src/client/stores/ui.store.ts
// Store Pinia global : Toasts, pile de modales, état réseau offline + heartbeat, et installation PWA.

import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface ToastItem {
  id: number;
  type: 'info' | 'success' | 'warning' | 'danger';
  message: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const useUiStore = defineStore('ui', () => {
  const toasts = ref<ToastItem[]>([]);
  const modalStack = ref<string[]>([]);
  const isOffline = ref<boolean>(typeof navigator !== 'undefined' ? !navigator.onLine : false);
  const canInstallPwa = ref(false);
  const isIosStandaloneNeeded = ref(false);

  let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
  let nextToastId = 1;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function pushToast(message: string, type: ToastItem['type'] = 'info', durationMs = 3500): void {
    const id = nextToastId++;
    toasts.value.push({ id, type, message });
    setTimeout(() => {
      dismissToast(id);
    }, durationMs);
  }

  function dismissToast(id: number): void {
    toasts.value = toasts.value.filter((item) => item.id !== id);
  }

  function registerModal(id: string): number {
    if (!modalStack.value.includes(id)) {
      modalStack.value.push(id);
    }
    syncBodyScrollLock();
    return 1000 + modalStack.value.indexOf(id) * 10;
  }

  function unregisterModal(id: string): void {
    modalStack.value = modalStack.value.filter((m) => m !== id);
    syncBodyScrollLock();
  }

  function isTopModal(id: string): boolean {
    return modalStack.value.length > 0 && modalStack.value[modalStack.value.length - 1] === id;
  }

  function syncBodyScrollLock(): void {
    if (typeof document === 'undefined') return;
    document.body.style.overflow = modalStack.value.length > 0 ? 'hidden' : '';
  }

  async function checkServerReachable(): Promise<boolean> {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (res.ok) {
        isOffline.value = false;
        return true;
      }
    } catch {
      // Serveur inaccessible
    }
    isOffline.value = true;
    return false;
  }

  function initGlobalListeners(): void {
    if (typeof window === 'undefined') return;

    window.addEventListener('online', () => {
      void checkServerReachable();
    });
    window.addEventListener('offline', () => {
      isOffline.value = true;
    });

    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        if (isOffline.value) {
          void checkServerReachable();
        }
      }, 10000);
    }

    // Détection installation PWA
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredInstallPrompt = event as BeforeInstallPromptEvent;
      canInstallPwa.value = true;
    });

    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      canInstallPwa.value = false;
    });

    const ua = window.navigator.userAgent;
    const isIos = /iPad|iPhone|iPod/.test(ua);
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      Boolean((window.navigator as unknown as { standalone?: boolean }).standalone);
    isIosStandaloneNeeded.value = isIos && !isStandalone;
  }

  async function triggerPwaInstall(): Promise<boolean> {
    if (!deferredInstallPrompt) return false;
    await deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice.outcome === 'accepted') {
      deferredInstallPrompt = null;
      canInstallPwa.value = false;
      return true;
    }
    return false;
  }

  return {
    toasts,
    modalStack,
    isOffline,
    canInstallPwa,
    isIosStandaloneNeeded,
    pushToast,
    dismissToast,
    registerModal,
    unregisterModal,
    isTopModal,
    checkServerReachable,
    initGlobalListeners,
    triggerPwaInstall
  };
});
