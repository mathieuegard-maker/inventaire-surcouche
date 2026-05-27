// src/core/orchestrators/search.orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchService } from './search.orchestrator';
import { databaseService } from '../database/database.service';
import { wishlistService } from '../services/wishlist.service';
import { syncOrchestrator } from './sync.orchestrator';

// --- MOCKING ---
vi.mock('../database/database.service', () => ({
  databaseService: {
    getBookByIsbn: vi.fn(),
    saveBookToCache: vi.fn(),
    getBookFromCache: vi.fn(),
    isUriInRegistry: vi.fn(),
    getOtherOwnedEdition: vi.fn(),
    getLoan: vi.fn()
  }
}));

vi.mock('../services/wishlist.service', () => ({
  wishlistService: { isUriWished: vi.fn() }
}));
vi.mock('../resolvers/entity.resolver', () => ({
  entityResolver: { fromIsbn: vi.fn() }
}));
vi.mock('../resolvers/humanizer', () => ({
  entityHumanizer: { humanize: vi.fn() }
}));
vi.mock('../resolvers/series.resolver', () => ({
  seriesResolver: { getFullSeries: vi.fn() }
}));
vi.mock('../services/image.service', () => ({
  imageService: { compressAndEncode: vi.fn() }
}));
vi.mock('./sync.orchestrator', () => ({
  syncOrchestrator: { refreshBookInBackground: vi.fn().mockResolvedValue(undefined) }
}));

describe('Search Orchestrator (TTL & Cache)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('doit renvoyer le livre du cache directement si récent (TTL < 30j)', async () => {
    // Arrange : Un livre vieux de seulement 1 seconde
    const freshBook = { uri: 'wd:Q1', title: 'Récent', updatedAt: Date.now() - 1000 };
    vi.mocked(databaseService.getBookByIsbn).mockResolvedValue(freshBook as any);
    vi.mocked(databaseService.isUriInRegistry).mockResolvedValue(false);
    vi.mocked(wishlistService.isUriWished).mockResolvedValue(false);
    vi.mocked(databaseService.getLoan).mockResolvedValue(undefined);

    // Act
    const res = await searchService.searchByIsbn('9782012101524');

    // Assert : Le livre vient du cache, et on n'a PAS appelé le rafraichissement
    expect(res?.source).toBe('cache');
    expect(syncOrchestrator.refreshBookInBackground).not.toHaveBeenCalled();
  });

  it('doit déclencher un rafraichissement fantôme si le cache est périmé (TTL > 30j)', async () => {
    // Arrange : Un livre vieux de 31 jours
    const THIRTY_ONE_DAYS = 31 * 24 * 60 * 60 * 1000;
    const oldBook = { uri: 'wd:Q1', title: 'Vieux', updatedAt: Date.now() - THIRTY_ONE_DAYS };
    
    vi.mocked(databaseService.getBookByIsbn).mockResolvedValue(oldBook as any);
    vi.mocked(databaseService.isUriInRegistry).mockResolvedValue(false);
    vi.mocked(wishlistService.isUriWished).mockResolvedValue(false);
    vi.mocked(databaseService.getLoan).mockResolvedValue(undefined);

    // Act
    const res = await searchService.searchByIsbn('9782012101524');

    // Assert : Le livre vient toujours du cache pour la rapidité visuelle...
    expect(res?.source).toBe('cache');
    // ... MAIS la mise à jour fantôme a bien été ordonnée en tâche de fond !
    expect(syncOrchestrator.refreshBookInBackground).toHaveBeenCalledWith('9782012101524');
  });
});