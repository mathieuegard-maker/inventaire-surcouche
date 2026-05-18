// src/core/orchestrators/connection.orchestrator.ts
import { userService } from '../services/user.service';
import { inventoryService } from '../services/inventory.service';
import { wishlistService } from '../services/wishlist.service';
import { databaseService } from '../database/database.service';
//import { entityResolver } from '../resolvers/entity.resolver';
import { entityHumanizer } from '../resolvers/humanizer';
import { loanService } from '../services/loan.service';
import { entityMapper } from '../resolvers/mapper'; // AJOUT pour le batching

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
   * Tâche de fond : MEGA-BATCHING des fiches complètes (Optimisé API)
   */
  async hydrateCacheInBackground(): Promise<void> {
    console.group("[HYDRATATION] Démarrage de la tâche de fond (Mega-Batching)");
    try {
      const inventoryUris = await databaseService.getAllRegistryUris('inventory');
      const wishlistUris = await databaseService.getAllRegistryUris('wishlist');
      
      // Fusion et déduplication des listes
      const allUris = Array.from(new Set([...inventoryUris, ...wishlistUris]));
      console.log(`[HYDRATATION] ${allUris.length} URIs totales détectées.`);

      const missingUris: string[] = [];
      
      // Filtre : Séparer ce qui est déjà en cache de ce qu'il faut télécharger
      for (const uri of allUris) {
        const existingBook = await databaseService.getBookFromCache(uri);
        if (!existingBook) {
          missingUris.push(uri);
        } else {
          // Mise à jour silencieuse du statut si nécessaire
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
      const CHUNK_SIZE = 50; // Limite stricte de l'API Inventaire.io

      // Traitement par paquets de 50 URIs
      for (let i = 0; i < missingUris.length; i += CHUNK_SIZE) {
        const chunk = missingUris.slice(i, i + CHUNK_SIZE);
        console.log(`[HYDRATATION] Traitement du lot ${Math.floor(i/CHUNK_SIZE) + 1} (${chunk.length} URIs)...`);
        
        try {
           const chunkUrl = `https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(chunk.join('|'))}&attributes=info|labels|descriptions|claims|image`;
           const res = await fetch(chunkUrl, { headers: { 'Accept': 'application/json', 'User-Agent': 'InventaireMobileOverlay/1.8' } });
           const data = await res.json();
           const entities = data.entities || {};

           // Extraction des Œuvres (Works) manquantes pour l'enrichissement (Logique Rebond P629)
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

           // Batch secondaire pour récupérer toutes les Œuvres manquantes d'un coup
           let workEntities: any = {};
           if (workUrisToFetch.size > 0) {
               const worksChunk = Array.from(workUrisToFetch);
               const worksUrl = `https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(worksChunk.join('|'))}&attributes=info|labels|descriptions|claims|image`;
               const wRes = await fetch(worksUrl, { headers: { 'Accept': 'application/json', 'User-Agent': 'InventaireMobileOverlay/1.8' } });
               const wData = await wRes.json();
               workEntities = wData.entities || {};
           }

           // Mapping et Humanisation en parallèle pour le lot entier
           const humanizePromises = chunk.map(async (uri) => {
              const entityData = entities[uri];
              if (!entityData) return;

              const workClaim = entityData.claims?.['wdt:P629']?.[0] || entityData.claims?.['P629']?.[0];
              const workUri = typeof workClaim === 'string' ? workClaim : workClaim?.value;
              const workData = workUri ? workEntities[workUri] : undefined;

              // Création de l'objet brut
              const rawBook = entityMapper.mapResponse(uri, entityData, workData);
              
              // Humanisation (Traduction IDs + Compression Image)
              const humanizedBook = await entityHumanizer.humanize(rawBook);
              
              // Inscription du statut visuel
              if (inventoryUris.includes(uri)) {
                humanizedBook.ownershipStatus = 'owned';
              } else if (wishlistUris.includes(uri)) {
                humanizedBook.ownershipStatus = 'wish';
              }
              
              // Sauvegarde en IndexedDB
              await databaseService.saveBookToCache(humanizedBook);
              addedCount++;
           });

           // On attend que les 50 traductions/compressions soient finies avant de passer au lot suivant
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