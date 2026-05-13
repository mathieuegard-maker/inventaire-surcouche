// src/services/connection.service.ts
import { userService } from './user.service';
import { inventoryService } from './inventory.service';
import { wishlistService } from './wishlist.service';
import { databaseService } from './database.service';
import { entityResolver } from '../resolvers/entity.resolver';
import { entityHumanizer } from '../resolvers/humanizer';
import { loanService } from './loan.service';

export const connectionService = {
  isInitialized: false,
  userUri: null as string | null,

  /**
   * Initialisation globale de l'application
   */
  async initializeApp(): Promise<boolean> {
    console.group("[CONNECTION SERVICE] Démarrage de l'application");
    try {
      console.log("Tentative de récupération du profil...");
      const profile = await userService.fetchProfile();
      
      if (!profile || !profile.uri) {
        console.warn("Aucune session active. Utilisateur déconnecté.");
        console.groupEnd();
        return false;
      }

      this.userUri = profile.uri;
      console.log(`Session trouvée : ${profile.username} (${this.userUri})`);

      // 1. Synchronisation bloquante des registres légers
      console.log("Synchronisation des registres (Inventory, Wishlist, Loans)...");
      await Promise.all([
        inventoryService.loadLibrary(this.userUri),
        wishlistService.loadWishlist(this.userUri),
        loanService.sync(this.userUri) // CORRECTION : On passe l'URI utilisateur
      ]);
      
      this.isInitialized = true;
      console.log("Application prête et registres à jour !");
      console.groupEnd();

      // 2. Lancement asynchrone de l'hydratation (Ne bloque pas l'UI)
      this.hydrateCacheInBackground();

      return true;
    } catch (error) {
      console.error("[CONNECTION SERVICE] Erreur fatale d'initialisation :", error);
      console.groupEnd();
      return false;
    }
  },

  /**
   * Tâche de fond : Télécharge et met en cache les fiches complètes des livres possédés/souhaités
   */
  async hydrateCacheInBackground(): Promise<void> {
    console.group("[HYDRATATION] Démarrage de la tâche de fond");
    try {
      const inventoryUris = await databaseService.getAllRegistryUris('inventory');
      const wishlistUris = await databaseService.getAllRegistryUris('wishlist');
      
      // Fusion et déduplication des listes
      const allUris = Array.from(new Set([...inventoryUris, ...wishlistUris]));
      console.log(`[HYDRATATION] ${allUris.length} URIs à vérifier en cache.`);

      let addedCount = 0;

      // Par lot pour ne pas surcharger le navigateur ou l'API
      for (const uri of allUris) {
        const existingBook = await databaseService.getBookFromCache(uri);
        
        if (!existingBook) {
          const rawBook = await entityResolver.fromUri(uri);
          if (rawBook) {
            const humanizedBook = await entityHumanizer.humanize(rawBook);
            
            if (inventoryUris.includes(uri)) {
              humanizedBook.ownershipStatus = 'owned';
            } else if (wishlistUris.includes(uri)) {
              humanizedBook.ownershipStatus = 'wish';
            }

            await databaseService.saveBookToCache(humanizedBook);
            addedCount++;
          }
        } else {
          let expectedStatus: 'owned' | 'wish' | 'none' = 'none';
          if (inventoryUris.includes(uri)) expectedStatus = 'owned';
          else if (wishlistUris.includes(uri)) expectedStatus = 'wish';

          if (existingBook.ownershipStatus !== expectedStatus) {
             existingBook.ownershipStatus = expectedStatus;
             await databaseService.saveBookToCache(existingBook);
             console.log(`[HYDRATATION] Mise à jour du statut pour : ${uri} (${expectedStatus})`);
          }
        }
      }

      console.log(`[HYDRATATION] Terminée. ${addedCount} nouvelles fiches complètes stockées.`);
    } catch (error) {
      console.error("[HYDRATATION] Erreur durant la tâche de fond :", error);
    } finally {
      console.groupEnd();
    }
  }
};