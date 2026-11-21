import { describe, it, expect } from 'vitest';
import {
  buildVisionPrompt,
  computeMonthlyAiQuota,
  parseJsonArraySafe,
  VISION_OCR_RESPONSE_SCHEMA
} from './vision-prompt.util';

describe('vision-prompt.util', () => {
  it('plafonne à 100 photos/mois pour un petit nombre d’utilisateurs', () => {
    expect(computeMonthlyAiQuota(1)).toBe(100);
    expect(computeMonthlyAiQuota(2)).toBe(100);
    expect(computeMonthlyAiQuota(150)).toBe(100);
  });

  it('réduit proportionnellement le quota quand le nombre d’utilisateurs augmente', () => {
    expect(computeMonthlyAiQuota(300)).toBe(50);
    expect(computeMonthlyAiQuota(500)).toBe(30);
    expect(computeMonthlyAiQuota(1000)).toBe(15);
  });

  it('garantit un plancher minimum de 5 photos/mois', () => {
    expect(computeMonthlyAiQuota(10000)).toBe(5);
  });

  it('cadre la scène dès le début et impose le schéma OCR compact à 6 champs', () => {
    const shelfPrompt = buildVisionPrompt('shelf');
    expect(shelfPrompt).toContain('bibliothèque');
    expect(shelfPrompt).toContain('90°');
    expect(shelfPrompt).toContain('TRANCHE PAR TRANCHE');

    expect(VISION_OCR_RESPONSE_SCHEMA.items.required).toEqual([
      'spineIndex',
      'rawText',
      'titleHint',
      'volumeNumber',
      'authorHint',
      'isbn'
    ]);

    const parsed = parseJsonArraySafe<{ spineIndex: number; rawText: string; titleHint: string }>(
      '```json\n[{"spineIndex":1,"rawText":"28 Boule & Bill ROBA LES QUATRE SAISONS","titleHint":"Boule & Bill - Les Quatre Saisons","volumeNumber":"28","authorHint":"Roba","isbn":""}]\n```'
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].titleHint).toBe('Boule & Bill - Les Quatre Saisons');
  });
});
