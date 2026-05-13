// src/resolvers/entity.resolver.ts
import { entityMapper } from './mapper';
import type { RawBook } from './types';

export const entityResolver = {
  /**
   * Recherche un livre par son ISBN
   */
  async fromIsbn(isbn: string): Promise<RawBook | null> {
    try {
      const res = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=isbn:${isbn}`, {
        headers: { 
          'Accept': 'application/json', 
          'User-Agent': 'InventaireMobileOverlay/1.8 (mathieu.egard@gmail.com)' 
        }
      });
      const data = await res.json();
      const entityId = Object.keys(data.entities || {})[0];

      if (!entityId) return null;

      const entityData = data.entities[entityId];
      return entityMapper.mapResponse(`isbn:${isbn}`, entityData);
    } catch (error) {
      console.error("[ENTITY RESOLVER] Erreur ISBN:", error);
      return null;
    }
  },

  /**
   * Recherche un livre par son URI (ex: wd:Q123) - Essentiel pour l'hydratation
   */
  async fromUri(uri: string): Promise<RawBook | null> {
    try {
      const res = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(uri)}`, {
        headers: { 
          'Accept': 'application/json', 
          'User-Agent': 'InventaireMobileOverlay/1.8 (mathieu.egard@gmail.com)' 
        }
      });
      const data = await res.json();
      
      const entityData = data.entities?.[uri];
      if (!entityData) return null;

      return entityMapper.mapResponse(uri, entityData);
    } catch (error) {
      console.error(`[ENTITY RESOLVER] Erreur URI (${uri}):`, error);
      return null;
    }
  },

  /**
   * Résout un identifiant brut (ex: wd:Q42) en nom lisible (Auteurs, Éditeurs, Séries...)
   */
  async resolveName(uri: string): Promise<string | undefined> {
    if (!uri) return undefined;
    
    try {
      const res = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(uri)}`, {
        headers: { 
          'Accept': 'application/json', 
          'User-Agent': 'InventaireMobileOverlay/1.8 (mathieu.egard@gmail.com)' 
        }
      });
      const data = await res.json();
      
      const entity = data.entities?.[uri];
      if (!entity) return undefined;

      const label = entity.labels?.fr || entity.labels?.en || entity.label;
      return label || undefined;
      
    } catch (error) {
      console.error(`[ENTITY RESOLVER] Impossible de résoudre le nom pour ${uri}:`, error);
      return undefined;
    }
  },

  /**
   * Récupère la "meilleure" édition pour une œuvre donnée
   */
  async getBestEdition(workUri: string): Promise<string | null> {
    try {
      const res = await fetch(`https://inventaire.io/api/entities?action=reverse-claims&property=P629&value=${workUri}`, {
        headers: { 
          'Accept': 'application/json', 
          'User-Agent': 'InventaireMobileOverlay/1.8 (mathieu.egard@gmail.com)' 
        }
      });
      const data = await res.json();
      const uris = data.uris || [];
      return uris.length > 0 ? uris[0] : null;
    } catch (error) {
      console.error(`[ENTITY RESOLVER] Erreur best edition pour ${workUri}:`, error);
      return null;
    }
  },

  /**
   * Résout une liste d'œuvres en leurs meilleures éditions respectives
   */
  async resolveBestEditions(workUris: string[]): Promise<string[]> {
    const results = await Promise.all(workUris.map(uri => this.getBestEdition(uri)));
    return results.filter((uri): uri is string => uri !== null);
  }
};