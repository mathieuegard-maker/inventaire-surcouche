// src/core/orchestrators/book-semantic.orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bookSemanticOrchestrator } from './book-semantic.orchestrator';
import { inventaireSyncService } from '../services/inventaire-sync.service';
import { inventoryService } from '../services/inventory.service';
import { bookCacheService } from '../services/book-cache.service';
import type { HumanizedBook } from '../types';

// Mock database service
vi.mock('../database/database.service', () => ({
  databaseService: {
    saveBookToCache: vi.fn().mockResolvedValue(undefined)
  }
}));

// Mock inventory service
vi.mock('../services/inventory.service', () => ({
  inventoryService: {
    addToLibrary: vi.fn().mockResolvedValue(undefined)
  }
}));

// Mock cache service
vi.mock('../services/book-cache.service', () => ({
  bookCacheService: {
    saveAndProcessImage: vi.fn().mockResolvedValue(undefined)
  }
}));

// Mock sync service
vi.mock('../services/inventaire-sync.service', () => ({
  inventaireSyncService: {
    searchEntity: vi.fn(),
    findSimilarSeries: vi.fn(),
    findSimilarAuthors: vi.fn(),
    syncBookToInventaire: vi.fn(),
    patchBookOnInventaire: vi.fn()
  }
}));

describe('Book Semantic Orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('analyzeDuplicates', () => {
    it('doit renvoyer une liste vide si la serie et les auteurs existent exactement', async () => {
      vi.mocked(inventaireSyncService.searchEntity).mockResolvedValue('inv:exact_uri');

      const steps = await bookSemanticOrchestrator.analyzeDuplicates(
        'René Goscinny, Albert Uderzo',
        'Astérix',
        false
      );

      expect(steps).toHaveLength(0);
      expect(inventaireSyncService.searchEntity).toHaveBeenCalledTimes(3); // 1 pour la série, 2 pour les auteurs
      expect(inventaireSyncService.findSimilarSeries).not.toHaveBeenCalled();
      expect(inventaireSyncService.findSimilarAuthors).not.toHaveBeenCalled();
    });

    it('doit renvoyer des etapes de resolution si des etites similaires existent mais pas de correspondance exacte', async () => {
      vi.mocked(inventaireSyncService.searchEntity).mockResolvedValue(null);
      vi.mocked(inventaireSyncService.findSimilarSeries).mockResolvedValue([
        { name: 'Astérix le Gaulois', uri: 'inv:asterix', distance: 2 }
      ]);
      vi.mocked(inventaireSyncService.findSimilarAuthors).mockResolvedValue([
        { name: 'Albert Uderzo', uri: 'inv:uderzo', distance: 1 }
      ]);

      const steps = await bookSemanticOrchestrator.analyzeDuplicates(
        'Uderzo',
        'Asterix',
        false
      );

      expect(steps).toHaveLength(2);
      expect(steps[0]).toEqual({
        type: 'series',
        name: 'Asterix',
        matches: [{ name: 'Astérix le Gaulois', uri: 'inv:asterix', distance: 2 }]
      });
      expect(steps[1]).toEqual({
        type: 'author',
        name: 'Uderzo',
        matches: [{ name: 'Albert Uderzo', uri: 'inv:uderzo', distance: 1 }]
      });
    });

    it('doit ignorer la serie si noSeries est coche', async () => {
      vi.mocked(inventaireSyncService.searchEntity).mockResolvedValue('inv:author_uri');

      const steps = await bookSemanticOrchestrator.analyzeDuplicates(
        'Uderzo',
        'Asterix',
        true
      );

      expect(steps).toHaveLength(0);
      // N'a été appelé que pour l'auteur (1 fois), pas pour la série
      expect(inventaireSyncService.searchEntity).toHaveBeenCalledTimes(1);
    });

    it('doit ignorer les auteurs ou la serie qui n\'ont pas change par rapport au livre d\'origine lors de l\'edition', async () => {
      vi.mocked(inventaireSyncService.searchEntity).mockResolvedValue(null);
      vi.mocked(inventaireSyncService.findSimilarAuthors).mockResolvedValue([
        { name: 'Albert Uderzo', uri: 'inv:uderzo', distance: 1 }
      ]);

      const originalBook: HumanizedBook = {
        uri: 'inv:edition_123',
        type: 'edition',
        title: 'Titre Original',
        authors: ['René Goscinny'],
        illustrators: [],
        scriptwriters: [],
        series: 'Astérix',
        seriesId: 'inv:asterix_id',
        ownershipStatus: 'owned',
        genres: []
      };

      // René Goscinny et Astérix n'ont pas changé. Seul "Albert Uderzo" est ajouté.
      const steps = await bookSemanticOrchestrator.analyzeDuplicates(
        'René Goscinny, Albert Uderzo',
        'Astérix',
        false,
        originalBook
      );

      expect(steps).toHaveLength(1);
      expect(steps[0].name).toBe('Albert Uderzo'); // Seul l'auteur ajouté est vérifié
    });
  });

  describe('saveCreatedBook', () => {
    it('doit synchroniser en ligne, ajouter a la collection, et traiter l\'image localement', async () => {
      const tempBook: HumanizedBook = {
        uri: 'isbn:9782012101524',
        type: 'edition',
        title: 'Astérix',
        authors: ['Uderzo'],
        illustrators: [],
        scriptwriters: [],
        coverUrl: 'https://inventaire.io/img/converted.jpg',
        ownershipStatus: 'none',
        genres: []
      };

      vi.mocked(inventaireSyncService.syncBookToInventaire).mockResolvedValue({
        editionUri: 'inv:edition_xyz',
        workUri: 'inv:work_xyz',
        seriesUri: 'inv:series_xyz'
      });

      const finalBook = await bookSemanticOrchestrator.saveCreatedBook(
        tempBook,
        'inv:series_xyz',
        { 'Uderzo': 'inv:uderzo_id' }
      );

      expect(inventaireSyncService.syncBookToInventaire).toHaveBeenCalledWith(
        tempBook,
        'inv:series_xyz',
        { 'Uderzo': 'inv:uderzo_id' }
      );
      expect(inventoryService.addToLibrary).toHaveBeenCalledWith('inv:edition_xyz');
      expect(bookCacheService.saveAndProcessImage).toHaveBeenCalledWith(
        expect.objectContaining({
          uri: 'inv:edition_xyz',
          workUri: 'inv:work_xyz',
          seriesId: 'inv:series_xyz',
          coverUrl: 'https://inventaire.io/img/converted.jpg',
          ownershipStatus: 'owned'
        }),
        'owned'
      );
      expect(finalBook.ownershipStatus).toBe('owned');
    });
  });

  describe('saveEditedBook', () => {
    it('doit patcher l\'edition en ligne et sauvegarder dans le cache local', async () => {
      const originalBook: HumanizedBook = {
        uri: 'inv:edition_xyz',
        workUri: 'inv:work_xyz',
        type: 'edition',
        title: 'Astérix le Gaulois',
        authors: ['René Goscinny'],
        illustrators: [],
        scriptwriters: [],
        ownershipStatus: 'owned',
        genres: []
      };

      const updatedFields = {
        title: 'Astérix le Gaulois (Édition Luxe)',
        authors: ['René Goscinny', 'Albert Uderzo'],
        series: 'Astérix',
        seriesNumber: '1',
        publisher: 'Hachette',
        publishDate: '2020',
        coverUrl: 'https://inventaire.io/img/new.jpg'
      };

      vi.mocked(inventaireSyncService.patchBookOnInventaire).mockResolvedValue({
        editionUri: 'inv:edition_xyz',
        workUri: 'inv:work_xyz',
        seriesUri: 'inv:series_xyz'
      });

      const updatedBook = await bookSemanticOrchestrator.saveEditedBook(
        originalBook,
        updatedFields,
        'inv:series_xyz',
        { 'Albert Uderzo': 'inv:uderzo_id' }
      );

      expect(inventaireSyncService.patchBookOnInventaire).toHaveBeenCalledWith(
        originalBook,
        updatedFields,
        'inv:series_xyz',
        { 'Albert Uderzo': 'inv:uderzo_id' }
      );
      expect(bookCacheService.saveAndProcessImage).toHaveBeenCalledWith(
        expect.objectContaining({
          uri: 'inv:edition_xyz',
          title: 'Astérix le Gaulois (Édition Luxe)',
          authors: ['René Goscinny', 'Albert Uderzo'],
          series: 'Astérix',
          seriesId: 'inv:series_xyz',
          seriesNumber: '1',
          publisher: 'Hachette',
          publishDate: '2020',
          coverUrl: 'https://inventaire.io/img/new.jpg',
          isLocallyEdited: true
        }),
        undefined,
        { forceOverwrite: true }
      );
      expect(updatedBook.isLocallyEdited).toBe(true);
    });
  });
});
