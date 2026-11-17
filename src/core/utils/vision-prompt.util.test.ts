import { describe, it, expect } from 'vitest';
import {
  buildSemanticWorkNormalizationPrompt,
  computeMonthlyAiQuota,
  mergeOcrAndSemanticLayers,
  parseJsonArraySafe
} from './vision-prompt.util';

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

  it('construit le prompt Couche 2 avec les séries existantes et fusionne sans inventer si inconnu', () => {
    const ocrItems = [
      {
        spineIndex: 1,
        rawSpineText: "LA SERPE D'OR Texte de GOSCINNY Dessins de UDERZO",
        title: "La Serpe d'or",
        series: '',
        volumeNumber: '',
        author: 'Goscinny'
      },
      {
        spineIndex: 2,
        rawSpineText: '41 Astérix ASTÉRIX EN LUSITANIE',
        title: 'Astérix en Lusitanie',
        series: 'Astérix',
        volumeNumber: '41',
        author: ''
      }
    ];

    const prompt = buildSemanticWorkNormalizationPrompt(ocrItems, ["Une aventure d'Astérix", 'Boule & Bill']);
    expect(prompt).toContain("Une aventure d'Astérix");
    expect(prompt).toContain('Boule & Bill');
    expect(prompt).toContain('"known": false');

    const semanticReply = parseJsonArraySafe<any>(
      JSON.stringify([
        {
          spineIndex: 1,
          known: true,
          canonicalSeries: "Une aventure d'Astérix",
          canonicalVolumeNumber: '2',
          canonicalWorkTitle: "La Serpe d'or",
          bnfSearchTitle: "La serpe d'or",
          bnfSearchAuthor: 'Goscinny',
          confidence: 'high'
        },
        {
          spineIndex: 2,
          known: false,
          canonicalSeries: '',
          canonicalVolumeNumber: '',
          canonicalWorkTitle: '',
          bnfSearchTitle: '',
          bnfSearchAuthor: '',
          confidence: 'low'
        }
      ])
    );

    const merged = mergeOcrAndSemanticLayers(ocrItems, semanticReply);
    expect(merged[0]).toMatchObject({
      spineIndex: 1,
      semanticKnown: true,
      series: "Une aventure d'Astérix",
      volumeNumber: '2',
      bnfSearchTitle: "La serpe d'or",
      rawSpineText: "LA SERPE D'OR Texte de GOSCINNY Dessins de UDERZO"
    });
    expect(merged[1]).toMatchObject({
      spineIndex: 2,
      semanticKnown: false,
      title: 'Astérix en Lusitanie',
      series: 'Astérix',
      volumeNumber: '41'
    });
  });
});
