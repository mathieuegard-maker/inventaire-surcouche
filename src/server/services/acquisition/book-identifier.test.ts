// src/server/services/acquisition/book-identifier.test.ts
// Tests unitaires & intégration SQLite :memory: pour Phases 3B/3C (BookIdentifierService + enrichExistingBookByIsbn)
// et le découplage 2 voies du BackgroundWorker (interactif vs catalogue).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDatabaseAdapter } from '../../db/sqlite.adapter';
import { applySqlMigrations } from '../../db/migrator';
import { CatalogRepository } from '../../repositories/catalog.repo';
import { LibraryRepository } from '../../repositories/library.repo';
import { JobRepository } from '../../repositories/job.repo';
import { LogRepository } from '../../repositories/log.repo';
import { UserRepository } from '../../repositories/user.repo';
import { CoverService } from '../cover.service';
import type { BibliographicConnectors, SourceCandidateRecord } from '../../connectors/types';
import { BookIdentifierService } from './book-identifier.service';
import { ComparisonTableService } from './comparison-table.service';
import { SeriesGraphService } from './series-graph.service';
import { IngestionService } from './ingestion.service';
import { BackgroundWorker } from '../../workers/background-worker';

describe('Phases 3B/3C (BookIdentifierService + Enrichissement Étage 2) & Worker 2 voies', () => {
  let db: SqliteDatabaseAdapter;
  let tmpCoversDir: string;
  let catalogRepo: CatalogRepository;
  let libraryRepo: LibraryRepository;
  let jobRepo: JobRepository;
  let logRepo: LogRepository;
  let userRepo: UserRepository;
  let coverService: CoverService;

  const userId = 'usr_p3_1';
  const libraryId = 'lib_p3_1';

  beforeEach(async () => {
    db = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(db, path.resolve(process.cwd(), 'migrations'));
    tmpCoversDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblio-p3-covers-'));

    catalogRepo = new CatalogRepository(db);
    libraryRepo = new LibraryRepository(db);
    jobRepo = new JobRepository(db);
    logRepo = new LogRepository(db);
    userRepo = new UserRepository(db);

    const fakePng = await sharp({
      create: {
        width: 240,
        height: 360,
        channels: 3,
        background: { r: 30, g: 90, b: 160 },
        noise: { type: 'gaussian', mean: 120, sigma: 35 }
      }
    })
      .png()
      .toBuffer();

    coverService = new CoverService({
      coversDir: tmpCoversDir,
      catalogRepo,
      libraryRepo,
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('images-eu.ssl-images-amazon.com') || url.includes('catalogue.bnf.fr/couverture')) {
          return new Response(new Uint8Array(fakePng), {
            status: 200,
            headers: { 'content-type': 'image/png' }
          });
        }
        return new Response('', { status: 404 });
      }) as typeof fetch
    });

    const now = new Date().toISOString();
    userRepo.createUser({
      id: userId,
      username: 'P3Tester',
      email: 'p3@test.local',
      passwordHash: 'scrypt:a:b',
      isAdmin: false,
      gdprAcceptedAt: now,
      now
    });
    libraryRepo.createLibrary({
      id: libraryId,
      name: 'Foyer P3',
      ownerUserId: userId,
      familyInviteCode: 'FAM-P3',
      friendShareToken: 'PUB-P3',
      now
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpCoversDir, { recursive: true, force: true });
  });

  it('identifie le bon ISBN FR BnF (rejette collections kiosque, homonymes, intégrales et mauvais médias) puis enrichit via Étage 2 sans boucle infinie ni écrasement Couche 2/3', async () => {
    const bnfByIsbn: Record<string, SourceCandidateRecord> = {
      '9782800100081': {
        source: 'bnf',
        isbn13: '9782800100081',
        title: 'La Corne de rhinocéros',
        seriesName: 'Spirou et Fantasio',
        seriesLinkKind: 'marc_ensemble_460',
        volumeNumber: '6',
        authors: ['André Franquin'],
        scriptwriters: [],
        illustrators: ['André Franquin'],
        publisher: 'Dupuis',
        publishYear: '1973',
        pageCount: 62,
        description: 'Spirou et Fantasio partent en Afrique sur la piste de plans secrets cachés dans une corne de rhinocéros.',
        language: 'fr',
        rawSubjects: ['Bandes dessinées'],
        contentKind: 'illustrated',
        coverUrl: 'https://catalogue.bnf.fr/couverture?idImage=999006&couverture=1&appName=NE'
      }
    };

    const connectors: BibliographicConnectors = {
      bnf: {
        async lookupByIsbn(isbn13) {
          return bnfByIsbn[isbn13] ?? null;
        },
        async searchByEnsembleId() {
          return [];
        },
        async sampleByCollectionName() {
          return [];
        },
        async searchByTitleAndAuthor(title) {
          if (title.toLowerCase().includes('corne de rhinoc')) {
            return [
              // Bruit 1 : homonyme hors série
              {
                source: 'bnf',
                isbn13: '9782738466779',
                title: 'La coupe en corne de rhinocéros',
                authors: ['Auteur Inconnu'],
                scriptwriters: [],
                illustrators: [],
                language: 'fr',
                rawSubjects: [],
                contentKind: 'text_only'
              },
              // Bruit 2 : collection kiosque Hachette à numérotation décalée (T.3 au lieu de T.6)
              {
                source: 'bnf',
                isbn13: '9782815206068',
                title: 'La corne de rhinocéros',
                seriesName: 'La collection Spirou et Fantasio',
                volumeNumber: '3',
                authors: ['André Franquin'],
                scriptwriters: [],
                illustrators: [],
                language: 'fr',
                rawSubjects: [],
                contentKind: 'illustrated'
              },
              // Bruit 3 : intégrale (doit être rejetée pour un tome unitaire)
              {
                source: 'bnf',
                isbn13: '9782800199993',
                title: 'La Corne de rhinocéros — Intégrale tomes 5 à 8',
                seriesName: 'Spirou et Fantasio',
                authors: ['André Franquin'],
                scriptwriters: [],
                illustrators: [],
                isIntegralHint: true,
                language: 'fr',
                rawSubjects: [],
                contentKind: 'illustrated'
              },
              // Cible valide : Dupuis T.6 !
              bnfByIsbn['9782800100081']
            ];
          }
          return [];
        }
      },
      sudoc: { async lookupByIsbn() { return null; } },
      // Inventaire 100 % hors-ligne pour prouver l'indépendance totale !
      inventaire: {
        async lookupByIsbn() { return null; },
        async fetchSeriesWorks() { return []; },
        async searchByText() { return []; }
      },
      wikidata: {
        async lookupWorkByQid() { return null; },
        async fetchSeriesWorksByQid() { return []; }
      },
      googleBooks: { async lookupByIsbn() { return null; } },
      openLibrary: { async lookupByIsbn() { return null; } }
    };

    const bookIdentifier = new BookIdentifierService({ connectors });
    const foundIsbn = await bookIdentifier.findBestIsbnForSeriesVolume({
      seriesName: 'Spirou et Fantasio',
      title: 'La Corne de rhinocéros',
      volumeNumber: 6,
      authors: [],
      mediaFamily: 'graphic',
      isIntegral: false
    });
    expect(foundIsbn).toBe('9782800100081');

    // Intégration complète Phase 3B -> Phase 3C sur une série avec un tome squelette (0 ISBN, 0 couverture)
    const now = new Date().toISOString();
    const seriesGraph = new SeriesGraphService({ catalogRepo, connectors, coverService });
    const { series } = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'Spirou et Fantasio',
      wikidataSeriesQid: 'Q102237771',
      bookTitle: 'La Corne de rhinocéros',
      volumeNumber: 6,
      isHorsSerie: false,
      isIntegral: false,
      mainCategory: 'BD',
      authors: ['André Franquin'],
      now
    });

    const skeleton = catalogRepo.upsertBookAutomatic({
      id: 'bk_spirou_6',
      workCanonicalId: 'wd:Q3207824',
      seriesId: series.id,
      title: 'La Corne de rhinocéros',
      normalizedTitle: 'la corne de rhinoceros',
      volumeNumber: 6,
      volumeLabel: '6',
      sortOrder: 6,
      isHorsSerie: false,
      isIntegral: false,
      includedVolumes: [],
      authors: [],
      scriptwriters: [],
      illustrators: [],
      publisher: null,
      collectionName: null,
      publishYear: null,
      pageCount: null,
      description: null,
      language: 'fr',
      mainCategory: 'BD',
      subgenres: [],
      coverKey: null,
      wikidataQid: 'Q3207824',
      inventaireUri: 'wd:Q3207824',
      sourceOrigin: 'auto',
      now
    });

    // Verrou Couche 2 Admin sur `publisher` + surcharge Couche 3 Foyer sur `title` : ne doivent JAMAIS être écrasés !
    db.run(`UPDATE books SET publisher = 'Éditeur Verrouillé Admin', locked_fields_json = '["publisher"]' WHERE id = ?`, [
      skeleton.id
    ]);
    libraryRepo.upsertLibraryBookStatus({
      libraryId,
      bookId: skeleton.id,
      status: 'wish',
      wishedByUserId: userId,
      now
    });
    libraryRepo.setLibraryBookOverrides(libraryId, skeleton.id, { title: 'Mon titre perso Foyer' }, now);

    const ingestion = new IngestionService({
      catalogRepo,
      libraryRepo,
      jobRepo,
      logRepo,
      comparisonService: new ComparisonTableService({ connectors }),
      seriesGraphService: seriesGraph,
      coverService,
      bookIdentifier
    });

    const progressEvents: Array<[number, number]> = [];
    const report = await ingestion.enrichIncompleteSeriesVolumes(series.id, (done, total) => {
      progressEvents.push([done, total]);
    });

    expect(report.processed).toBe(1);
    expect(report.enrichedByIsbn).toBe(1);
    expect(report.coversAdded).toBe(1);
    expect(report.stillMissingIsbn).toBe(0);
    expect(progressEvents).toEqual([
      [0, 1],
      [1, 1]
    ]);

    const updated = catalogRepo.findBookById(skeleton.id)!;
    expect(updated.cover_key).toBeTruthy();
    expect(updated.page_count).toBe(62);
    expect(updated.description).toContain('plans secrets');
    // Verrou Couche 2 intact !
    expect(updated.publisher).toBe('Éditeur Verrouillé Admin');
    // Édition ISBN enregistrée !
    expect(catalogRepo.listEditionsByBookId(skeleton.id).map((e) => e.isbn13)).toEqual(['9782800100081']);
    // Surcharge Couche 3 Foyer intacte !
    const mergedView = ingestion.buildMergedBookView(updated, libraryRepo.findLibraryBook(libraryId, skeleton.id));
    expect(mergedView.title).toBe('Mon titre perso Foyer');
    // Zéro boucle infinie : aucun job series_expand n'a été empilé !
    expect(jobRepo.findActiveJobByTypeAndPayloadKey('series_expand', series.id)).toBeNull();
  });

  it('exécute la voie interactive (photo_ocr) en parallèle sans être bloquée par la voie catalogue (series_enrich_volumes)', async () => {
    const worker = new BackgroundWorker({ jobRepo, logRepo, pollIntervalMs: 50 });

    let releaseCatalogJob!: () => void;
    const catalogRunning = new Promise<void>((resolve) => {
      worker.registerHandler('series_enrich_volumes', async () => {
        resolve();
        await new Promise<void>((done) => {
          releaseCatalogJob = done;
        });
        return { result: { processed: 10 }, total: 10 };
      });
    });

    const interactiveDone = new Promise<void>((resolve) => {
      worker.registerHandler('photo_ocr', async () => {
        resolve();
        return { result: { ok: true }, total: 1 };
      });
    });

    const now = new Date().toISOString();
    const catJob = jobRepo.createJob({
      id: 'job_cat_slow',
      type: 'series_enrich_volumes',
      userId,
      libraryId,
      payload: { seriesId: 'ser_demo' },
      progressTotal: 10,
      now
    });
    const photoJob = jobRepo.createJob({
      id: 'job_photo_fast',
      type: 'photo_ocr',
      userId,
      libraryId,
      payload: {},
      progressTotal: 1,
      now
    });

    worker.start();
    try {
      await catalogRunning;
      // Pendant que `series_enrich_volumes` est bloqué en cours d'exécution, `photo_ocr` DOIT s'exécuter et finir immédiatement !
      await interactiveDone;
      await new Promise((r) => setTimeout(r, 40));

      expect(jobRepo.findJobById(photoJob.id)?.status).toBe('done');
      expect(jobRepo.findJobById(catJob.id)?.status).toBe('running');

      releaseCatalogJob();
      await new Promise((r) => setTimeout(r, 60));
      expect(jobRepo.findJobById(catJob.id)?.status).toBe('done');
    } finally {
      worker.stop();
    }
  });
});
