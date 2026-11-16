// src/state/scanner.ts
// État réactif global du Scanner unifié :
// 1. 'simple' : Scan unitaire -> ferme le scanner et ouvre directement la fiche complète du livre
// 2. 'burst'  : Scan rafale multiple -> constitue une liste de livres à cocher (sans enregistrement automatique) avec actions groupées
// 3. 'photo'  : Photo Étagère / Couverture (lot multi-photos traité en file d'attente par l'IA)

import { ref } from 'vue';
import type { Router } from 'vue-router';
import { barcodeIsbnProvider, playScanBeep } from '../plugins/barcode/barcode-isbn.provider';
import { externalMetadataService } from '../core/services/external-metadata.service';
import type { HumanizedBook } from '../core/types';

export type ScannerMode = 'simple' | 'burst' | 'photo';

const isScanningActive = ref(false);
const isSearching = ref(false);
const errorMessage = ref<string | null>(null);
const activeMode = ref<ScannerMode>('simple');
const burstBooks = ref<HumanizedBook[]>([]);
const latestBurstBook = ref<HumanizedBook | null>(null);
const lastUpdatedTick = ref<number>(Date.now());
let activeRouter: Router | null = null;

export const scannerState = {
  isScanningActive,
  isSearching,
  errorMessage,
  activeMode,
  burstBooks,
  latestBurstBook,
  lastUpdatedTick,

  notifyCatalogChanged() {
    lastUpdatedTick.value = Date.now();
  },

  async startScan(router: Router, mode: ScannerMode = 'simple') {
    activeRouter = router;
    activeMode.value = mode;
    errorMessage.value = null;
    isScanningActive.value = true;

    if (activeMode.value === 'photo') {
      isSearching.value = false;
      await barcodeIsbnProvider.stopScanner();
      return;
    }

    const isContinuous = activeMode.value === 'burst';

    setTimeout(async () => {
      try {
        await barcodeIsbnProvider.startScanner(
          'global-barcode-scanner-viewport',
          async (response: any, rawIsbn?: string) => {
            if (activeMode.value === 'burst') {
              await this.handleBurstDetection(response, rawIsbn || '');
              return;
            }

            // Mode 'simple' : dès que le livre est trouvé, on ferme la fenêtre de scan et on ouvre sa fiche complète
            isSearching.value = false;
            if (response) {
              playScanBeep(response.ownership?.isWorkOwned ? 'duplicate' : 'success');
              await this.stopScan();
              if ('isUnknown' in response && response.isUnknown) {
                await router.push({
                  name: 'BookCreateUnknown',
                  query: { isbn: response.isbn || rawIsbn || '' }
                });
              } else if (response.mainBook?.uri) {
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
            errorMessage.value = errorMsg;
          },
          () => {
            isSearching.value = true;
          },
          { continuous: isContinuous }
        );
      } catch (err: any) {
        isScanningActive.value = false;
        isSearching.value = false;
        errorMessage.value = err.message || 'Erreur de démarrage du scanner.';
      }
    }, 150);
  },

  async handleBurstDetection(response: any, scannedIsbn: string) {
    if (!scannedIsbn) return;

    // Éviter d'empiler deux fois le même ISBN dans la liste courante
    const alreadyInList = burstBooks.value.some(
      (b) => b.isbn13 === scannedIsbn || b.isbn10 === scannedIsbn || b.uri === `isbn:${scannedIsbn}`
    );
    if (alreadyInList) {
      playScanBeep('duplicate');
      return;
    }

    // Cas 1 : Livre déjà connu (cache local / D1) — aucun enregistrement automatique !
    if (response && response.mainBook?.uri && !response.isUnknown) {
      const book: HumanizedBook = {
        ...response.mainBook,
        loan: response.loan?.details || response.mainBook.loan
      };
      playScanBeep(response.ownership?.isWorkOwned ? 'duplicate' : 'success');
      burstBooks.value.unshift(book);
      latestBurstBook.value = book;
      return;
    }

    // Cas 2 : ISBN absent de D1 -> résolution métadonnées externes pour l'afficher dans la liste à cocher (sans création auto)
    playScanBeep('success');
    const placeholderUri = `isbn:${scannedIsbn}`;
    const placeholderBook: HumanizedBook = {
      uri: placeholderUri,
      type: 'edition',
      isbn13: scannedIsbn,
      title: `Recherche BnF (${scannedIsbn})...`,
      authors: [],
      illustrators: [],
      scriptwriters: [],
      genres: [],
      ownershipStatus: 'none'
    };
    burstBooks.value.unshift(placeholderBook);
    latestBurstBook.value = placeholderBook;

    externalMetadataService
      .fetchFromExternalSources(scannedIsbn)
      .then((meta) => {
        const idx = burstBooks.value.findIndex((b) => b.uri === placeholderUri);
        if (idx === -1) return;
        burstBooks.value[idx] = {
          ...burstBooks.value[idx],
          title: meta?.title?.trim() || `Livre ISBN ${scannedIsbn}`,
          authors: meta?.authors?.length ? meta.authors : ['Auteur inconnu'],
          publisher: meta?.publisher || '',
          publishDate: meta?.publishDate,
          pageCount: meta?.pageCount,
          coverUrl: meta?.coverUrl,
          series: meta?.series,
          seriesNumber: meta?.seriesNumber,
          genres: meta?.genres || []
        };
        if (latestBurstBook.value?.uri === placeholderUri) {
          latestBurstBook.value = burstBooks.value[idx];
        }
      })
      .catch((e: unknown) => {
        console.warn('[BURST SCAN] Échec enrichissement aperçu :', e);
      });
  },

  clearBurstBooks() {
    burstBooks.value = [];
    latestBurstBook.value = null;
  },

  async switchMode(newMode: ScannerMode) {
    activeMode.value = newMode;
    errorMessage.value = null;
    if (isScanningActive.value && activeRouter) {
      await this.startScan(activeRouter, newMode);
    }
  },

  async stopScan() {
    await barcodeIsbnProvider.stopScanner();
    isScanningActive.value = false;
    isSearching.value = false;
  },

  toggleScan(router: Router, mode?: ScannerMode) {
    if (isScanningActive.value && (!mode || activeMode.value === mode)) {
      this.stopScan();
    } else {
      // Par défaut, cliquer sur Scanner ouvre le Scan simple
      this.startScan(router, mode || 'simple');
    }
  }
};
