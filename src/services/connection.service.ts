// src/services/connection.service.ts
import { userService } from './user.service';
import { inventoryService } from './inventory.service';
import { wishlistService } from './wishlist.service';
import { databaseService } from './database.service';
import { entityResolver } from '../resolvers/entity.resolver';
import { entityHumanizer } from '../resolvers/humanizer';

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

      // 1. Synchronisation bloquante des registres légers (Indispensable avant d'afficher l'UI)
      console.log("Synchronisation des registres (Inventory & Wishlist)...");
      await Promise.all([
        inventoryService.loadLibrary(this.userUri),
        wishlistService.loadWishlist(this.userUri)
      ]);
      
      this.isInitialized = true;
      console.log("Application prête et registres à jour !");
      console.groupEnd();

      // 2. Lancement asynchrone de l'hydratation (Ne bloque pas l'utilisateur)
      this.hydrateCacheInBackground();

      return true;

    } catch (error) {
      console.error("Erreur critique lors de l'initialisation :", error);
      console.groupEnd();
      return false;
    }
  },

  /**
   * Action 3 : Moteur d'hydratation (Tâche de fond)
   * Compare les registres au cache local et télécharge/traite les données manquantes
   */
  async hydrateCacheInBackground(): Promise<void> {
    console.groupCollapsed("[HYDRATATION] Démarrage de la tâche de fond");
    try {
      // On récupère toutes les URIs que le serveur nous a confirmées
      const inventoryUris = await databaseService.getAllRegistryUris('inventory');
      const wishlistUris = await databaseService.getAllRegistryUris('wishlist');
      
      const allUris = [...new Set([...inventoryUris, ...wishlistUris])];
      console.log(`${allUris.length} URIs à vérifier dans le cache.`);

      let addedCount = 0;

      for (const uri of allUris) {
        // Le livre est-il déjà complètement en cache ?
        const existingBook = await databaseService.getBookFromCache(uri);
        
        if (!existingBook) {
          console.log(`[HYDRATATION] Téléchargement de la fiche manquante : ${uri}`);
          const rawBook = await entityResolver.fromUri(uri);
          
          if (rawBook) {
            // L'humaniseur gère la résolution des noms et la compression de l'image
            const humanizedBook = await entityHumanizer.humanize(rawBook);
            
            // On attribue le bon statut selon son registre d'appartenance
            if (inventoryUris.includes(uri)) {
              humanizedBook.ownershipStatus = 'owned';
            } else if (wishlistUris.includes(uri)) {
              humanizedBook.ownershipStatus = 'wish';
            }

            // On le range dans le coffre-fort
            await databaseService.saveBookToCache(humanizedBook);
            addedCount++;
          }
        } else {
          // Sécurité : On s'assure que le statut en cache correspond bien au serveur (en cas de transfert wishlist -> inventory par ex.)
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