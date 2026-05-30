// src/core/orchestrators/sync.orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncOrchestrator } from './sync.orchestrator';
import { databaseService } from '../database/database.service';
import { workUriResolver } from '../resolvers/workUri.resolver';
import { bookCacheService } from '../services/book-cache.service';

// Mock database service
vi.mock('../database/database.service', () => ({
  databaseService: {
    getAllRegistryUris: vi.fn(),
    getAllBooksFromCache: vi.fn(),
    getBookFromCache: vi.fn(),
    getBooksBySeriesId: vi.fn().mockResolvedValue([]),
  }
}));

// Mock resolvers & services
vi.mock('../resolvers/workUri.resolver', () => ({
  workUriResolver: {
    resolveBulk: vi.fn()
  }
}));

vi.mock('../services/book-cache.service', () => ({
  bookCacheService: {
    saveAndProcessImage: vi.fn().mockResolvedValue(undefined)
  }
}));

describe('Sync Orchestrator - Cache Hydration & Bidirectional Reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('doit réinitialiser ownershipStatus à "none" pour les livres supprimés à distance', async () => {
    // 1. Arrange
    // Registres distants (ne contiennent que "book1")
    vi.mocked(databaseService.getAllRegistryUris).mockImplementation(async (table) => {
      if (table === 'inventory') return ['inv:book1'];
      if (table === 'wishlist') return [];
      return [];
    });

    vi.mocked(workUriResolver.resolveBulk).mockImplementation(async (uris) => uris);

    // Cache local (contient "book1" et "book2" qui a été retiré à distance)
    const localBooks = [
      { uri: 'inv:book1', ownershipStatus: 'owned', title: 'Book 1' },
      { uri: 'inv:book2', ownershipStatus: 'owned', title: 'Book 2 (Removed)' }
    ];
    vi.mocked(databaseService.getAllBooksFromCache).mockResolvedValue(localBooks as any[]);
    vi.mocked(databaseService.getBookFromCache).mockImplementation(async (uri) => {
      return localBooks.find(b => b.uri === uri) as any;
    });

    // 2. Act
    await syncOrchestrator.hydrateCacheInBackground();

    // 3. Assert
    // book1 est toujours possédé, pas besoin de le modifier ou de le supprimer
    // book2 est marqué owned en local mais n'est pas dans l'inventaire distant -> doit être réinitialisé à 'none'
    expect(bookCacheService.saveAndProcessImage).toHaveBeenCalledWith(
      expect.objectContaining({ uri: 'inv:book2' }),
      'none'
    );
    expect(bookCacheService.saveAndProcessImage).not.toHaveBeenCalledWith(
      expect.objectContaining({ uri: 'inv:book1' }),
      'none'
    );
  });
});
