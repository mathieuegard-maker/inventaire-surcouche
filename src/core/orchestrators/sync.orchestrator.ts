// src/core/orchestrators/sync.orchestrator.ts
import { databaseService } from '../database/database.service';
import { entityHumanizer } from '../resolvers/humanizer';
import { entityMapper } from '../resolvers/mapper';
import { entityResolver } from '../resolvers/entity.resolver';
import { imageService } from '../services/image.service';

export const syncOrchestrator = {
  
  /**
   * AJOUT (TTL) : Rafraîchit un livre en cache de manière totalement silencieuse
   */
  async refreshBookInBackground(isbn: string): Promise<void> {
    console.log(`[BACKGROUND] Rafraîchissement silencieux (TTL) de l'ISBN: ${isbn}`);
    try {
      const raw = await entityResolver.fromIsbn(isbn);
      if (raw) {
        const book = await entityHumanizer.humanize(raw);
        await databaseService.saveBookToCache(book);
        
        // Compression de la nouvelle couverture si elle a changé
        if (book.coverUrl) {
          const base64 = await imageService.compressAndEncode(book.coverUrl);
          if (base64) {
            const currentBook = await databaseService.getBookFromCache(book.uri);
            if (currentBook) {
              currentBook.localCover = base64;
              await databaseService.saveBookToCache(currentBook);
            }
          }
        }
      }
    } catch (e) {
      console.error(`[BACKGROUND] Erreur lors du rafraîchissement de ${isbn}:`, e);
    }
  },

  /**
   * AJOUT (WINDOWING) : Aspire les tomes manquants d'une série longue (Mega-Batching)
   */
  async hydrateRemainingSeries(missingUris: string[]): Promise<void> {
    console.group(`[BACKGROUND SERIES] Aspiration silencieuse de ${missingUris.length} tomes...`);
    try {
      let addedCount = 0;
      const CHUNK_SIZE = 50;

      const inventoryUris = await databaseService.getAllRegistryUris('inventory');
      const wishlistUris = await databaseService.getAllRegistryUris('wishlist');

      for (let i = 0; i < missingUris.length; i += CHUNK_SIZE) {
        const chunk = missingUris.slice(i, i + CHUNK_SIZE);
        console.log(`[BACKGROUND SERIES] Traitement du lot ${Math.floor(i/CHUNK_SIZE) + 1} (${chunk.length} tomes)...`);
        
        try {
           const chunkUrl = `https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(chunk.join('|'))}&attributes=info|labels|descriptions|claims|image`;
           const res = await fetch(chunkUrl, { headers: { 'Accept': 'application/json', 'User-Agent': 'InventaireMobileOverlay/1.8' } });
           const data = await res.json();
           const entities = data.entities || {};

           const humanizePromises = chunk.map(async (uri) => {
              const entityData = entities[uri];
              if (!entityData) return;
              
              // Simplification : on ne fait pas de double-rebond pour le fond, l'édition suffit généralement
              const rawBook = entityMapper.mapResponse(uri, entityData, undefined);
              const humanizedBook = await entityHumanizer.humanize(rawBook);
              
              if (inventoryUris.includes(uri)) humanizedBook.ownershipStatus = 'owned';
              else if (wishlistUris.includes(uri)) humanizedBook.ownershipStatus = 'wish';
              
              await databaseService.saveBookToCache(humanizedBook);
              addedCount++;
           });

           await Promise.all(humanizePromises);
           
        } catch (chunkError) {
           console.error(`[BACKGROUND SERIES] 💥 Erreur fatale sur le lot ${Math.floor(i/CHUNK_SIZE) + 1}:`, chunkError);
        }
      }
      
      console.log(`[BACKGROUND SERIES] Terminée. ${addedCount} tomes aspirés.`);
    } catch (error) {
      console.error("[BACKGROUND SERIES] Erreur globale :", error);
    } finally {
      console.groupEnd();
    }
  },

  async hydrateCacheInBackground(): Promise<void> {
    console.group("[HYDRATATION] Démarrage de la tâche de fond (Mega-Batching)");
    try {
      const inventoryUris = await databaseService.getAllRegistryUris('inventory');
      const wishlistUris = await databaseService.getAllRegistryUris('wishlist');
      
      const allUris = Array.from(new Set([...inventoryUris, ...wishlistUris]));
      console.log(`[HYDRATATION] ${allUris.length} URIs totales détectées.`);

      const missingUris: string[] = [];
      
      for (const uri of allUris) {
        const existingBook = await databaseService.getBookFromCache(uri);
        if (!existingBook) {
          missingUris.push(uri);
        } else {
          let expectedStatus: 'owned' | 'wish' | 'none' = 'none';
          if (inventoryUris.includes(uri)) expectedStatus = 'owned';
          else if (wishlistUris.includes(uri)) expectedStatus = 'wish';
          
          if (existingBook.ownershipStatus !== expectedStatus) {
             existingBook.ownershipStatus = expectedStatus;
             await databaseService.saveBookToCache(existingBook);
             console.log(`[HYDRATATION] Statut mis à jour en local pour : ${uri} (${expectedStatus})`);
          }
        }
      }

      console.log(`[HYDRATATION] ${missingUris.length} nouvelles fiches à télécharger en batch.`);

      let addedCount = 0;
      const CHUNK_SIZE = 50;

      for (let i = 0; i < missingUris.length; i += CHUNK_SIZE) {
        const chunk = missingUris.slice(i, i + CHUNK_SIZE);
        console.log(`[HYDRATATION] Traitement du lot ${Math.floor(i/CHUNK_SIZE) + 1} (${chunk.length} URIs)...`);
        
        try {
           const chunkUrl = `https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(chunk.join('|'))}&attributes=info|labels|descriptions|claims|image`;
           const res = await fetch(chunkUrl, { headers: { 'Accept': 'application/json', 'User-Agent': 'InventaireMobileOverlay/1.8' } });
           const data = await res.json();
           const entities = data.entities || {};

           const workUrisToFetch = new Set<string>();
           for (const uri of chunk) {
              const entityData = entities[uri];
              if (entityData && entityData.type !== 'work') {
                 const workClaim = entityData.claims?.['wdt:P629']?.[0] || entityData.claims?.['P629']?.[0];
                 const workUri = typeof workClaim === 'string' ? workClaim : workClaim?.value;
                 if (workUri && !entities[workUri]) {
                    workUrisToFetch.add(workUri);
                 }
              }
           }

           let workEntities: any = {};
           if (workUrisToFetch.size > 0) {
               const worksChunk = Array.from(workUrisToFetch);
               const worksUrl = `https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(worksChunk.join('|'))}&attributes=info|labels|descriptions|claims|image`;
               const wRes = await fetch(worksUrl, { headers: { 'Accept': 'application/json', 'User-Agent': 'InventaireMobileOverlay/1.8' } });
               const wData = await wRes.json();
               workEntities = wData.entities || {};
           }

           const humanizePromises = chunk.map(async (uri) => {
              const entityData = entities[uri];
              if (!entityData) return;

              const workClaim = entityData.claims?.['wdt:P629']?.[0] || entityData.claims?.['P629']?.[0];
              const workUri = typeof workClaim === 'string' ? workClaim : workClaim?.value;
              const workData = workUri ? workEntities[workUri] : undefined;

              const rawBook = entityMapper.mapResponse(uri, entityData, workData);
              const humanizedBook = await entityHumanizer.humanize(rawBook);
              
              if (inventoryUris.includes(uri)) {
                humanizedBook.ownershipStatus = 'owned';
              } else if (wishlistUris.includes(uri)) {
                humanizedBook.ownershipStatus = 'wish';
              }
              
              await databaseService.saveBookToCache(humanizedBook);
              addedCount++;
           });

           await Promise.all(humanizePromises);
           
        } catch (chunkError) {
           console.error(`[HYDRATATION] 💥 Erreur fatale sur le lot ${Math.floor(i/CHUNK_SIZE) + 1}:`, chunkError);
        }
      }
      
      console.log(`[HYDRATATION] Terminée. ${addedCount} nouvelles fiches complètes stockées.`);
    } catch (error) {
      console.error("[HYDRATATION] Erreur durant la tâche de fond globale :", error);
    } finally {
      console.groupEnd();
    }
  }
};