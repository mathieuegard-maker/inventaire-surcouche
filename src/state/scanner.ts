// src/state/scanner.ts
// État réactif global du Scanner 4 Modes :
// 1. 'simple' : Mode Simple (ouvre directement la fiche complète du livre et de sa série pour sélectionner à la main)
// 2. 'check'  : Mode Vérif Magasin (< 1s, affiche le verdict immédiat + tomes manquants sans quitter le scanner)
// 3. 'burst'  : Mode Rafale continu (empile les livres scannés en direct sous la caméra + bouton Valider & Transférer)
// 4. 'photo'  : Mode Photo Étagère / Couverture (lecture des tranches de BD via clé IA gratuite BYOK + validation par cases)

import { ref } from 'vue';
import type { Router } from 'vue-router';
import { barcodeIsbnProvider, playScanBeep } from '../plugins/barcode/barcode-isbn.provider';
import { queueService } from '../core/orchestrators/queue.orchestrator';
import { backgroundCreationOrchestrator } from '../core/orchestrators/background-creation.orchestrator';
import { externalMetadataService } from '../core/services/external-metadata.service';
import { databaseService } from '../core/database/database.service';
import type { SearchResponse } from '../core/types';

export type ScannerMode = 'simple' | 'check' | 'burst' | 'photo';
export type BurstTarget = 'owned' | 'wishlist';

export interface BurstScannedEntry {
  isbn: string;
  uri: string;
  title: string;
  series?: string;
  seriesNumber?: string;
  status: 'added' | 'already_owned' | 'creating_bg';
  target: BurstTarget;
  timestamp: number;
}

const isScanningActive = ref(false);
const isSearching = ref(false);
const errorMessage = ref<string | null>(null);
const activeMode = ref<ScannerMode>('simple');
const burstTarget = ref<BurstTarget>('owned');
const lastCheckResult = ref<(SearchResponse & { isUnknown?: boolean; isbn?: string }) | null>(null);
const burstHistory = ref<BurstScannedEntry[]>([]);
const latestBurstToast = ref<BurstScannedEntry | null>(null);
const lastUpdatedTick = ref<number>(Date.now());
let activeRouter: Router | null = null;

export const scannerState = {
  isScanningActive,
  isSearching,
  errorMessage,
  activeMode,
  burstTarget,
  lastCheckResult,
  burstHistory,
  latestBurstToast,
  lastUpdatedTick,

  notifyCatalogChanged() {
    lastUpdatedTick.value = Date.now();
  },

  async startScan(router: Router, mode?: ScannerMode) {
    activeRouter = router;
    if (mode) activeMode.value = mode;
    errorMessage.value = null;
    lastCheckResult.value = null;
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

            // Mode 'simple' : ouvre directement la fiche complète du livre (ou la création s'il est inconnu)
            if (activeMode.value === 'simple') {
              isSearching.value = false;
              playScanBeep('success');
              await this.stopScan();
              const cleanIsbn = rawIsbn || response?.isbn || response?.mainBook?.isbn13;
              if (response?.isUnknown && cleanIsbn) {
                router.push({ name: 'BookCreateUnknown', query: { isbn: cleanIsbn } });
              } else if (response?.mainBook?.uri) {
                router.push(`/book/${encodeURIComponent(response.mainBook.uri)}`);
              } else if (cleanIsbn) {
                router.push({ name: 'BookCreateUnknown', query: { isbn: cleanIsbn } });
              } else {
                errorMessage.value = 'Ouvrage non trouvé.';
              }
              return;
            }

            // Mode 'check' (Vérif Magasin < 1s)
            isSearching.value = false;
            if (response) {
              playScanBeep(response.ownership?.isWorkOwned ? 'duplicate' : 'success');
              lastCheckResult.value = {
                ...response,
                isbn: rawIsbn || response.isbn || response.mainBook?.isbn13
              };
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
    const target = burstTarget.value;

    // Évite de empiler deux fois le même ISBN dans la même session de rafale
    if (burstHistory.value.some((e) => e.isbn === scannedIsbn)) {
      playScanBeep('duplicate');
      return;
    }

    // Cas 1 : Livre résolu immédiatement (depuis le cache local ou auto-résolu sur Cloudflare D1 via BnF/Google/OL)
    if (response && response.mainBook?.uri && !response.isUnknown) {
      const book = response.mainBook;
      const alreadyOwned = Boolean(response.ownership?.isWorkOwned);

      if (alreadyOwned && target === 'owned') {
        playScanBeep('duplicate');
        const entry: BurstScannedEntry = {
          isbn: scannedIsbn,
          uri: book.uri,
          title: book.title,
          series: book.series,
          seriesNumber: book.seriesNumber,
          status: 'already_owned',
          target,
          timestamp: Date.now()
        };
        burstHistory.value.unshift(entry);
        latestBurstToast.value = entry;
        return;
      }

      playScanBeep('success');
      if (target === 'owned') {
        await queueService.enqueueAction('ADD_INVENTORY', book.uri);
      } else {
        await queueService.enqueueAction('ADD_WISHLIST', book.uri);
      }
      this.notifyCatalogChanged();

      const entry: BurstScannedEntry = {
        isbn: scannedIsbn,
        uri: book.uri,
        title: book.title,
        series: book.series,
        seriesNumber: book.seriesNumber,
        status: 'added',
        target,
        timestamp: Date.now()
      };
      burstHistory.value.unshift(entry);
      latestBurstToast.value = entry;
      return;
    }

    // Cas 2 : ISBN inconnu -> Enrichissement et création en tâche de fond sans bloquer la caméra !
    playScanBeep('success');
    const placeholderUri = `isbn:${scannedIsbn}`;
    const entry: BurstScannedEntry = {
      isbn: scannedIsbn,
      uri: placeholderUri,
      title: `ISBN ${scannedIsbn} (Recherche BnF...)`,
      status: 'creating_bg',
      target,
      timestamp: Date.now()
    };
    burstHistory.value.unshift(entry);
    latestBurstToast.value = entry;

    externalMetadataService
      .fetchFromExternalSources(scannedIsbn)
      .then(async (meta) => {
        const title = meta?.title?.trim() || `Livre ISBN ${scannedIsbn}`;
        entry.title = title;
        entry.series = meta?.series;
        entry.seriesNumber = meta?.seriesNumber;
        await backgroundCreationOrchestrator.enqueueBookCreation({
          tempBook: {
            uri: placeholderUri,
            type: 'edition',
            isbn13: scannedIsbn,
            title,
            authors: meta?.authors?.length ? meta.authors : ['Auteur inconnu'],
            illustrators: [],
            scriptwriters: [],
            publisher: meta?.publisher || '',
            publishDate: meta?.publishDate,
            pageCount: meta?.pageCount,
            coverUrl: meta?.coverUrl,
            series: meta?.series,
            seriesNumber: meta?.seriesNumber,
            genres: [],
            ownershipStatus: target === 'owned' ? 'owned' : 'wish'
          },
          expandSeries: Boolean(meta?.series)
        });
        entry.status = 'added';
        this.notifyCatalogChanged();
      })
      .catch((e: unknown) => {
        console.warn('[BURST SCAN] Échec enrichissement en tâche de fond :', e);
      });
  },

  async undoBurstEntry(entry: BurstScannedEntry) {
    burstHistory.value = burstHistory.value.filter((e) => e.timestamp !== entry.timestamp);
    if (latestBurstToast.value?.timestamp === entry.timestamp) {
      latestBurstToast.value = null;
    }
    if (entry.status === 'added' || entry.status === 'creating_bg') {
      if (entry.target === 'owned') {
        await queueService.enqueueAction('REMOVE_INVENTORY', entry.uri);
      } else {
        await queueService.enqueueAction('REMOVE_WISHLIST', entry.uri);
      }
      const cached = await databaseService.getBookFromCache(entry.uri);
      if (cached) {
        cached.ownershipStatus = 'none';
        await databaseService.saveBookToCache(cached);
      }
      this.notifyCatalogChanged();
    }
  },

  async finishAndOpenBurstTarget(router: Router) {
    const target = burstTarget.value;
    await this.stopScan();
    burstHistory.value = [];
    latestBurstToast.value = null;
    this.notifyCatalogChanged();
    if (target === 'owned') {
      await router.push({ name: 'CollectionView', query: { mode: 'books' } });
    } else {
      await router.push('/wishlist');
    }
  },

  async switchMode(newMode: ScannerMode) {
    activeMode.value = newMode;
    lastCheckResult.value = null;
    errorMessage.value = null;
    if (isScanningActive.value && activeRouter) {
      await this.startScan(activeRouter, newMode);
    }
  },

  async resumeCameraInCheckMode() {
    lastCheckResult.value = null;
    if (activeRouter) {
      await this.startScan(activeRouter, 'check');
    }
  },

  async stopScan() {
    await barcodeIsbnProvider.stopScanner();
    isScanningActive.value = false;
    isSearching.value = false;
    lastCheckResult.value = null;
    this.notifyCatalogChanged();
  },

  toggleScan(router: Router, mode?: ScannerMode) {
    if (isScanningActive.value && (!mode || activeMode.value === mode)) {
      this.stopScan();
    } else {
      this.startScan(router, mode || activeMode.value);
    }
  }
};
