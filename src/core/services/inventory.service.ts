// src/core/services/inventory.service.ts
import { databaseService } from '../database/database.service';
import { fetchWithTimeout } from '../../state/connection';

export const inventoryService = {
  async loadLibrary(uri: string): Promise<{ count: number, items: any[] }> {
    console.group(`[INVENTORY] Synchronisation pour ${uri}`);
    try {
      const res = await fetchWithTimeout(`/api/gateway?action=inventory-list&uri=${encodeURIComponent(uri)}`);
      const data = await res.json();

      const items = data.items || [];
      const itemList = Array.isArray(items) ? items : Object.values(items);
      const entriesToSync = itemList.map((item: any) => ({
        uri: item.entity,
        itemId: item._id
      })).filter((e: any) => Boolean(e.uri));

      await databaseService.syncRegistry('inventory', entriesToSync);
      
      console.groupEnd();
      return { count: entriesToSync.length, items: itemList };
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
    const res = await fetchWithTimeout('/api/gateway?action=inventory-add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri })
    });
    if (!res.ok) throw new Error("Erreur ajout");
    const data = await res.json();
    const itemId = data.item?._id || data._id || undefined;
    await databaseService.addRegistryEntry('inventory', uri, itemId);
    return true;
  },

  async removeFromLibrary(uri: string): Promise<boolean> {
    const entry = await databaseService.getRegistryEntry('inventory', uri);
    const itemId = entry?.itemId;

    if (itemId) {
      const res = await fetchWithTimeout('/api/gateway?action=inventory-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [itemId] })
      });
      if (!res.ok) {
        throw new Error("Erreur lors de la suppression de l'exemplaire sur inventaire.io");
      }
    }

    await databaseService.removeRegistryEntry('inventory', uri);

    const cachedBook = await databaseService.getBookFromCache(uri);
    if (cachedBook) {
      cachedBook.ownershipStatus = 'none';
      await databaseService.saveBookToCache(cachedBook);
    }
    return true;
  },

  async addBulkToLibrary(uris: string[]): Promise<boolean> {
    const res = await fetchWithTimeout('/api/gateway?action=inventory-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris })
    });
    if (!res.ok) throw new Error("Erreur bulk");
    for (const uri of uris) await databaseService.addRegistryEntry('inventory', uri);
    return true;
  }
};