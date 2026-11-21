// src/core/services/inventory.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inventoryService } from './inventory.service';
import { wishlistService } from './wishlist.service';
import { databaseService } from '../database/database.service';

// Mock database service
vi.mock('../database/database.service', () => ({
  databaseService: {
    getRegistryEntry: vi.fn(),
    addRegistryEntry: vi.fn(),
    removeRegistryEntry: vi.fn(),
    getBookFromCache: vi.fn(),
    saveBookToCache: vi.fn(),
  }
}));

// Mock global fetch
globalThis.fetch = vi.fn();

describe('Inventory & Wishlist Deletion Services', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('inventoryService.removeFromLibrary', () => {
    it('doit supprimer le livre sur le serveur (si itemId existe) et en cache local', async () => {
      const uri = 'inv:edition1';
      const itemId = 'item123';
      const cachedBook = { uri, title: 'Test Book', ownershipStatus: 'owned' };

      vi.mocked(databaseService.getRegistryEntry).mockResolvedValue({ uri, itemId, addedAt: Date.now() });
      vi.mocked(databaseService.getBookFromCache).mockResolvedValue(cachedBook as any);
      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true })
      } as any);

      const result = await inventoryService.removeFromLibrary(uri);

      expect(result).toBe(true);
      expect(databaseService.getRegistryEntry).toHaveBeenCalledWith('inventory', uri);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/gateway?action=inventory-delete'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ ids: [itemId], uris: [uri] })
        })
      );
      expect(databaseService.removeRegistryEntry).toHaveBeenCalledWith('inventory', uri);
      expect(databaseService.saveBookToCache).toHaveBeenCalledWith(
        expect.objectContaining({ uri, ownershipStatus: 'none' })
      );
    });

    it('doit supprimer sur le serveur par URI et localement même si aucun itemId n\'existe (modèle V4)', async () => {
      const uri = 'inv:edition1';
      const cachedBook = { uri, title: 'Test Book', ownershipStatus: 'owned' };

      vi.mocked(databaseService.getRegistryEntry).mockResolvedValue(undefined);
      vi.mocked(databaseService.getBookFromCache).mockResolvedValue(cachedBook as any);
      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true })
      } as any);

      const result = await inventoryService.removeFromLibrary(uri);

      expect(result).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/gateway?action=inventory-delete'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ uris: [uri] })
        })
      );
      expect(databaseService.removeRegistryEntry).toHaveBeenCalledWith('inventory', uri);
      expect(databaseService.saveBookToCache).toHaveBeenCalledWith(
        expect.objectContaining({ uri, ownershipStatus: 'none' })
      );
    });
  });

  describe('wishlistService.removeFromWishlist', () => {
    it('doit appeler l\'API de la wishlist et nettoyer le registre et le cache local', async () => {
      wishlistService.wishlistId = 'wishlist123';
      const uris = ['inv:edition1'];
      const cachedBook = { uri: 'inv:edition1', workUri: 'wd:work1', ownershipStatus: 'wish' };

      vi.mocked(databaseService.getBookFromCache).mockResolvedValue(cachedBook as any);
      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true })
      } as any);

      const result = await wishlistService.removeFromWishlist(uris);

      expect(result).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/gateway?action=lists-remove-elements'),
        expect.objectContaining({
          method: 'PUT',
          body: expect.any(String)
        })
      );
      
      const lastCallBody = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body as string);
      expect(lastCallBody.id).toBe('wishlist123');
      expect(lastCallBody.uris).toContain('inv:edition1');
      expect(lastCallBody.uris).toContain('wd:work1');

      expect(databaseService.removeRegistryEntry).toHaveBeenCalledWith('wishlist', 'inv:edition1');
      expect(databaseService.removeRegistryEntry).toHaveBeenCalledWith('wishlist', 'wd:work1');
      
      expect(databaseService.saveBookToCache).toHaveBeenCalledWith(
        expect.objectContaining({ uri: 'inv:edition1', ownershipStatus: 'none' })
      );
    });
  });

  describe('inventoryService.addBulkToLibrary', () => {
    it('doit enregistrer les itemIds retournés par le gateway dans le registre local', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          added: 2,
          addedItems: [
            { uri: 'inv:ed1', itemId: 'item-1' },
            { uri: 'inv:ed2', itemId: 'item-2' }
          ],
          errors: []
        })
      } as any);

      const res = await inventoryService.addBulkToLibrary(['inv:ed1', 'inv:ed2']);
      expect(res).toBe(true);
      expect(databaseService.addRegistryEntry).toHaveBeenCalledWith('inventory', 'inv:ed1', 'item-1');
      expect(databaseService.addRegistryEntry).toHaveBeenCalledWith('inventory', 'inv:ed2', 'item-2');
    });
  });
});
