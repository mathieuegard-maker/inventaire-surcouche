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
    const fakeUris = Array.from({length: 25}, (_, i) => `wd:Tome${i+1}`);
    
    vi.mocked(globalThis.fetch).mockImplementation(async (url: string | Request | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('action=series-list')) {
        // CORRECTION : On s'aligne sur le nouveau Gateway qui renvoie 'uris'
        return { json: async () => ({ uris: fakeUris }) } as any;
      }
      if (urlStr.includes('entities/by-uris')) {
        const mockEntities: any = {};
        fakeUris.forEach(uri => { mockEntities[uri] = { type: 'work', claims: {} }; });
        return { json: async () => ({ entities: mockEntities }) } as any;
      }
      return { json: async () => ({}) } as any;
    });

    vi.mocked(databaseService.getBookFromCache).mockResolvedValue(undefined);
    vi.mocked(databaseService.getEditionByWorkFromCache).mockResolvedValue(undefined);

    await seriesResolver.getFullSeries('wd:SERIE_TEST');

    expect(syncOrchestrator.hydrateRemainingSeries).toHaveBeenCalledTimes(1);
    
    const backgroundCallArg = vi.mocked(syncOrchestrator.hydrateRemainingSeries).mock.calls[0][0];
    expect(backgroundCallArg.length).toBe(5);
    
    expect(backgroundCallArg).toContain('wd:Tome21');
    expect(backgroundCallArg).toContain('wd:Tome25');
  });
});