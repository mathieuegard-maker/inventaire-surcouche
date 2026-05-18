// src/core/orchestrators/connection.orchestrator.ts
import { userService } from '../services/user.service';
import { inventoryService } from '../services/inventory.service';
import { wishlistService } from '../services/wishlist.service';
//import { databaseService } from '../database/database.service';
//import { entityResolver } from '../resolvers/entity.resolver';
//import { entityHumanizer } from '../resolvers/humanizer';
import { loanService } from '../services/loan.service';
//import { entityMapper } from '../resolvers/mapper'; // AJOUT pour le batching
import { syncOrchestrator } from './sync.orchestrator';

export const connectionService = {
  isInitialized: false,
  userUri: null as string | null,

  /**
   * Initialisation globale de l'application (Résistante aux pannes)
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

      // 1. Synchronisation NON-bloquante des registres avec Tolérance aux Pannes
      console.log("Synchronisation des registres (Inventory, Wishlist, Loans)...");
      let inventoryData = { count: 0, items: [] as any[] };

      // Lancement en parallèle, mais une erreur n'arrête pas le processus global
      await Promise.all([
        inventoryService.loadLibrary(this.userUri)
          .then(data => { inventoryData = data; })
          .catch(e => console.error("[CONNECTION SERVICE] ⚠️ Échec chargement Inventaire :", e)),
          
        wishlistService.loadWishlist(this.userUri)
          .catch(e => console.error("[CONNECTION SERVICE] ⚠️ Échec chargement Wishlist :", e))
      ]);

      // OPTIMISATION RÉSEAU : La synchronisation des prêts réutilise les données de l'inventaire
      await loanService.sync(this.userUri, inventoryData.items)
          .catch(e => console.error("[CONNECTION SERVICE] ⚠️ Échec synchronisation Prêts :", e));

      this.isInitialized = true;
      console.log("Application prête (mode résilient) !");
      console.groupEnd();

      // 2. Lancement asynchrone de l'hydratation DÉLÉGUÉ au Sync Orchestrator
      syncOrchestrator.hydrateCacheInBackground();

      return true;
    } catch (error) {
      console.error("[CONNECTION SERVICE] Erreur fatale d'initialisation :", error);
      console.groupEnd();
      return false;
    }
  }
};