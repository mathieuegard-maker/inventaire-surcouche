// src/core/orchestrators/series.orchestrator.ts
import { databaseService } from '../database/database.service';
import { syncOrchestrator } from './sync.orchestrator';
import type { SeriesContext, HumanizedBook } from '../types';

export const seriesOrchestrator = {
  /**
   * Construit le contexte complet d'une série pour l'interface utilisateur.
   * Récupère les données locales instantanément et déclenche une mise à jour en arrière-plan.
   */
  async getCompleteSeriesForUI(seriesId: string, seriesName?: string): Promise<SeriesContext | undefined> {
    if (!seriesId) return undefined;

    console.log(`[SERIES ORCHESTRATOR] Construction du paquet UI pour la série : ${seriesId}`);

    // 1. Récupération instantanée depuis le cache local (Local-First)
    const tomes: HumanizedBook[] = await databaseService.getBooksBySeriesId(seriesId);

    // 2. CRITICAL FIX : Double-check sémantique (Édition + Œuvre) pour synchroniser l'inventaire et la Wishlist serveur
    for (const tome of tomes) {
      // Vérification de l'inventaire (soit l'édition physique, soit l'œuvre abstraite)
      const isInInventory = await databaseService.isUriInRegistry('inventory', tome.uri) || 
                            (tome.workUri ? await databaseService.isUriInRegistry('inventory', tome.workUri) : false);
      
      if (isInInventory) {
        tome.ownershipStatus = 'owned';
      } else {
        // Vérification de la Wishlist (soit l'édition physique, soit l'œuvre abstraite de type workUri)
        const isInWishlist = await databaseService.isUriInRegistry('wishlist', tome.uri) || 
                             (tome.workUri ? await databaseService.isUriInRegistry('wishlist', tome.workUri) : false);
        if (isInWishlist) {
          tome.ownershipStatus = 'wish';
        } else {
          tome.ownershipStatus = 'none';
        }
      }
    }

    // 3. Fire & Forget : Aspiration des tomes manquants en arrière-plan
    syncOrchestrator.hydrateSeriesInBackground(seriesId);

    // 4. Tri des tomes par numéro
    tomes.sort((a, b) => parseInt(a.seriesNumber || '999') - parseInt(b.seriesNumber || '999'));
    
    // 5. Calcul des statistiques de possession
    const ownedCount = tomes.filter(t => t.ownershipStatus === 'owned').length;

    // 6. Paquet "SeriesContext" standardisé et prêt à l'emploi pour le front
    return {
      id: seriesId,
      name: seriesName,
      tomes: tomes,
      ownedCount: ownedCount,
      isComplete: tomes.length > 0 && ownedCount === tomes.length
    };
  }
};