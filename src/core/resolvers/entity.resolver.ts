// src/core/resolvers/entity.resolver.ts
import { entityMapper } from './mapper';
import { entityHumanizer } from './humanizer';
import type { RawBook, HumanizedBook } from '../types';

const USER_AGENT = 'InventaireMobileOverlay/1.8 (mathieu.egard@gmail.com)';

export const entityResolver = {
  /**
   * Maintenu pour la compatibilité stricte avec d'éventuels appels ISBN résiduels
   */
  async fromIsbn(isbn: string): Promise<RawBook | null> {
    try {
      const searchUri = `isbn:${isbn}`;
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

      console.log(`[DEBUG-RESOLVER] Données brutes de l'édition (${entityId}) :`, entityData);
      console.log(`[DEBUG-RESOLVER] Champ image présent sur édition ? :`, !!entityData.image);

      const workClaim = entityData.claims?.['wdt:P629']?.[0] || entityData.claims?.['P629']?.[0];
      const workUri = typeof workClaim === 'string' ? workClaim : workClaim?.value;
      
      let workData = undefined;
      if (workUri) {
        const wRes = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(workUri)}&attributes=info|labels|descriptions|claims|image`, {
          headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT }
        });
        const wData = await wRes.json();
        workData = wData.entities?.[workUri];
      }

      return entityMapper.mapResponse(entityId, entityData, workData);
    } catch (error) {
      console.error(`[ENTITY RESOLVER] Erreur pour ISBN ${isbn}:`, error);
      return null;
    }
  },

  /**
   * [NOUVEAU - V2] Spécialiste des éditions. Prend une URI Physique, résout le graphe,
   * mappe et humanise la réponse d'un coup.
   */
  async resolvePhysicalEntity(physicalUri: string): Promise<HumanizedBook | null> {
    try {
      const url = `https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(physicalUri)}&attributes=info|labels|descriptions|claims|image`;
      
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT }
      });
      const data = await res.json();
      
      // CRITICAL FIX : L'API renvoie la vraie URI 'inv:...' même si on cherche par 'isbn:...'
      // On doit donc récupérer la vraie clé de l'entité retournée.
      const resolvedEntityId = Object.keys(data.entities || {})[0];
      const entityData = data.entities?.[resolvedEntityId];

      if (!entityData) {
        console.warn(`[ENTITY RESOLVER] Aucune entité trouvée pour la requête : ${physicalUri}`);
        return null;
      }

      const workClaim = entityData.claims?.['wdt:P629']?.[0] || entityData.claims?.['P629']?.[0];
      const workUri = typeof workClaim === 'string' ? workClaim : workClaim?.value;
      
      let workData = undefined;
      if (workUri) {
        const wRes = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(workUri)}&attributes=info|labels|descriptions|claims|image`, {
           headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT }
        });
        const wData = await wRes.json();
        workData = wData.entities?.[workUri];
      }

      // On s'assure d'utiliser le resolvedEntityId (inv:...) et non la requête (isbn:...)
      const rawBook = entityMapper.mapResponse(resolvedEntityId, entityData, workData);
      const humanizedBook = await entityHumanizer.humanize(rawBook);
      
      return humanizedBook;
    } catch (error) {
      console.error(`[ENTITY RESOLVER] Erreur résolution physique pour ${physicalUri}:`, error);
      return null;
    }
  }
};