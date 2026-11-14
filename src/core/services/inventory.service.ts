// src/core/services/inventory.service.ts
import { databaseService } from '../database/database.service';
import { fetchWithTimeout } from '../../state/connection';
import { loanService } from './loan.service';

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
      loanService.invalidateInventoryCache();
      
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
    loanService.invalidateInventoryCache();
    return true;
  },

  async removeFromLibrary(uri: string, explicitItemId?: string): Promise<boolean> {
    const entry = await databaseService.getRegistryEntry('inventory', uri);
    let itemId = explicitItemId || entry?.itemId;
    if (!itemId) {
      itemId = (await loanService.getInventoryItemId(uri)) || undefined;
    }

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
    loanService.invalidateInventoryCache();

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
    let data: any = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    const itemIdByUri = new Map<string, string | undefined>();
    if (Array.isArray(data?.addedItems)) {
      for (const entry of data.addedItems) {
        if (entry?.uri) itemIdByUri.set(entry.uri, entry.itemId);
      }
    }
    for (const uri of uris) {
      await databaseService.addRegistryEntry('inventory', uri, itemIdByUri.get(uri));
    }
    loanService.invalidateInventoryCache();
    return true;
  }
};