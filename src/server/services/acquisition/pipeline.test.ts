// src/server/services/acquisition/pipeline.test.ts
// Tests unitaires & intégration SQLite :memory: du Pipeline Bibliographique 3 Étages (Jalon 2).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDatabaseAdapter } from '../../db/sqlite.adapter';
import { applySqlMigrations } from '../../db/migrator';
import { CatalogRepository } from '../../repositories/catalog.repo';
import { LibraryRepository } from '../../repositories/library.repo';
import { JobRepository } from '../../repositories/job.repo';
import { LogRepository } from '../../repositories/log.repo';
import { UserRepository } from '../../repositories/user.repo';
import { CoverService } from '../cover.service';
import { CollectionGuardService } from './collection-guard.service';
import { ComparisonTableService } from './comparison-table.service';
import { SeriesGraphService } from './series-graph.service';
import { IngestionService } from './ingestion.service';
import type {
  BibliographicConnectors,
  CollectionSampleItem,
  GraphSeriesWork,
  SourceCandidateRecord
} from '../../connectors/types';

function createMockConnectors(overrides?: {
  bnfByIsbn?: Record<string, SourceCandidateRecord>;
  bnfSamples?: Record<string, CollectionSampleItem[]>;
  bnfEnsemble?: Record<string, GraphSeriesWork[]>;
  sudocByIsbn?: Record<string, SourceCandidateRecord>;
  inventaireByIsbn?: Record<string, SourceCandidateRecord>;
  inventaireSeries?: Record<string, GraphSeriesWork[]>;
  wikidataByQid?: Record<string, SourceCandidateRecord>;
  wikidataSeries?: Record<string, GraphSeriesWork[]>;
  gbByIsbn?: Record<string, SourceCandidateRecord>;
  olByIsbn?: Record<string, SourceCandidateRecord>;
}): BibliographicConnectors {
  return {
    bnf: {
      async lookupByIsbn(isbn13) {
        return overrides?.bnfByIsbn?.[isbn13] ?? null;
      },
      async searchByEnsembleId(ensId) {
        return overrides?.bnfEnsemble?.[ensId] ?? [];
      },
      async sampleByCollectionName(name) {
        return overrides?.bnfSamples?.[name.toLowerCase()] ?? [];
      },
      async searchByTitleAndAuthor() {
        return [];
      }
    },
    sudoc: {
      async lookupByIsbn(isbn13) {
        return overrides?.sudocByIsbn?.[isbn13] ?? null;
      }
    },
    inventaire: {
      async lookupByIsbn(isbn13) {
        return overrides?.inventaireByIsbn?.[isbn13] ?? null;
      },
      async fetchSeriesWorks(uri) {
        return overrides?.inventaireSeries?.[uri] ?? [];
      }
    },
    wikidata: {
      async lookupWorkByQid(qid) {
        return overrides?.wikidataByQid?.[qid] ?? null;
      },
      async fetchSeriesWorksByQid(qid) {
        return overrides?.wikidataSeries?.[qid] ?? [];
      }
    },
    googleBooks: {
      async lookupByIsbn(isbn13) {
        return overrides?.gbByIsbn?.[isbn13] ?? null;
      }
    },
    openLibrary: {
      async lookupByIsbn(isbn13) {
        return overrides?.olByIsbn?.[isbn13] ?? null;
      }
    }
  };
}

describe('Jalon 2 — Pipeline Bibliographique 3 Étages (Anti-fausses séries, Franchise/Découpage, Graphe & Primauté)', () => {
  let db: SqliteDatabaseAdapter;
  let tmpCoversDir: string;
  let catalogRepo: CatalogRepository;
  let libraryRepo: LibraryRepository;
  let jobRepo: JobRepository;
  let logRepo: LogRepository;
  let userRepo: UserRepository;
  let coverService: CoverService;

  const userId = 'usr_test_1';
  const libraryId = 'lib_test_1';

  beforeEach(() => {
    db = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(db, path.resolve(process.cwd(), 'migrations'));
    tmpCoversDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblio-covers-test-'));

    catalogRepo = new CatalogRepository(db);
    libraryRepo = new LibraryRepository(db);
    jobRepo = new JobRepository(db);
    logRepo = new LogRepository(db);
    userRepo = new UserRepository(db);
    coverService = new CoverService({
      coversDir: tmpCoversDir,
      catalogRepo,
      libraryRepo
    });

    const now = new Date().toISOString();
    userRepo.createUser({
      id: userId,
      username: 'Tester',
      email: 'tester@biblio.test',
      passwordHash: 'scrypt:a:b',
      isAdmin: false,
      gdprAcceptedAt: now,
      now
    });
    libraryRepo.createLibrary({
      id: libraryId,
      name: 'Foyer Test',
      ownerUserId: userId,
      familyInviteCode: 'FAM-TEST0001',
      friendShareToken: 'PUB-TEST0001',
      now
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpCoversDir, { recursive: true, force: true });
  });

  it('rejette algorithmiquement les collections éditoriales poche (Totem, Folio, Tout Simenon) sans liste en dur, tout en conservant les anthologies ancrées (Les Reines de sang)', async () => {
    const connectors = createMockConnectors({
      bnfByIsbn: {
        // Cas 1 : Totem (collection 225/410 avec 6 auteurs différents dans l'échantillon)
        '9782351785423': {
          source: 'bnf',
          isbn13: '9782351785423',
          title: 'Betty',
          seriesName: 'Totem',
          seriesLinkKind: 'marc_collection_225',
          volumeNumber: '42',
          collectionName: 'Totem',
          collectionNumber: '42',
          authors: ['Tiffany McDaniel'],
          scriptwriters: [],
          illustrators: [],
          publisher: 'Gallmeister',
          rawSubjects: ['Roman']
        },
        // Cas 2 : Folio #7304 (collection 225/410 avec numéro très élevé)
        '9782073041234': {
          source: 'bnf',
          isbn13: '9782073041234',
          title: 'La Peste',
          seriesName: 'Folio',
          seriesLinkKind: 'marc_collection_225',
          volumeNumber: '7304',
          collectionName: 'Folio',
          collectionNumber: '7304',
          authors: ['Albert Camus'],
          scriptwriters: [],
          illustrators: [],
          publisher: 'Gallimard',
          rawSubjects: ['Roman']
        },
        // Cas 3 : Collection mono-auteur "Tout Simenon" en 225, mais l'œuvre appartient à Maigret sur Inventaire/Wikidata
        '9782258031111': {
          source: 'bnf',
          isbn13: '9782258031111',
          title: 'Pietr-le-Letton',
          seriesName: 'Tout Simenon',
          seriesLinkKind: 'marc_collection_225',
          volumeNumber: '1',
          collectionName: 'Tout Simenon',
          authors: ['Georges Simenon'],
          scriptwriters: [],
          illustrators: [],
          publisher: 'Presses de la Cité',
          rawSubjects: ['Roman policier']
        },
        // Cas 4 : Anthologie multi-auteurs "Les Reines de sang" ancrée en MARC 460
        '9782756051234': {
          source: 'bnf',
          isbn13: '9782756051234',
          title: 'Aliénor, la légende noire',
          seriesName: 'Les Reines de sang',
          seriesLinkKind: 'marc_ensemble_460',
          volumeNumber: '1',
          bnfEnsembleId: '43501234',
          authors: ['Arnaud Delalande', 'Simona Mogavino'],
          scriptwriters: ['Arnaud Delalande'],
          illustrators: ['Carlos Gómez'],
          publisher: 'Delcourt',
          rawSubjects: ['Bandes dessinées historiques']
        }
      },
      inventaireByIsbn: {
        '9782258031111': {
          source: 'inventaire',
          isbn13: '9782258031111',
          title: 'Pietr-le-Letton',
          seriesName: 'Maigret',
          seriesLinkKind: 'graph_p179',
          volumeNumber: '1',
          wikidataWorkQid: 'Q1199184',
          wikidataSeriesQid: 'Q1140219',
          authors: ['Georges Simenon'],
          scriptwriters: [],
          illustrators: [],
          rawSubjects: []
        }
      },
      bnfSamples: {
        totem: [
          { title: 'Betty', authors: ['Tiffany McDaniel'], volumeNumber: '42' },
          { title: 'Sukkwann Island', authors: ['David Vann'], volumeNumber: '12' },
          { title: 'My Absolute Darling', authors: ['Gabriel Tallent'], volumeNumber: '55' },
          { title: 'L’Homme qui aimait les chiens', authors: ['Edward Abbey'], volumeNumber: '18' },
          { title: 'Un endroit où aller', authors: ['Robert Penn Warren'], volumeNumber: '29' },
          { title: 'Le Gang de la clef à molette', authors: ['Pete Fromm'], volumeNumber: '33' }
        ]
      }
    });

    const comparison = new ComparisonTableService({
      connectors,
      collectionGuard: new CollectionGuardService({ bnf: connectors.bnf })
    });

    // Totem -> rejeté en collection éditoriale, One-shot
    const totem = await comparison.collectAndArbitrate('9782351785423');
    expect(totem).not.toBeNull();
    expect(totem!.seriesName).toBeNull();
    expect(totem!.volumeNumber).toBeNull();
    expect(totem!.collectionName).toBe('Totem');
    expect(totem!.seriesGuardVerdict?.reason).toBe('author_heterogeneity_editorial_collection');

    // Folio #7304 -> rejeté en collection éditoriale
    const folio = await comparison.collectAndArbitrate('9782073041234');
    expect(folio).not.toBeNull();
    expect(folio!.seriesName).toBeNull();
    expect(folio!.collectionName).toBe('Folio');

    // Tout Simenon -> démasqué, la vraie série Maigret (P179) gagne !
    const simenon = await comparison.collectAndArbitrate('9782258031111');
    expect(simenon).not.toBeNull();
    expect(simenon!.seriesName).toBe('Maigret');
    expect(simenon!.collectionName).toBe('Tout Simenon');

    // Les Reines de sang (anthologie ancrée 460) -> conservée en vraie série !
    const reines = await comparison.collectAndArbitrate('9782756051234');
    expect(reines).not.toBeNull();
    expect(reines!.seriesName).toBe('Les Reines de sang');
    expect(reines!.volumeNumber).toBe(1);
    expect(reines!.seriesGuardVerdict?.verdict).toBe('series');
  });

  it('fusionne Astérix + Astérix la grande collection en 1 découpage, et sépare Fables classique vs Fables Nomad en 2 découpages de la même Franchise', async () => {
    const connectors = createMockConnectors({
      bnfByIsbn: {
        // Astérix T21 édition standard
        '9782012101531': {
          source: 'bnf',
          isbn13: '9782012101531',
          title: 'Le Cadeau de César',
          seriesName: 'Astérix',
          seriesLinkKind: 'marc_ensemble_460',
          volumeNumber: '21',
          collectionName: 'Astérix',
          authors: ['René Goscinny', 'Albert Uderzo'],
          scriptwriters: ['René Goscinny'],
          illustrators: ['Albert Uderzo'],
          publisher: 'Hachette',
          pageCount: 48,
          rawSubjects: ['Bandes dessinées']
        },
        // Astérix T21 "la grande collection" -> même contenu (Le Cadeau de César, 48 p.)
        '9782864972532': {
          source: 'bnf',
          isbn13: '9782864972532',
          title: 'Le Cadeau de César',
          seriesName: 'Astérix, la grande collection',
          seriesLinkKind: 'marc_ensemble_460',
          volumeNumber: '21',
          collectionName: 'La Grande Collection',
          authors: ['René Goscinny', 'Albert Uderzo'],
          scriptwriters: ['René Goscinny'],
          illustrators: ['Albert Uderzo'],
          publisher: 'Albert René',
          pageCount: 48,
          rawSubjects: ['Bandes dessinées']
        },
        // Fables T4 édition classique (22 tomes, ~216 p.)
        '9782365770453': {
          source: 'bnf',
          isbn13: '9782365770453',
          title: 'La Marche des soldats de bois',
          seriesName: 'Fables',
          seriesLinkKind: 'marc_ensemble_460',
          volumeNumber: '4',
          collectionName: 'Vertigo Classiques',
          authors: ['Bill Willingham'],
          scriptwriters: ['Bill Willingham'],
          illustrators: ['Mark Buckingham'],
          publisher: 'Urban Comics',
          pageCount: 216,
          rawSubjects: ['Comics']
        },
        // Fables T4 édition Urban Nomad (10 tomes, ~440 p., titre différent !)
        '9791026825555': {
          source: 'bnf',
          isbn13: '9791026825555',
          title: 'Les Mille et Une Nuits',
          seriesName: 'Fables',
          seriesLinkKind: 'marc_ensemble_460',
          volumeNumber: '4',
          collectionName: 'Urban Nomad',
          authors: ['Bill Willingham'],
          scriptwriters: ['Bill Willingham'],
          illustrators: ['Mark Buckingham'],
          publisher: 'Urban Comics',
          pageCount: 440,
          rawSubjects: ['Comics']
        },
        // Fables T5 édition Urban Nomad -> doit rejoindre le découpage Urban Nomad
        '9791026825562': {
          source: 'bnf',
          isbn13: '9791026825562',
          title: 'Homelands',
          seriesName: 'Fables',
          seriesLinkKind: 'marc_ensemble_460',
          volumeNumber: '5',
          collectionName: 'Urban Nomad',
          authors: ['Bill Willingham'],
          scriptwriters: ['Bill Willingham'],
          illustrators: ['Mark Buckingham'],
          publisher: 'Urban Comics',
          pageCount: 432,
          rawSubjects: ['Comics']
        }
      }
    });

    const comparisonService = new ComparisonTableService({ connectors });
    const seriesGraphService = new SeriesGraphService({ catalogRepo, connectors, coverService });
    const ingestion = new IngestionService({
      catalogRepo,
      libraryRepo,
      jobRepo,
      logRepo,
      comparisonService,
      seriesGraphService,
      coverService
    });

    // 1. Astérix : 2 éditions du T21 -> 1 seule série (1 seul découpage) et 1 seule œuvre avec 2 ISBNs
    const astRes = await ingestion.resolveIsbns({
      rawIsbns: ['9782012101531', '9782864972532'],
      channel: 'barcode_simple',
      action: 'owned',
      userId,
      libraryId
    });
    expect(astRes.results[0].book?.seriesId).toBeTruthy();
    expect(astRes.results[1].book?.seriesId).toBe(astRes.results[0].book?.seriesId);
    expect(astRes.results[1].book?.id).toBe(astRes.results[0].book?.id);
    expect(astRes.results[1].book?.knownIsbns).toHaveLength(2);

    const asterixFranchise = catalogRepo.findFranchiseByNormalizedKey('asterix');
    expect(asterixFranchise).not.toBeNull();
    expect(catalogRepo.findSeriesByFranchiseId(asterixFranchise!.id)).toHaveLength(1);

    // 2. Fables : T4 Classique + T4 Urban Nomad + T5 Urban Nomad -> 1 Franchise, 2 découpages distincts !
    const fabRes = await ingestion.resolveIsbns({
      rawIsbns: ['9782365770453', '9791026825555', '9791026825562'],
      channel: 'barcode_simple',
      action: 'owned',
      userId,
      libraryId
    });
    const t4Classic = fabRes.results[0].book!;
    const t4Nomad = fabRes.results[1].book!;
    const t5Nomad = fabRes.results[2].book!;

    expect(t4Classic.franchiseId).toBeTruthy();
    expect(t4Nomad.franchiseId).toBe(t4Classic.franchiseId);
    expect(t4Nomad.seriesId).not.toBe(t4Classic.seriesId);
    expect(t5Nomad.seriesId).toBe(t4Nomad.seriesId);

    const fablesCuts = catalogRepo.findSeriesByFranchiseId(t4Classic.franchiseId!);
    expect(fablesCuts).toHaveLength(2);
  });

  it('étend une série multi-auteurs (Spirou) par le graphe Wikidata/Inventaire d’abord, créant les tomes officiels même avant ISBN FR', async () => {
    const connectors = createMockConnectors({
      wikidataSeries: {
        Q143456: [
          {
            title: 'Quatre aventures de Spirou et Fantasio',
            volumeNumber: 1,
            volumeLabel: '1',
            wikidataQid: 'Q3413711',
            authors: ['André Franquin'],
            isbn13s: [],
            publishYear: '1950',
            source: 'wikidata'
          },
          {
            title: 'Le Faiseur d’or',
            volumeNumber: 20,
            volumeLabel: '20',
            wikidataQid: 'Q3222749',
            authors: ['Jean-Claude Fournier'],
            isbn13s: [],
            publishYear: '1970',
            source: 'wikidata'
          },
          {
            title: 'Virus',
            volumeNumber: 33,
            volumeLabel: '33',
            wikidataQid: 'Q3560918',
            authors: ['Tome', 'Janry'],
            isbn13s: [],
            publishYear: '1984',
            source: 'wikidata'
          }
        ]
      },
      inventaireSeries: {
        'wd:Q143456': [
          {
            title: 'Virus',
            volumeNumber: 33,
            volumeLabel: '33',
            wikidataQid: 'Q3560918',
            inventaireUri: 'wd:Q3560918',
            authors: ['Tome', 'Janry'],
            isbn13s: ['9782800110219'],
            source: 'inventaire'
          }
        ]
      }
    });

    const seriesGraph = new SeriesGraphService({ catalogRepo, connectors, coverService });
    const { series } = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'Spirou et Fantasio',
      wikidataSeriesQid: 'Q143456',
      bookTitle: 'Quatre aventures de Spirou et Fantasio',
      volumeNumber: 1,
      isHorsSerie: false,
      isIntegral: false,
      authors: ['André Franquin']
    });

    const report = await seriesGraph.expandSeriesByGraph(series.id);
    expect(report.sourcesUsed).toContain('wikidata');
    expect(report.sourcesUsed).toContain('inventaire');
    expect(report.addedCount).toBe(3);
    expect(report.totalVolumes).toBe(3);

    const books = catalogRepo.listBooksBySeriesId(series.id);
    expect(books.map((b) => b.title)).toEqual([
      'Quatre aventures de Spirou et Fantasio',
      'Le Faiseur d’or',
      'Virus'
    ]);

    // T1 et T20 existent dans le catalogue même avant d'avoir un ISBN FR ; T33 a son ISBN FR indexé O(1)
    expect(catalogRepo.listEditionsByBookId(books[0].id)).toHaveLength(0);
    expect(catalogRepo.findBookByIsbn13('9782800110219')?.id).toBe(books[2].id);
  });

  it('garantit la primauté absolue : un champ verrouillé en Couche 2 (Admin) ou Couche 3 (Foyer) n’est jamais écrasé par un ré-enrichissement', async () => {
    let robotTitle = 'Titre Robot v1';
    let robotPublisher = 'Éditeur Robot v1';

    const connectors = createMockConnectors({
      bnfByIsbn: {
        '9782205000016': {
          source: 'bnf',
          isbn13: '9782205000016',
          get title() {
            return robotTitle;
          },
          get publisher() {
            return robotPublisher;
          },
          authors: ['Auteur Test'],
          scriptwriters: [],
          illustrators: [],
          rawSubjects: ['Bandes dessinées']
        }
      }
    });

    const comparisonService = new ComparisonTableService({ connectors });
    const seriesGraphService = new SeriesGraphService({ catalogRepo, connectors, coverService });
    const ingestion = new IngestionService({
      catalogRepo,
      libraryRepo,
      jobRepo,
      logRepo,
      comparisonService,
      seriesGraphService,
      coverService
    });

    // 1. Ingestion initiale (Couche 1 Robot)
    const first = await ingestion.resolveIsbns({
      rawIsbns: ['9782205000016'],
      channel: 'barcode_simple',
      action: 'owned',
      userId,
      libraryId
    });
    const bookId = first.results[0].book!.id;
    expect(first.results[0].book!.title).toBe('Titre Robot v1');

    // 2. Verrou Couche 2 (Admin) sur `publisher`
    const now = new Date().toISOString();
    db.run('UPDATE books SET publisher = ? WHERE id = ?', ['Éditeur Corrigé Admin', bookId]);
    catalogRepo.setBookLockedFields(bookId, ['publisher'], now);

    // 3. Surcharge Couche 3 (Foyer) sur `title` et `oneShotForced`
    libraryRepo.setLibraryBookOverrides(
      libraryId,
      bookId,
      { title: 'Mon Titre Perso Foyer', oneShotForced: true },
      now
    );

    // 4. Ré-enrichissement forcé avec de nouvelles données robots
    robotTitle = 'Titre Robot v2 Modifié';
    robotPublisher = 'Éditeur Robot v2 Modifié';

    const refreshed = await ingestion.resolveIsbns({
      rawIsbns: ['9782205000016'],
      channel: 'manual_isbn',
      action: 'owned',
      userId,
      libraryId,
      forceRefresh: true
    });

    const dbBook = catalogRepo.findBookById(bookId)!;
    // Couche 2 : `publisher` verrouillé -> protégé contre le robot !
    expect(dbBook.publisher).toBe('Éditeur Corrigé Admin');
    // Champ non verrouillé en Couche 2 (`title`) -> mis à jour au Catalogue Central...
    expect(dbBook.title).toBe('Titre Robot v2 Modifié');
    // ...MAIS Couche 3 Foyer prime à l'affichage et n'est JAMAIS écrasée !
    expect(refreshed.results[0].book!.title).toBe('Mon Titre Perso Foyer');
    expect(refreshed.results[0].book!.publisher).toBe('Éditeur Corrigé Admin');
    expect(refreshed.results[0].book!.hasUserOverrides).toBe(true);
  });
});
