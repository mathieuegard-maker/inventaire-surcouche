import { ref } from 'vue';
import { barcodeIsbnProvider } from '../plugins/barcode/barcode-isbn.provider';
import { TEXTS } from '../ui/locales/fr';
import type { Router } from 'vue-router';

const isScanningActive = ref(false);
const isSearching = ref(false);
const errorMessage = ref<string | null>(null);

export const scannerState = {
  isScanningActive,
  isSearching,
  errorMessage,

  async startScan(router: Router) {
    errorMessage.value = null;
    isScanningActive.value = true;
    
    // Petit délai pour s'assurer que le DOM a rendu la div avec l'ID viewport
    setTimeout(async () => {
      try {
        await barcodeIsbnProvider.startScanner(
          'global-barcode-scanner-viewport',
          (response) => {
            isScanningActive.value = false;
            isSearching.value = false;
            if (response && response.mainBook?.uri) {
              router.push(`/book/${encodeURIComponent(response.mainBook.uri)}`);
            } else {
              errorMessage.value = TEXTS.scanner?.notFound || 'Ouvrage non trouvé.';
            }
          },
          (errorMsg) => {
            isScanningActive.value = false;
            isSearching.value = false;
            errorMessage.value = errorMsg;
          },
          () => {
            isSearching.value = true;
          }
        );
      } catch (err: any) {
        isScanningActive.value = false;
        isSearching.value = false;
        errorMessage.value = err.message || "Erreur de démarrage du scanner.";
      }
    }, 150);
  },

  async stopScan() {
    await barcodeIsbnProvider.stopScanner();
    isScanningActive.value = false;
    isSearching.value = false;
  },

  toggleScan(router: Router) {
    if (isScanningActive.value) {
      this.stopScan();
    } else {
      this.startScan(router);
    }
  }
};
