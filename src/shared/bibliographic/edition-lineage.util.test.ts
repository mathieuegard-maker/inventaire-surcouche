// src/shared/bibliographic/edition-lineage.util.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildEditionLineage,
  electDominantSeriesLineage,
  extractIsbnPublisherPrefix,
  matchEditionLineageScore,
  normalizePublisherKey,
  selectBestEditionForLineage
} from './edition-lineage.util';

describe('edition-lineage.util — identification et harmonisation des éditions de série', () => {
  it('extrait précisément les préfixes éditeurs ISBN-13 sur les plages GS1/AFNIL francophones', () => {
    expect(extractIsbnPublisherPrefix('9782070612758')).toBe('978207'); // Gallimard (2 chiffres)
    expect(extractIsbnPublisherPrefix('9782205051230')).toBe('9782205'); // Dargaud (3 chiffres)
    expect(extractIsbnPublisherPrefix('9782266154123')).toBe('9782266'); // Pocket (3 chiffres)
    expect(extractIsbnPublisherPrefix('9782800100128')).toBe('97828001'); // Dupuis (4 chiffres)
    expect(extractIsbnPublisherPrefix('9791032701232')).toBe('97910327'); // AFNIL 979-10 (3 chiffres)
    expect(extractIsbnPublisherPrefix('9780140449136')).toBe('9780140'); // International
    expect(extractIsbnPublisherPrefix('invalide')).toBeNull();
  });

  it('normalise les variantes de noms d’éditeurs sans rien coder en dur', () => {
    expect(normalizePublisherKey('Éditions Dargaud')).toBe('dargaud');
    expect(normalizePublisherKey('Dargaud France')).toBe('dargaud');
    expect(normalizePublisherKey('DARGAUD / Le Lombard')).toBe('dargaud');
    expect(normalizePublisherKey('Éd. Gallimard')).toBe('gallimard');
  });

  it('distingue deux collections différentes chez un même éditeur et tolère le repli par préfixe ISBN', () => {
    const folioSf = buildEditionLineage({
      isbn13: '9782070415632',
      publisher: 'Gallimard',
      collectionName: 'Folio SF'
    });
    const folioSfSame = buildEditionLineage({
      isbn13: '9782070415649',
      publisher: 'Éditions Gallimard',
      collectionName: 'Coll. Folio SF'
    });
    const blanche = buildEditionLineage({
      isbn13: '9782070758128',
      publisher: 'Gallimard',
      collectionName: 'Blanche'
    });
    const dargaud = buildEditionLineage({
      isbn13: '9782205051230',
      publisher: 'Dargaud'
    });
    const dargaudPrefixOnly = buildEditionLineage({
      isbn13: '9782205059991'
    });

    expect(matchEditionLineageScore(folioSf, folioSfSame)).toBe(100);
    expect(matchEditionLineageScore(folioSf, blanche)).toBe(0);
    expect(matchEditionLineageScore(folioSf, dargaud)).toBe(0);
    expect(matchEditionLineageScore(dargaud, dargaudPrefixOnly)).toBe(65);
  });

  it('élit la lignée éditoriale qui couvre le plus grand nombre de tomes (avec tie-breaker sur les tomes possédés)', () => {
    const dominant = electDominantSeriesLineage([
      {
        bookId: 'b1',
        isOwned: true,
        editions: [
          { isbn13: '9782205000016', publisher: 'Dargaud', coverKey: 'cov_d1' },
          { isbn13: '9782266000010', publisher: 'Pocket', coverKey: 'cov_p1' }
        ]
      },
      {
        bookId: 'b2',
        isOwned: false,
        editions: [
          { isbn13: '9782205000023', publisher: 'Dargaud', coverKey: 'cov_d2' },
          { isbn13: '9782744100025', publisher: 'France Loisirs', coverKey: 'cov_fl2' }
        ]
      },
      {
        bookId: 'b3',
        isOwned: true,
        editions: [
          { isbn13: '9782205000030', publisher: 'Dargaud', coverKey: 'cov_d3' }
        ]
      }
    ]);

    expect(dominant).not.toBeNull();
    expect(dominant?.lineage.publisher).toBe('Dargaud');
    expect(dominant?.coveredBookCount).toBe(3);

    const bestForB2 = selectBestEditionForLineage(
      [
        { isbn13: '9782744100025', publisher: 'France Loisirs', coverKey: 'cov_fl2' },
        { isbn13: '9782205000023', publisher: 'Dargaud', coverKey: 'cov_d2' }
      ],
      dominant!.lineage,
      true
    );
    expect(bestForB2?.edition.coverKey).toBe('cov_d2');
  });
});
