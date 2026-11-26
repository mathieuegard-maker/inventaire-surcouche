// src/shared/bibliographic/integral.util.test.ts
import { describe, expect, it } from 'vitest';
import {
  annotateIntegralCoverage,
  extractIncludedVolumesFromEditorialText,
  formatIncludedVolumeNumbers,
  formatIntegralRangeLabel,
  parseIncludedVolumeNumbers,
  type IntegralCheckBook
} from './integral.util';

describe('integral.util', () => {
  it('parse et formate les plages de tomes inclus en ignorant les années (ex. 1946-1948)', () => {
    expect(parseIncludedVolumeNumbers('1 à 3')).toEqual(['1', '2', '3']);
    expect(parseIncludedVolumeNumbers('T.1-3, 5')).toEqual(['1', '2', '3', '5']);
    expect(parseIncludedVolumeNumbers("Buck Danny, l'intégrale 1 (1946-1948)")).toEqual(['1']);
    expect(formatIncludedVolumeNumbers(['1', '2', '3'])).toBe('1-3');
    expect(formatIncludedVolumeNumbers(['1', '3', '5'])).toBe('1, 3, 5');
    expect(formatIntegralRangeLabel(['1', '2', '3'])).toBe('Int. T.1-3');
  });

  it('extrait les tomes inclus depuis les notes MARC 300/327 sans capturer les nombres narratifs d’un résumé', () => {
    expect(extractIncludedVolumesFromEditorialText('Réunit les tomes 1 à 9 de la série.')).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9'
    ]);
    expect(
      extractIncludedVolumesFromEditorialText(
        'Réunit : 1, Le combat ordinaire ; 2, Les quantités négligeables ; 3, Ce qui est précieux ; 4, Planter des clous'
      )
    ).toEqual(['1', '2', '3', '4']);
    expect(extractIncludedVolumesFromEditorialText('Coffret réunissant les quatre tomes du cycle.')).toEqual([
      '1',
      '2',
      '3',
      '4'
    ]);
    // Zéro faux positif sur un résumé narratif contenant des chiffres
    expect(
      extractIncludedVolumesFromEditorialText('En 14 jours, 3 amis traversent 7 mers entre 1940 et 1945.')
    ).toEqual([]);
  });

  it('annote correctement un tome couvert par une intégrale possédée de la même série', () => {
    const books: IntegralCheckBook[] = [
      {
        id: 'bk_int_1',
        title: 'Thorgal Intégrale 1',
        seriesId: 'ser_thorgal',
        seriesName: 'Thorgal',
        volumeNumber: null,
        volumeLabel: 'Intégrale 1',
        isIntegral: true,
        includedVolumes: ['1', '2', '3'],
        ownershipStatus: 'owned',
        primaryIsbn13: '9782803630001',
        ownedViaIntegral: null
      },
      {
        id: 'bk_t2',
        title: "L'Île des mers gelées",
        seriesId: 'ser_thorgal',
        seriesName: 'Thorgal',
        volumeNumber: 2,
        volumeLabel: '2',
        isIntegral: false,
        includedVolumes: [],
        ownershipStatus: 'none',
        primaryIsbn13: '9782803603589',
        ownedViaIntegral: null
      },
      {
        id: 'bk_t4',
        title: 'La Galère noire',
        seriesId: 'ser_thorgal',
        seriesName: 'Thorgal',
        volumeNumber: 4,
        volumeLabel: '4',
        isIntegral: false,
        includedVolumes: [],
        ownershipStatus: 'none',
        primaryIsbn13: '9782803604050',
        ownedViaIntegral: null
      }
    ];

    const annotated = annotateIntegralCoverage(books, books);
    expect(annotated[0].ownedViaIntegral).toBeNull();
    expect(annotated[1].ownedViaIntegral?.integralBookId).toBe('bk_int_1');
    expect(annotated[2].ownedViaIntegral).toBeNull();
  });
});
