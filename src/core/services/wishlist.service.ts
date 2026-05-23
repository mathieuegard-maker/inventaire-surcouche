// src/core/services/wishlist.service.ts
import { databaseService } from '../database/database.service';

export const wishlistService = {
  wishlistId: null as string | null,

  async loadWishlist(userUri: string): Promise<number> {
    const userId = userUri.includes(':') ? userUri.split(':')[1] : userUri;
    console.group(`[WISHLIST] Initialisation pour l'utilisateur ${userId}`);
    
    try {
      const res = await fetch(`/api/gateway?action=lists-by-creator&userId=${encodeURIComponent(userId)}`);
      const data = await res.json();
      
      if (!res.ok) throw new Error(data.error || "Impossible de charger les listes");

      const listsData = data.lists || {};
      const listsArray = Array.isArray(listsData) ? listsData : Object.values(listsData);
      let targetList: any = listsArray.find((l: any) => 
        l.name.toLowerCase() === 'wishlist' || l.name.toLowerCase() === 'envies'
      );

      if (!targetList) {
        console.log("Aucune liste Wishlist trouvée, création en cours...");
        const createRes = await fetch('/api/gateway?action=lists-create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: "Wishlist",
            description: "Liste de souhaits automatique générée par l'application",
            type: "work",
            visibility: "public"
          })
        });
        const createData = await createRes.json();
        if (!createRes.ok) throw new Error(createData.error || "Échec de la création");
        
        const listObj = createData.list || createData;
        targetList = { _id: listObj._id };
        console.log("Liste créée avec succès :", targetList._id);
      } else {
        console.log("Liste trouvée :", targetList._id);
      }

      this.wishlistId = targetList._id;
      
      const listRes = await fetch(`/api/gateway?action=lists-get&id=${this.wishlistId}`);
      const listData = await listRes.json();
      
      if (!listRes.ok) throw new Error(listData.error || "Impossible de lire le contenu");

      const elementsList = listData.list?.elements || listData.elements || [];
      
      const urisToSync = elementsList.map((item: any) => {
        if (typeof item === 'string') return item;
        if (item.element) return item.element;
        if (item.uri) return item.uri;
        if (item.entity) return item.entity; 
        return null;
      }).filter(Boolean);

      await databaseService.syncRegistry('wishlist', urisToSync);
      console.log(`Contenu téléchargé et synchronisé : ${urisToSync.length} éléments.`);

      console.groupEnd();
      return urisToSync.length;
    } catch (error) {
      console.error("[WISHLIST] Erreur fatale :", error);
      console.groupEnd();
      throw error;
    }
  },

  async isUriWished(uri: string, workUri?: string): Promise<boolean> {
    const directMatch = await databaseService.isUriInRegistry('wishlist', uri);
    if (directMatch) return true;
    const targetWork = workUri || uri;
    return await databaseService.isUriInRegistry('wishlist', targetWork);
  },

  async addToWishlist(editionUri: string): Promise<boolean> {
    if (!this.wishlistId) throw new Error("La Wishlist n'est pas initialisée.");
    
    // CRITICAL FIX : Extraction du workUri depuis le cache local car le serveur refuse les éditions physiques dans cette liste
    const cachedBook = await databaseService.getBookFromCache(editionUri);
    const targetUri = cachedBook?.workUri || editionUri;

    const res = await fetch('/api/gateway?action=lists-add-elements', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: this.wishlistId, uris: [targetUri] })
    });
    const data = await res.json();
    if (!res.ok) {
      console.error("[WISHLIST ADD ERROR]", data);
      throw new Error(data.status_verbose || data.error || JSON.stringify(data));
    }
    
    // Double sauvegarde locale pour assurer la réactivité de la vue Série et la cohérence au rechargement
    await databaseService.addRegistryEntry('wishlist', editionUri);
    if (cachedBook?.workUri) {
      await databaseService.addRegistryEntry('wishlist', cachedBook.workUri);
    }
    return true;
  },

  async addBulkToWishlist(editionUris: string[]): Promise<boolean> {
    if (!this.wishlistId) throw new Error("La Wishlist n'est pas initialisée.");
    
    // CRITICAL FIX : Résolution asynchrone groupée pour obtenir les identifiants d'œuvres correspondants
    const targetUris = await Promise.all(editionUris.map(async (uri) => {
      const cachedBook = await databaseService.getBookFromCache(uri);
      return cachedBook?.workUri || uri;
    }));

    const res = await fetch('/api/gateway?action=lists-add-elements', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: this.wishlistId, uris: targetUris })
    });
    const data = await res.json();
    if (!res.ok) {
      console.error("[WISHLIST BULK ADD ERROR]", data);
      throw new Error(data.status_verbose || data.error || JSON.stringify(data));
    }
    
    // Enregistrement des correspondances en base locale pour chaque tome traité
    for (const uri of editionUris) {
      await databaseService.addRegistryEntry('wishlist', uri);
      const cachedBook = await databaseService.getBookFromCache(uri);
      if (cachedBook?.workUri) {
        await databaseService.addRegistryEntry('wishlist', cachedBook.workUri);
      }
    }
    return true;
  },

  async removeFromWishlist(uris: string[]): Promise<boolean> {
    if (!this.wishlistId) return false;
    if (uris.length === 0) return true;

    // Pour le retrait, on nettoie les deux types d'URIs (œuvres et éditions) pour éviter tout résidu
    const targetUris = new Set<string>();
    for (const uri of uris) {
      targetUris.add(uri);
      const cachedBook = await databaseService.getBookFromCache(uri);
      if (cachedBook?.workUri) {
        targetUris.add(cachedBook.workUri);
      }
    }

    const res = await fetch('/api/gateway?action=lists-remove-elements', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: this.wishlistId, uris: Array.from(targetUris) })
    });
    const data = await res.json();
    if (res.ok) {
      for (const uri of targetUris) {
         await databaseService.removeRegistryEntry('wishlist', uri);
      }
      return true;
    } else {
      console.error("[WISHLIST REMOVE ERROR]", data);
      return false;
    }
  }
};