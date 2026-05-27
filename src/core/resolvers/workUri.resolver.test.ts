// src/core/resolvers/workUri.resolver.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workUriResolver } from './workUri.resolver';
import { databaseService } from '../database/database.service';
//import { configService } from '../services/config.service';

// 1. MOCKING DES DÉPENDANCES
vi.mock('../database/database.service', () => ({
  databaseService: {
    getEditionByWorkFromCache: vi.fn(),
    saveBookToCache: vi.fn()
  }
}));

vi.mock('../services/config.service', () => ({
  configService: {
    getPreferredLanguageWdCode: vi.fn().mockReturnValue('wd:Q150') // Langue par défaut : français
  }
}));

globalThis.fetch = vi.fn();

describe('Work URI Resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolveBulk', () => {
    it('doit renvoyer directement les URI de type isbn:', async () => {
      // Act
      const result = await workUriResolver.resolveBulk(['isbn:9782203353275']);

      // Assert
      expect(result).toEqual(['isbn:9782203353275']);
      expect(databaseService.getEditionByWorkFromCache).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('doit utiliser le cache local en priorité', async () => {
      // Arrange
      vi.mocked(databaseService.getEditionByWorkFromCache).mockResolvedValue({
        uri: 'inv:tintin_tibet_fr',
        workUri: 'wd:Q_TINTIN_TIBET'
      } as any);

      // Act
      const result = await workUriResolver.resolveBulk(['wd:Q_TINTIN_TIBET']);

      // Assert
      expect(result).toEqual(['inv:tintin_tibet_fr']);
      expect(databaseService.getEditionByWorkFromCache).toHaveBeenCalledWith('wd:Q_TINTIN_TIBET');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('doit arbitrer l\'élection de l\'édition physique (langue, regex anti-bruit, Levenshtein, native)', async () => {
      // Arrange
      // Pas en cache local
      vi.mocked(databaseService.getEditionByWorkFromCache).mockResolvedValue(undefined);

      // Mocks réseau
      const mockReverseClaimsResponse = {
        uris: ['wd:EDITION_JUNK_INTEGRALE', 'inv:EDITION_NATIVE_FR', 'wd:EDITION_ENGLISH']
      };

      const mockByUrisResponse = {
        entities: {
          'wd:EDITION_JUNK_INTEGRALE': {
            labels: { fr: 'Tintin au Tibet - L\'intégrale' },
            claims: { 'wdt:P407': ['wd:Q150'] } // Français, mais JUNK (Intégrale)
          },
          'inv:EDITION_NATIVE_FR': {
            labels: { fr: 'Tintin au Tibet' },
            claims: { 'wdt:P407': ['wd:Q150'] } // Français, propre (non junk), natif inv:
          },
          'wd:EDITION_ENGLISH': {
            labels: { en: 'Tintin in Tibet' },
            claims: { 'wdt:P407': ['wd:Q1860'] } // Anglais
          },
          'wd:Q_TINTIN_TIBET': {
            labels: { fr: 'Tintin au Tibet' }
          }
        }
      };

      vi.mocked(globalThis.fetch)
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue(mockReverseClaimsResponse)
        } as any)
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue(mockByUrisResponse)
        } as any)
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue(mockByUrisResponse)
        } as any);

      // Act
      const result = await workUriResolver.resolveBulk(['wd:Q_TINTIN_TIBET']);

      // Assert
      // L'élection doit préférer l'édition en français propre non intégrale et native (inv:EDITION_NATIVE_FR)
      expect(result).toEqual(['inv:EDITION_NATIVE_FR']);
    });
  });

  describe('resolveIsbnFromWorkUri', () => {
    it('doit résoudre l\'ISBN depuis le cache si disponible', async () => {
      // Arrange
      vi.mocked(databaseService.getEditionByWorkFromCache).mockResolvedValue({
        uri: 'inv:123',
        isbn13: '9782203353275'
      } as any);

      // Act
      const result = await workUriResolver.resolveIsbnFromWorkUri('wd:Q123');

      // Assert
      expect(result).toBe('9782203353275');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });
});
