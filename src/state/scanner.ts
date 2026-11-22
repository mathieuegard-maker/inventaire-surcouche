// src/state/scanner.ts
// État réactif global du Scanner unifié :
// 1. 'simple' : Scan unitaire -> ferme le scanner et ouvre directement la fiche complète du livre
// 2. 'burst'  : Scan rafale multiple -> constitue une liste de livres à cocher (sans enregistrement automatique) avec actions groupées
// 3. 'photo'  : Photo Étagère / Couverture (lot multi-photos traité en file d'attente par l'IA)

import { ref } from 'vue';
import type { Router } from 'vue-router';
import { barcodeIsbnProvider, playScanBeep, unlockScanAudio } from '../plugins/barcode/barcode-isbn.provider';
import { searchService } from '../core/orchestrators/search.orchestrator';
import { imageUtil } from '../core/utils/image.util';
import { saveBookNavigationOrder } from './bookNavigation';
import { connectionState } from './connection';
import { pendingScansStore } from './pendingScans';
import type { HumanizedBook } from '../core/types';

export type ScannerMode = 'simple' | 'burst' | 'photo' | 'search';

const isCameraModalOpen = ref(false);
const isScanningActive = isCameraModalOpen;
const isIsbnPickerMode = ref(false);
const isSearching = ref(false);
const isSimpleResolving = ref(false);
const simpleResolvingIsbn = ref<string | null>(null);
const errorMessage = ref<string | null>(null);
const activeMode = ref<ScannerMode>('photo');
const burstBooks = ref<HumanizedBook[]>([]);
const simpleBooks = ref<HumanizedBook[]>([]);
const latestBurstBook = ref<HumanizedBook | null>(null);
const burstFlashEvent = ref<{ id: number; status: 'success' | 'duplicate'; isbn?: string } | null>(null);
const lastUpdatedTick = ref<number>(Date.now());
let activeRouter: Router | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;
let isbnPickerCallback: ((isbn: string) => void) | null = null;

function triggerBurstFeedback(status: 'success' | 'duplicate', isbn?: string) {
  burstFlashEvent.value = { id: Date.now(), status, isbn };
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(status === 'duplicate' ? [25, 45, 25] : 55);
    } catch {
      // Vibration ignorée si non supportée par l'appareil
    }
  }
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    burstFlashEvent.value = null;
  }, 1400);
}

export const scannerState = {
  isCameraModalOpen,
  isScanningActive,
  isIsbnPickerMode,
  isSearching,
  isSimpleResolving,
  simpleResolvingIsbn,
  errorMessage,
  activeMode,
  burstBooks,
  simpleBooks,
  latestBurstBook,
  burstFlashEvent,
  lastUpdatedTick,

  clearSimpleBooks() {
    simpleBooks.value = [];
  },

  notifyCatalogChanged() {
    lastUpdatedTick.value = Date.now();
  },

  /**
   * Navigue vers la page dédiée `/scan` dans le mode demandé,
   * et n'ouvre la modale caméra que lorsque la lecture caméra code-barres est lancée explicitement.
   */
  async startScan(router: Router, mode: ScannerMode = 'photo', options?: { openCamera?: boolean }) {
    activeRouter = router;
    activeMode.value = mode;
    errorMessage.value = null;

    const currentRoute = router.currentRoute.value;
    if (currentRoute.name !== 'ScanView' || currentRoute.query.mode !== mode) {
      await router.push({ name: 'ScanView', query: { mode } });
    }

    if (mode === 'photo' || mode === 'search' || !options?.openCamera) {
      isSearching.value = false;
      isCameraModalOpen.value = false;
      await barcodeIsbnProvider.stopScanner().catch(() => {});
      return;
    }

    await this.openCameraModal(router, mode);
  },

  async openCameraModal(router: Router, mode: 'simple' | 'burst' = 'simple') {
    unlockScanAudio();
    activeRouter = router;
    activeMode.value = mode;
    errorMessage.value = null;
    isCameraModalOpen.value = true;

    const isContinuous = mode === 'burst';

    setTimeout(async () => {
      try {
        await barcodeIsbnProvider.startScanner(
          'global-barcode-scanner-viewport',
          async (response: any, rawIsbn?: string) => {
            if (activeMode.value === 'burst') {
              return;
            }

            // Mode 'simple' : fermer la caméra dès détection, afficher chargement puis ouvrir la fiche
            isSearching.value = false;
            isSimpleResolving.value = false;
            simpleResolvingIsbn.value = null;
            const cleanScanned = (response?.isbn || rawIsbn || '').trim();
            if (response?.isOfflineUnavailable || (!response && connectionState.isOffline.value)) {
              await this.stopScan();
              if (cleanScanned) {
                pendingScansStore.addPendingScan(cleanScanned);
              }
              errorMessage.value = cleanScanned
                ? `Pas de réseau actuellement : ce livre est absent de votre base locale. Le code-barres (${cleanScanned}) a été mémorisé pour consulter sa fiche dès le retour du réseau.`
                : 'Pas de réseau actuellement : impossible de rechercher cet ouvrage pour le moment.';
              return;
            }

            if (response) {
              if (response.ownership?.isWorkOwned) {
                playScanBeep('duplicate');
              }
              await this.stopScan();
              if ('isUnknown' in response && response.isUnknown) {
                await router.push({
                  name: 'BookCreateUnknown',
                  query: { isbn: response.isbn || rawIsbn || '' }
                });
              } else if (response.mainBook?.uri) {
                saveBookNavigationOrder([response.mainBook.uri], 'direct');
                await router.push(`/book/${encodeURIComponent(response.mainBook.uri)}`);
              } else {
                errorMessage.value = 'Ouvrage non trouvé.';
              }
            } else {
              errorMessage.value = 'Ouvrage non trouvé.';
            }
          },
          (errorMsg) => {
            isSearching.value = false;
            isSimpleResolving.value = false;
            simpleResolvingIsbn.value = null;
            errorMessage.value = errorMsg;
          },
          () => {
            isSearching.value = true;
          },
          {
            continuous: isContinuous,
            skipLookup: isContinuous,
            onBarcodeDetected: (isbn) => {
              if (isContinuous) {
                this.handleInstantBurstCapture(isbn);
                return;
              }
              playScanBeep('success');
              isCameraModalOpen.value = false;
              isSearching.value = false;
              isSimpleResolving.value = true;
              simpleResolvingIsbn.value = isbn;
            }
          }
        );
      } catch (err: any) {
        isCameraModalOpen.value = false;
        isSearching.value = false;
        isSimpleResolving.value = false;
        simpleResolvingIsbn.value = null;
        errorMessage.value = err.message || 'Erreur de démarrage du scanner.';
      }
    }, 150);
  },

  /**
   * Capture Rafale instantanée (0 ms) : bip + vibration + confirmation visuelle immédiate,
   * puis identification V4 / BnF / sources externes entièrement en arrière-plan.
   */
  handleInstantBurstCapture(scannedIsbn: string) {
    const cleanIsbn = (scannedIsbn || '').trim();
    if (!cleanIsbn) return;

    const alreadyInList = burstBooks.value.some(
      (b) =>
        b.isbn13 === cleanIsbn ||
        b.isbn10 === cleanIsbn ||
        b.uri === `isbn:${cleanIsbn}` ||
        b.knownIsbns?.includes(cleanIsbn)
    );
    if (alreadyInList) {
      playScanBeep('duplicate');
      triggerBurstFeedback('duplicate', cleanIsbn);
      return;
    }

    // 1. Retour immédiat (0 ms) pour enchaîner sur le livre suivant sans attendre le réseau
    playScanBeep('success');
    triggerBurstFeedback('success', cleanIsbn);

    const placeholderUri = `isbn:${cleanIsbn}`;
    const placeholderBook: HumanizedBook = {
      uri: placeholderUri,
      type: 'edition',
      isbn13: cleanIsbn,
      title: `Code-barres pris en compte (${cleanIsbn})`,
      authors: ['Identification en cours en arrière-plan...'],
      illustrators: [],
      scriptwriters: [],
      genres: [],
      ownershipStatus: 'none'
    };
    burstBooks.value.unshift(placeholderBook);
    latestBurstBook.value = placeholderBook;

    // 2. Identification asynchrone en arrière-plan via l'orchestrateur unifié (Cache -> V4 -> EntityResolver -> Sources externes)
    void this.resolveBurstPlaceholder(cleanIsbn, placeholderUri);
  },

  async resolveBurstPlaceholder(scannedIsbn: string, placeholderUri: string) {
    try {
      const response = await searchService.searchByIsbn(scannedIsbn);
      const idx = burstBooks.value.findIndex((b) => b.uri === placeholderUri);
      if (idx === -1) return;

      if (response && (response as any).mainBook?.uri && !(response as any).isUnknown && !(response as any).isOfflineUnavailable) {
        const resolvedBook: HumanizedBook = {
          ...(response as any).mainBook,
          loan: (response as any).loan?.details || (response as any).mainBook.loan
        };
        burstBooks.value[idx] = resolvedBook;
        if (latestBurstBook.value?.uri === placeholderUri) {
          latestBurstBook.value = resolvedBook;
        }
        return;
      }

      if ((response as any)?.isOfflineUnavailable || connectionState.isOffline.value) {
        pendingScansStore.addPendingScan(scannedIsbn);
        const offlineBook: HumanizedBook = {
          ...burstBooks.value[idx],
          title: `Code-barres mémorisé (${scannedIsbn})`,
          authors: ['Hors réseau — à consulter dès le retour de la connexion']
        };
        burstBooks.value[idx] = offlineBook;
        if (latestBurstBook.value?.uri === placeholderUri) {
          latestBurstBook.value = offlineBook;
        }
        return;
      }

      const fallbackUrls = imageUtil.buildCoverCandidates(scannedIsbn);
      const unknownBook: HumanizedBook = {
        ...burstBooks.value[idx],
        title: `Livre ISBN ${scannedIsbn}`,
        authors: ['Référence à préciser'],
        coverUrl: burstBooks.value[idx].coverUrl || fallbackUrls[0],
        ...(fallbackUrls.length ? { coverFallbackUrls: fallbackUrls } : {})
      };
      burstBooks.value[idx] = unknownBook;
      if (latestBurstBook.value?.uri === placeholderUri) {
        latestBurstBook.value = unknownBook;
      }
    } catch (e: unknown) {
      console.warn('[BURST SCAN] Échec enrichissement en arrière-plan :', e);
      const idx = burstBooks.value.findIndex((b) => b.uri === placeholderUri);
      if (idx !== -1) {
        const fallbackUrls = imageUtil.buildCoverCandidates(scannedIsbn);
        burstBooks.value[idx] = {
          ...burstBooks.value[idx],
          title: `Livre ISBN ${scannedIsbn}`,
          authors: ['Auteur inconnu'],
          coverUrl: burstBooks.value[idx].coverUrl || fallbackUrls[0],
          ...(fallbackUrls.length ? { coverFallbackUrls: fallbackUrls } : {})
        };
      }
    }
  },

  clearBurstBooks() {
    burstBooks.value = [];
    latestBurstBook.value = null;
  },

  async switchMode(newMode: ScannerMode) {
    activeMode.value = newMode;
    errorMessage.value = null;
    if (isCameraModalOpen.value) {
      await this.stopScan();
    }
    if (activeRouter) {
      await activeRouter.push({ name: 'ScanView', query: { mode: newMode } });
    }
  },

  async openIsbnPickerModal(onPicked: (isbn: string) => void) {
    unlockScanAudio();
    isIsbnPickerMode.value = true;
    isbnPickerCallback = onPicked;
    errorMessage.value = null;
    isSearching.value = false;
    isCameraModalOpen.value = true;

    setTimeout(async () => {
      try {
        await barcodeIsbnProvider.startScanner(
          'global-barcode-scanner-viewport',
          () => {},
          (errorMsg) => {
            isSearching.value = false;
            errorMessage.value = errorMsg;
          },
          () => {
            isSearching.value = true;
          },
          {
            continuous: false,
            skipLookup: true,
            onBarcodeDetected: (isbn) => {
              playScanBeep('success');
              const cb = isbnPickerCallback;
              isbnPickerCallback = null;
              isIsbnPickerMode.value = false;
              isCameraModalOpen.value = false;
              isSearching.value = false;
              cb?.(isbn);
            }
          }
        );
      } catch (err: any) {
        isCameraModalOpen.value = false;
        isSearching.value = false;
        isIsbnPickerMode.value = false;
        isbnPickerCallback = null;
        errorMessage.value = err.message || 'Erreur de démarrage du scanner.';
      }
    }, 150);
  },

  async stopScan() {
    await barcodeIsbnProvider.stopScanner().catch(() => {});
    isCameraModalOpen.value = false;
    isSearching.value = false;
    isIsbnPickerMode.value = false;
    isbnPickerCallback = null;
  },

  toggleScan(router: Router, mode?: ScannerMode) {
    if (router.currentRoute.value.name === 'ScanView' && (!mode || activeMode.value === mode)) {
      if (isCameraModalOpen.value) {
        this.stopScan();
      } else {
        router.back();
      }
    } else {
      this.startScan(router, mode || activeMode.value || 'photo');
    }
  }
};
