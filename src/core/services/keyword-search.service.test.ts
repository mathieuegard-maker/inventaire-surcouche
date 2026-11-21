import { describe, it, expect, vi, beforeEach } from 'vitest';
import { keywordSearchService } from './keyword-search.service';
import { databaseService } from '../database/database.service';
import { inventaireSearchProvider } from '../providers/inventaire-search.provider';
import { bnfResolver } from '../resolvers/bnf.resolver';
import { googleBooksResolver } from '../resolvers/googlebooks.resolver';
import { openLibraryResolver } from '../resolvers/openlibrary.resolver';

vi.mock('../database/database.service', () => ({
  databaseService: {
    searchBooksLocally: vi.fn()
  }
}));

vi.mock('../providers/inventaire-search.provider', () => ({
  inventaireSearchProvider: {
    searchByKeywords: vi.fn()
  }
}));

vi.mock('../resolvers/bnf.resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../resolvers/bnf.resolver')>();
  return {
    ...actual,
    bnfResolver: {
      ...actual.bnfResolver,
      searchKeywordVolumes: vi.fn(),
      searchSeriesVolumes: vi.fn(),
      searchCandidatesByHints: vi.fn()
    }
  };
});

vi.mock('../resolvers/googlebooks.resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../resolvers/googlebooks.resolver')>();
  return {
    ...actual,
    googleBooksResolver: {
      ...actual.googleBooksResolver,
      searchKeywordOrSeriesVolumes: vi.fn(),
      searchCandidatesByHints: vi.fn()
    }
  };
});

vi.mock('../resolvers/openlibrary.resolver', () => ({
  openLibraryResolver: {
    searchCandidatesByHints: vi.fn()
  }
}));

describe('keywordSearchService.searchGrouped', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(databaseService.searchBooksLocally).mockResolvedValue([]);
    vi.mocked(inventaireSearchProvider.searchByKeywords).mockResolvedValue([]);
    vi.mocked(bnfResolver.searchKeywordVolumes).mockResolvedValue([]);
    vi.mocked(bnfResolver.searchSeriesVolumes).mockResolvedValue([]);
    vi.mocked(googleBooksResolver.searchKeywordOrSeriesVolumes).mockResolvedValue([]);
    vi.mocked(openLibraryResolver.searchCandidatesByHints).mockResolvedValue([]);
  });

  it('croise toute la triade en 2 passes (mot-clé + expansion de séries complètes) et dédoublonne les rééditions', async () => {
    vi.mocked(inventaireSearchProvider.searchByKeywords).mockResolvedValue([
      {
        uri: 'inv:human:Albert_Uderzo',
        type: 'author',
        label: 'Albert Uderzo',
        description: 'Dessinateur et scénariste français'
      },
      {
        uri: 'inv:serie:asterix',
        type: 'series',
        label: 'Astérix'
      }
    ]);

    vi.mocked(bnfResolver.searchKeywordVolumes).mockResolvedValue([
      {
        isbn: '9782012101333',
        title: 'Astérix le Gaulois',
        authors: ['René Goscinny', 'Albert Uderzo'],
        series: 'Astérix',
        seriesNumber: '1',
        publisher: 'Hachette',
        publishDate: '1999',
        rawSubjects: ['Bande dessinée'],
        _bnfEnsembleId: '34299999'
      }
    ]);

    // Passe 2 : expansion complète de la série Astérix (ex: tome 2 sans le mot "Astérix" dans le titre + réédition du tome 1)
    vi.mocked(bnfResolver.searchSeriesVolumes).mockResolvedValue([
      {
        isbn: '9782012101340',
        title: 'La Serpe d\'or',
        authors: ['René Goscinny', 'Albert Uderzo'],
        series: 'Astérix',
        seriesNumber: '2',
        publisher: 'Hachette',
        publishDate: '2004',
        rawSubjects: ['Bande dessinée']
      }
    ]);

    vi.mocked(googleBooksResolver.searchKeywordOrSeriesVolumes)
      // Appel Passe 1 ("Astérix")
      .mockResolvedValueOnce([
        {
          isbn: '9782012101333',
          title: 'Astérix le Gaulois',
          authors: ['René Goscinny'],
          coverUrl: 'https://books.google.com/asterix1.jpg',
          rawSubjects: ['Comics & Graphic Novels', 'Juvenile Fiction']
        },
        {
          isbn: '9782070584628',
          title: 'Les Contes du chat perché',
          authors: ['Marcel Aymé'],
          publisher: 'Gallimard Jeunesse',
          rawSubjects: ['Juvenile Fiction']
        }
      ])
      // Appel Passe 2 (expansion série "Astérix") : inclut un tome 3 + une réédition du tome 1 à fusionner
      .mockResolvedValueOnce([
        {
          isbn: '9782864971535',
          title: 'Astérix le Gaulois (Édition collector)',
          authors: ['René Goscinny', 'Albert Uderzo'],
          series: 'Astérix',
          seriesNumber: '1',
          publishDate: '1961'
        },
        {
          isbn: '9782012101357',
          title: 'Astérix et les Goths',
          authors: ['René Goscinny', 'Albert Uderzo'],
          series: 'Astérix',
          seriesNumber: '3',
          publisher: 'Hachette',
          coverUrl: 'https://books.google.com/asterix3.jpg'
        }
      ]);

    const grouped = await keywordSearchService.searchGrouped('Astérix', false);

    // Passe 2 a bien interrogé l'ensemble BnF avec l'ID d'ensemble 34299999 et la triade
    expect(bnfResolver.searchSeriesVolumes).toHaveBeenCalledWith('Astérix', 'René Goscinny', ['34299999']);
    expect(googleBooksResolver.searchKeywordOrSeriesVolumes).toHaveBeenCalledTimes(2);
    expect(openLibraryResolver.searchCandidatesByHints).toHaveBeenCalledTimes(2);

    // 1. Séries avec 3 tomes uniques triés T.1 -> T.2 -> T.3 (la réédition 1961 du T.1 est fusionnée, pas dupliquée)
    expect(grouped.series).toHaveLength(1);
    expect(grouped.series[0].name).toBe('Astérix');
    expect(grouped.series[0].uri).toBe('inv:serie:asterix');
    expect(grouped.series[0].volumes).toHaveLength(3);
    expect(grouped.series[0].volumes.map((v) => v.seriesNumber)).toEqual(['1', '2', '3']);
    expect(grouped.series[0].volumes[0].coverUrl).toBe('https://books.google.com/asterix1.jpg');
    expect(grouped.series[0].volumes[0].sources).toEqual(expect.arrayContaining(['BnF', 'Google Books']));
    expect(grouped.series[0].volumes[0].genres).toEqual(expect.arrayContaining(['BD', 'Jeunesse']));

    // 2. Liste des tomes individuels triés
    expect(grouped.volumes).toHaveLength(3);

    // 3. Œuvres uniques classées comme Jeunesse (et non Roman générique)
    expect(grouped.standaloneWorks).toHaveLength(1);
    expect(grouped.standaloneWorks[0].title).toBe('Les Contes du chat perché');
    expect(grouped.standaloneWorks[0].category).toBe('Jeunesse');

    // 4. Auteurs consolidés depuis les résultats et notices D1
    expect(grouped.authors.map((a) => a.name)).toContain('Albert Uderzo');
    expect(grouped.authors.map((a) => a.name)).toContain('René Goscinny');

    // 5. Sous-catégories agrégées
    expect(grouped.categories.map((c) => c.label)).toEqual(
      expect.arrayContaining(['BD', 'Jeunesse'])
    );
  });

  it('n\'appelle pas les API externes en mode hors-ligne et utilise le cache local', async () => {
    vi.mocked(databaseService.searchBooksLocally).mockResolvedValue([
      {
        uri: 'local:1',
        isbn13: '9782205051234',
        title: 'Blacksad - Quelque part entre les ombres',
        authors: ['Juan Díaz Canales', 'Juanjo Guarnido'],
        illustrators: ['Juanjo Guarnido'],
        scriptwriters: ['Juan Díaz Canales'],
        ownershipStatus: 'owned',
        type: 'work',
        series: 'Blacksad',
        seriesNumber: '1',
        genres: ['BD', 'Polar / Thriller']
      }
    ]);

    const grouped = await keywordSearchService.searchGrouped('Blacksad', true);

    expect(inventaireSearchProvider.searchByKeywords).not.toHaveBeenCalled();
    expect(bnfResolver.searchKeywordVolumes).not.toHaveBeenCalled();
    expect(bnfResolver.searchSeriesVolumes).not.toHaveBeenCalled();
    expect(googleBooksResolver.searchKeywordOrSeriesVolumes).not.toHaveBeenCalled();
    expect(openLibraryResolver.searchCandidatesByHints).not.toHaveBeenCalled();
    expect(grouped.series).toHaveLength(1);
    expect(grouped.series[0].volumes[0].category).toBe('BD');
  });
});
