import { fetchWithTimeout } from '../../state/connection';

export interface SearchResultItem {
  uri: string;
  type: 'author' | 'series' | 'work' | 'unknown';
  label: string;
  description?: string;
  coverUrl?: string;
}

export interface InventaireSearchProvider {
  searchByKeywords(query: string): Promise<SearchResultItem[]>;
  fetchAuthorWorks(authorUri: string): Promise<string[]>;
}

export const inventaireSearchProvider: InventaireSearchProvider = {
  /**
   * Interroge la gateway pour obtenir une auto-complétion et une recherche textuelle globale
   * Ventile les résultats bruts sous forme d'objets normalisés SearchResultItem
   */
  async searchByKeywords(query: string): Promise<SearchResultItem[]> {
    if (!query || !query.trim()) return [];
    
    try {
      const response = await fetchWithTimeout(`/api/gateway?action=search-text&q=${encodeURIComponent(query.trim())}`);
      if (!response.ok) {
        throw new Error(`Erreur gateway HTTP ${response.status}`);
      }
      
      const data = await response.json();
      // Sécurisation adaptative : gère si l'API renvoie directement un tableau ou un objet encapsulé
      const results = Array.isArray(data) ? data : (data.results || data.items || []);
      
      return results.map((item: any) => {
        // Détermination stricte du type sémantique instancié
        let computedType: 'author' | 'series' | 'work' | 'unknown' = 'unknown';
        
        // CORRECTION INTERCEPTION : Prise en compte des types exacts "humans" et "works" retournés par l'enum d'Inventaire
        if (item.type === 'human' || item.type === 'humans' || item.type === 'author' || (item.uri?.includes('Q') && item.claims?.['wdt:P31']?.includes('wd:Q5'))) {
          computedType = 'author';
        } else if (item.type === 'series' || item.claims?.['wdt:P31']?.includes('wd:Q19832840') || item.claims?.['wdt:P31']?.includes('wd:Q4301548')) {
          computedType = 'series';
        } else if (item.type === 'work' || item.type === 'works' || item.type === 'edition') {
          computedType = 'work';
        }

        return {
          uri: item.uri || item.id,
          type: computedType,
          label: item.label || item.name || 'SANS TITRE',
          description: item.description || undefined,
          coverUrl: item.image || undefined
        };
      });
    } catch (error) {
      console.error('[INVENTAIRE SEARCH PROVIDER] Échec de la recherche sémantique textuelle :', error);
      return [];
    }
  },

  /**
   * Récupère toutes les œuvres conceptuelles (Works) rattachées à un auteur spécifique
   * via l'endpoint dédié de l'API d'Inventaire.io
   */
  async fetchAuthorWorks(authorUri: string): Promise<string[]> {
    if (!authorUri) return [];
    
    try {
      const response = await fetchWithTimeout(`/api/gateway?action=author-works&authorUri=${encodeURIComponent(authorUri)}`);
      if (!response.ok) {
        throw new Error(`Erreur gateway HTTP ${response.status}`);
      }
      const data = await response.json();
      // Extraction adaptative selon la forme de l'objet de retour de l'endpoint dédié
      const rawList = data.uris || data.items || data.works || (Array.isArray(data) ? data : []);
      return rawList.map((item: any) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') return item.uri || item.id;
        return '';
      }).filter((uri: string) => !!uri);
    } catch (error) {
      console.error(`[INVENTAIRE SEARCH PROVIDER] Échec de la récupération des œuvres de l'auteur ${authorUri} :`, error);
      return [];
    }
  }
};