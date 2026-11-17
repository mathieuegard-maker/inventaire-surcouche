import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bnfResolver, scoreEditionCandidate } from '../resolvers/bnf.resolver';
import { googleBooksResolver } from '../resolvers/googlebooks.resolver';
import { openLibraryResolver } from '../resolvers/openlibrary.resolver';
import { externalMetadataService } from './external-metadata.service';
import { entityResolver } from '../resolvers/entity.resolver';
import { databaseService } from '../database/database.service';
import { wishlistService } from './wishlist.service';
import { photoBookResolutionService } from './photo-book-resolution.service';

describe('scoreEditionCandidate (meilleure & dernière édition)', () => {
  it('privilégie la réédition française la plus récente avec couverture', () => {
    const oldEdition = {
      isbn: '9782800122151',
      title: 'Le bal des vampires',
      authors: ['Clarke'],
      publisher: 'Dupuis',
      publishDate: '1995',
      _lang: 'fre',
      _hasPrimaryIsbn: true
    };
    const newerEdition = {
      isbn: '9782800131924',
      title: 'Le bal des vampires',
      authors: ['Clarke'],
      publisher: 'Dupuis',
      publishDate: '2018',
      coverUrl: 'https://catalogue.bnf.fr/couverture?idImage=123',
      _lang: 'fre',
      _hasPrimaryIsbn: true
    };

    expect(scoreEditionCandidate(newerEdition)).toBeGreaterThan(scoreEditionCandidate(oldEdition));
  });
});

describe('photoBookResolutionService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(databaseService, 'getBookByIsbn').mockResolvedValue(undefined);
    vi.spyOn(databaseService, 'isUriInRegistry').mockResolvedValue(false);
    vi.spyOn(wishlistService, 'isUriWished').mockResolvedValue(false);
    vi.spyOn(entityResolver, 'resolvePhysicalEntity').mockResolvedValue(null);
    vi.spyOn(bnfResolver, 'searchCandidatesByHints').mockResolvedValue([]);
    vi.spyOn(googleBooksResolver, 'searchCandidatesByHints').mockResolvedValue([]);
    vi.spyOn(openLibraryResolver, 'searchCandidatesByHints').mockResolvedValue([]);
  });

  it('retrouve l’ISBN via BnF puis complète notice + couverture via le flux classique ISBN et propose les autres tomes de la série', async () => {
    vi.spyOn(bnfResolver, 'searchCandidatesByHints').mockResolvedValue([
      {
        score: 75,
        meta: {
          isbn: '9782800131924',
          title: 'Le bal des vampires',
          authors: ['Clarke', 'François Gilson'],
          publisher: 'Dupuis',
          publishDate: '2001',
          series: 'Mélusine',
          seriesNumber: '2'
        }
      }
    ]);

    vi.spyOn(externalMetadataService, 'fetchFromExternalSources').mockImplementation(async (isbn) => {
      if (isbn === '9782800131924') {
        return {
          isbn: '9782800131924',
          title: 'Le bal des vampires',
          authors: ['Clarke', 'François Gilson'],
          publisher: 'Dupuis',
          publishDate: '2001',
          pageCount: 48,
          coverUrl: 'https://books.google.com/melusine2.jpg',
          series: 'Mélusine',
          seriesNumber: '2'
        };
      }
      return {
        isbn,
        title: 'Sortilèges',
        authors: ['Clarke'],
        coverUrl: `https://covers.openlibrary.org/${isbn}.jpg`,
        series: 'Mélusine',
        seriesNumber: '1'
      };
    });

    vi.spyOn(bnfResolver, 'searchSeriesVolumes').mockResolvedValue([
      {
        isbn: '9782800120928',
        title: 'Sortilèges',
        authors: ['Clarke'],
        series: 'Mélusine',
        seriesNumber: '1',
        publishDate: '1994'
      },
      {
        isbn: '9782800131924',
        title: 'Le bal des vampires',
        authors: ['Clarke'],
        series: 'Mélusine',
        seriesNumber: '2',
        publishDate: '2001'
      }
    ]);

    const result = await photoBookResolutionService.resolveCandidatesAndDiscoverSeries([
      {
        title: 'Le bal des vampires',
        series: 'Mélusine',
        volumeNumber: '2',
        author: 'Clarke',
        publisher: 'Dupuis'
      }
    ]);

    expect(result.detectedItems).toHaveLength(1);
    expect(result.detectedItems[0]).toMatchObject({
      status: 'resolved',
      selected: true,
      isbn13: '9782800131924',
      coverUrl: 'https://books.google.com/melusine2.jpg',
      series: 'Mélusine',
      seriesNumber: '2'
    });

    // Le tome 2 déjà détecté est exclu des extras, le tome 1 est proposé avec couverture récupérée
    expect(result.seriesExtraItems).toHaveLength(1);
    expect(result.seriesExtraItems[0]).toMatchObject({
      sourceKind: 'series_extra',
      isbn13: '9782800120928',
      seriesNumber: '1',
      coverUrl: 'https://covers.openlibrary.org/9782800120928.jpg',
      selected: false
    });
  });

  it('bascule sur Google Books si la BnF ne trouve pas, puis repasse par le flux classique ISBN', async () => {
    vi.spyOn(bnfResolver, 'searchCandidatesByHints').mockResolvedValue([]);
    vi.spyOn(googleBooksResolver, 'searchCandidatesByHints').mockResolvedValue([
      {
        isbn: '9782012101333',
        title: 'Astérix le Gaulois',
        authors: ['René Goscinny', 'Albert Uderzo'],
        coverUrl: 'https://books.google.com/asterix1.jpg'
      }
    ]);

    const extSpy = vi.spyOn(externalMetadataService, 'fetchFromExternalSources').mockResolvedValue({
      isbn: '9782012101333',
      title: 'Astérix le Gaulois',
      authors: ['René Goscinny', 'Albert Uderzo'],
      publisher: 'Hachette',
      publishDate: '2004',
      coverUrl: 'https://catalogue.bnf.fr/couverture?idImage=999',
      series: 'Astérix',
      seriesNumber: '1'
    });
    vi.spyOn(bnfResolver, 'searchSeriesVolumes').mockResolvedValue([]);

    const result = await photoBookResolutionService.resolveCandidatesAndDiscoverSeries([
      { title: 'Astérix le Gaulois', author: 'Goscinny' }
    ]);

    expect(extSpy).toHaveBeenCalledWith('9782012101333');
    expect(result.detectedItems[0].status).toBe('resolved');
    expect(result.detectedItems[0].coverUrl).toBe('https://catalogue.bnf.fr/couverture?idImage=999');
  });

  it('élit le consensus multi-sources même si l’IA a halluciné un mauvais auteur et marque correctedFromAi', async () => {
    // BnF a deux candidats dont le bon (avec score légèrement pénalisé par le faux auteur IA),
    // Google Books & Open Library corroborent l’ISBN officiel.
    vi.spyOn(bnfResolver, 'searchCandidatesByHints').mockResolvedValue([
      {
        score: 26,
        meta: {
          isbn: '9782800122151',
          title: 'Le bal des vampires',
          authors: ['Clarke', 'François Gilson'],
          publisher: 'Dupuis',
          series: 'Mélusine',
          seriesNumber: '4'
        }
      },
      {
        score: 30,
        meta: {
          isbn: '9789999999999',
          title: 'Faux titre homonyme',
          authors: ['Mauvais Auteur IA'],
          publisher: 'Autre'
        }
      }
    ]);
    vi.spyOn(googleBooksResolver, 'searchCandidatesByHints').mockResolvedValue([
      {
        isbn: '9782800122151',
        title: 'Mélusine, tome 4 : Le bal des vampires',
        authors: ['Clarke'],
        publisher: 'Dupuis'
      }
    ]);
    vi.spyOn(openLibraryResolver, 'searchCandidatesByHints').mockResolvedValue([
      {
        isbn: '9782800122151',
        title: 'Le bal des vampires',
        authors: ['Clarke'],
        publisher: 'Dupuis'
      }
    ]);

    vi.spyOn(externalMetadataService, 'fetchFromExternalSources').mockResolvedValue({
      isbn: '9782800122151',
      title: 'Le bal des vampires',
      authors: ['Clarke', 'François Gilson'],
      publisher: 'Dupuis',
      publishDate: '1996',
      coverUrl: 'https://catalogue.bnf.fr/couverture?idImage=444',
      series: 'Mélusine',
      seriesNumber: '4'
    });
    vi.spyOn(bnfResolver, 'searchSeriesVolumes').mockResolvedValue([]);

    const result = await photoBookResolutionService.resolveCandidatesAndDiscoverSeries([
      {
        title: 'Le bal des vampires',
        series: 'Mélusine',
        volumeNumber: '4',
        author: 'Mauvais Auteur IA',
        rawSpineText: 'MELUSINE 4 LE BAL DES VAMPIRES DUPUIS'
      }
    ]);

    expect(result.detectedItems).toHaveLength(1);
    expect(result.detectedItems[0]).toMatchObject({
      status: 'resolved',
      isbn13: '9782800122151',
      authors: ['Clarke', 'François Gilson'],
      correctedFromAi: true,
      sourcesCount: 3
    });
  });

  it('résout via Open Library quand BnF et Google Books ne renvoient rien', async () => {
    vi.spyOn(openLibraryResolver, 'searchCandidatesByHints').mockResolvedValue([
      {
        isbn: '9782205051230',
        title: 'La marque jaune',
        authors: ['Edgar P. Jacobs'],
        publisher: 'Blake et Mortimer',
        coverUrl: 'https://covers.openlibrary.org/b/id/12345-L.jpg'
      }
    ]);
    vi.spyOn(externalMetadataService, 'fetchFromExternalSources').mockResolvedValue({
      isbn: '9782205051230',
      title: 'La marque jaune',
      authors: ['Edgar P. Jacobs'],
      publisher: 'Éditions Blake et Mortimer',
      coverUrl: 'https://covers.openlibrary.org/b/id/12345-L.jpg',
      series: 'Blake et Mortimer',
      seriesNumber: '6'
    });
    vi.spyOn(bnfResolver, 'searchSeriesVolumes').mockResolvedValue([]);

    const result = await photoBookResolutionService.resolveCandidatesAndDiscoverSeries([
      { title: 'La marque jaune', author: 'Jacobs' }
    ]);

    expect(result.detectedItems[0]).toMatchObject({
      status: 'resolved',
      isbn13: '9782205051230',
      sourcesCount: 1
    });
  });

  it('rattrape une tranche voisine ambiguë grâce à la série résolue sur la même étagère', async () => {
    vi.spyOn(bnfResolver, 'searchCandidatesByHints').mockImplementation(async (hints) => {
      if (hints.series === 'Thorgal' && hints.volumeNumber === '1') {
        return [
          {
            score: 80,
            meta: {
              isbn: '9782803603589',
              title: 'La magicienne trahie',
              authors: ['Jean Van Hamme', 'Grzegorz Rosinski'],
              publisher: 'Le Lombard',
              series: 'Thorgal',
              seriesNumber: '1'
            }
          }
        ];
      }
      // La tranche adjacente n’avait que le numéro "2" et pas le nom de série "Thorgal" au premier passage
      if (hints.series === 'Thorgal' && hints.volumeNumber === '2') {
        return [
          {
            score: 75,
            meta: {
              isbn: '9782803603596',
              title: "L'île des mers gelées",
              authors: ['Jean Van Hamme', 'Grzegorz Rosinski'],
              publisher: 'Le Lombard',
              series: 'Thorgal',
              seriesNumber: '2'
            }
          }
        ];
      }
      return [];
    });

    vi.spyOn(externalMetadataService, 'fetchFromExternalSources').mockImplementation(async (isbn) => {
      if (isbn === '9782803603589') {
        return {
          isbn,
          title: 'La magicienne trahie',
          authors: ['Jean Van Hamme', 'Grzegorz Rosinski'],
          publisher: 'Le Lombard',
          series: 'Thorgal',
          seriesNumber: '1'
        };
      }
      return {
        isbn,
        title: "L'île des mers gelées",
        authors: ['Jean Van Hamme', 'Grzegorz Rosinski'],
        publisher: 'Le Lombard',
        series: 'Thorgal',
        seriesNumber: '2'
      };
    });
    vi.spyOn(bnfResolver, 'searchSeriesVolumes').mockResolvedValue([]);

    const result = await photoBookResolutionService.resolveCandidatesAndDiscoverSeries([
      {
        spineIndex: 0,
        title: 'La magicienne trahie',
        series: 'Thorgal',
        volumeNumber: '1',
        author: 'Van Hamme',
        publisher: 'Le Lombard'
      },
      {
        spineIndex: 1,
        title: 'Tome 2',
        volumeNumber: '2',
        publisher: 'Le Lombard',
        rawSpineText: '2 LE LOMBARD'
      }
    ]);

    expect(result.detectedItems).toHaveLength(2);
    expect(result.detectedItems[0].status).toBe('resolved');
    expect(result.detectedItems[1]).toMatchObject({
      status: 'resolved',
      isbn13: '9782803603596',
      series: 'Thorgal',
      seriesNumber: '2',
      correctedFromAi: true
    });
  });

  it('marque le livre comme doubt avec alternatives si deux œuvres distinctes sont très proches sur une seule source', async () => {
    vi.spyOn(bnfResolver, 'searchCandidatesByHints').mockResolvedValue([
      {
        score: 32,
        meta: {
          isbn: '9782070612758',
          title: 'Les Royaumes du Nord',
          authors: ['Philip Pullman'],
          publisher: 'Gallimard Jeunesse',
          series: 'À la croisée des mondes',
          seriesNumber: '1'
        }
      },
      {
        score: 28,
        meta: {
          isbn: '9782070584925',
          title: 'La Tour des Anges',
          authors: ['Philip Pullman'],
          publisher: 'Gallimard Jeunesse',
          series: 'À la croisée des mondes',
          seriesNumber: '2'
        }
      }
    ]);
    vi.spyOn(googleBooksResolver, 'searchCandidatesByHints').mockResolvedValue([]);
    vi.spyOn(openLibraryResolver, 'searchCandidatesByHints').mockResolvedValue([]);
    vi.spyOn(externalMetadataService, 'fetchFromExternalSources').mockImplementation(async (isbn) => ({
      isbn,
      title: isbn === '9782070612758' ? 'Les Royaumes du Nord' : 'La Tour des Anges',
      authors: ['Philip Pullman'],
      publisher: 'Gallimard Jeunesse',
      series: 'À la croisée des mondes',
      seriesNumber: isbn === '9782070612758' ? '1' : '2',
      coverUrl: `https://covers.example/${isbn}.jpg`
    }));
    vi.spyOn(bnfResolver, 'searchSeriesVolumes').mockResolvedValue([]);

    const result = await photoBookResolutionService.resolveCandidatesAndDiscoverSeries([
      {
        title: 'Les Royaumes',
        author: 'Pullman',
        confidence: 'medium'
      }
    ]);

    expect(result.detectedItems).toHaveLength(1);
    expect(result.detectedItems[0].status).toBe('doubt');
    expect(result.detectedItems[0].selected).toBe(false);
    expect(result.detectedItems[0].alternatives?.length).toBeGreaterThanOrEqual(2);
    expect(result.detectedItems[0].alternatives?.[0].isbn13).toBe('9782070612758');
  });

  it('marque le livre comme unresolved (non validable) si aucun ISBN n’est trouvé', async () => {
    const result = await photoBookResolutionService.resolveCandidatesAndDiscoverSeries([
      { title: 'Tranche illisible xyz' }
    ]);

    expect(result.detectedItems).toHaveLength(1);
    expect(result.detectedItems[0].status).toBe('unresolved');
    expect(result.detectedItems[0].selected).toBe(false);
    expect(result.seriesExtraItems).toHaveLength(0);
  });
});
