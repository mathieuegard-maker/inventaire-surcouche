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
import { createBnfConnector } from './bnf.connector';
import { PriorityRateLimiter, runWithRequestPriority } from './request-priority';
import { createInventaireConnector } from './inventaire.connector';
import { createWikidataConnector } from './wikidata.connector';
import { createGeminiConnector, PREFERRED_GEMINI_MODELS } from './gemini.connector';
import { JobRepository } from '../repositories/job.repo';

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
          JSON.stringify({ uris: ['inv:ed_omnibus', 'inv:ed_en_1', 'inv:ed_fr_1'] }),
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
              'inv:ed_omnibus': {
                uri: 'inv:ed_omnibus',
                type: 'edition',
                claims: {
                  'wdt:P407': ['wd:Q150'],
                  'wdt:P212': ['978-2-7242-5447-1'],
                  'wdt:P629': ['wd:Q599154', 'wd:Q618719']
                }
              },
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

  it('ne coupe pas le circuit-breaker HttpClient sur des 404 normaux, mais protège bien sur 503 répétés', async () => {
    let statusToReturn = 404;
    const mockFetch = vi.fn(async () => new Response('', { status: statusToReturn }));
    const http = new HttpClient({ fetchImpl: mockFetch as typeof fetch });

    // 8 réponses 404 (ex. ISBN absent d'Inventaire) ne doivent JAMAIS ouvrir le circuit-breaker
    for (let i = 0; i < 8; i++) {
      await http.fetchText({ source: 'inventaire', url: `https://inventaire.io/test/${i}` });
    }
    expect(http.isCircuitOpen('inventaire')).toBe(false);

    // En revanche, 6 erreurs 503 consécutives ouvrent bien le circuit
    statusToReturn = 503;
    for (let i = 0; i < 6; i++) {
      await http.fetchText({ source: 'inventaire', url: `https://inventaire.io/err/${i}` });
    }
    expect(http.isCircuitOpen('inventaire')).toBe(true);
  });

  it('réessaie une fois sur HTTP 429 ponctuel sur Inventaire sans couper 10 min, mais coupe toujours Google Books sur 429', async () => {
    vi.useFakeTimers();
    try {
      let invCalls = 0;
      const mockFetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.includes('inventaire.io')) {
          invCalls++;
          if (invCalls === 1) return new Response('Too Many Requests', { status: 429 });
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response('Quota exceeded', { status: 429 });
      });

      const http = new HttpClient({ fetchImpl: mockFetch as typeof fetch });

      // 1. Inventaire 429 -> pause 3 s + retry automatique réussi, circuit reste fermé !
      const invPromise = http.fetchText({ source: 'inventaire', url: 'https://inventaire.io/api/test' });
      await vi.advanceTimersByTimeAsync(3500);
      const invBody = await invPromise;
      expect(invBody).toBe('{"ok":true}');
      expect(invCalls).toBe(2);
      expect(http.isCircuitOpen('inventaire')).toBe(false);

      // 2. Google Books 429 -> circuit-breaker ouvert immédiatement (10 min)
      const gbBody = await http.fetchText({ source: 'google_books', url: 'https://www.googleapis.com/books/v1/volumes?q=isbn:123' });
      expect(gbBody).toBeNull();
      expect(http.isCircuitOpen('google_books')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('transforme une saturation Gemini HTTP 503 JSON brut en message utilisateur français lisible', async () => {
    const rawGoogle503 = JSON.stringify({
      error: {
        code: 503,
        message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary.',
        status: 'UNAVAILABLE'
      }
    });
    const mockFetch = vi.fn(async () => new Response(rawGoogle503, { status: 503 }));
    const gemini = createGeminiConnector('fake-key', mockFetch as typeof fetch);

    await expect(
      gemini.extractBooksFromImage({
        imageDataUrl: 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=',
        mimeType: 'image/webp',
        mode: 'shelf'
      })
    ).rejects.toThrow(/momentanément surchargé.*Réessayer/i);
  });

  it('envoie un User-Agent API propre vers Inventaire/Wikidata (jamais Mozilla/5.0) et ne met jamais en cache une erreur JSON HTTP 200', async () => {
    const db = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(db, path.resolve(process.cwd(), 'migrations'));
    try {
      const jobRepo = new JobRepository(db);
      const seenUserAgents: Record<string, string> = {};
      let wdCalls = 0;

      const mockFetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const ua = headers['User-Agent'] ?? '';
        if (url.includes('catalogue.bnf.fr')) {
          seenUserAgents.bnf = ua;
          return new Response('<xml/>', { status: 200 });
        }
        if (url.includes('inventaire.io')) {
          seenUserAgents.inventaire = ua;
          return new Response('{"results":[]}', { status: 200 });
        }
        if (url.includes('wikidata.org')) {
          seenUserAgents.wikidata = ua;
          wdCalls++;
          if (wdCalls === 1) {
            return new Response(
              JSON.stringify({ error: { code: 'cirrussearch-too-busy-error', info: 'busy' } }),
              { status: 200 }
            );
          }
          return new Response(JSON.stringify({ search: [{ id: 'Q42490', description: 'série de bandes dessinées' }] }), {
            status: 200
          });
        }
        return new Response('', { status: 404 });
      });

      const http = new HttpClient({ jobRepo, fetchImpl: mockFetch as typeof fetch });
      await http.fetchText({ source: 'bnf', url: 'https://catalogue.bnf.fr/api/SRU?test=1' });
      await http.fetchJson({ source: 'inventaire', url: 'https://inventaire.io/api/search?test=1' });

      // 1er appel Wikidata = erreur applicative HTTP 200 -> ne doit PAS être mis en cache
      await http.fetchJson({
        source: 'wikidata',
        url: 'https://www.wikidata.org/w/api.php?action=wbsearchentities&search=asterix',
        cacheKey: 'wd:test:busy'
      });
      // 2e appel avec la même cacheKey -> doit réellement rappeler le réseau et réussir !
      const second = await http.fetchJson<{ search?: Array<{ id: string }> }>({
        source: 'wikidata',
        url: 'https://www.wikidata.org/w/api.php?action=wbsearchentities&search=asterix',
        cacheKey: 'wd:test:busy'
      });

      expect(seenUserAgents.bnf).toContain('Mozilla/5.0');
      expect(seenUserAgents.inventaire).not.toContain('Mozilla/5.0');
      expect(seenUserAgents.inventaire).toContain('BiblioCollection/2.0');
      expect(seenUserAgents.wikidata).not.toContain('Mozilla/5.0');
      expect(wdCalls).toBe(2);
      expect(second?.search?.[0]?.id).toBe('Q42490');
    } finally {
      db.close();
    }
  });

  it('classe Q42490 (Astérix) avant franchise/personnage/jeu vidéo et bascule Boule & Bill -> Boule et Bill (Q59991) sur Wikidata', async () => {
    const mockFetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      expect(url).toContain('uselang=fr');
      if (url.includes('search=Ast%C3%A9rix')) {
        return new Response(
          JSON.stringify({
            search: [
              { id: 'Q105030970', label: 'Astérix', description: 'franchise médiatique' },
              { id: 'Q2442526', label: 'Astérix', description: 'jeu vidéo de 1993' },
              { id: 'Q42490', label: 'Astérix', description: 'série française de bandes dessinées' },
              {
                id: 'Q7620503',
                label: 'Astérix',
                description: 'personnage fictif et héros titulaire de la série de bandes dessinées française Astérix'
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes('search=Boule%20%26%20Bill')) {
        return new Response(JSON.stringify({ search: [] }), { status: 200 });
      }
      if (url.includes('search=Boule%20et%20Bill')) {
        return new Response(
          JSON.stringify({
            search: [
              { id: 'Q2921731', label: 'Boule et Bill', description: "série télévisée d'animation, 2005" },
              { id: 'Q59991', label: 'Boule et Bill', description: 'série de bande dessinée humoristique belge' }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes('search=Nestor%20Burma')) {
        return new Response(
          JSON.stringify({
            search: [
              { id: 'Q1780654', label: 'Nestor Burma', description: 'personnage créé par Léo Malet' },
              { id: 'Q3144248', label: 'Nestor Burma', description: 'série de bande dessinée' },
              { id: 'Q9999999', label: 'Nestor Burma', description: 'série de romans policiers de Léo Malet' }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ search: [] }), { status: 200 });
    });

    const http = new HttpClient({ fetchImpl: mockFetch as typeof fetch });
    const wd = createWikidataConnector(http);

    expect(await wd.searchSeriesQids!('Astérix', 'graphic')).toEqual(['Q42490']);
    expect(await wd.searchSeriesQids!('Boule & Bill', 'graphic')).toEqual(['Q59991']);
    expect(await wd.searchSeriesQids!('Nestor Burma', 'graphic')).toEqual(['Q3144248']);
    expect(await wd.searchSeriesQids!('Nestor Burma', 'prose')).toEqual(['Q9999999']);
  });

  it('corrige un label Wikidata fr copié depuis une langue étrangère via frwiki et filtre les fiches locales étrangères sans ISBN sur Inventaire', async () => {
    const mockFetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('action=wbgetentities')) {
        return new Response(
          JSON.stringify({
            entities: {
              Q30728090: {
                id: 'Q30728090',
                labels: {
                  fr: { value: "Asterix e la corsa d'Italia" },
                  it: { value: "Asterix e la corsa d'Italia" },
                  en: { value: 'Asterix and the Chariot Race' }
                },
                sitelinks: {
                  frwiki: { title: 'Astérix et la Transitalique' }
                },
                claims: {
                  P179: [
                    {
                      mainsnak: { datavalue: { value: { id: 'Q42490' } } },
                      qualifiers: { P1545: [{ datavalue: { value: '37' } }] }
                    }
                  ]
                }
              },
              Q42490: {
                id: 'Q42490',
                labels: { fr: { value: 'Astérix' } },
                sitelinks: { frwiki: { title: 'Astérix (bande dessinée)' } }
              }
            }
          }),
          { status: 200 }
        );
      }
      if (url.includes('query.wikidata.org/sparql')) {
        return new Response(
          JSON.stringify({
            results: {
              bindings: [
                {
                  work: { value: 'http://www.wikidata.org/entity/Q30728090' },
                  workLabel: { value: "Asterix e la corsa d'Italia" },
                  frLabel: { value: "Asterix e la corsa d'Italia" },
                  foreignLabels: { value: "Asterix e la corsa d'Italia|Asterix and the Chariot Race" },
                  frWiki: { value: 'Astérix et la Transitalique' },
                  ordinal: { value: '37' }
                },
                {
                  work: { value: 'http://www.wikidata.org/entity/Q1196871' },
                  workLabel: { value: 'Le Devin' },
                  frLabel: { value: 'Le Devin' },
                  frWiki: { value: 'Le Devin (Astérix)' },
                  ordinal: { value: '19' }
                }
              ]
            }
          }),
          { status: 200 }
        );
      }
      if (url.includes('action=reverse-claims&property=wdt:P179')) {
        return new Response(
          JSON.stringify({ uris: ['inv:foreign1', 'inv:french1', 'wd:Q1682411'] }),
          { status: 200 }
        );
      }
      if (url.includes('action=reverse-claims&property=wdt:P629')) {
        if (url.includes('inv%3Afrench1')) {
          return new Response(JSON.stringify({ uris: ['isbn:9782864971115'] }), { status: 200 });
        }
        return new Response(JSON.stringify({ uris: [] }), { status: 200 });
      }
      if (url.includes('action=by-uris')) {
        return new Response(
          JSON.stringify({
            entities: {
              'inv:foreign1': {
                uri: 'inv:foreign1',
                labels: { de: "Asterix und der Kampf um's Kanzleramt" },
                claims: {}
              },
              'inv:french1': {
                uri: 'inv:french1',
                labels: { fr: "Le meilleur d'Astérix" },
                claims: {}
              },
              'wd:Q1682411': {
                uri: 'wd:Q1682411',
                labels: { fr: 'Comment Obélix est tombé dans la marmite' },
                claims: {}
              }
            }
          }),
          { status: 200 }
        );
      }
      return new Response('', { status: 404 });
    });

    const http = new HttpClient({ fetchImpl: mockFetch as typeof fetch });
    const wd = createWikidataConnector(http);
    const inv = createInventaireConnector(http);

    const work = await wd.lookupWorkByQid('Q30728090', '9782864973270');
    expect(work?.title).toBe('Astérix et la Transitalique');
    expect(work?.seriesName).toBe('Astérix');

    const seriesWorks = await wd.fetchSeriesWorksByQid('Q42490');
    expect(seriesWorks.find((w) => w.wikidataQid === 'Q30728090')?.title).toBe('Astérix et la Transitalique');
    expect(seriesWorks.find((w) => w.wikidataQid === 'Q1196871')?.title).toBe('Le Devin');

    const invWorks = await inv.fetchSeriesWorks('wd:Q42490');
    expect(invWorks.map((w) => w.title)).toEqual([
      "Le meilleur d'Astérix",
      'Comment Obélix est tombé dans la marmite'
    ]);
  });

  it('préempte les tâches de fond (LOW) au profit des requêtes utilisateur (HIGH) et fusionne les appels réseau identiques simultanés', async () => {
    const limiter = new PriorityRateLimiter({
      policies: { bnf: { maxConcurrency: 1, defaultMinIntervalMs: 0 } },
      bypassTiming: true
    });

    const executionOrder: string[] = [];
    let releaseBlocker!: () => void;
    const blockerPromise = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });

    // 1. Une tâche LOW occupe l'unique créneau BnF
    const low1 = runWithRequestPriority('low', () =>
      limiter.schedule('bnf', async () => {
        executionOrder.push('low-1-start');
        await blockerPromise;
        executionOrder.push('low-1-end');
      })
    );

    // 2. Deux autres tâches LOW sont mises en file d'attente
    const low2 = runWithRequestPriority('low', () =>
      limiter.schedule('bnf', async () => {
        executionOrder.push('low-2');
      })
    );
    const low3 = runWithRequestPriority('low', () =>
      limiter.schedule('bnf', async () => {
        executionOrder.push('low-3');
      })
    );

    // 3. Une requête interactive HIGH arrive ensuite : elle DOIT passer avant low-2 et low-3 !
    const high1 = runWithRequestPriority('high', () =>
      limiter.schedule('bnf', async () => {
        executionOrder.push('high-1');
      })
    );

    releaseBlocker();
    await Promise.all([low1, low2, low3, high1]);

    expect(executionOrder).toEqual(['low-1-start', 'low-1-end', 'high-1', 'low-2', 'low-3']);

    // 4. Fusion in-flight sur HttpClient : 2 appels simultanés sur la même URL ne déclenchent qu'1 seul fetch !
    let fetchCalls = 0;
    const mockFetch = vi.fn(async () => {
      fetchCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response('{"ok":true}', { status: 200 });
    });
    const http = new HttpClient({ fetchImpl: mockFetch as typeof fetch, rateLimiter: limiter });

    const [r1, r2] = await Promise.all([
      http.fetchJson<{ ok: boolean }>({
        source: 'inventaire',
        url: 'https://inventaire.io/api/same-flight',
        cacheKey: 'inv:flight:test'
      }),
      http.fetchJson<{ ok: boolean }>({
        source: 'inventaire',
        url: 'https://inventaire.io/api/same-flight',
        cacheKey: 'inv:flight:test'
      })
    ]);

    expect(r1?.ok).toBe(true);
    expect(r2?.ok).toBe(true);
    expect(fetchCalls).toBe(1);
  });

  it('filtre les intégrales étrangères et les faux positifs partiels sur série courte dans bnf.searchSeriesIntegrals (ex. Polo vs Marco Polo il Milione)', async () => {
    const sruXml = `<?xml version="1.0" encoding="UTF-8"?>
<srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/" xmlns:mxc="info:lc/xmlns/marcxchange-v2">
  <srw:records>
    <srw:record>
      <srw:recordData>
        <mxc:record>
          <mxc:datafield tag="008"><mxc:subfield code="a">200101s1928    it            000 0 ita  </mxc:subfield></mxc:datafield>
          <mxc:datafield tag="041"><mxc:subfield code="a">ita</mxc:subfield></mxc:datafield>
          <mxc:datafield tag="245"><mxc:subfield code="a">Marco Polo il Milione. Prima edizione integrale</mxc:subfield></mxc:datafield>
          <mxc:datafield tag="100"><mxc:subfield code="a">Benedetto</mxc:subfield><mxc:subfield code="m">Luigi Foscolo</mxc:subfield></mxc:datafield>
        </mxc:record>
      </srw:recordData>
    </srw:record>
    <srw:record>
      <srw:recordData>
        <mxc:record>
          <mxc:datafield tag="041"><mxc:subfield code="a">fre</mxc:subfield></mxc:datafield>
          <mxc:datafield tag="020"><mxc:subfield code="a">978-2-227-71500-4</mxc:subfield></mxc:datafield>
          <mxc:datafield tag="245"><mxc:subfield code="a">Marco Polo, intégrale des voyages</mxc:subfield></mxc:datafield>
          <mxc:datafield tag="100"><mxc:subfield code="a">Polo</mxc:subfield><mxc:subfield code="m">Marco</mxc:subfield></mxc:datafield>
        </mxc:record>
      </srw:recordData>
    </srw:record>
    <srw:record>
      <srw:recordData>
        <mxc:record>
          <mxc:datafield tag="041"><mxc:subfield code="a">fre</mxc:subfield></mxc:datafield>
          <mxc:datafield tag="020"><mxc:subfield code="a">978-2-227-49012-3</mxc:subfield></mxc:datafield>
          <mxc:datafield tag="245"><mxc:subfield code="a">Polo, l'intégrale</mxc:subfield><mxc:subfield code="e">Tomes 1 à 3</mxc:subfield></mxc:datafield>
          <mxc:datafield tag="460"><mxc:subfield code="t">Polo</mxc:subfield><mxc:subfield code="v">1</mxc:subfield></mxc:datafield>
          <mxc:datafield tag="100"><mxc:subfield code="a">Faller</mxc:subfield><mxc:subfield code="m">Régis</mxc:subfield></mxc:datafield>
        </mxc:record>
      </srw:recordData>
    </srw:record>
  </srw:records>
</srw:searchRetrieveResponse>`;

    const mockFetch = vi.fn(async () => new Response(sruXml, { status: 200 }));
    const http = new HttpClient({ fetchImpl: mockFetch as typeof fetch });
    const bnf = createBnfConnector(http);

    const integrals = await bnf.searchSeriesIntegrals!('Polo');
    expect(integrals).toHaveLength(1);
    expect(integrals[0].title).toContain('Polo');
    expect(integrals[0].title).not.toContain('Marco Polo');
    expect(integrals[0].isbn13s).toEqual(['9782227490123']);
  });
});
