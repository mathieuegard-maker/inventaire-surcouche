// src/core/orchestrators/background-creation.orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { backgroundCreationOrchestrator } from './background-creation.orchestrator';
import { databaseService } from '../database/database.service';
import { inventaireSyncService } from '../services/inventaire-sync.service';
import { bnfResolver } from '../resolvers/bnf.resolver';
import type { HumanizedBook } from '../types';

vi.mock('../database/database.service', () => ({
  databaseService: {
    findLocalSeriesMatches: vi.fn().mockResolvedValue([]),
    saveBookToCache: vi.fn().mockResolvedValue(undefined),
    addRegistryEntry: vi.fn().mockResolvedValue(undefined),
    savePendingCreation: vi.fn().mockResolvedValue(1),
    getPendingCreations: vi.fn().mockResolvedValue([]),
    updatePendingCreation: vi.fn().mockResolvedValue(undefined),
    deletePendingCreation: vi.fn().mockResolvedValue(undefined),
    replaceBookUri: vi.fn(),
    getBookFromCache: vi.fn().mockResolvedValue(undefined)
  }
}));

vi.mock('../services/inventaire-sync.service', () => ({
  inventaireSyncService: {
    syncBookToInventaire: vi.fn(),
    updateClaim: vi.fn().mockResolvedValue(undefined),
    searchEntity: vi.fn().mockResolvedValue(null),
    resolveOrCreateAuthor: vi.fn().mockResolvedValue('inv:author_new'),
    createEntity: vi.fn()
  }
}));

vi.mock('../services/inventory.service', () => ({
  inventoryService: {
    addToLibrary: vi.fn().mockResolvedValue(true)
  }
}));

vi.mock('../services/book-cache.service', () => ({
  bookCacheService: {
    saveAndProcessImage: vi.fn().mockResolvedValue(undefined)
  }
}));

vi.mock('../resolvers/bnf.resolver', async () => {
  const actual = await vi.importActual<typeof import('../resolvers/bnf.resolver')>('../resolvers/bnf.resolver');
  return {
    ...actual,
    bnfResolver: {
      ...actual.bnfResolver,
      searchSeriesVolumes: vi.fn().mockResolvedValue([])
    }
  };
});

describe('Background Creation Orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backgroundCreationOrchestrator.isProcessing = false;
  });

  const makeBook = (overrides: Partial<HumanizedBook> = {}): HumanizedBook => ({
    uri: 'isbn:9782800136929',
    isbn13: '9782800136929',
    type: 'edition',
    title: 'La disparition',
    authors: ['Fabien Vehlmann'],
    illustrators: [],
    scriptwriters: [],
    genres: [],
    ownershipStatus: 'none',
    series: 'Seuls',
    seriesNumber: '1',
    ...overrides
  });

  it('doit enregistrer localement immédiatement et lancer processQueue sans bloquer', async () => {
    const processSpy = vi.spyOn(backgroundCreationOrchestrator, 'processQueue').mockImplementation(async () => {});
    const book = makeBook();

    const saved = await backgroundCreationOrchestrator.enqueueBookCreation({
      tempBook: book,
      resolvedAuthorUris: { 'Fabien Vehlmann': 'inv:author_veh' },
      expandSeries: true
    });

    expect(saved.ownershipStatus).toBe('owned');
    expect(databaseService.saveBookToCache).toHaveBeenCalledWith(expect.objectContaining({ uri: 'isbn:9782800136929', ownershipStatus: 'owned' }));
    expect(databaseService.addRegistryEntry).toHaveBeenCalledWith('inventory', 'isbn:9782800136929');
    expect(databaseService.savePendingCreation).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledTimes(1);

    processSpy.mockRestore();
  });

  it('doit fusionner les livres locaux de la série, éviter les doublons BNF/locaux et créer les tomes manquants', async () => {
    const seedBook = makeBook({
      uri: 'inv:ed_t1',
      workUri: 'inv:work_t1',
      seriesId: 'inv:series_seuls',
      ownershipStatus: 'owned'
    });

    // Un livre local pré-existant (Tome 2) rattaché à une ancienne série / sans seriesId,
    // plus un doublon temporaire isbn: du Tome 1
    const existingTome2 = makeBook({
      uri: 'inv:ed_t2',
      workUri: 'inv:work_t2',
      isbn13: '9782800138000',
      title: 'Le maître des couteaux',
      seriesId: 'inv:old_dup_series',
      series: 'Seuls',
      seriesNumber: '2',
      ownershipStatus: 'owned'
    });
    const dupLocalTome1 = makeBook({
      uri: 'isbn:9782800136929',
      seriesId: undefined,
      ownershipStatus: 'owned'
    });

    vi.mocked(databaseService.findLocalSeriesMatches).mockResolvedValue([seedBook, dupLocalTome1, existingTome2]);
    vi.mocked(databaseService.replaceBookUri).mockImplementation(async (_oldUri, winner) => winner);

    // BNF renvoie Tome 1 (déjà possédé), Tome 2 (déjà en base locale), Tome 3 (absent -> à créer)
    vi.mocked(bnfResolver.searchSeriesVolumes).mockResolvedValue([
      { isbn: '9782800136929', title: 'La disparition', authors: ['Fabien Vehlmann'], series: 'Seuls', seriesNumber: '1' },
      { isbn: '9782800138000', title: 'Le maître des couteaux', authors: ['Fabien Vehlmann'], series: 'Seuls', seriesNumber: '2' },
      { isbn: '9782800140000', title: 'Le clan du requin', authors: ['Fabien Vehlmann'], series: 'Seuls', seriesNumber: '3', publishDate: '2008' }
    ]);

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('action=series-list')) {
        return Promise.resolve({ ok: true, json: async () => ({ uris: ['inv:work_t1'] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ entities: {}, redirects: {} }) });
    }));

    vi.mocked(inventaireSyncService.createEntity)
      .mockResolvedValueOnce('inv:work_t3')
      .mockResolvedValueOnce('inv:ed_t3');

    await backgroundCreationOrchestrator.reconcileAndExpandSeries(
      seedBook,
      'inv:series_seuls',
      'inv:work_t1',
      { 'Fabien Vehlmann': 'inv:author_veh' },
      true
    );

    // 1. Le doublon local isbn: du Tome 1 a été fusionné avec inv:ed_t1
    expect(databaseService.replaceBookUri).toHaveBeenCalledWith(
      'isbn:9782800136929',
      expect.objectContaining({ uri: 'inv:ed_t1', seriesId: 'inv:series_seuls' })
    );

    // 2. Le Tome 2 local existant a été aligné sur inv:series_seuls en local ET sur inventaire.io
    expect(databaseService.saveBookToCache).toHaveBeenCalledWith(
      expect.objectContaining({ uri: 'inv:ed_t2', seriesId: 'inv:series_seuls' })
    );
    expect(inventaireSyncService.updateClaim).toHaveBeenCalledWith(
      'inv:work_t2',
      'wdt:P179',
      'inv:old_dup_series',
      'inv:series_seuls'
    );

    // 3. Seul le Tome 3 (manquant) a été créé sur inventaire.io (work + edition = 2 créations)
    expect(inventaireSyncService.createEntity).toHaveBeenCalledTimes(2);
    expect(inventaireSyncService.createEntity).toHaveBeenCalledWith(
      'work',
      'Le clan du requin',
      expect.objectContaining({ 'wdt:P179': ['inv:series_seuls'], 'wdt:P1545': ['3'], 'wdt:P50': ['inv:author_veh'] })
    );
    expect(databaseService.saveBookToCache).toHaveBeenCalledWith(
      expect.objectContaining({ uri: 'inv:ed_t3', seriesId: 'inv:series_seuls', seriesNumber: '3', ownershipStatus: 'none' })
    );
  });
});
