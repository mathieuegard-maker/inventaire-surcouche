// src/services/inventory.service.ts
import { databaseService } from '../database/database.service';

export const inventoryService = {
  async loadLibrary(uri: string): Promise<number> {
    console.group(`[INVENTORY] Synchronisation pour ${uri}`);
    try {
      const res = await fetch(`/api/inventory/list?uri=${encodeURIComponent(uri)}`);
      const data = await res.json();
      const items = data.items || [];
      const itemList = Array.isArray(items) ? items : Object.values(items);
      
      const urisToSync = itemList.map((item: any) => item.entity).filter(Boolean);
      await databaseService.syncRegistry('inventory', urisToSync);
      
      console.groupEnd();
      return urisToSync.length;
    } catch (error) {
      console.error("[INVENTORY] Erreur :", error);
      console.groupEnd();
      throw error;
    }
  },

  /**
   * VÉRIFICATION INTELLIGENTE (Identity-Aware)
   */
  async isUriOwned(uri: string, workUri?: string): Promise<boolean> {
    // 1. Match direct (l'URI exacte est dans l'inventaire)
    if (await databaseService.isUriInRegistry('inventory', uri)) return true;

    // 2. Match par l'œuvre (On possède l'œuvre en tant que telle)
    if (workUri && await databaseService.isUriInRegistry('inventory', workUri)) return true;

    // 3. Match par "Cousin" (On possède une autre édition de la même œuvre)
    if (workUri) {
      const other = await databaseService.getOtherOwnedEdition(workUri, uri);
      return !!other;
    }

    return false;
  },

  async addToLibrary(uri: string): Promise<boolean> {
    const res = await fetch('/api/inventory/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri })
    });
    if (!res.ok) throw new Error("Erreur ajout");
    await databaseService.addRegistryEntry('inventory', uri);
    return true;
  },

  async addBulkToLibrary(uris: string[]): Promise<boolean> {
    const res = await fetch('/api/inventory/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris })
    });
    if (!res.ok) throw new Error("Erreur bulk");
    for (const uri of uris) await databaseService.addRegistryEntry('inventory', uri);
    return true;
  }
};