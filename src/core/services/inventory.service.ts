// src/core/services/inventory.service.ts
import { databaseService } from '../database/database.service';

export const inventoryService = {
  async loadLibrary(uri: string): Promise<{ count: number, items: any[] }> {
    console.group(`[INVENTORY] Synchronisation pour ${uri}`);
    try {
      const res = await fetch(`/api/gateway?action=inventory-list&uri=${encodeURIComponent(uri)}`);
      const data = await res.json();

      const items = data.items || [];
      const itemList = Array.isArray(items) ? items : Object.values(items);
      const urisToSync = itemList.map((item: any) => item.entity).filter(Boolean);
      await databaseService.syncRegistry('inventory', urisToSync);
      
      console.groupEnd();
      return { count: urisToSync.length, items: itemList };
    } catch (error) {
      console.error("[INVENTORY] Erreur :", error);
      console.groupEnd();
      throw error;
    }
  },

  async isUriOwned(uri: string, workUri?: string): Promise<boolean> {
    if (await databaseService.isUriInRegistry('inventory', uri)) return true;
    if (workUri && await databaseService.isUriInRegistry('inventory', workUri)) return true;
    if (workUri) {
      const other = await databaseService.getOtherOwnedEdition(workUri, uri);
      return !!other;
    }
    return false;
  },

  async addToLibrary(uri: string): Promise<boolean> {
    const res = await fetch('/api/gateway?action=inventory-add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri })
    });
    if (!res.ok) throw new Error("Erreur ajout");
    await databaseService.addRegistryEntry('inventory', uri);
    return true;
  },

  async addBulkToLibrary(uris: string[]): Promise<boolean> {
    const res = await fetch('/api/gateway?action=inventory-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris })
    });
    if (!res.ok) throw new Error("Erreur bulk");
    for (const uri of uris) await databaseService.addRegistryEntry('inventory', uri);
    return true;
  }
};