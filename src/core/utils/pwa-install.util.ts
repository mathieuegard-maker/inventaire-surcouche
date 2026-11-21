import { computed, ref } from 'vue';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const deferredPrompt = ref<BeforeInstallPromptEvent | null>(null);
const isStandalone = ref(false);
let listenerInitialized = false;

export const isIosDevice = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
};

export const canInstallPwa = computed(() => Boolean(deferredPrompt.value) && !isStandalone.value);
export const isAppInstalled = computed(() => isStandalone.value);

export function initPwaInstallListener(): void {
  if (typeof window === 'undefined' || listenerInitialized) return;
  listenerInitialized = true;

  const checkStandalone = () => {
    const standaloneMedia = window.matchMedia?.('(display-mode: standalone)')?.matches;
    const iosStandalone = Boolean((window.navigator as unknown as { standalone?: boolean }).standalone);
    isStandalone.value = Boolean(standaloneMedia || iosStandalone);
  };

  checkStandalone();

  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault();
    deferredPrompt.value = e as BeforeInstallPromptEvent;
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt.value = null;
    isStandalone.value = true;
  });
}

export async function promptPwaInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferredPrompt.value) return 'unavailable';
  const promptEvent = deferredPrompt.value;
  await promptEvent.prompt();
  const choice = await promptEvent.userChoice;
  deferredPrompt.value = null;
  if (choice.outcome === 'accepted') {
    isStandalone.value = true;
  }
  return choice.outcome;
}
