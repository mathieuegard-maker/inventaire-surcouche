// src/resolvers/entity.resolver.ts
import { entityMapper } from './mapper';
import type { RawBook } from '../types';

const USER_AGENT = 'InventaireMobileOverlay/1.8 (mathieu.egard@gmail.com)';

export const entityResolver = {
  /**
   * Recherche un livre par son ISBN et récupère systématiquement l'œuvre liée
   */
  async fromIsbn(isbn: string): Promise<RawBook | null> {
    try {
      const searchUri = `isbn:${isbn}`;
      // On demande explicitement l'image et les claims pour ne rien rater
      const url = `https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(searchUri)}&attributes=info|labels|descriptions|claims|image`;
      
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT }
      });
      const data = await res.json();
      
      const entityId = Object.keys(data.entities || {})[0];
      const entityData = data.entities?.[entityId];

      if (!entityData) {
        console.warn(`[RESOLVER] Aucun résultat pour l'ISBN : ${isbn}`);
        return null;
      }

      // SONDE DEBUG : RAW DATA API
      console.log(`[DEBUG-RESOLVER] Données brutes de l'édition (${entityId}) :`, entityData);
      console.log(`[DEBUG-RESOLVER] Champ image présent sur édition ? :`, !!entityData.image);

      // Extraction robuste de l'identifiant de l'œuvre (P629)
      const workClaim = entityData.claims?.['wdt:P629']?.[0] || entityData.claims?.['P629']?.[0];
      const workUri = typeof workClaim === 'string' ? workClaim : workClaim?.value;
      
      let workData = null;

      if (workUri) {
        console.log(`[RESOLVER] Édition trouvée (${entityId}). Rebond sur l'œuvre : ${workUri}`);
        const workUrl = `https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(workUri)}&attributes=info|labels|descriptions|claims|image`;
        
        const resWork = await fetch(workUrl, {
          headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT }
        });
        const dataWork = await resWork.json();
        workData = dataWork.entities?.[workUri];

        // SONDE DEBUG : RAW DATA OEUVRE
        console.log(`[DEBUG-RESOLVER] Données brutes de l'œuvre (${workUri}) :`, workData);
        console.log(`[DEBUG-RESOLVER] Champ image présent sur œuvre ? :`, !!workData?.image);
      }

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
      const url = `https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(uri)}&attributes=info|labels|descriptions|claims|image`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT }
      });
      const data = await res.json();
      
      const entityData = data.entities?.[uri];
      
      if (!entityData) return null;

      if (entityData.type === 'work') {
        return entityMapper.mapResponse(uri, entityData);
      }

      const workClaim = entityData.claims?.['wdt:P629']?.[0] || entityData.claims?.['P629']?.[0];
      const workUri = typeof workClaim === 'string' ? workClaim : workClaim?.value;
      let workData = null;

      if (workUri) {
        const workUrl = `https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(workUri)}&attributes=info|labels|descriptions|claims|image`;
        const resWork = await fetch(workUrl, {
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