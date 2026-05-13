// src/resolvers/entity.resolver.ts
import { entityMapper } from './mapper';
import type { RawBook } from './types';

const USER_AGENT = 'InventaireMobileOverlay/1.8 (mathieu.egard@gmail.com)';

export const entityResolver = {
  /**
   * Recherche un livre par son ISBN et récupère systématiquement l'œuvre liée
   */
  async fromIsbn(isbn: string): Promise<RawBook | null> {
    try {
      const searchUri = `isbn:${isbn}`;
      const res = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${searchUri}`, {
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT }
      });
      const data = await res.json();
      
      // CORRECTION : L'API indexe par l'URI réelle (inv:...) et non par "isbn:..."
      // On récupère donc la première clé disponible dans l'objet entities
      const entityId = Object.keys(data.entities || {})[0];
      const entityData = data.entities?.[entityId];

      if (!entityData) {
        console.warn(`[RESOLVER] Aucun résultat pour l'ISBN : ${isbn}`);
        return null;
      }

      // Récupération systématique de l'œuvre (P629) si elle existe
      const workUri = entityData.claims?.['wdt:P629']?.[0];
      let workData = null;

      if (workUri) {
        console.log(`[RESOLVER] Édition trouvée (${entityId}). Rebond sur l'œuvre : ${workUri}`);
        const resWork = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(workUri)}`, {
          headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT }
        });
        const dataWork = await resWork.json();
        workData = dataWork.entities?.[workUri];
      }

      // On passe l'ID réel (entityId) au mapper plutôt que la chaîne de recherche
      return entityMapper.mapResponse(entityId, entityData, workData);
    } catch (error) {
      console.error("[ENTITY RESOLVER] Erreur ISBN:", error);
      return null;
    }
  },

  /**
   * Recherche par URI (ex: wd:Q123) avec enrichissement par l'œuvre
   */
  async fromUri(uri: string): Promise<RawBook | null> {
    try {
      const res = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(uri)}`, {
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT }
      });
      const data = await res.json();
      
      // Ici l'URI est déjà la bonne clé (wd: ou inv:)
      const entityData = data.entities?.[uri];
      
      if (!entityData) return null;

      if (entityData.type === 'work') {
        return entityMapper.mapResponse(uri, entityData);
      }

      const workUri = entityData.claims?.['wdt:P629']?.[0];
      let workData = null;

      if (workUri) {
        const resWork = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(workUri)}`, {
          headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT }
        });
        const dataWork = await resWork.json();
        workData = dataWork.entities?.[workUri];
      }

      return entityMapper.mapResponse(uri, entityData, workData);
    } catch (error) {
      console.error(`[ENTITY RESOLVER] Erreur URI (${uri}):`, error);
      return null;
    }
  },

  /**
   * Résout un identifiant brut (ex: wd:Q42) en nom lisible
   */
  async resolveName(uri: string): Promise<string | undefined> {
    if (!uri) return undefined;
    
    try {
      const res = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(uri)}`, {
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT }
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
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT }
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