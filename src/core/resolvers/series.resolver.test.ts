// src/core/resolvers/series.resolver.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { seriesResolver } from './series.resolver';
import { databaseService } from '../database/database.service';
import { syncOrchestrator } from '../orchestrators/sync.orchestrator';

// --- MOCKING ---
vi.mock('../database/database.service', () => ({
  databaseService: {
    getBookFromCache: vi.fn(),
    getEditionByWorkFromCache: vi.fn(),
    saveBookToCache: vi.fn()
  }
}));
vi.mock('../services/inventory.service', () => ({
  inventoryService: { isUriOwned: vi.fn() }
}));
vi.mock('../services/wishlist.service', () => ({
  wishlistService: { isUriWished: vi.fn() }
}));
vi.mock('../orchestrators/sync.orchestrator', () => ({
  syncOrchestrator: { hydrateRemainingSeries: vi.fn().mockResolvedValue(undefined) }
}));

globalThis.fetch = vi.fn();

describe('Series Resolver (Windowing)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('doit isoler 20 tomes urgents et envoyer le reste en arrière-plan', async () => {
    // Arrange : On invente une série de 25 tomes (pour dépasser la limite de 20)
    const fakeUris = Array.from({length: 25}, (_, i) => `wd:Tome${i+1}`);
    
    vi.mocked(globalThis.fetch).mockImplementation(async (url: string | Request | URL) => {
      const urlStr = url.toString();
      // CORRECTION : On écoute la nouvelle route Gateway
      if (urlStr.includes('action=series-list')) {
        return { json: async () => ({ tomes: fakeUris }) } as any;
      }
      // CORRECTION : On rend l'écoute de by-uris plus flexible
      if (urlStr.includes('entities/by-uris')) {
        // Simulation des traductions brutes pour éviter que le mapper ne plante
        const mockEntities: any = {};
        fakeUris.forEach(uri => { mockEntities[uri] = { type: 'work', claims: {} }; });
        return { json: async () => ({ entities: mockEntities }) } as any;
      }
      return { json: async () => ({}) } as any;
    });

    // On simule une base de données vide pour forcer le téléchargement des 25 tomes
    vi.mocked(databaseService.getBookFromCache).mockResolvedValue(undefined);
    vi.mocked(databaseService.getEditionByWorkFromCache).mockResolvedValue(undefined);

    // Act
    await seriesResolver.getFullSeries('wd:SERIE_TEST');

    // Assert : Vérification de la mécanique de coupe (Windowing)
    expect(syncOrchestrator.hydrateRemainingSeries).toHaveBeenCalledTimes(1);
    
    // On vérifie que la tâche de fond a bien reçu EXACTEMENT les 5 tomes restants
    const backgroundCallArg = vi.mocked(syncOrchestrator.hydrateRemainingSeries).mock.calls[0][0];
    expect(backgroundCallArg.length).toBe(5);
    
    // On s'assure que le lot de fond contient bien les tomes 21 à 25
    expect(backgroundCallArg).toContain('wd:Tome21');
    expect(backgroundCallArg).toContain('wd:Tome25');
  });
});