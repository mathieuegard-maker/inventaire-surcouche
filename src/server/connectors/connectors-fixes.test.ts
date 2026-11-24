// src/server/connectors/connectors-fixes.test.ts
// Tests de non-régression terrain V2 : Inventaire inv: + invp:P2, Gemini cascade 404/503, découverte séries sans Q-ID.

import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import sharp from 'sharp';
import { SqliteDatabaseAdapter } from '../db/sqlite.adapter';
import { applySqlMigrations } from '../db/migrator';
import { CatalogRepository } from '../repositories/catalog.repo';
import { LibraryRepository } from '../repositories/library.repo';
import { CoverService } from '../services/cover.service';
import { SeriesGraphService } from '../services/acquisition/series-graph.service';
import type { BibliographicConnectors } from './types';
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
    expect(hints[0].spineIndex).toBe(1);
  });

  it('rejette les couvertures .svg (Asterix.svg), conserve la HD 1800px sur preview Photo IA et fusionne les numéros de tomes BnF sur Wikidata', async () => {
    const db = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(db, path.resolve(process.cwd(), 'migrations'));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblio-cov-fix-'));
    try {
      const catalogRepo = new CatalogRepository(db);
      const libraryRepo = new LibraryRepository(db);
      const coverService = new CoverService({
        coversDir: tmpDir,
        catalogRepo,
        libraryRepo,
        fetchImpl: (async () => new Response('', { status: 404 })) as typeof fetch
      });

      // 1. Rejet strict des .svg (ex: Asterix.svg sur Wikimedia Commons)
      const svgRes = await coverService.ingestFromExternalUrl(
        'http://commons.wikimedia.org/wiki/Special:FilePath/Asterix.svg?width=400'
      );
      expect(svgRes).toBeNull();

      // 2. Preview Photo IA conservée en haute définition (ex: 1200x900 > 420px miniature couverture)
      const hdPng = await sharp({
        create: { width: 1200, height: 900, channels: 3, background: { r: 20, g: 80, b: 140 } }
      })
        .png()
        .toBuffer();
      const hdDataUrl = `data:image/png;base64,${hdPng.toString('base64')}`;
      const preview = await coverService.storePreviewDataUrlAsWebp(hdDataUrl);
      const storedBin = await coverService.readCoverBinary(preview.coverKey);
      expect(storedBin).not.toBeNull();
      const meta = await sharp(storedBin!.buffer).metadata();
      expect(meta.width).toBe(1200);
      expect(meta.height).toBe(900);

      // 3. Fusion numéros de tomes BnF sur tomes Wikidata sans P1545 (cas Mortelle Adèle)
      const mockConnectors: BibliographicConnectors = {
        bnf: {
          async lookupByIsbn() { return null; },
          async searchByEnsembleId() {
            return [
              {
                title: "C'est pas ma faute !",
                volumeNumber: 1,
                volumeLabel: '1',
                sortOrder: 1,
                authors: ['Mr Tan'],
                isbn13s: ['9782848018690'],
                source: 'bnf'
              }
            ];
          },
          async sampleByCollectionName() { return []; },
          async searchByTitleAndAuthor() { return []; }
        },
        sudoc: { async lookupByIsbn() { return null; } },
        inventaire: {
          async lookupByIsbn() { return null; },
          async fetchSeriesWorks() { return []; }
        },
        wikidata: {
          async lookupWorkByQid() { return null; },
          async fetchSeriesWorksByQid() {
            return [
              {
                title: "C'est pas ma faute !",
                volumeNumber: null,
                volumeLabel: null,
                sortOrder: null,
                wikidataQid: 'Q101871200',
                authors: ['Mr Tan'],
                isbn13s: [],
                source: 'wikidata'
              }
            ];
          }
        },
        googleBooks: { async lookupByIsbn() { return null; } },
        openLibrary: { async lookupByIsbn() { return null; } }
      };

      const graph = new SeriesGraphService({ catalogRepo, connectors: mockConnectors, coverService });
      const { series } = graph.resolveOrCreateSeriesCut({
        seriesName: 'Mortelle Adèle',
        wikidataSeriesQid: 'Q3324557',
        bnfEnsembleId: '43805008',
        bookTitle: 'Un talent monstre !',
        volumeNumber: 6,
        isHorsSerie: false,
        isIntegral: false,
        authors: ['Mr Tan']
      });
      await graph.expandSeriesByGraph(series.id);
      const savedBooks = catalogRepo.listBooksBySeriesId(series.id);
      const tome1 = savedBooks.find((b) => b.title.includes('faute'));
      expect(tome1?.volume_number).toBe(1);
      expect(tome1?.sort_order).toBe(1);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('résout les éditions FR inv:... (ISBN P212 + couverture éditeur invp:P2) dans Inventaire fetchSeriesWorks', async () => {
    const mockFetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('property=wdt:P179') && url.includes('wd%3AQ42490')) {
        return new Response(JSON.stringify({ uris: ['wd:Q599154'] }), { status: 200 });
      }
      if (url.includes('property=wdt:P629') && url.includes('wd%3AQ599154')) {
        return new Response(
          JSON.stringify({ uris: ['inv:ed_en_1', 'inv:ed_fr_1'] }),
          { status: 200 }
        );
      }
      if (url.includes('action=by-uris') && url.includes('wd%3AQ599154')) {
        return new Response(
          JSON.stringify({
            entities: {
              'wd:Q599154': {
                uri: 'wd:Q599154',
                type: 'work',
                labels: { fr: 'Astérix chez Rahàzade' },
                image: { url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Asterix.svg?width=1280' },
                claims: { 'wdt:P1545': ['28'] }
              }
            }
          }),
          { status: 200 }
        );
      }
      if (url.includes('action=by-uris') && url.includes('inv%3Aed_fr_1')) {
        return new Response(
          JSON.stringify({
            entities: {
              'inv:ed_en_1': {
                uri: 'inv:ed_en_1',
                type: 'edition',
                claims: { 'wdt:P407': ['wd:Q1860'], 'wdt:P212': ['978-0-7528-4776-4'] }
              },
              'inv:ed_fr_1': {
                uri: 'inv:ed_fr_1',
                type: 'edition',
                image: { url: '/img/entities/a4d2420302179f38af46ac5a1c3d22b6c749ffae' },
                claims: {
                  'wdt:P407': ['wd:Q150'],
                  'wdt:P212': ['978-2-86497-209-9'],
                  'wdt:P1476': ['Astérix chez Rahàzade'],
                  'invp:P2': ['a4d2420302179f38af46ac5a1c3d22b6c749ffae']
                }
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
    const works = await inv.fetchSeriesWorks('wd:Q42490');

    expect(works).toHaveLength(1);
    expect(works[0].title).toBe('Astérix chez Rahàzade');
    expect(works[0].volumeNumber).toBe(28);
    expect(works[0].isbn13s).toEqual(['9782864972099']);
    expect(works[0].coverUrl).toBe('https://inventaire.io/img/entities/a4d2420302179f38af46ac5a1c3d22b6c749ffae');
  });
});
