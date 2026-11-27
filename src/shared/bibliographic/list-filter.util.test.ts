// src/shared/bibliographic/list-filter.util.test.ts
import { describe, expect, it } from 'vitest';
import {
  applyBookListFilters,
  applySeriesListFilters,
  countActiveAdvancedFilters,
  createEmptyListFilters,
  extractFilterFacets
} from './list-filter.util';
import type { BookView, SeriesView } from '../types/domain.types';

function makeBook(overrides: Partial<BookView>): BookView {
  return {
    id: 'bk_1',
    workCanonicalId: 'work_1',
    seriesId: null,
    seriesName: null,
    franchiseId: null,
    title: 'Titre Test',
    volumeNumber: null,
    volumeLabel: null,
    sortOrder: null,
    isHorsSerie: false,
    isIntegral: false,
    includedVolumes: [],
    authors: [],
    scriptwriters: [],
    illustrators: [],
    publisher: null,
    collectionName: null,
    publishYear: null,
    pageCount: null,
    description: null,
    language: 'fr',
    mainCategory: 'BD',
    genres: [],
    coverKey: null,
    coverUrl: null,
    knownIsbns: [],
    editions: [],
    primaryIsbn13: null,
    ownershipStatus: 'owned',
    wishedByName: null,
    hasUserOverrides: false,
    hiddenSeriesIds: [],
    ownedViaIntegral: null,
    readingState: null,
    activeLoan: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function makeSeries(overrides: Partial<SeriesView>): SeriesView {
  return {
    id: 'ser_1',
    franchiseId: null,
    canonicalName: 'Thorgal',
    aliases: [],
    editionSignature: null,
    primaryAuthors: ['Jean Van Hamme', 'Grzegorz Rosinski'],
    wikidataQid: null,
    isCompleteExpanded: true,
    knownVolumesCount: 10,
    ownedCount: 10,
    coverUrl: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

describe('list-filter.util — Filtrage composite multi-facettes V2.6', () => {
  const books: BookView[] = [
    makeBook({
      id: 'b1',
      title: 'Alinoë',
      seriesId: 's_thorgal',
      seriesName: 'Thorgal',
      volumeNumber: 8,
      authors: ['Jean Van Hamme', 'Grzegorz Rosinski'],
      publisher: 'Le Lombard',
      mainCategory: 'BD',
      genres: ['Heroic Fantasy', 'Aventure'],
      readingState: { status: 'read', rating: 5, notes: '', updatedAt: '2026-01-01T00:00:00Z' }
    }),
    makeBook({
      id: 'b2',
      title: 'Dune',
      authors: ['Frank Herbert'],
      publisher: 'Robert Laffont',
      mainCategory: 'Roman',
      genres: ['Science-Fiction'],
      activeLoan: {
        id: 'loan_1',
        bookId: 'b2',
        borrowerName: 'Camille',
        loanedAt: '2026-01-02T00:00:00Z',
        notes: null
      }
    }),
    makeBook({
      id: 'b3',
      title: 'Thorgal Intégrale 2',
      seriesId: 's_thorgal',
      seriesName: 'Thorgal',
      isIntegral: true,
      includedVolumes: ['6', '7', '8'],
      authors: ['Jean Van Hamme'],
      publisher: 'Le Lombard',
      mainCategory: 'BD',
      genres: ['Aventure']
    })
  ];

  it('croise genre + auteur + numéro de tome (y compris les intégrales couvrant le tome)', () => {
    const filters = {
      ...createEmptyListFilters(),
      genre: 'BD',
      author: 'van hamme',
      volumeNumber: '8'
    };
    expect(countActiveAdvancedFilters(filters)).toBe(3);

    const matched = applyBookListFilters(books, filters);
    expect(matched.map((b) => b.id)).toEqual(['b1', 'b3']);
  });

  it('filtre par éditeur, statut de lecture, prêt et intégrales uniquement', () => {
    expect(
      applyBookListFilters(books, { ...createEmptyListFilters(), publisher: 'laffont', loanState: 'lent' }).map(
        (b) => b.id
      )
    ).toEqual(['b2']);

    expect(
      applyBookListFilters(books, { ...createEmptyListFilters(), integralOnly: true }).map((b) => b.id)
    ).toEqual(['b3']);

    expect(
      applyBookListFilters(books, { ...createEmptyListFilters(), readingStatus: 'read' }).map((b) => b.id)
    ).toEqual(['b1']);
  });

  it('extrait les facettes en respectant l’ordre des genres préférés de l’utilisateur', () => {
    const facets = extractFilterFacets(books, ['Science-Fiction', 'BD']);
    expect(facets.genres.slice(0, 2)).toEqual(['Science-Fiction', 'BD']);
    expect(facets.publishers).toEqual(['Le Lombard', 'Robert Laffont']);
    expect(facets.seriesNames).toEqual(['Thorgal']);
  });

  it('filtre les séries par complétude, genre et éditeur des tomes associés', () => {
    const sComplete = makeSeries({ id: 's_thorgal', canonicalName: 'Thorgal', knownVolumesCount: 10, ownedCount: 10 });
    const sIncomplete = makeSeries({
      id: 's_other',
      canonicalName: 'Blacksad',
      primaryAuthors: ['Juanjo Guarnido'],
      knownVolumesCount: 7,
      ownedCount: 3
    });
    const map = new Map<string, BookView[]>([
      ['s_thorgal', [books[0], books[2]]],
      ['s_other', []]
    ]);

    expect(
      applySeriesListFilters(
        [sComplete, sIncomplete],
        { ...createEmptyListFilters(), seriesCompletion: 'complete', publisher: 'Lombard' },
        map
      ).map((s) => s.id)
    ).toEqual(['s_thorgal']);

    expect(
      applySeriesListFilters(
        [sComplete, sIncomplete],
        { ...createEmptyListFilters(), seriesCompletion: 'incomplete' },
        map
      ).map((s) => s.id)
    ).toEqual(['s_other']);
  });
});
