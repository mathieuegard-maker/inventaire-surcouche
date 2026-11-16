import { describe, it, expect } from 'vitest';
import {
  findBestMatchingSeries,
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
    expect(stripEditorialCollectionSuffixes("Une aventure d'Astérix").coreKey).toBe('asterix');
    expect(stripEditorialCollectionSuffixes('Astérix (Édition Luxe)').coreKey).toBe('asterix');
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
});
