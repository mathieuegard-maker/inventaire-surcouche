// src/core/resolvers/entity.resolver.ts
import { entityMapper } from './mapper';
import { entityHumanizer } from './humanizer';
import type { RawBook, HumanizedBook } from '../types';
import { fetchWithTimeout } from '../../state/connection';

async function scavengeMissingImage(entityData: any, workUri: string, entityId: string): Promise<void> {
  // Correction du bug `{}` : On vérifie que l'image existe ET qu'elle n'est pas un objet vide
  const hasValidImage = entityData.image && (
    typeof entityData.image === 'string' || 
    (typeof entityData.image === 'object' && Object.keys(entityData.image).length > 0)
  );

  // Si on a déjà une vraie image ou si l'édition n'est reliée à aucune œuvre, on abandonne
  if (hasValidImage || !workUri) return;

  console.log(`[ENTITY RESOLVER] Couverture manquante (ou objet vide) pour ${entityId}. Début du pillage sur l'œuvre ${workUri}...`);
  try {
    const sibRes = await fetchWithTimeout(`/api/gateway?action=reverse-claims&property=wdt:P629&value=${encodeURIComponent(workUri)}`);
    const sibData = await sibRes.json();
    const siblingUris = (sibData.uris || []).filter((u: string) => u !== entityId);
    
    if (siblingUris.length === 0) return;

    const topSiblings = siblingUris.slice(0, 10);
    const imgRes = await fetchWithTimeout(`/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(topSiblings.join('|'))}&attributes=image`);
    const imgData = await imgRes.json();
    
    for (const sUri of topSiblings) {
      const sisImage = imgData.entities?.[sUri]?.image;
      const isValidSisImage = sisImage && (
        typeof sisImage === 'string' || 
        (typeof sisImage === 'object' && Object.keys(sisImage).length > 0)
      );

      if (isValidSisImage) {
        console.log(`[ENTITY RESOLVER] ✅ Couverture trouvée chez la sœur : ${sUri}. Pillage réussi.`);
        entityData.image = sisImage;
        break;
      }
    }
  } catch (e) {
    console.warn(`[ENTITY RESOLVER] Échec du pillage de couverture :`, e);
  }
}

export const entityResolver = {
  /**
   * Maintenu pour la compatibilité stricte avec d'éventuels appels ISBN résiduels
   */
  async fromIsbn(isbn: string): Promise<RawBook | null> {
    try {
      const searchUri = `isbn:${isbn}`;
      const url = `/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(searchUri)}&attributes=${encodeURIComponent('info|labels|descriptions|claims|image')}&relatives=wdt:P629`;
      
      const res = await fetchWithTimeout(url, {
        headers: { 'Accept': 'application/json' }
      });
      const data = await res.json();
      
      const entityId = Object.keys(data.entities || {}).find(k => k === searchUri || !k.startsWith('wd:')) || Object.keys(data.entities || {})[0];
      const entityData = data.entities?.[entityId];

      if (!entityData) {
        console.warn(`[RESOLVER] Aucun résultat pour l'ISBN : ${isbn}`);
        return null;
      }

      console.log(`[DEBUG-RESOLVER] Données brutes de l'édition (${entityId}) :`, entityData);
      console.log(`[DEBUG-RESOLVER] Champ image présent sur édition ? :`, !!entityData.image);

      const workClaim = entityData.claims?.['wdt:P629']?.[0] || entityData.claims?.['P629']?.[0];
      const workUri = typeof workClaim === 'string' ? workClaim : workClaim?.value;
      
      await scavengeMissingImage(entityData, workUri, entityId);

      let workData = workUri ? data.entities?.[workUri] : undefined;
      if (workUri && !workData) {
        const wRes = await fetchWithTimeout(`/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(workUri)}&attributes=${encodeURIComponent('info|labels|descriptions|claims|image')}`, {
          headers: { 'Accept': 'application/json' }
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
      const url = `/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(physicalUri)}&attributes=${encodeURIComponent('info|labels|descriptions|claims|image')}&relatives=wdt:P629`;
      
      const res = await fetchWithTimeout(url, {
        headers: { 'Accept': 'application/json' }
      });
      const data = await res.json();
      
      // CRITICAL FIX : L'API renvoie la vraie URI 'inv:...' même si on cherche par 'isbn:...'
      // On doit donc récupérer la vraie clé de l'entité retournée.
      const resolvedEntityId = data.entities?.[physicalUri]
        ? physicalUri
        : (Object.keys(data.entities || {}).find(k => !k.startsWith('wd:')) || Object.keys(data.entities || {})[0]);
      const entityData = data.entities?.[resolvedEntityId];

      if (!entityData) {
        console.warn(`[ENTITY RESOLVER] Aucune entité trouvée pour la requête : ${physicalUri}`);
        return null;
      }

      const workClaim = entityData.claims?.['wdt:P629']?.[0] || entityData.claims?.['P629']?.[0];
      const workUri = typeof workClaim === 'string' ? workClaim : workClaim?.value;
      
      await scavengeMissingImage(entityData, workUri, resolvedEntityId);

      let workData = workUri ? data.entities?.[workUri] : undefined;
      if (workUri && !workData) {
        const wRes = await fetchWithTimeout(`/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(workUri)}&attributes=${encodeURIComponent('info|labels|descriptions|claims|image')}`, {
           headers: { 'Accept': 'application/json' }
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