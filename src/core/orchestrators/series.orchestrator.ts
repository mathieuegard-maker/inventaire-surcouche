// src/core/orchestrators/series.orchestrator.ts
import { ref, computed } from 'vue';
import { databaseService } from '../database/database.service';
import { syncOrchestrator } from './sync.orchestrator';
import type { SeriesContext, HumanizedBook } from '../types';

export interface HydrationProgress {
  current: number;
  total: number;
  isActive: boolean;
}

// Registre réactif global partagé pour suivre la progression à travers les vues
const progressRegistry = ref<Record<string, HydrationProgress>>({});

export const seriesOrchestrator = {
  /**
   * Fournit l'accès à l'état réactif de téléchargement d'une saga pour l'UI
   */
  getProgress(seriesId: string) {
    if (!progressRegistry.value[seriesId]) {
      progressRegistry.value[seriesId] = { current: 0, total: 0, isActive: false };
    }
    return computed(() => progressRegistry.value[seriesId]);
  },

  /**
   * Déclenche le téléchargement de fond asynchrone de manière étanche
   */
  startBackgroundHydration(seriesId: string): void {
    if (!seriesId) return;
    if (progressRegistry.value[seriesId]?.isActive) return;

    progressRegistry.value[seriesId] = { current: 0, total: 0, isActive: true };
    console.log(`[SERIES ORCHESTRATOR] 🚀 Aspiration asynchrone lancée pour la série : ${seriesId}`);

    // Transmission sécurisée du callback bi-argument résolu au niveau de syncOrchestrator
    syncOrchestrator.hydrateSeriesInBackground(seriesId, (current: number, total: number) => {
      if (progressRegistry.value[seriesId]) {
        progressRegistry.value[seriesId].current = current;
        progressRegistry.value[seriesId].total = total;
      }
    }).then(() => {
      if (progressRegistry.value[seriesId]) {
        progressRegistry.value[seriesId].isActive = false;
        console.log(`[SERIES ORCHESTRATOR] ✅ Tâche de fond complétée pour ${seriesId}`);
      }
    }).catch((err) => {
      console.error(`[SERIES ORCHESTRATOR] 💥 Échec tâche de fond pour ${seriesId} :`, err);
      if (progressRegistry.value[seriesId]) {
        progressRegistry.value[seriesId].isActive = false;
      }
    });
  },

  /**
   * Construit le contexte complet d'une série pour l'interface utilisateur.
   * Nettoyé de tout blocage synchrone pour du Local-First pur et instantané.
   */
  async getCompleteSeriesForUI(seriesId: string, seriesName?: string): Promise<SeriesContext | undefined> {
    if (!seriesId) return undefined;

    console.group(`[SERIES ORCHESTRATOR] Analyse de la saga : ${seriesId}`);

    // 1. Extraction rapide depuis le cache local (Local-First)
    const tomes: HumanizedBook[] = await databaseService.getBooksBySeriesId(seriesId);
    console.log(`[SERIES ORCHESTRATOR] Tomes trouvés en cache local : ${tomes.length}`);

    // 2. Couplage des registres (Inventaire, Wishlist, Prêts)
    for (const tome of tomes) {
      const isInInventory = await databaseService.isUriInRegistry('inventory', tome.uri) || 
                            (tome.workUri ? await databaseService.isUriInRegistry('inventory', tome.workUri) : false);
      
      if (isInInventory) {
        tome.ownershipStatus = 'owned';
        const activeLoan = await databaseService.getLoan(tome.uri);
        if (activeLoan) {
          tome.loan = activeLoan;
        }
      } else {
        const isInWishlist = await databaseService.isUriInRegistry('wishlist', tome.uri) || 
                             (tome.workUri ? await databaseService.isUriInRegistry('wishlist', tome.workUri) : false);
        if (isInWishlist) {
          tome.ownershipStatus = 'wish';
        } else {
          tome.ownershipStatus = 'none';
        }
      }
    }

    // 3. Tri numérique strict par numéro de volume
    tomes.sort((a, b) => parseInt(a.seriesNumber || '999') - parseInt(b.seriesNumber || '999'));
    
    // 4. Calcul des métadonnées de possession
    const ownedCount = tomes.filter(t => t.ownershipStatus === 'owned').length;

    console.groupEnd();

    // 5. Envoi du paquet complet standardisé à la vue
    return {
      id: seriesId,
      name: seriesName || (tomes.length > 0 ? tomes[0].series : undefined),
      tomes: tomes,
      ownedCount: ownedCount,
      isComplete: tomes.length > 0 && ownedCount === tomes.length
    };
  }
};