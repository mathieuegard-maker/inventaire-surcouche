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
   * NOUVELLE MÉTHODE SÉCURISÉE : Aspire tous les tomes manquants d'une série en tâche de fond.
   * Intègre un filtrage stricte en AMONT (Upstream Filtering) pour éviter les doublons 
   * et économiser les appels réseaux inutiles.
   */
  async hydrateSeriesInBackground(seriesId: string): Promise<void> {
    console.log(`[BACKGROUND] Amorçage du pré-chargement sécurisé en arrière-plan pour la série ${seriesId}...`);
    try {
      // 1. DRESSER LE BOUCLIER LOCAL
      // On récupère instantanément ce qu'on a déjà pour cette série dans Dexie
      const localTomes = await databaseService.getBooksBySeriesId(seriesId);
      
      // On crée un Set ultra-rapide contenant les URIs d'OEUVRES (wd:) déjà possédées
      const localWorkUris = new Set<string>();
      for (const tome of localTomes) {
        if (tome.workUri) {
          localWorkUris.add(tome.workUri);
        }
      }

      console.log(`[BACKGROUND] ${localWorkUris.size} œuvres de la série sont déjà sécurisées en cache local.`);

      // 2. RÉCUPÉRER LA LISTE CIBLE (Le collecteur)
      const allSeriesWorks = await seriesResolver.getSeriesWorks(seriesId);

      // 3. FILTRAGE EN AMONT (Le coupe-feu)
      // On retire de la liste à traiter tout ce qu'on possède déjà.
      const strictlyMissingWorks = allSeriesWorks.filter(workUri => !localWorkUris.has(workUri));

      if (strictlyMissingWorks.length === 0) {
        console.log(`[BACKGROUND] La série ${seriesId} est déjà intégralement en cache. Abandon de l'aspiration.`);
        return;
      }

      console.log(`[BACKGROUND] ${strictlyMissingWorks.length} œuvres nécessitent réellement une résolution réseau...`);

      // 4. RÉSOLUTION SÉMANTIQUE ALLÉGÉE
      // On ne passe dans le goulot d'étranglement (Levenshtein) QUE les tomes manquants
      const physicalUris = await workUriResolver.resolveBulk(strictlyMissingWorks);
      
      // 5. DOUBLE CHECK LOCAL ET PRÉPARATION À L'ASPIRATION
      const missingTomes: {uri: string, status: 'owned'|'wish'|'none'}[] = [];
      for (const uri of physicalUris) {
         if (!(await databaseService.getBookFromCache(uri))) {
             // Les tomes aspirés passivement ont le statut 'none'
             missingTomes.push({ uri, status: 'none' });
         }
      }
      
      // 6. TÉLÉCHARGEMENT FINAL DES DONNÉES MANQUANTES
      if (missingTomes.length > 0) {
         await this.hydrateRemainingPhysicalEntities(missingTomes);
      }
    } catch (e) {
      console.error(`[BACKGROUND] Erreur sur l'aspiration sécurisée de la saga ${seriesId}`, e);
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
      
      // 2. Filtrage sémantique
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
        if (book.seriesId && (book.ownershipStatus === 'owned' || book.ownershipStatus === 'wish')) {
          seriesIds.add(book.seriesId);
        }
      }

      if (seriesIds.size > 0) {
        console.log(`[HYDRATATION] Amorçage du pré-chargement en arrière-plan pour ${seriesIds.size} séries...`);
        for (const seriesId of seriesIds) {
          // Appel de la version sécurisée
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