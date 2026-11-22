import { describe, expect, it } from 'vitest';
import type { HumanizedBook } from '../types';
import {
  annotateIntegralCoverage,
  findCoveringOwnedIntegral,
  formatIncludedVolumeNumbers,
  formatIntegralRangeLabel,
  parseIncludedVolumeNumbers
} from './integral.util';

const makeBook = (overrides: Partial<HumanizedBook>): HumanizedBook => ({
  uri: 'isbn:9782000000001',
  type: 'edition',
  title: 'Livre test',
  authors: ['Auteur'],
  illustrators: [],
  scriptwriters: [],
  genres: [],
  ownershipStatus: 'none',
  ...overrides
});

describe('integral.util', () => {
  it('parse les plages ("1 à 3", "1-3, 5") et tableaux de tomes inclus', () => {
    expect(parseIncludedVolumeNumbers('1 à 3')).toEqual(['1', '2', '3']);
    expect(parseIncludedVolumeNumbers('T.4-T.6, 8')).toEqual(['4', '5', '6', '8']);
    expect(parseIncludedVolumeNumbers(['3', '1', '2', '2'])).toEqual(['1', '2', '3']);
    expect(parseIncludedVolumeNumbers('')).toEqual([]);
  });

  it('formate les plages contiguës et non contiguës proprement', () => {
    expect(formatIncludedVolumeNumbers(['1', '2', '3'])).toBe('1-3');
    expect(formatIncludedVolumeNumbers(['1', '3', '5'])).toBe('1, 3, 5');
    expect(formatIntegralRangeLabel(['1', '2', '3'])).toBe('Int. T.1-3');
    expect(formatIntegralRangeLabel([])).toBe('Intégrale');
  });

  it('détecte la couverture par une intégrale possédée de la même série et annote les listes', () => {
    const integral = makeBook({
      uri: 'isbn:9782010000999',
      bookId: 'bk_int_1',
      title: 'Thorgal — Intégrale 1',
      series: 'Thorgal',
      seriesId: 'ser_thorgal',
      isIntegral: true,
      integralMetadata: {
        includedVolumeNumbers: ['1', '2', '3'],
        includedWorkIds: [],
        includedIsbns: []
      },
      ownershipStatus: 'owned'
    });
    const t2 = makeBook({
      uri: 'isbn:9782010000002',
      bookId: 'bk_t2',
      title: 'L’Île des mers gelées',
      series: 'Thorgal',
      seriesId: 'ser_thorgal',
      seriesNumber: '2',
      ownershipStatus: 'none'
    });
    const t4 = makeBook({
      uri: 'isbn:9782010000004',
      bookId: 'bk_t4',
      title: 'La Galère noire',
      series: 'Thorgal',
      seriesId: 'ser_thorgal',
      seriesNumber: '4',
      ownershipStatus: 'none'
    });

    const ref = findCoveringOwnedIntegral(t2, [integral]);
    expect(ref?.integralBookId).toBe('bk_int_1');
    expect(ref?.title).toBe('Thorgal — Intégrale 1');
    expect(findCoveringOwnedIntegral(t4, [integral])).toBeNull();

    const annotated = annotateIntegralCoverage([integral, t2, t4], [integral, t2, t4]);
    expect(annotated[0].ownedViaIntegral).toBeUndefined();
    expect(annotated[1].ownedViaIntegral?.integralBookId).toBe('bk_int_1');
    expect(annotated[2].ownedViaIntegral).toBeUndefined();
  });
});
