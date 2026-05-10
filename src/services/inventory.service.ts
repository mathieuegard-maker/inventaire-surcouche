// src/services/inventory.service.ts

export const inventoryService = {
  ownedUris: new Set<string>(),

  async loadLibrary(uri: string): Promise<number> {
    console.group(`[INVENTORY] Chargement de la bibliothèque pour ${uri}`);
    console.log("Appel API en cours...");
    
    const res = await fetch(`/api/inventory/list?uri=${encodeURIComponent(uri)}`);
    const data = await res.json();

    if (!res.ok) {
      console.error("Échec de l'API :", data);
      console.groupEnd();
      throw new Error(data.error || "Impossible de charger l'inventaire");
    }

    this.ownedUris.clear();
    const items = data.items || [];
    const itemList = Array.isArray(items) ? items : Object.values(items);
    
    itemList.forEach((item: any) => {
      if (item.entity) {
        this.ownedUris.add(item.entity);
      }
    });

    console.log(`Données brutes reçues : ${itemList.length} items physiques.`);
    console.log(`URIs uniques extraites et stockées dans le Set :`, Array.from(this.ownedUris));
    console.groupEnd();

    return this.ownedUris.size;
  },

  isUriOwned(uri: string): boolean {
    return this.ownedUris.has(uri);
  },

  async addToLibrary(uri: string): Promise<boolean> {
    const res = await fetch('/api/inventory/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || data.message || "Erreur lors de l'ajout à l'inventaire");
    }

    // CRUCIAL : On met à jour la mémoire locale immédiatement
    this.ownedUris.add(uri);
    
    return true;
  },

  async addBulkToLibrary(uris: string[]): Promise<boolean> {
    const res = await fetch('/api/inventory/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris })
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      // On affiche l'erreur brute envoyée par Inventaire dans F12
      console.error("[DEBUG BULK ERROR]", data);
      // On lance l'erreur avec le texte précis d'Inventaire (status_verbose)
      throw new Error(data.status_verbose || data.error || "Erreur inconnue du serveur");
    }

    uris.forEach(uri => this.ownedUris.add(uri));
    return true;
  }
};