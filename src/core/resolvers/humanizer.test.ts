// src/core/resolvers/humanizer.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { entityHumanizer } from './humanizer';
import { imageService } from '../services/image.service';
import type { RawBook } from '../types';

// 1. MOCKING (Les Simulacres)
// On désactive le vrai service d'image pour ne pas faire planter Node.js avec des Canvas
vi.mock('../services/image.service', () => ({
  imageService: {
    compressAndEncode: vi.fn()
  }
}));

// On intercepte TOUTES les requêtes réseau (fetch) via globalThis (Standard JS)
globalThis.fetch = vi.fn();

describe('Entity Humanizer', () => {
  
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('doit regrouper les traductions (Mega-Batching) et ne pas bloquer sur l\'image', async () => {
    // --- ARRANGE (Préparation) ---
    const fakeRawBook: RawBook = {
      uri: 'wd:Q_ASTERIX',
      type: 'edition',
      title: 'Astérix le Gaulois',
      authorIds: ['wd:Q_GOSCINNY', 'wd:Q_UDERZO'],
      publisherId: 'wd:Q_DARGAUD',
      genreIds: ['wd:Q_BD'],
      coverUrl: 'https://inventaire.io/img/asterix.jpg'
    } as RawBook;

    const fakeApiResponse = {
      entities: {
        'wd:Q_GOSCINNY': { labels: { fr: 'René Goscinny' } },
        'wd:Q_UDERZO': { labels: { en: 'Albert Uderzo' } },
        'wd:Q_DARGAUD': { labels: { fr: 'Dargaud' } },
        'wd:Q_BD': { labels: { fr: 'Bande Dessinée' } }
      }
    };

    // On dit au faux 'fetch' de renvoyer notre faux dictionnaire
    vi.mocked(globalThis.fetch).mockResolvedValue({
      json: vi.fn().mockResolvedValue(fakeApiResponse)
    } as any);

    // --- ACT (Action) ---
    const result = await entityHumanizer.humanize(fakeRawBook);

    // --- ASSERT (Vérifications) ---
    
    // Test 1 : Vérifier le Mega-Batching
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    
    const fetchUrl = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    // CORRECTION : On s'attend bien à ce que le ":" soit encodé en "%3A" et le "|" en "%7C"
    expect(fetchUrl).toContain('uris=wd%3AQ_GOSCINNY%7Cwd%3AQ_UDERZO%7Cwd%3AQ_DARGAUD%7Cwd%3AQ_BD');

    // Test 2 : Vérifier les traductions
    expect(result.authors).toEqual(['René Goscinny', 'Albert Uderzo']);
    expect(result.publisher).toBe('Dargaud');
    expect(result.genres).toEqual(['Bande Dessinée']);

    // Test 3 : Vérifier le Fire & Forget (L'image ne bloque plus)
    expect(result.localCover).toBeUndefined();
    expect(imageService.compressAndEncode).not.toHaveBeenCalled();
    expect(result.coverUrl).toBe('https://inventaire.io/img/asterix.jpg');
  });

  it('doit survivre si l\'API d\'Inventaire ne connait pas l\'identifiant', async () => {
    // Arrange
    const fakeRawBook = { uri: 'wd:Q1', title: 'Test', authorIds: ['wd:Q_INCONNU'] } as RawBook;
    
    vi.mocked(globalThis.fetch).mockResolvedValue({
      json: vi.fn().mockResolvedValue({ entities: {} })
    } as any);

    // Act
    const result = await entityHumanizer.humanize(fakeRawBook);

    // Assert
    expect(result.authors).toEqual(['wd:Q_INCONNU']);
  });
});