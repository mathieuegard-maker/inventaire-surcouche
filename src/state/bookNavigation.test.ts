import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  sortBooksByCollectionMode,
  sortSeriesTomes,
  saveBookNavigationOrder,
  getSavedBookNavigationOrder,
  getSavedBookNavigationOrigin,
  resolveCollectionOrderedUrisForBook
} from './bookNavigation';
import { databaseService } from '../core/database/database.service';
import type { HumanizedBook } from '../core/types';

vi.mock('../core/database/database.service', () => ({
  databaseService: {
    getAllBooksFromCache: vi.fn()
  }
}));

const makeBook = (
  uri: string,
  title: string,
  author: string,
  updatedAt: number,
  seriesNumber?: string
): HumanizedBook => ({
  uri,
  isbn13: '9782012101333',
  type: 'edition',
  title,
  authors: [author],
  illustrators: [],
  scriptwriters: [],
  genres: ['BD'],
  ownershipStatus: 'owned',
  seriesNumber,
  updatedAt
});

describe('bookNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const store: Record<string, string> = {};
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; }
    });
  });

  it('trie les livres selon le mode titre, auteur ou date', () => {
    const books = [
      makeBook('b1', 'Les Aventures de Tintin', 'Hergé', 100),
      makeBook('b2', 'Astérix le Gaulois', 'Goscinny', 300),
      makeBook('b3', 'Blacksad', 'Canales', 200)
    ];

    expect(sortBooksByCollectionMode(books, 'title').map((b) => b.uri)).toEqual(['b2', 'b1', 'b3']);
    expect(sortBooksByCollectionMode(books, 'author').map((b) => b.uri)).toEqual(['b3', 'b2', 'b1']);
    expect(sortBooksByCollectionMode(books, 'date').map((b) => b.uri)).toEqual(['b2', 'b3', 'b1']);
  });

  it('trie strictement les tomes d’une série (entiers, décimaux, HS, sans numéro)', () => {
    const tomes = [
      makeBook('t_hs', 'Hors-série', 'Auteur', 1, 'HS 1'),
      makeBook('t10', 'Tome 10', 'Auteur', 1, '10'),
      makeBook('t2', 'Tome 2', 'Auteur', 1, '2'),
      makeBook('t_none', 'Intégrale', 'Auteur', 1),
      makeBook('t1', 'Tome 1', 'Auteur', 1, '1')
    ];

    expect(sortSeriesTomes(tomes).map((b) => b.uri)).toEqual([
      't1',
      't2',
      't10',
      't_hs',
      't_none'
    ]);
  });

  it('sauvegarde et réutilise l’ordre de navigation ou recalcule selon le tri collection', async () => {
    saveBookNavigationOrder(['u3', 'u1', 'u2']);
    expect(getSavedBookNavigationOrder()).toEqual(['u3', 'u1', 'u2']);
    expect(await resolveCollectionOrderedUrisForBook('u1')).toEqual(['u3', 'u1', 'u2']);

    vi.mocked(databaseService.getAllBooksFromCache).mockResolvedValue([
      makeBook('x1', 'Zelda', 'Auteur B', 100),
      makeBook('x2', 'Alpha', 'Auteur A', 500)
    ]);
    // Fallback par tri récent par défaut pour un livre possédé absent du sessionStorage
    expect(await resolveCollectionOrderedUrisForBook('x1')).toEqual(['x2', 'x1']);
  });

  it('isole la navigation selon l’origine (série, wishlist ou ouverture directe)', async () => {
    vi.mocked(databaseService.getAllBooksFromCache).mockResolvedValue([
      makeBook('s1', 'Tome 1', 'Auteur', 100),
      makeBook('other', 'Autre livre possédé', 'Auteur', 500)
    ]);

    saveBookNavigationOrder(['s1'], 'series');
    expect(getSavedBookNavigationOrigin()).toBe('series');
    expect(await resolveCollectionOrderedUrisForBook('s1')).toEqual(['s1']);

    saveBookNavigationOrder(['s1'], 'direct');
    expect(await resolveCollectionOrderedUrisForBook('s1')).toEqual([]);
  });
});
