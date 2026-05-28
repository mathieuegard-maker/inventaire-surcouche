// src/core/orchestrators/connection.orchestrator.ts
import { userService } from '../services/user.service';
import { inventoryService } from '../services/inventory.service';
import { wishlistService } from '../services/wishlist.service';
import { sessionStore } from '../../state/session';
import { connectionState } from '../../state/connection';
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
   * Initialisation globale de l'application (Résistante aux pannes et compatible hors-ligne)
   */
  async initializeApp(): Promise<boolean> {
    console.group("[CONNECTION SERVICE] Démarrage de l'application");
    try {
      let profile: { uri: string; username: string } | null = null;
      const isOffline = connectionState.isOffline.value;

      if (!isOffline) {
        console.log("Tentative de récupération du profil à distance...");
        try {
          profile = await userService.fetchProfile();
        } catch (e) {
          console.warn("[CONNECTION SERVICE] Échec de la récupération du profil à distance, tentative locale...", e);
        }
      }

      if (!profile) {
        console.log("Tentative de restauration de la session locale...");
        const restored = sessionStore.restoreSessionFromLocalStorage();
        if (restored && sessionStore.state.user) {
          profile = sessionStore.state.user;
          console.log("[CONNECTION SERVICE] Session restaurée depuis le cache local (mode consultation).");
        }
      }

      if (!profile || !profile.uri) {
        console.warn("Aucune session active ou restaurable. Utilisateur déconnecté.");
        console.groupEnd();
        return false;
      }

      this.userUri = profile.uri;
      console.log(`Session activée : ${profile.username} (${this.userUri})`);

      // Si l'application démarre hors-ligne, on court-circuite la synchronisation réseau
      if (isOffline) {
        console.log("Application prête en mode hors-ligne restreint (consultation seule) !");
        this.isInitialized = true;
        console.groupEnd();
        return true;
      }

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
      console.log("Application prête (mode résilient et connecté) !");
      console.groupEnd();

      // 2. Lancement asynchrone de l'hydratation DÉLÉGUÉ au Sync Orchestrator
      syncOrchestrator.hydrateCacheInBackground();

      return true;
    } catch (error) {
      console.error("[CONNECTION SERVICE] Erreur fatale d'initialisation :", error);
      console.groupEnd();
      return false;
    }
  },

  /**
   * Séquence d'authentification et d'amorçage de session
   */
  async login(username: string, password: string): Promise<boolean> {
    console.group("[CONNECTION SERVICE] Tentative de connexion de l'utilisateur");
    try {
      // On relaie la requête brute au service utilisateur dédié
      const success = await userService.login(username, password);
      
      if (!success) {
        console.warn("Identifiants refusés par le service utilisateur.");
        console.groupEnd();
        return false;
      }

      console.log("Authentification validée. Amorçage des données utilisateur...");
      console.groupEnd();
      
      // On lance immédiatement l'initialisation des bases et caches locaux
      return await this.initializeApp();
    } catch (error) {
      console.error("[CONNECTION SERVICE] Erreur critique pendant le login :", error);
      console.groupEnd();
      throw error;
    }
  }
};