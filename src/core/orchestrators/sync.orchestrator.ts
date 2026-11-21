// src/core/orchestrators/sync.orchestrator.ts
import { databaseService } from '../database/database.service';
import { entityResolver } from '../resolvers/entity.resolver';
import { seriesResolver } from '../resolvers/series.resolver';
import { workUriResolver } from '../resolvers/workUri.resolver';
import { bookCacheService } from '../services/book-cache.service';
import { fetchV4SeriesBooksToIndexedDb, syncV4BooksToIndexedDb } from '../services/v4-client.service';
import { scannerState } from '../../state/scanner';

let activeHydrationPromise: Promise<void> | null = null;

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
   * AJOUT : Paramètre optionnel onProgress pour piloter le suivi de l'interface graphique
   */
  async hydrateRemainingPhysicalEntities(items: {uri: string, status: 'owned'|'wish'|'none'}[], onProgress?: (current: number, total: number) => void): Promise<void> {
    const CHUNK_SIZE = 50;
    let completedCount = 0;
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE);
      console.log(`[BACKGROUND] Aspiration du lot ${Math.floor(i/CHUNK_SIZE) + 1} (${chunk.length} tomes)...`);
      await Promise.all(chunk.map(async (item) => {
        const humanizedBook = await entityResolver.resolvePhysicalEntity(item.uri);
        if (humanizedBook) {
          // Injection immédiate et forcée du statut correct à la création
          await bookCacheService.saveAndProcessImage(humanizedBook, item.status);
        }
        completedCount++;
        onProgress?.(completedCount, items.length);
      }));
    }
  },

  /**
   * NOUVELLE MÉTHODE SÉCURISÉE : Aspire tous les tomes manquants d'une série en tâche de fond.
   * Intègre un filtrage stricte en AMONT (Upstream Filtering) pour éviter les doublons 
   * et économiser les appels réseaux inutiles.
   * AJOUT : Prise en charge du callback onProgress pour alimenter la barre de progression réactive
   */
  async hydrateSeriesInBackground(seriesId: string, onProgress?: (current: number, total: number) => void): Promise<void> {
    console.log(`[BACKGROUND] Amorçage du pré-chargement sécurisé en arrière-plan pour la série ${seriesId}...`);
    try {
      // 0. Voie V4 pure prioritaire : lecture directe des tomes consolidés (`books` + `v4_library_books` + expansion C5 auto)
      const v4Series = await fetchV4SeriesBooksToIndexedDb(seriesId).catch(() => null);
      if (v4Series && v4Series.count > 1) {
        onProgress?.(v4Series.count, v4Series.count);
        scannerState.notifyCatalogChanged();
        console.log(`[BACKGROUND] ✅ Série ${seriesId} hydratée via V4 pure (${v4Series.count} tomes).`);
        return;
      }

      // 1. Repli V2 (si série historique absente de `v4_series` / `books`)
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
      
      // 6. TÉLÉCHARGEMENT FINAL DES DONNÉES MANQUANTES AVEC ÉMISSION DE PROGRESSION
      if (missingTomes.length > 0) {
         onProgress?.(0, missingTomes.length); // Initialisation de la barre à 0%
         await this.hydrateRemainingPhysicalEntities(missingTomes, onProgress);
      }
    } catch (e) {
      console.error(`[BACKGROUND] Erreur sur l'aspiration sécurisée de la saga ${seriesId}`, e);
    }
  },

  /**
   * TÂCHE GLOBALE (V2.1) : S'assure que le cache est synchronisé avec les registres
   */
  async hydrateCacheInBackground(): Promise<void> {
    if (activeHydrationPromise) {
      return activeHydrationPromise;
    }
    activeHydrationPromise = (async () => {
    console.group("[HYDRATATION] Démarrage de la tâche de fond (V2.1)");
    try {
      const DB_RESET_TOKEN = 'reset_2026_11_21_v4_clean_v25';
      if (
        typeof localStorage !== 'undefined' &&
        localStorage.getItem('biblio_db_reset_token') !== DB_RESET_TOKEN &&
        typeof (databaseService as any).clearAllBookData === 'function'
      ) {
        console.log('[HYDRATATION] Purge complète de la base locale IndexedDB (Clean Slate)...');
        await databaseService.clearAllBookData();
        localStorage.removeItem('biblio_catalog_sync_version');
        localStorage.removeItem('biblio_scan_photo_draft_v1');
        localStorage.removeItem('biblio_v4_last_sync_at');
        localStorage.setItem('biblio_db_reset_token', DB_RESET_TOKEN);
      }

      // 0. Synchronisation différentielle V4 pure (books + v4_library_books + tomes des séries suivies)
      const v4Sync = await syncV4BooksToIndexedDb().catch(() => null);
      if (v4Sync && v4Sync.syncedCount > 0) {
        console.log(`[HYDRATATION] ✅ Synchro différentielle V4 : ${v4Sync.syncedCount} fiche(s) synchronisée(s).`);
        scannerState.lastUpdatedTick.value++;
      }

      // 1. Collecte des URIs Registres
      const inventoryRaw = await databaseService.getAllRegistryUris('inventory');
      const wishlistRaw = await databaseService.getAllRegistryUris('wishlist');

      if (inventoryRaw.length === 0 && wishlistRaw.length === 0) {
        // Si les registres distants sont vides (ex: purge serveur), réinitialiser tout statut local obsolète
        const staleBooks = (await databaseService.getAllBooksFromCache()).filter(
          (b) => b.ownershipStatus === 'owned' || b.ownershipStatus === 'wish'
        );
        if (staleBooks.length > 0) {
          for (const stale of staleBooks) {
            await databaseService.saveBookToCache({ ...stale, ownershipStatus: 'none' });
          }
          scannerState.lastUpdatedTick.value++;
        }
        return;
      }
      
      // 2. Filtrage sémantique
      console.log(`[HYDRATATION] Filtrage sémantique de l'Inventaire (${inventoryRaw.length}) et Wishlist (${wishlistRaw.length})...`);
      const inventoryPhysicalUris = await workUriResolver.resolveBulk(inventoryRaw);
      const wishlistPhysicalUris = await workUriResolver.resolveBulk(wishlistRaw);

      const missingItems: {uri: string, status: 'owned'|'wish'|'none'}[] = [];
      const CATALOG_SYNC_VERSION = 'v2.4-covers-series';
      const needsGlobalCatalogRefresh =
        typeof localStorage !== 'undefined' &&
        localStorage.getItem('biblio_catalog_sync_version') !== CATALOG_SYNC_VERSION;

      const needsBookRefresh = (livre: any): boolean => {
        if (!livre?.uri?.startsWith('isbn:')) return false;
        // Ne jamais écraser par le pipeline V2 legacy un livre déjà consolidé en V4 ou édité par l'utilisateur !
        if (livre.bookId || livre.isLocallyEdited) return false;
        if (needsGlobalCatalogRefresh) return true;
        if (livre.coverUrl && livre.coverUrl.includes('idArk=')) return true;
        if (livre.series && livre.series.includes('|')) return true;
        if (livre.title && livre.title.includes('|')) return true;
        if (!livre.localCover && livre.coverUrl) return true;
        return false;
      };

      // 3. Analyse du delta Local vs Inventaire
      for (const uri of inventoryPhysicalUris) {
        const livre = await databaseService.getBookFromCache(uri);
        if (!livre || needsBookRefresh(livre)) {
          missingItems.push({ uri, status: 'owned' });
        } else if (livre.ownershipStatus !== 'owned') {
           await bookCacheService.saveAndProcessImage(livre, 'owned');
        }
      }

      const existingLocalBooks = await databaseService.getAllBooksFromCache();

      // 4. Analyse du delta Local vs Wishlist (sans créer de doublon work + edition)
      for (const uri of wishlistPhysicalUris) {
        if (inventoryPhysicalUris.includes(uri)) continue;

        let livre = await databaseService.getBookFromCache(uri);
        if (!livre) {
          // Si le registre D1 pointe vers un workUri déjà représenté par une édition locale, réutiliser celle-ci !
          livre = existingLocalBooks.find((b) => b.workUri === uri);
        }

        if (!livre || needsBookRefresh(livre)) {
          missingItems.push({ uri, status: 'wish' });
        } else if (livre.ownershipStatus !== 'wish') {
          await bookCacheService.saveAndProcessImage(livre, 'wish');
        }
      }

      // 5. Téléchargement des manquants
      console.log(`[HYDRATATION] ${missingItems.length} nouvelles éditions physiques à télécharger...`);
      if (missingItems.length > 0) {
         await this.hydrateRemainingPhysicalEntities(missingItems);
         scannerState.lastUpdatedTick.value++;
      }
      if (needsGlobalCatalogRefresh && typeof localStorage !== 'undefined') {
        localStorage.setItem('biblio_catalog_sync_version', CATALOG_SYNC_VERSION);
      }

      // 6. Nettoyage du cache pour les livres retirés à distance
      console.log(`[HYDRATATION] Nettoyage du cache pour les livres supprimés à distance...`);
      const localBooks = await databaseService.getAllBooksFromCache();
      const inventoryUrisSet = new Set(inventoryPhysicalUris);
      const wishlistUrisSet = new Set(wishlistPhysicalUris);

      for (const book of localBooks) {
        const isActuallyOwned = inventoryUrisSet.has(book.uri) || (!!book.workUri && inventoryUrisSet.has(book.workUri));
        const isActuallyWished = wishlistUrisSet.has(book.uri) || (!!book.workUri && wishlistUrisSet.has(book.workUri));

        // Dédoublonnage Wishlist : si un work nu et une édition du même workUri coexistent, supprimer le work nu redondant
        if (
          book.type !== 'edition' &&
          !book.isbn13 &&
          localBooks.some((other) => other.uri !== book.uri && other.workUri === book.uri)
        ) {
          await databaseService.deleteBookFromCache(book.uri);
          continue;
        }

        if (book.ownershipStatus === 'owned' && !isActuallyOwned) {
          if (isActuallyWished) {
            await bookCacheService.saveAndProcessImage(book, 'wish');
          } else {
            await bookCacheService.saveAndProcessImage(book, 'none');
          }
        } else if (book.ownershipStatus === 'wish' && !isActuallyWished) {
          if (isActuallyOwned) {
            await bookCacheService.saveAndProcessImage(book, 'owned');
          } else {
            await bookCacheService.saveAndProcessImage(book, 'none');
          }
        }
      }

      // 7. Aspiration préventive des séries (Sagas)
      console.log(`[HYDRATATION] Analyse des sagas pour aspiration préventive...`);
      const latestBooksForSeries = await databaseService.getAllBooksFromCache();
      const seriesIds = new Set<string>();
      
      for (const book of latestBooksForSeries) {
        if (book.seriesId && (book.ownershipStatus === 'owned' || book.ownershipStatus === 'wish')) {
          seriesIds.add(book.seriesId);
        }
      }

      if (seriesIds.size > 0) {
        console.log(`[HYDRATATION] Amorçage du pré-chargement en arrière-plan pour ${seriesIds.size} séries...`);
        (async () => {
          for (const seriesId of seriesIds) {
            await this.hydrateSeriesInBackground(seriesId);
          }
        })();
      }

      // 8. Correction silencieuse des fiches mal humanisées en tâche de fond
      this.correctPoorlyHumanizedBooks();

    } catch (error) {
      console.error("[HYDRATATION] Erreur globale :", error);
    } finally {
      activeHydrationPromise = null;
      console.groupEnd();
    }
    })();
    return activeHydrationPromise;
  },

  /**
   * TÂCHE DE FOND : Détecte et ré-humanise de manière transparente les fiches de livres
   * contenant encore des IDs bruts Wikidata (wd:Q...).
   */
  async correctPoorlyHumanizedBooks(): Promise<void> {
    console.log("[BACKGROUND-CORRECTOR] Lancement de la vérification de la base locale...");
    try {
      const allBooks = await databaseService.getAllBooksFromCache();
      const needsCorrection = allBooks.filter(book => {
        if (book.isLocallyEdited) return false;
        const check = (val: string | undefined) => val && val.startsWith('wd:');
        const checkArray = (arr: string[] | undefined) => arr && arr.some(val => val && val.startsWith('wd:'));
        return !!(
          check(book.series) ||
          check(book.publisher) ||
          check(book.collection) ||
          checkArray(book.authors) ||
          checkArray(book.illustrators) ||
          checkArray(book.scriptwriters) ||
          checkArray(book.genres)
        );
      });

      if (needsCorrection.length === 0) {
        console.log("[BACKGROUND-CORRECTOR] ✅ Aucun livre mal humanisé détecté dans la base locale.");
        return;
      }

      console.log(`[BACKGROUND-CORRECTOR] ⚠️ ${needsCorrection.length} livres nécessitent une ré-humanisation.`);

      const { entityHumanizer } = await import('../resolvers/humanizer');
      for (const book of needsCorrection) {
        // Attente entre chaque livre pour laisser respirer l'application et l'API
        await new Promise(resolve => setTimeout(resolve, 1500));

        const { connectionState } = await import('../../state/connection');
        const { queueService } = await import('./queue.orchestrator');

        // Gardes d'inactivité : on s'arrête si offline ou si le réseau est sollicité
        if (connectionState.isOffline.value) {
          console.log("[BACKGROUND-CORRECTOR] Application hors-ligne. Interruption.");
          break;
        }

        if (queueService.isProcessing) {
          console.log("[BACKGROUND-CORRECTOR] File d'attente réseau active. Attente...");
          continue;
        }

        try {
          console.log(`[BACKGROUND-CORRECTOR] Correction sémantique pour : ${book.title} (${book.uri})`);
          await entityHumanizer.rehumanize(book);
        } catch (err: any) {
          console.warn(`[BACKGROUND-CORRECTOR] Impossible de corriger ${book.uri}:`, err.message);
        }
      }
      console.log("[BACKGROUND-CORRECTOR] Fin du cycle de correction.");
    } catch (e) {
      console.error("[BACKGROUND-CORRECTOR] Erreur lors de la correction :", e);
    }
  }
};