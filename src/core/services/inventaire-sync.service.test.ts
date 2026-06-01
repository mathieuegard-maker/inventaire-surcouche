// src/core/services/inventaire-sync.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inventaireSyncService } from './inventaire-sync.service';
import type { HumanizedBook } from '../types';

describe('Inventaire Sync Service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('searchEntity', () => {
    it('doit retourner l\'URI de l\'entité si elle correspond exactement', async () => {
      const mockSearchData = {
        results: [
          { type: 'series', label: 'Thorgal', uri: 'wd:Q128277' },
          { type: 'series', label: 'Thorgal Saga', uri: 'wd:Q121840107' }
        ]
      };
      
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockSearchData)
      });
      vi.stubGlobal('fetch', fetchMock);

      const uri = await inventaireSyncService.searchEntity('Thorgal', 'series');
      expect(uri).toBe('wd:Q128277');
    });

    it('doit retourner null si aucun label ne correspond exactement', async () => {
      const mockSearchData = {
        results: [
          { type: 'series', label: 'Thorgal Saga', uri: 'wd:Q121840107' }
        ]
      };
      
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockSearchData)
      });
      vi.stubGlobal('fetch', fetchMock);

      const uri = await inventaireSyncService.searchEntity('Thorgal', 'series');
      expect(uri).toBeNull();
    });
  });

  describe('createEntity', () => {
    it('doit envoyer le bon payload et retourner l\'URI créée', async () => {
      const mockCreateResponse = {
        entity: {
          uri: 'inv:created_series_123'
        }
      };

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockCreateResponse)
      });
      vi.stubGlobal('fetch', fetchMock);

      const uri = await inventaireSyncService.createEntity('serie', 'Thorgal', {
        'wdt:P31': [ 'wd:Q14406742' ]
      });
      
      expect(uri).toBe('inv:created_series_123');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('doit lever une erreur si le statut de création est KO', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        text: () => Promise.resolve('Conflict or validation error')
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(inventaireSyncService.createEntity('serie', 'Thorgal', {}))
        .rejects.toThrow("Erreur lors de la création de l'entité serie");
    });
  });

  describe('syncBookToInventaire', () => {
    it('doit piloter l\'aspiration séquentielle et retourner les URIs résolues', async () => {
      const testBook: HumanizedBook = {
        uri: 'isbn:9782803622641',
        title: 'Docteur Bonheur',
        authors: ['Clarke', 'Turk'],
        illustrators: [],
        scriptwriters: [],
        genres: [],
        type: 'edition',
        publisher: 'Lombard',
        publishDate: '2007',
        ownershipStatus: 'none',
        series: 'Docteur Bonheur',
        seriesNumber: '1'
      };

      // Mock des appels séquentiels :
      // 1. Search series "Docteur Bonheur" -> non trouvée (null)
      // 2. Create series "Docteur Bonheur" -> "inv:series_db"
      // 3. Search author "Clarke" -> trouvé ("wd:ClarkeId")
      // 4. Search author "Turk" -> non trouvé (null)
      // 5. Create author "Turk" -> "inv:author_turk"
      // 6. Search work "Docteur Bonheur" -> non trouvé (null)
      // 7. Create work "Docteur Bonheur" -> "inv:work_db"
      // 8. Search edition "isbn:9782803622641" -> non trouvée (null redirects)
      // 9. Create edition "Docteur Bonheur" -> "inv:edition_db"

      const fetchMock = vi.fn().mockImplementation((url: string, options?: any) => {
        if (url.includes('action=search-text')) {
          const q = decodeURIComponent(url.split('q=')[1]);
          if (q.includes('Clarke')) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ results: [{ type: 'humans', label: 'Clarke', uri: 'wd:ClarkeId' }] })
            });
          }
          // Autres recherches non trouvées
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ results: [] })
          });
        }
        
        if (url.includes('action=entities-create')) {
          const body = JSON.parse(options.body);
          const p31 = body.claims?.['wdt:P31']?.[0];
          if (p31 === 'wd:Q14406742') {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ entity: { uri: 'inv:series_db' } }) });
          }
          if (p31 === 'wd:Q5') {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ entity: { uri: 'inv:author_turk' } }) });
          }
          if (p31 === 'wd:Q47461344') {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ entity: { uri: 'inv:work_db' } }) });
          }
          if (p31 === 'wd:Q3331189') {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ entity: { uri: 'inv:edition_db' } }) });
          }
        }

        // Par défaut
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({})
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await inventaireSyncService.syncBookToInventaire(testBook);
      expect(result).toEqual({
        editionUri: 'inv:edition_db',
        workUri: 'inv:work_db',
        seriesUri: 'inv:series_db'
      });
    });
  });
});
