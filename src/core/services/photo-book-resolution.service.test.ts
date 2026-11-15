import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bnfResolver, scoreEditionCandidate } from '../resolvers/bnf.resolver';
import { googleBooksResolver } from '../resolvers/googlebooks.resolver';
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
  });

  it('retrouve l’ISBN via BnF puis complète notice + couverture via le flux classique ISBN et propose les autres tomes de la série', async () => {
    vi.spyOn(bnfResolver, 'searchBestMatchByHints').mockResolvedValue({
      isbn: '9782800131924',
      title: 'Le bal des vampires',
      authors: ['Clarke', 'François Gilson'],
      publisher: 'Dupuis',
      publishDate: '2001',
      series: 'Mélusine',
      seriesNumber: '2'
    });

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
      selected: true
    });
  });

  it('bascule sur Google Books si la BnF ne trouve pas, puis repasse par le flux classique ISBN', async () => {
    vi.spyOn(bnfResolver, 'searchBestMatchByHints').mockResolvedValue(null);
    vi.spyOn(googleBooksResolver, 'searchByHints').mockResolvedValue({
      isbn: '9782012101333',
      title: 'Astérix le Gaulois',
      authors: ['René Goscinny', 'Albert Uderzo'],
      coverUrl: 'https://books.google.com/asterix1.jpg'
    });

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

  it('marque le livre comme unresolved (non validable) si aucun ISBN n’est trouvé', async () => {
    vi.spyOn(bnfResolver, 'searchBestMatchByHints').mockResolvedValue(null);
    vi.spyOn(googleBooksResolver, 'searchByHints').mockResolvedValue(null);

    const result = await photoBookResolutionService.resolveCandidatesAndDiscoverSeries([
      { title: 'Tranche illisible xyz' }
    ]);

    expect(result.detectedItems).toHaveLength(1);
    expect(result.detectedItems[0].status).toBe('unresolved');
    expect(result.detectedItems[0].selected).toBe(false);
    expect(result.seriesExtraItems).toHaveLength(0);
  });
});
