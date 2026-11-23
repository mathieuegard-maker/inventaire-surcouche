// src/server/connectors/connectors-fixes.test.ts
// Tests de non-régression terrain V2 : Inventaire inv: + invp:P2, Gemini cascade 404/503, découverte séries sans Q-ID.

import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from './http-client';
import { createInventaireConnector } from './inventaire.connector';
import { createGeminiConnector, PREFERRED_GEMINI_MODELS } from './gemini.connector';

describe('Connecteurs V2 — Corrections terrain (Inventaire, Gemini)', () => {
  it('résout une édition Inventaire indexée sous clé canonique inv:... et extrait la couverture invp:P2', async () => {
    const mockFetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('isbn%3A9782848018416')) {
        return new Response(
          JSON.stringify({
            entities: {
              'inv:bcbc0fd3834df5d5e91cb28e0e338d8b': {
                uri: 'inv:bcbc0fd3834df5d5e91cb28e0e338d8b',
                type: 'edition',
                labels: { fromclaims: 'Un talent monstre !' },
                claims: {
                  'wdt:P212': ['978-2-84801-841-6'],
                  'wdt:P1476': ['Un talent monstre !'],
                  'invp:P2': ['80ec03d42be90e5cb80773159aa1fbe006d8615b'],
                  'wdt:P577': ['2013'],
                  'wdt:P629': ['inv:work_adele_6']
                }
              }
            }
          }),
          { status: 200 }
        );
      }
      if (url.includes('inv%3Awork_adele_6')) {
        return new Response(
          JSON.stringify({
            entities: {
              'inv:work_adele_6': {
                uri: 'inv:work_adele_6',
                type: 'work',
                labels: { fr: 'Un talent monstre !' },
                claims: {
                  'wdt:P179': ['wd:Q28496691'],
                  'wdt:P1545': ['6'],
                  'wdt:P50': ['wd:Q16665645']
                }
              },
              'wd:Q28496691': {
                uri: 'wd:Q28496691',
                type: 'serie',
                labels: { fr: 'Mortelle Adèle' }
              },
              'wd:Q16665645': {
                uri: 'wd:Q16665645',
                type: 'human',
                labels: { fr: 'Mr Tan' }
              }
            }
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    });

    const http = new HttpClient({ fetchImpl: mockFetch as typeof fetch });
    const inv = createInventaireConnector(http);
    const rec = await inv.lookupByIsbn('9782848018416');

    expect(rec).not.toBeNull();
    expect(rec?.title).toBe('Un talent monstre !');
    expect(rec?.seriesName).toBe('Mortelle Adèle');
    expect(rec?.wikidataSeriesQid).toBe('Q28496691');
    expect(rec?.volumeNumber).toBe('6');
    expect(rec?.authors).toEqual(['Mr Tan']);
    expect(rec?.coverUrl).toBe('https://inventaire.io/img/entities/80ec03d42be90e5cb80773159aa1fbe006d8615b');
  });

  it('bascule automatiquement vers le modèle Gemini suivant en cas de 404 ou 503', async () => {
    const calledModels: string[] = [];
    const mockFetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      const match = url.match(/models\/([^:]+):generateContent/);
      if (match) calledModels.push(decodeURIComponent(match[1]));

      if (calledModels.length === 1) {
        return new Response('model not found', { status: 404 });
      }
      if (calledModels.length === 2) {
        return new Response('high demand', { status: 503 });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify([{ title: 'Tintin au Congo', series: 'Tintin', confidence: 'high' }]) }]
              }
            }
          ]
        }),
        { status: 200 }
      );
    });

    const gemini = createGeminiConnector('fake-key', mockFetch as typeof fetch);
    const hints = await gemini.extractBooksFromImage({
      imageDataUrl: 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=',
      mimeType: 'image/webp',
      mode: 'cover'
    });

    expect(calledModels).toEqual(PREFERRED_GEMINI_MODELS.slice(0, 3));
    expect(hints).toHaveLength(1);
    expect(hints[0].title).toBe('Tintin au Congo');
  });
});
