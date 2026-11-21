// src/plugins/barcode/barcode-isbn.provider.ts
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { searchService } from '../../core/orchestrators/search.orchestrator';
import { isbnUtil } from '../../core/utils/isbn.util';
import { connectionState } from '../../state/connection';
import type { SearchResponse } from '../../core/types';

let html5QrcodeInstance: Html5Qrcode | null = null;
const recentScansCooldown = new Map<string, number>();
const COOLDOWN_MS = 3200;

/**
 * Émet un court bip sonore de confirmation via Web Audio API (0 dépendance externe)
 */
export function playScanBeep(type: 'success' | 'duplicate' = 'success'): void {
  try {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(type === 'success' ? 85 : [45, 50, 45]);
    }
  } catch {
    // Ignore si non supporté
  }
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = type === 'success' ? 1046.5 : 440; // Do6 (succès) ou La4 (doublon)
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.14);
    setTimeout(() => ctx.close().catch(() => {}), 200);
  } catch {
    // Ignore si l'audio est bloqué par le navigateur
  }
}

export const barcodeIsbnProvider = {
  /**
   * Démarre le scanner caméra en mode Unitaire (`continuous: false`) ou Rafale (`continuous: true`)
   */
  async startScanner(
    containerId: string,
    onResult: (response: SearchResponse | null, rawIsbn?: string) => void,
    onError: (errorMsg: string) => void,
    onScanningReady?: () => void,
    options?: { continuous?: boolean; onBarcodeDetected?: (isbn: string) => void; skipLookup?: boolean }
  ): Promise<void> {
    const continuous = Boolean(options?.continuous);
    const skipLookup = Boolean(options?.skipLookup);
    try {
      if (html5QrcodeInstance && html5QrcodeInstance.isScanning) {
        await this.stopScanner();
      }

      html5QrcodeInstance = new Html5Qrcode(containerId);

      const config = {
        fps: 12,
        qrbox: (width: number, height: number) => {
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
          const cleanIsbn = isbnUtil.normalize(decodedText.trim());
          const isPressEan = /^(330|378|977)\d{10}$/.test(cleanIsbn);
          if (!cleanIsbn || (!isbnUtil.isValidBookBarcode(cleanIsbn) && !isPressEan)) {
            return;
          }

          // Anti-rebond en mode rafale : ignore le même ISBN pendant 3,2 secondes
          const now = Date.now();
          const lastTime = recentScansCooldown.get(cleanIsbn) || 0;
          if (now - lastTime < COOLDOWN_MS) {
            return;
          }
          recentScansCooldown.set(cleanIsbn, now);

          if (!continuous) {
            await this.stopScanner();
            options?.onBarcodeDetected?.(cleanIsbn);
            if (skipLookup) {
              return;
            }
          }

          try {
            const searchResponse = await searchService.searchByIsbn(cleanIsbn);
            onResult(searchResponse, cleanIsbn);
          } catch (err: any) {
            console.error('[BARCODE PLUGIN] Échec lors de la transmission à l orchestrateur :', err);
            if (connectionState.isOffline.value || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
              onResult({ isOfflineUnavailable: true, isbn: cleanIsbn } as any, cleanIsbn);
              return;
            }
            if (!continuous) {
              onError(err.message || "Erreur lors du traitement de l'ouvrage.");
            }
          }
        },
        () => {
          // Frame non décodée : ignorée silencieusement
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
