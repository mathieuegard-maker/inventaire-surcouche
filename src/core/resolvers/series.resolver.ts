// src/core/resolvers/series.resolver.ts

export const seriesResolver = {
  /**
   * Récupère la liste brute des œuvres (wd:) constituant une série.
   * Aucune traduction ni résolution d'édition n'est effectuée ici.
   */
  async getSeriesWorks(seriesId: string): Promise<string[]> {
    console.group(`[SERIES RESOLVER] Récupération de la série: ${seriesId}`);
    try {
      const resList = await fetch(`/api/gateway?action=series-list&seriesId=${encodeURIComponent(seriesId)}`);
      const dataList = await resList.json();
      
      const tomeUris = dataList.uris || dataList.tomes || [];
      
      if (!tomeUris || tomeUris.length === 0) {
        console.log(`[SERIES RESOLVER] Aucun tome trouvé pour la série.`);
        return [];
      }

      console.log(`[SERIES RESOLVER] ${tomeUris.length} œuvres trouvées pour la saga.`);
      return tomeUris;
    } catch (e) {
      console.error(`[SERIES RESOLVER] Erreur lors de la récupération :`, e);
      return [];
    } finally {
      console.groupEnd();
    }
  }
};