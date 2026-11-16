import { describe, it, expect } from 'vitest';
import { computeMonthlyAiQuota } from './vision-prompt.util';

describe('vision-prompt.util computeMonthlyAiQuota', () => {
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
});
