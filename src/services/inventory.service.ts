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

  
};