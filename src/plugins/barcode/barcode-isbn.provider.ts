// src/plugins/barcode/barcode-isbn.provider.ts
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { searchService } from '../../core/orchestrators/search.orchestrator';
import type { SearchResponse } from '../../core/types';

let html5QrcodeInstance: Html5Qrcode | null = null;

export const barcodeIsbnProvider = {
  /**
   * Initialise le flux caméra sous-jacent, capture le code EAN et délègue immédiatement la recherche sémantique à l'orchestrateur
   */
  async startScanner(
    containerId: string,
    onResult: (response: SearchResponse | null) => void,
    onError: (errorMsg: string) => void,
    onScanningReady?: () => void
  ): Promise<void> {
    try {
      // Nettoyage préventif d'une instance matérielle précédente
      if (html5QrcodeInstance && html5QrcodeInstance.isScanning) {
        await this.stopScanner();
      }

      html5QrcodeInstance = new Html5Qrcode(containerId);

      const config = {
        fps: 12,
        qrbox: (width: number, height: number) => {
          // Zone de ciblage optimisée pour les formats horizontaux de codes-barres d'éditions (ISBN)
          const boxWidth = Math.min(width * 0.85, 320);
          const boxHeight = Math.min(height * 0.45, 160);
          return { width: boxWidth, height: boxHeight };
        },
        formatsToSupport: [
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8
        ]
      };

      await html5QrcodeInstance.start(
        { facingMode: 'environment' },
        config,
        async (decodedText) => {
          const cleanIsbn = decodedText.trim();
          if (cleanIsbn) {
            // Arrêt immédiat du capteur matériel dès l'interception du signal
            await this.stopScanner();
            
            try {
              // Envoi direct de la valeur décodée à l'orchestrateur du Middle-End
              const searchResponse = await searchService.searchByIsbn(cleanIsbn);
              onResult(searchResponse);
            } catch (err: any) {
              console.error("[BARCODE PLUGIN] Échec lors de la transmission à l'orchestrateur :", err);
              onError(err.message || "Erreur lors du traitement de l'ouvrage.");
            }
          }
        },
        () => {
          // Frame non décodée : capture silencieuse pour éviter la saturation de la console
        }
      );

      if (onScanningReady) {
        onScanningReady();
      }
    } catch (err: any) {
      console.error("[BARCODE PLUGIN] Erreur critique d'accès au périphérique de capture :", err);
      onError("Impossible d'accéder à la caméra. Veuillez accorder les permissions nécessaires.");
    }
  },

  /**
   * Interrompt proprement l'alimentation de la caméra et libère le pointeur matériel
   */
  async stopScanner(): Promise<void> {
    if (html5QrcodeInstance) {
      if (html5QrcodeInstance.isScanning) {
        try {
          await html5QrcodeInstance.stop();
        } catch (err) {
          console.error("[BARCODE PLUGIN] Échec de l'interruption du flux vidéo :", err);
        }
      }
      html5QrcodeInstance = null;
    }
  }
};