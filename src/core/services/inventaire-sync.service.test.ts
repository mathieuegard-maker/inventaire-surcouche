// src/core/services/inventaire-sync.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inventaireSyncService } from './inventaire-sync.service';
import type { HumanizedBook } from '../types';
import { databaseService } from '../database/database.service';

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

      // Vérifier que la création de l'édition a bien reçu la propriété wdt:P1476 (titre)
      const createCalls = fetchMock.mock.calls.filter((c: any) => c[0].includes('action=entities-create'));
      const editionCall = createCalls.find((c: any) => {
        const body = JSON.parse(c[1].body);
        return body.claims?.['wdt:P31']?.[0] === 'wd:Q3331189';
      });
      expect(editionCall).toBeDefined();
      const editionBody = JSON.parse(editionCall![1].body);
      expect(editionBody.claims?.['wdt:P1476']).toEqual(['Docteur Bonheur']);
    });
  });

  describe('findSimilarSeries', () => {
    it('doit filtrer les series locales et distantes selon la distance de Levenshtein', async () => {
      vi.spyOn(databaseService, 'getAllCachedBooks').mockResolvedValue([
        {
          uri: 'inv:ed1',
          title: 'Tome 1',
          authors: [],
          illustrators: [],
          scriptwriters: [],
          genres: [],
          type: 'edition',
          series: 'Spirou et Fantasio',
          seriesId: 'inv:spirou_fantasio',
          ownershipStatus: 'owned'
        }
      ] as any);

      const mockSearchData = {
        results: [
          { type: 'series', label: 'Le Petit Spirou', uri: 'wd:Q3225492' },
          { type: 'series', label: 'Spirou', uri: 'wd:Q1128277' },
          { type: 'series', label: 'Asterix', uri: 'wd:Q42' }
        ]
      };
      
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockSearchData)
      });
      vi.stubGlobal('fetch', fetchMock);

      const results = await inventaireSyncService.findSimilarSeries('Spriou');
      
      expect(results).toContainEqual({
        name: 'Spirou',
        uri: 'wd:Q1128277',
        distance: 2
      });
    });
  });

  describe('findSimilarAuthors', () => {
    it('doit filtrer les auteurs distants selon la distance de Levenshtein', async () => {
      const mockSearchData = {
        results: [
          { type: 'humans', label: 'Goscinny', uri: 'wd:Q191823' },
          { type: 'humans', label: 'René Goscinny', uri: 'wd:Q191823' },
          { type: 'humans', label: 'Uderzo', uri: 'wd:Q206781' }
        ]
      };
      
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockSearchData)
      });
      vi.stubGlobal('fetch', fetchMock);

      const results = await inventaireSyncService.findSimilarAuthors('Gociny');
      
      expect(results).toContainEqual({
        name: 'Goscinny',
        uri: 'wd:Q191823',
        distance: 2
      });
    });
  });

  describe('patchBookOnInventaire', () => {
    it('doit cloner le Work si Wikidata et lier l\'edition', async () => {
      const originalBook: HumanizedBook = {
        uri: 'inv:edition_test',
        workUri: 'wd:Q_WIKIDATA_WORK',
        title: 'Original Title',
        authors: ['Author A'],
        illustrators: [],
        scriptwriters: [],
        genres: [],
        type: 'edition',
        ownershipStatus: 'owned'
      };

      const updatedData = {
        title: 'New Title',
        authors: ['Author A', 'Author B'],
        series: 'New Series',
        seriesNumber: '2',
        publisher: 'Dupuis',
        publishDate: '2020',
        coverUrl: ''
      };

      const fetchMock = vi.fn().mockImplementation((url: string, options?: any) => {
        if (url.includes('action=search-text')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ results: [] }) });
        }
        if (url.includes('action=entities-create')) {
          const body = JSON.parse(options.body);
          if (body.claims?.['wdt:P31']?.[0] === 'wd:Q14406742') {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ entity: { uri: 'inv:new_series' } }) });
          }
          if (body.claims?.['wdt:P31']?.[0] === 'wd:Q5') {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ entity: { uri: 'inv:new_author' } }) });
          }
          if (body.claims?.['wdt:P31']?.[0] === 'wd:Q47461344') {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ entity: { uri: 'inv:new_cloned_work' } }) });
          }
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await inventaireSyncService.patchBookOnInventaire(originalBook, updatedData);

      expect(res.workUri).toBe('inv:new_cloned_work');
      expect(res.editionUri).toBe('inv:edition_test');
    });

    it('doit utiliser chosenAuthorUris si fourni pour eviter de resoudre/creer l\'auteur', async () => {
      const originalBook: HumanizedBook = {
        uri: 'inv:edition_test',
        workUri: 'inv:local_work_123',
        title: 'Original Title',
        authors: ['Original Author'],
        illustrators: [],
        scriptwriters: [],
        genres: [],
        type: 'edition',
        ownershipStatus: 'owned'
      };

      const updatedData = {
        title: 'Original Title',
        authors: ['Resolved Author'],
        series: '',
        seriesNumber: '',
        publisher: '',
        publishDate: '',
        coverUrl: ''
      };

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('action=entities-by-uris&uris=inv%3Alocal_work_123')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              entities: {
                'inv:local_work_123': {
                  claims: {
                    'wdt:P50': ['inv:old_author_uri']
                  }
                }
              }
            })
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
      vi.stubGlobal('fetch', fetchMock);

      const chosenAuthorUris = {
        'Resolved Author': 'inv:resolved_author_uri'
      };

      await inventaireSyncService.patchBookOnInventaire(
        originalBook,
        updatedData,
        undefined,
        chosenAuthorUris
      );

      const updateCalls = fetchMock.mock.calls.filter(c => c[0].includes('entities-update-claim'));
      expect(updateCalls.length).toBe(2);
      
      const removeCallBody = JSON.parse(updateCalls[0][1].body);
      expect(removeCallBody.property).toBe('wdt:P50');
      expect(removeCallBody['old-value']).toBe('inv:old_author_uri');
      expect(removeCallBody['new-value']).toBeUndefined();

      const addCallBody = JSON.parse(updateCalls[1][1].body);
      expect(addCallBody.property).toBe('wdt:P50');
      expect(addCallBody['old-value']).toBeUndefined();
      expect(addCallBody['new-value']).toBe('inv:resolved_author_uri');
    });
  });

  describe('updateClaim', () => {
    it('doit resoudre avec succes si la requete HTTP est valide', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(inventaireSyncService.updateClaim('inv:work_123', 'wdt:P179', undefined, 'wd:Q784649'))
        .resolves.not.toThrow();
    });

    it('doit lever une erreur si la requete echoue avec un autre message', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        text: () => Promise.resolve('{"status":400,"message":"some other error"}')
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(inventaireSyncService.updateClaim('inv:work_123', 'wdt:P179', undefined, 'wd:Q784649'))
        .rejects.toThrow("Erreur lors de la mise à jour de la propriété");
    });

    it('doit ignorer l\'erreur si le claim existe deja', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        text: () => Promise.resolve('{"status":400,"message":"claim property new value already exist"}')
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(inventaireSyncService.updateClaim('inv:work_123', 'wdt:P179', undefined, 'wd:Q784649'))
        .resolves.not.toThrow();
    });
  });
});
