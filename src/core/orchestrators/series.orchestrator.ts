// src/core/orchestrators/series.orchestrator.ts
import { databaseService } from '../database/database.service';
import { syncOrchestrator } from './sync.orchestrator';
import type { SeriesContext, HumanizedBook } from '../types';

export const seriesOrchestrator = {
  /**
   * Construit le contexte complet d'une série pour l'interface utilisateur.
   * Récupère les données locales instantanément et déclenche une mise à jour en arrière-plan.
   * Réutilisable par n'importe quel composant Vue (Recherche, Bibliothèque, etc.)
   */
  async getCompleteSeriesForUI(seriesId: string, seriesName?: string): Promise<SeriesContext | undefined> {
    if (!seriesId) return undefined;

    console.log(`[SERIES ORCHESTRATOR] Construction du paquet UI pour la série : ${seriesId}`);

    // 1. Récupération instantanée depuis le cache local (Local-First)
    const tomes: HumanizedBook[] = await databaseService.getBooksBySeriesId(seriesId);

    // 2. Fire & Forget : Aspiration des tomes manquants en arrière-plan
    syncOrchestrator.hydrateSeriesInBackground(seriesId);

    // 3. Tri des tomes par numéro
    tomes.sort((a, b) => parseInt(a.seriesNumber || '999') - parseInt(b.seriesNumber || '999'));
    
    // 4. Calcul des statistiques de possession
    const ownedCount = tomes.filter(t => t.ownershipStatus === 'owned').length;

    // 5. Paquet "SeriesContext" standardisé et prêt à l'emploi pour le front
    return {
      id: seriesId,
      name: seriesName,
      tomes: tomes,
      ownedCount: ownedCount,
      isComplete: tomes.length > 0 && ownedCount === tomes.length
    };
  }
};