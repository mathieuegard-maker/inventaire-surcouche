// src/state/scanner.ts
// État réactif global du Scanner unifié :
// 1. 'simple' : Scan unitaire -> ferme le scanner et ouvre directement la fiche complète du livre
// 2. 'burst'  : Scan rafale multiple -> constitue une liste de livres à cocher (sans enregistrement automatique) avec actions groupées
// 3. 'photo'  : Photo Étagère / Couverture (lot multi-photos traité en file d'attente par l'IA)

import { ref } from 'vue';
import type { Router } from 'vue-router';
import { barcodeIsbnProvider, playScanBeep } from '../plugins/barcode/barcode-isbn.provider';
import { externalMetadataService } from '../core/services/external-metadata.service';
import { databaseService } from '../core/database/database.service';
import { findMatchingOwnedWork } from '../core/utils/series-matcher.util';
import { ingestIsbnsViaV4, v4BookRecordToHumanizedBook } from '../core/services/v4-client.service';
import { imageUtil } from '../core/utils/image.util';
import { saveBookNavigationOrder } from './bookNavigation';
import { connectionState } from './connection';
import { pendingScansStore } from './pendingScans';
import type { HumanizedBook } from '../core/types';

export type ScannerMode = 'simple' | 'burst' | 'photo';

const isCameraModalOpen = ref(false);
const isScanningActive = isCameraModalOpen;
const isSearching = ref(false);
const isSimpleResolving = ref(false);
const simpleResolvingIsbn = ref<string | null>(null);
const errorMessage = ref<string | null>(null);
const activeMode = ref<ScannerMode>('photo');
const burstBooks = ref<HumanizedBook[]>([]);
const latestBurstBook = ref<HumanizedBook | null>(null);
const burstFlashEvent = ref<{ id: number; status: 'success' | 'duplicate' } | null>(null);
const lastUpdatedTick = ref<number>(Date.now());
let activeRouter: Router | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

function triggerBurstFeedback(status: 'success' | 'duplicate') {
  burstFlashEvent.value = { id: Date.now(), status };
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    burstFlashEvent.value = null;
  }, 600);
}

export const scannerState = {
  isCameraModalOpen,
  isScanningActive,
  isSearching,
  isSimpleResolving,
  simpleResolvingIsbn,
  errorMessage,
  activeMode,
  burstBooks,
  latestBurstBook,
  burstFlashEvent,
  lastUpdatedTick,

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

    if (mode === 'photo' || !options?.openCamera) {
      isSearching.value = false;
      isCameraModalOpen.value = false;
      await barcodeIsbnProvider.stopScanner().catch(() => {});
      return;
    }

    await this.openCameraModal(router, mode);
  },

  async openCameraModal(router: Router, mode: 'simple' | 'burst' = 'simple') {
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
              await this.handleBurstDetection(response, rawIsbn || '');
              return;
            }

            // Mode 'simple' : fermer la caméra dès détection, afficher chargement puis ouvrir la fiche
            isSearching.value = false;
            isSimpleResolving.value = false;
            simpleResolvingIsbn.value = null;
            const cleanScanned = (response?.isbn || rawIsbn || '').trim();
            if (response?.isOfflineUnavailable || (!response && connectionState.isOffline.value)) {
              playScanBeep('success');
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
              playScanBeep(response.ownership?.isWorkOwned ? 'duplicate' : 'success');
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
            onBarcodeDetected: (isbn) => {
              if (!isContinuous) {
                playScanBeep('success');
                isCameraModalOpen.value = false;
                isSearching.value = false;
                isSimpleResolving.value = true;
                simpleResolvingIsbn.value = isbn;
              }
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

  async handleBurstDetection(response: any, scannedIsbn: string) {
    if (!scannedIsbn) return;

    // Éviter d'empiler deux fois le même ISBN ou la même œuvre dans la liste courante
    const alreadyInList = burstBooks.value.some(
      (b) =>
        b.isbn13 === scannedIsbn ||
        b.isbn10 === scannedIsbn ||
        b.uri === `isbn:${scannedIsbn}` ||
        b.knownIsbns?.includes(scannedIsbn)
    );
    if (alreadyInList) {
      playScanBeep('duplicate');
      triggerBurstFeedback('duplicate');
      return;
    }

    // Cas 1 : Livre déjà connu (cache local / D1) — aucun enregistrement automatique !
    if (response && response.mainBook?.uri && !response.isUnknown && !response.isOfflineUnavailable) {
      const book: HumanizedBook = {
        ...response.mainBook,
        loan: response.loan?.details || response.mainBook.loan
      };
      playScanBeep(response.ownership?.isWorkOwned ? 'duplicate' : 'success');
      triggerBurstFeedback('success');
      burstBooks.value.unshift(book);
      latestBurstBook.value = book;
      return;
    }

    // Cas 1b : Pas de réseau et absent du cache local -> mémoriser le code-barres pour plus tard
    if (response?.isOfflineUnavailable || connectionState.isOffline.value) {
      pendingScansStore.addPendingScan(scannedIsbn);
      playScanBeep('success');
      triggerBurstFeedback('success');
      const offlineBook: HumanizedBook = {
        uri: `isbn:${scannedIsbn}`,
        type: 'edition',
        isbn13: scannedIsbn,
        title: `Code-barres mémorisé (${scannedIsbn})`,
        authors: ['Hors réseau — à consulter dès le retour de la connexion'],
        illustrators: [],
        scriptwriters: [],
        genres: [],
        ownershipStatus: 'none'
      };
      burstBooks.value.unshift(offlineBook);
      latestBurstBook.value = offlineBook;
      return;
    }

    // Cas 2 : ISBN absent de D1 -> Pipeline V4 (/api/v2/books/ingest en aperçu) puis repli externalMetadataService
    playScanBeep('success');
    triggerBurstFeedback('success');
    const placeholderUri = `isbn:${scannedIsbn}`;
    const placeholderBook: HumanizedBook = {
      uri: placeholderUri,
      type: 'edition',
      isbn13: scannedIsbn,
      title: `Recherche V4 / BnF (${scannedIsbn})...`,
      authors: [],
      illustrators: [],
      scriptwriters: [],
      genres: [],
      ownershipStatus: 'none'
    };
    burstBooks.value.unshift(placeholderBook);
    latestBurstBook.value = placeholderBook;

    ingestIsbnsViaV4({ isbns: [scannedIsbn], sourceChannel: 'canal_1_barcode', action: 'preview' })
      .then(async (v4Batch) => {
        const v4Item = v4Batch?.results?.[0];
        if (v4Item?.book) {
          const idx = burstBooks.value.findIndex((b) => b.uri === placeholderUri);
          if (idx === -1) return;
          const isDup =
            v4Item.layer2Status === 'ALREADY_OWNED' ||
            v4Item.layer2Status === 'INCLUDED_IN_INTEGRAL' ||
            v4Item.layer2Status === 'FULL_INTEGRAL_OWNED';
          if (isDup) playScanBeep('duplicate');
          const resolvedBook = v4BookRecordToHumanizedBook(v4Item.book, isDup ? 'owned' : 'none');
          burstBooks.value[idx] = resolvedBook;
          if (latestBurstBook.value?.uri === placeholderUri) {
            latestBurstBook.value = resolvedBook;
          }
          return;
        }
        return externalMetadataService.fetchFromExternalSources(scannedIsbn).then(async (meta) => {
          const idx = burstBooks.value.findIndex((b) => b.uri === placeholderUri);
          if (idx === -1) return;
          const coverFallbackUrls = imageUtil.buildCoverCandidates(scannedIsbn, [
            meta?.coverUrl,
            ...(meta?.coverFallbackUrls || [])
          ]);
          const localBooks =
            typeof databaseService.getAllBooksFromCache === 'function'
              ? await databaseService.getAllBooksFromCache().catch(() => [])
              : [];
          const ownedMatch = findMatchingOwnedWork({
            candidateIsbns: [scannedIsbn],
            candidateTitle: meta?.title,
            candidateAuthors: meta?.authors,
            candidateSeries: meta?.series,
            candidateSeriesNumber: meta?.seriesNumber,
            existingBooks: localBooks,
            targetStatuses: ['owned', 'wish']
          });
          if (ownedMatch?.book.ownershipStatus === 'owned') {
            playScanBeep('duplicate');
          }
          burstBooks.value[idx] = {
            ...burstBooks.value[idx],
            uri: ownedMatch?.book.uri || burstBooks.value[idx].uri,
            workUri: ownedMatch?.book.workUri,
            title: meta?.title?.trim() || `Livre ISBN ${scannedIsbn}`,
            authors: meta?.authors?.length ? meta.authors : ['Auteur inconnu'],
            publisher: meta?.publisher || '',
            publishDate: meta?.publishDate,
            pageCount: meta?.pageCount,
            coverUrl: meta?.coverUrl || coverFallbackUrls[0],
            ...(coverFallbackUrls.length ? { coverFallbackUrls } : {}),
            series: ownedMatch?.book.series || meta?.series,
            seriesId: ownedMatch?.book.seriesId,
            seriesNumber: meta?.seriesNumber,
            genres: meta?.genres || [],
            ownershipStatus: ownedMatch?.book.ownershipStatus || 'none'
          };
          if (latestBurstBook.value?.uri === placeholderUri || latestBurstBook.value?.uri === burstBooks.value[idx].uri) {
            latestBurstBook.value = burstBooks.value[idx];
          }
        });
      })
      .catch((e: unknown) => {
        console.warn('[BURST SCAN] Échec enrichissement aperçu :', e);
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
      });
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

  async stopScan() {
    await barcodeIsbnProvider.stopScanner().catch(() => {});
    isCameraModalOpen.value = false;
    isSearching.value = false;
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
