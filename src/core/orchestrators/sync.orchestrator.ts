// src/core/orchestrators/sync.orchestrator.ts
import { databaseService } from '../database/database.service';
import { entityResolver } from '../resolvers/entity.resolver';
import { seriesResolver } from '../resolvers/series.resolver';
import { workUriResolver } from '../resolvers/workUri.resolver';
import { bookCacheService } from '../services/book-cache.service';

export const syncOrchestrator = {
  
  /**
   * AJOUT (TTL) : Rafraîchit un livre en cache de manière totalement silencieuse
   */
  async refreshBookInBackground(isbn: string): Promise<void> {
    console.log(`[BACKGROUND] Rafraîchissement silencieux (TTL) de l'ISBN: ${isbn}`);
    try {
      const book = await entityResolver.resolvePhysicalEntity(`isbn:${isbn}`);
      if (book) {
        await bookCacheService.saveAndProcessImage(book);
      }
    } catch (e) {
      console.error(`[BACKGROUND] Erreur lors du rafraîchissement de ${isbn}:`, e);
    }
  },

  /**
   * TÂCHE DE FOND : Pré-charge l'ensemble des tomes d'une liste de manière séquentielle
   * CORRECTION : Accepte désormais un objet incluant le statut de possession attendu
   */
  async hydrateRemainingPhysicalEntities(items: {uri: string, status: 'owned'|'wish'|'none'}[]): Promise<void> {
    const CHUNK_SIZE = 50;
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE);
      console.log(`[BACKGROUND] Aspiration du lot ${Math.floor(i/CHUNK_SIZE) + 1} (${chunk.length} tomes)...`);
      await Promise.all(chunk.map(async (item) => {
        const humanizedBook = await entityResolver.resolvePhysicalEntity(item.uri);
        if (humanizedBook) {
          // Injection immédiate et forcée du statut correct à la création
          await bookCacheService.saveAndProcessImage(humanizedBook, item.status);
        }
      }));
    }
  },

  /**
   * NOUVELLE MÉTHODE : Extraite pour être appelable depuis search.orchestrator
   * Aspire tous les tomes d'une série en tâche de fond.
   */
  async hydrateSeriesInBackground(seriesId: string): Promise<void> {
    console.log(`[BACKGROUND] Amorçage du pré-chargement en arrière-plan pour la série ${seriesId}...`);
    try {
      const workUris = await seriesResolver.getSeriesWorks(seriesId);
      const physicalUris = await workUriResolver.resolveBulk(workUris);
      
      const missingTomes: {uri: string, status: 'owned'|'wish'|'none'}[] = [];
      for (const uri of physicalUris) {
         if (!(await databaseService.getBookFromCache(uri))) {
             // Les tomes aspirés passivement ont le statut 'none'
             missingTomes.push({ uri, status: 'none' });
         }
      }
      if (missingTomes.length > 0) {
         await this.hydrateRemainingPhysicalEntities(missingTomes);
      }
    } catch (e) {
      console.error(`[BACKGROUND] Erreur sur l'aspiration de la saga ${seriesId}`, e);
    }
  },

  /**
   * TÂCHE GLOBALE (V2.1) : S'assure que le cache est synchronisé avec les registres
   */
  async hydrateCacheInBackground(): Promise<void> {
    console.group("[HYDRATATION] Démarrage de la tâche de fond (V2.1)");
    try {
      // 1. Collecte des URIs Registres
      const inventoryRaw = await databaseService.getAllRegistryUris('inventory');
      const wishlistRaw = await databaseService.getAllRegistryUris('wishlist');
      
      // 2. CORRECTION CRITIQUE : On passe TOUT au crible du WorkResolver.
      // L'inventaire peut contenir des 'wd:' si l'utilisateur a ajouté une oeuvre abstraite manuellement.
      console.log(`[HYDRATATION] Filtrage sémantique de l'Inventaire (${inventoryRaw.length}) et Wishlist (${wishlistRaw.length})...`);
      const inventoryPhysicalUris = await workUriResolver.resolveBulk(inventoryRaw);
      const wishlistPhysicalUris = await workUriResolver.resolveBulk(wishlistRaw);

      const missingItems: {uri: string, status: 'owned'|'wish'|'none'}[] = [];

      // 3. Analyse du delta Local vs Inventaire
      for (const uri of inventoryPhysicalUris) {
        const livre = await databaseService.getBookFromCache(uri);
        if (!livre) {
          missingItems.push({ uri, status: 'owned' });
        } else if (livre.ownershipStatus !== 'owned') {
           await bookCacheService.saveAndProcessImage(livre, 'owned');
        }
      }

      // 4. Analyse du delta Local vs Wishlist
      for (const uri of wishlistPhysicalUris) {
         // Si c'est possédé, on ignore la wishlist
         if (inventoryPhysicalUris.includes(uri)) continue;

         const livre = await databaseService.getBookFromCache(uri);
         if (!livre) {
           missingItems.push({ uri, status: 'wish' });
         } else if (livre.ownershipStatus !== 'wish') {
           await bookCacheService.saveAndProcessImage(livre, 'wish');
         }
      }

      // 5. Téléchargement des manquants
      console.log(`[HYDRATATION] ${missingItems.length} nouvelles éditions physiques à télécharger...`);
      if (missingItems.length > 0) {
         await this.hydrateRemainingPhysicalEntities(missingItems);
      }

      // 6. Aspiration préventive des séries (Sagas)
      console.log(`[HYDRATATION] Analyse des sagas pour aspiration préventive...`);
      const localBooks = await databaseService.getAllBooksFromCache();
      const seriesIds = new Set<string>();
      
      for (const book of localBooks) {
        // book.ownershipStatus est désormais GARANTI d'être correct
        if (book.seriesId && (book.ownershipStatus === 'owned' || book.ownershipStatus === 'wish')) {
          seriesIds.add(book.seriesId);
        }
      }

      if (seriesIds.size > 0) {
        console.log(`[HYDRATATION] Amorçage du pré-chargement en arrière-plan pour ${seriesIds.size} séries...`);
        for (const seriesId of seriesIds) {
          // Remplacement de l'IIFE par un appel direct à la méthode extraite
          this.hydrateSeriesInBackground(seriesId);
        }
      }

    } catch (error) {
      console.error("[HYDRATATION] Erreur globale :", error);
    } finally {
      console.groupEnd();
    }
  }
};