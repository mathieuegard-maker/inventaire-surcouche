import { describe, it, expect } from 'vitest';
import {
  findBestMatchingSeries,
  findMatchingOwnedWork,
  isEditorialPaperbackCollectionName,
  stripEditorialCollectionSuffixes
} from './series-matcher.util';

describe('series-matcher.util', () => {
  const existingBooks = [
    {
      uri: 'isbn:9782014001143',
      workUri: 'wd:Q618719',
      seriesId: 'inv:serie:asterix48',
      series: "Une aventure d'Astérix",
      title: 'Astérix le Gaulois',
      authors: ['René Goscinny', 'Albert Uderzo']
    },
    {
      uri: 'isbn:9782012101531',
      workUri: 'wd:Q12345',
      seriesId: 'inv:serie:asterix48',
      series: "Une aventure d'Astérix",
      title: 'Le Devin',
      authors: ['René Goscinny', 'Albert Uderzo']
    }
  ];

  it('nettoie les suffixes de collection éditoriale et préfixes de série', () => {
    expect(stripEditorialCollectionSuffixes('Astérix - La Grande Collection').coreKey).toBe('asterix');
    expect(stripEditorialCollectionSuffixes('Astérix, la grande collection').coreKey).toBe('asterix');
    expect(stripEditorialCollectionSuffixes("Une aventure d'Astérix").coreKey).toBe('asterix');
    expect(stripEditorialCollectionSuffixes('Astérix (Édition Luxe)').coreKey).toBe('asterix');
    expect(stripEditorialCollectionSuffixes('Album de Boule & Bill').coreKey).toBe('boule bill');
    expect(stripEditorialCollectionSuffixes('Le petit Spirou présente').coreKey).toBe('petit spirou');
    expect(stripEditorialCollectionSuffixes('Collection les Schtroumpfs').coreKey).toBe('schtroumpfs');
    expect(stripEditorialCollectionSuffixes('La collection les Schtroumpfs').coreKey).toBe('schtroumpfs');
    expect(stripEditorialCollectionSuffixes('Les Schtroumpfs: série classique').coreKey).toBe('schtroumpfs');
    expect(stripEditorialCollectionSuffixes('Les Schtroumpfs: série classique').cleanDisplay).toBe('Les Schtroumpfs');
    expect(stripEditorialCollectionSuffixes('Les aventures de Tintin reporter').coreKey).toBe('tintin');
    expect(stripEditorialCollectionSuffixes('Les aventures de Tintin').coreKey).toBe('tintin');
    expect(isEditorialPaperbackCollectionName('Collection Folio')).toBe(true);
    expect(isEditorialPaperbackCollectionName('Folio')).toBe(true);
    expect(isEditorialPaperbackCollectionName('Les Schtroumpfs')).toBe(false);
  });

  it("rattache 'Astérix - La Grande Collection' / Le Devin à 'Une aventure d'Astérix'", () => {
    const byWork = findBestMatchingSeries({
      candidateSeries: 'Astérix - La Grande Collection',
      candidateTitle: 'Le Devin',
      candidateAuthors: ['René Goscinny'],
      existingBooks
    });
    expect(byWork?.seriesId).toBe('inv:serie:asterix48');
    expect(byWork?.series).toBe("Une aventure d'Astérix");
    expect(byWork?.matchReason).toBe('work_title_author');

    const bySeriesCore = findBestMatchingSeries({
      candidateSeries: 'Astérix - La Grande Collection',
      candidateTitle: 'Le Cadeau de César',
      candidateAuthors: ['Albert Uderzo'],
      existingBooks
    });
    expect(bySeriesCore?.seriesId).toBe('inv:serie:asterix48');
    expect(bySeriesCore?.matchReason).toBe('series_core_key');
  });

  it('ne fusionne pas deux séries homonymes si les auteurs sont complètement différents', () => {
    const res = findBestMatchingSeries({
      candidateSeries: 'Astérix',
      candidateTitle: 'Autre livre',
      candidateAuthors: ['Jean Dupont'],
      existingBooks
    });
    expect(res).toBeNull();
  });

  it("unifie '&' vs 'et', les préfixes '60 gags de' et les reprises d'auteurs ('d'après Roba')", () => {
    expect(stripEditorialCollectionSuffixes('Boule & Bill').coreKey).toBe('boule bill');
    expect(stripEditorialCollectionSuffixes('60 gags de Boule et Bill').coreKey).toBe('boule bill');
    expect(stripEditorialCollectionSuffixes('Boule & Bill, la collection Roba').coreKey).toBe('boule bill');

    const bouleBooks = [
      {
        uri: 'isbn:9782800100001',
        seriesId: 'inv:serie:boulebill',
        series: 'Boule & Bill',
        seriesNumber: '2',
        title: '60 gags de Boule et Bill',
        authors: ['Jean Roba'],
        ownershipStatus: 'owned' as const
      }
    ];

    const matched = findBestMatchingSeries({
      candidateSeries: 'Boule et Bill',
      candidateTitle: 'Les quatre saisons',
      candidateAuthors: ["Verron d'après Roba"],
      existingBooks: bouleBooks
    });
    expect(matched?.seriesId).toBe('inv:serie:boulebill');
    expect(matched?.series).toBe('Boule & Bill');
  });

  it("détecte une œuvre déjà possédée même sous une autre édition (knownIsbns, titre+auteur, ou série+tome)", () => {
    const ownedPool = [
      {
        uri: 'isbn:9782014001228',
        isbn13: '9782014001228',
        knownIsbns: ['9782014001228', '9782298020472', '9782731251906'],
        seriesId: 'inv:serie:asterix48',
        series: "Une aventure d'Astérix",
        seriesNumber: '2',
        title: "La serpe d'or",
        authors: ['René Goscinny', 'Albert Uderzo'],
        ownershipStatus: 'owned' as const
      }
    ];

    // Match via knownIsbns (ex: édition Atlas scannée en brocante)
    const byKnown = findMatchingOwnedWork({
      candidateIsbns: ['9782731251906'],
      existingBooks: ownedPool
    });
    expect(byKnown?.matchReason).toBe('known_isbn');

    // Match via titre + auteur quand le nouvel ISBN n'est pas encore dans knownIsbns
    const byTitle = findMatchingOwnedWork({
      candidateIsbns: ['9782298099539'],
      candidateTitle: "La Serpe d'Or",
      candidateAuthors: ['Goscinny'],
      existingBooks: ownedPool
    });
    expect(byTitle?.matchReason).toBe('title_author');

    // Match via série canonique + numéro de tome
    const bySeriesVol = findMatchingOwnedWork({
      candidateIsbns: ['9780000000001'],
      candidateTitle: 'Astérix le Gaulois / La Serpe d’or',
      candidateSeries: 'Astérix - La Grande Collection',
      candidateSeriesNumber: '2',
      candidateAuthors: ['Albert Uderzo'],
      existingBooks: ownedPool
    });
    expect(bySeriesVol?.matchReason).toBe('series_volume');
  });
});
