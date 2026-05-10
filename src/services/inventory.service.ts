// src/services/inventory.service.ts
import { entityResolver } from '../resolvers/entity.resolver';

export const inventoryService = {
  // On stocke tes livres ici (Un "Set" est ultra-rapide pour vérifier si un élément existe)
  ownedUris: new Set<string>(),

  /**
   * 1. Charge toute la bibliothèque en mémoire
   * À appeler juste après que l'utilisateur se soit connecté.
   */
  async loadLibrary(username: string): Promise<number> {
    const res = await fetch(`/api/inventory/list?username=${username}`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "Impossible de charger l'inventaire");

    // L'API renvoie souvent un objet où les clés sont les URIs des livres
    const uris = Object.keys(data.entities || data);
    
    // On met à jour notre Set en mémoire
    this.ownedUris.clear();
    uris.forEach(uri => this.ownedUris.add(uri));

    return this.ownedUris.size; // Retourne le nombre de livres possédés
  },

  /**
   * 2. Vérifie instantanément si une URI est possédée
   */
  isUriOwned(uri: string): boolean {
    return this.ownedUris.has(uri);
  },

  /**
   * 3. La fonction "Magique" que tu as demandée : ISBN -> Propriété
   */
  async checkOwnershipByIsbn(isbn: string): Promise<{ isOwned: boolean; uri: string; title: string }> {
    // On utilise notre brique existante pour trouver l'URI !
    const rawBook = await entityResolver.fromIsbn(isbn);
    
    return {
      isOwned: this.isUriOwned(rawBook.uri),
      uri: rawBook.uri,
      title: rawBook.title
    };
  }
};