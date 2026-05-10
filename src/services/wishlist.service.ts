// src/services/wishlist.service.ts

export const wishlistService = {
  wishlistId: null as string | null,
  wishedUris: new Set<string>(),

  /**
   * Charge ou crée la liste "Wishlist" au démarrage.
   * @param userUri L'URI complète de l'utilisateur (ex: "inv:bc897...")
   */
  async loadWishlist(userUri: string): Promise<number> {
    // 1. Extraire l'ID court pour l'API (on enlève le "inv:")
    const userId = userUri.includes(':') ? userUri.split(':')[1] : userUri;
    console.group(`[WISHLIST] Initialisation pour l'utilisateur ${userId}`);
    
    try {
      // 2. Récupérer toutes les listes de l'utilisateur
      const res = await fetch(`/api/lists/by-creator?userId=${encodeURIComponent(userId)}`);
      const data = await res.json();
      
      if (!res.ok) throw new Error(data.error || "Impossible de charger les listes");

      const listsData = data.lists || {};
      const listsArray = Array.isArray(listsData) ? listsData : Object.values(listsData);
      
      // 3. Chercher la liste par son nom
      let targetList: any = listsArray.find((l: any) => 
        l.name.toLowerCase() === 'wishlist' || l.name.toLowerCase() === 'envies'
      );

      // 4. Si inexistante, on la crée
      if (!targetList) {
        console.log("Aucune wishlist trouvée. Création d'une nouvelle liste...");
        const createRes = await fetch('/api/lists/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Wishlist' })
        });
        
        const createdData = await createRes.json();
        console.log("[DEBUG] Réponse serveur création:", createdData);

        if (!createRes.ok) {
          throw new Error(createdData.status_verbose || createdData.error || "Erreur lors de la création de la liste");
        }
        
        // L'API renvoie l'objet créé soit directement, soit dans une propriété 'list'
        targetList = createdData.list || createdData;
      }

      // 5. Capture de l'ID (gère _id ou id)
      this.wishlistId = targetList._id || targetList.id;

      if (!this.wishlistId) {
        console.error("[DEBUG] Objet liste reçu incomplet:", targetList);
        throw new Error("ID de liste introuvable après création/lecture");
      }

      console.log(`ID de la Wishlist validé : ${this.wishlistId}`);

      // 6. Synchronisation de la mémoire locale (Set)
      this.wishedUris.clear();
      const elements = targetList.elements || [];
      elements.forEach((uri: string) => this.wishedUris.add(uri));
      
      console.groupEnd();
      return this.wishedUris.size;
    } catch (err: any) {
      console.error("[WISHLIST ERROR]", err);
      console.groupEnd();
      throw err;
    }
  },

  /**
   * Vérifie si une URI est déjà dans la wishlist locale
   */
  isUriWished(uri: string): boolean {
    return this.wishedUris.has(uri);
  },

  /**
   * Ajout unitaire à la liste
   */
  async addToWishlist(editionUri: string): Promise<boolean> {
    if (!this.wishlistId) throw new Error("La Wishlist n'est pas initialisée.");

    const res = await fetch('/api/lists/add-elements', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: this.wishlistId, uris: [editionUri] })
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("[WISHLIST ADD ERROR]", data);
      throw new Error(data.status_verbose || data.error || JSON.stringify(data));
    }

    this.wishedUris.add(editionUri);
    return true;
  },

  /**
   * Ajout groupé à la liste (Bulk)
   */
  async addBulkToWishlist(editionUris: string[]): Promise<boolean> {
    if (!this.wishlistId) throw new Error("La Wishlist n'est pas initialisée.");

    const res = await fetch('/api/lists/add-elements', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: this.wishlistId, uris: editionUris })
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("[WISHLIST BULK ADD ERROR]", data);
      throw new Error(data.status_verbose || data.error || JSON.stringify(data));
    }

    editionUris.forEach(uri => this.wishedUris.add(uri));
    return true;
  },

  /**
   * Retrait de la liste
   */
  async removeFromWishlist(uris: string[]): Promise<boolean> {
    if (!this.wishlistId) return false;

    const toRemove = uris.filter(uri => this.wishedUris.has(uri));
    if (toRemove.length === 0) return true;

    const res = await fetch('/api/lists/remove-elements', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: this.wishlistId, uris: toRemove })
    });

    const data = await res.json();
    if (res.ok) {
      toRemove.forEach(uri => this.wishedUris.delete(uri));
      return true;
    } else {
      console.error("[WISHLIST REMOVE ERROR]", data);
      return false;
    }
  }
};