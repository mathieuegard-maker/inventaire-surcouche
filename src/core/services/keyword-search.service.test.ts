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
      searchCandidatesByHints: vi.fn()
    }
  };
});

vi.mock('../resolvers/googlebooks.resolver', () => ({
  googleBooksResolver: {
    searchCandidatesByHints: vi.fn()
  }
}));

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
  });

  it('croise BnF, Google Books, Open Library et D1 puis ordonne par sous-catégorie, série, tome, œuvre unique et auteur', async () => {
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

    vi.mocked(bnfResolver.searchCandidatesByHints).mockResolvedValue([
      {
        score: 85,
        meta: {
          isbn: '9782012101340',
          title: 'La Serpe d\'or',
          authors: ['René Goscinny', 'Albert Uderzo'],
          series: 'Astérix',
          seriesNumber: '2',
          publisher: 'Hachette',
          rawSubjects: ['Bande dessinée']
        }
      },
      {
        score: 82,
        meta: {
          isbn: '9782012101333',
          title: 'Astérix le Gaulois',
          authors: ['René Goscinny', 'Albert Uderzo'],
          series: 'Astérix',
          seriesNumber: '1',
          publisher: 'Hachette',
          rawSubjects: ['Bande dessinée']
        }
      }
    ]);

    vi.mocked(googleBooksResolver.searchCandidatesByHints).mockResolvedValue([
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
    ]);

    vi.mocked(openLibraryResolver.searchCandidatesByHints).mockResolvedValue([]);

    const grouped = await keywordSearchService.searchGrouped('Astérix', false);

    // 1. Séries avec tomes triés numériquement (tome 1 avant tome 2) + fusion ISBN BnF + Google Books
    expect(grouped.series).toHaveLength(1);
    expect(grouped.series[0].name).toBe('Astérix');
    expect(grouped.series[0].uri).toBe('inv:serie:asterix');
    expect(grouped.series[0].volumes).toHaveLength(2);
    expect(grouped.series[0].volumes[0].seriesNumber).toBe('1');
    expect(grouped.series[0].volumes[0].coverUrl).toBe('https://books.google.com/asterix1.jpg');
    expect(grouped.series[0].volumes[0].sources).toEqual(expect.arrayContaining(['BnF', 'Google Books']));
    expect(grouped.series[0].volumes[0].genres).toEqual(expect.arrayContaining(['BD', 'Jeunesse']));
    expect(grouped.series[0].volumes[1].seriesNumber).toBe('2');

    // 2. Liste des tomes individuels triés par série puis numéro de tome
    expect(grouped.volumes).toHaveLength(2);
    expect(grouped.volumes[0].isbn13).toBe('9782012101333');
    expect(grouped.volumes[1].isbn13).toBe('9782012101340');

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
    expect(bnfResolver.searchCandidatesByHints).not.toHaveBeenCalled();
    expect(googleBooksResolver.searchCandidatesByHints).not.toHaveBeenCalled();
    expect(openLibraryResolver.searchCandidatesByHints).not.toHaveBeenCalled();
    expect(grouped.series).toHaveLength(1);
    expect(grouped.series[0].volumes[0].category).toBe('BD');
  });
});
