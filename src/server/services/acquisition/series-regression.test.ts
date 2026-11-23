// src/server/services/acquisition/series-regression.test.ts
// Suite permanente de tests de non-régression couvrant les invariants universels Étage 2 & Étage 3 :
//   1. Non-collision sur titres génériques ("Bug" T.1..T.4 -> jamais fusionnés sur T.4, titres distinctifs conservés)
//   2. Confrontation Œuvre vs Édition collector ("Tintin au Congo" Les archives Tintin -> Les Aventures de Tintin T.2, sans fuite d'ensemble BnF)
//   3. Complétion non destructive des numéros de tome ("Mortelle Adèle" Wikidata sans P1545 + BnF 460$v)
//   4. Rejet strict des logos .svg et préférence des vraies couvertures ("Astérix")
//   5. Triple verrou Wikidata Titre+Auteur : zéro faux positif sur titres courts/génériques ou mauvais auteur/sans P179.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteDatabaseAdapter } from '../../db/sqlite.adapter';
import { applySqlMigrations } from '../../db/migrator';
import { CatalogRepository } from '../../repositories/catalog.repo';
import { LibraryRepository } from '../../repositories/library.repo';
import { JobRepository } from '../../repositories/job.repo';
import { LogRepository } from '../../repositories/log.repo';
import { UserRepository } from '../../repositories/user.repo';
import { CoverService } from '../cover.service';
import { ComparisonTableService } from './comparison-table.service';
import { SeriesGraphService } from './series-graph.service';
import { IngestionService } from './ingestion.service';
import { createWikidataConnector } from '../../connectors/wikidata.connector';
import type { HttpClient } from '../../connectors/http-client';
import type {
  BibliographicConnectors,
  BnfSeriesDiscoveryResult,
  GraphSeriesWork,
  SourceCandidateRecord
} from '../../connectors/types';
import { isCompatibleSeriesName } from '../../../shared/bibliographic/text-normalize.util';

function createMockConnectors(overrides?: {
  bnfByIsbn?: Record<string, SourceCandidateRecord>;
  bnfEnsemble?: Record<string, GraphSeriesWork[]>;
  bnfBySeriesName?: Record<string, BnfSeriesDiscoveryResult>;
  inventaireByIsbn?: Record<string, SourceCandidateRecord>;
  inventaireSeries?: Record<string, GraphSeriesWork[]>;
  wikidataByQid?: Record<string, SourceCandidateRecord>;
  wikidataByTitleAuthor?: (title: string, author: string, isbn13?: string) => Promise<SourceCandidateRecord | null>;
  wikidataSeries?: Record<string, GraphSeriesWork[]>;
}): BibliographicConnectors {
  return {
    bnf: {
      async lookupByIsbn(isbn13) {
        return overrides?.bnfByIsbn?.[isbn13] ?? null;
      },
      async searchByEnsembleId(ensId) {
        return overrides?.bnfEnsemble?.[ensId] ?? [];
      },
      async searchBySeriesName(seriesName) {
        return overrides?.bnfBySeriesName?.[seriesName.toLowerCase()] ?? { works: [], discoveredEnsembleIds: [] };
      },
      async sampleByCollectionName() {
        return [];
      },
      async searchByTitleAndAuthor() {
        return [];
      }
    },
    sudoc: {
      async lookupByIsbn() {
        return null;
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
      async lookupWorkByTitleAndAuthor(title, author, isbn13) {
        return overrides?.wikidataByTitleAuthor ? overrides.wikidataByTitleAuthor(title, author, isbn13) : null;
      },
      async fetchSeriesWorksByQid(qid) {
        return overrides?.wikidataSeries?.[qid] ?? [];
      }
    },
    googleBooks: {
      async lookupByIsbn() {
        return null;
      }
    },
    openLibrary: {
      async lookupByIsbn() {
        return null;
      }
    }
  };
}

describe('Non-régression Séries & Étage 2/3 (Invariants universels)', () => {
  let db: SqliteDatabaseAdapter;
  let tmpCoversDir: string;
  let catalogRepo: CatalogRepository;
  let libraryRepo: LibraryRepository;
  let jobRepo: JobRepository;
  let logRepo: LogRepository;
  let userRepo: UserRepository;
  let coverService: CoverService;

  const userId = 'usr_reg_1';
  const libraryId = 'lib_reg_1';

  beforeEach(() => {
    db = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(db, path.resolve(process.cwd(), 'migrations'));
    tmpCoversDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblio-reg-covers-'));

    catalogRepo = new CatalogRepository(db);
    libraryRepo = new LibraryRepository(db);
    jobRepo = new JobRepository(db);
    logRepo = new LogRepository(db);
    userRepo = new UserRepository(db);
    coverService = new CoverService({ coversDir: tmpCoversDir, catalogRepo, libraryRepo });

    const now = new Date().toISOString();
    userRepo.createUser({
      id: userId,
      username: 'RegTester',
      email: 'reg@test.local',
      passwordHash: 'scrypt:a:b',
      isAdmin: false,
      gdprAcceptedAt: now,
      now
    });
    libraryRepo.createLibrary({
      id: libraryId,
      name: 'Foyer Test',
      ownerUserId: userId,
      familyInviteCode: 'FAM-REGTEST',
      friendShareToken: 'PUB-REGTEST',
      now
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpCoversDir, { recursive: true, force: true });
  });

  it('Cas 1 (Bug — Enki Bilal) : 4 tomes distincts ne collisionnent jamais dans le T.4 et conservent leurs titres distinctifs', async () => {
    const connectors = createMockConnectors({
      bnfByIsbn: {
        '9782203273450': {
          source: 'bnf',
          isbn13: '9782203273450',
          title: 'Bug',
          seriesName: 'Bug',
          seriesLinkKind: 'marc_ensemble_460',
          bnfEnsembleId: '45384111',
          volumeNumber: '4',
          authors: ['Enki Bilal'],
          scriptwriters: [],
          illustrators: [],
          publisher: 'Casterman',
          publishYear: '2026',
          pageCount: 88,
          rawSubjects: ['Bandes dessinées']
        }
      },
      wikidataSeries: {
        Q55599901: [
          { title: 'Bug, Livre 1', volumeNumber: 1, volumeLabel: '1', sortOrder: 1, wikidataQid: 'Q1001', authors: ['Enki Bilal'], isbn13s: [], source: 'wikidata' },
          { title: 'Bug, Livre 2', volumeNumber: 2, volumeLabel: '2', sortOrder: 2, wikidataQid: 'Q1002', authors: ['Enki Bilal'], isbn13s: [], source: 'wikidata' },
          { title: 'Bug, Livre 3', volumeNumber: 3, volumeLabel: '3', sortOrder: 3, wikidataQid: 'Q1003', authors: ['Enki Bilal'], isbn13s: [], source: 'wikidata' },
          { title: 'Bug, Livre 4', volumeNumber: 4, volumeLabel: '4', sortOrder: 4, wikidataQid: 'Q1004', authors: ['Enki Bilal'], isbn13s: [], source: 'wikidata' }
        ]
      },
      bnfEnsemble: {
        '45384111': [
          { title: 'Bug', volumeNumber: 1, volumeLabel: '1', sortOrder: 1, authors: ['Enki Bilal'], isbn13s: ['9782203105782'], publisher: 'Casterman', publishYear: '2017', source: 'bnf' },
          { title: 'Bug', volumeNumber: 2, volumeLabel: '2', sortOrder: 2, authors: ['Enki Bilal'], isbn13s: ['9782203163614'], publisher: 'Casterman', publishYear: '2019', source: 'bnf' },
          { title: 'Bug', volumeNumber: 3, volumeLabel: '3', sortOrder: 3, authors: ['Enki Bilal'], isbn13s: ['9782203202283'], publisher: 'Casterman', publishYear: '2022', source: 'bnf' },
          { title: 'Bug', volumeNumber: 4, volumeLabel: '4', sortOrder: 4, authors: ['Enki Bilal'], isbn13s: ['9782203273450'], publisher: 'Casterman', publishYear: '2026', source: 'bnf' }
        ]
      }
    });

    const seriesGraph = new SeriesGraphService({ catalogRepo, connectors });
    const ingestion = new IngestionService({
      catalogRepo,
      libraryRepo,
      jobRepo,
      logRepo,
      comparisonService: new ComparisonTableService({ connectors }),
      seriesGraphService: seriesGraph,
      coverService
    });

    const ingested = await ingestion.resolveIsbns({
      rawIsbns: ['9782203273450'],
      libraryId,
      userId,
      channel: 'barcode_simple',
      action: 'owned'
    });
    const seriesId = ingested.results[0].book?.seriesId;
    expect(seriesId).toBeTruthy();

    // Attacher le Q-ID Wikidata de la série puis lancer l'expansion complète (Wikidata + BnF)
    catalogRepo.mergeSeriesMetadataAutomatic(seriesId!, {
      wikidataQid: 'Q55599901',
      now: new Date().toISOString()
    });
    const report = await seriesGraph.expandSeriesByGraph(seriesId!);
    expect(report.totalVolumes).toBe(4);

    const books = catalogRepo.listBooksBySeriesId(seriesId!);
    expect(books).toHaveLength(4);
    expect(books.map((b) => b.volume_number)).toEqual([1, 2, 3, 4]);
    expect(books.map((b) => b.title)).toEqual(['Bug, Livre 1', 'Bug, Livre 2', 'Bug, Livre 3', 'Bug, Livre 4']);

    // Vérifier que chaque ISBN pointe bien vers son propre tome (aucune collision sur T.4)
    expect(catalogRepo.findBookByIsbn13('9782203105782')?.volume_number).toBe(1);
    expect(catalogRepo.findBookByIsbn13('9782203163614')?.volume_number).toBe(2);
    expect(catalogRepo.findBookByIsbn13('9782203202283')?.volume_number).toBe(3);
    expect(catalogRepo.findBookByIsbn13('9782203273450')?.volume_number).toBe(4);
  });

  it('Cas 1b (Bug sans Wikidata) : même si seule la BnF retourne 4 tomes tous titrés "Bug", ils restent 4 livres distincts', async () => {
    const connectors = createMockConnectors({
      bnfByIsbn: {
        '9782203273450': {
          source: 'bnf',
          isbn13: '9782203273450',
          title: 'Bug',
          seriesName: 'Bug',
          seriesLinkKind: 'marc_ensemble_460',
          bnfEnsembleId: '45384111',
          volumeNumber: '4',
          authors: ['Enki Bilal'],
          scriptwriters: [],
          illustrators: [],
          rawSubjects: []
        }
      },
      bnfEnsemble: {
        '45384111': [
          { title: 'Bug', volumeNumber: 1, volumeLabel: '1', sortOrder: 1, authors: ['Enki Bilal'], isbn13s: ['9782203105782'], source: 'bnf' },
          { title: 'Bug', volumeNumber: 2, volumeLabel: '2', sortOrder: 2, authors: ['Enki Bilal'], isbn13s: ['9782203163614'], source: 'bnf' },
          { title: 'Bug', volumeNumber: 3, volumeLabel: '3', sortOrder: 3, authors: ['Enki Bilal'], isbn13s: ['9782203202283'], source: 'bnf' },
          { title: 'Bug', volumeNumber: 4, volumeLabel: '4', sortOrder: 4, authors: ['Enki Bilal'], isbn13s: ['9782203273450'], source: 'bnf' }
        ]
      }
    });

    const seriesGraph = new SeriesGraphService({ catalogRepo, connectors });
    const ingestion = new IngestionService({
      catalogRepo,
      libraryRepo,
      jobRepo,
      logRepo,
      comparisonService: new ComparisonTableService({ connectors }),
      seriesGraphService: seriesGraph,
      coverService
    });

    const ingested = await ingestion.resolveIsbns({
      rawIsbns: ['9782203273450'],
      libraryId,
      userId,
      channel: 'barcode_simple',
      action: 'owned'
    });
    const seriesId = ingested.results[0].book!.seriesId!;
    await seriesGraph.expandSeriesByGraph(seriesId);

    const books = catalogRepo.listBooksBySeriesId(seriesId);
    expect(books).toHaveLength(4);
    expect(books.map((b) => b.volume_number)).toEqual([1, 2, 3, 4]);
  });

  it('Cas 2 (Tintin au Congo — édition Les archives Tintin 9782874242281) : résout Les Aventures de Tintin T.2 sans fuite de bnfEnsembleId 43615215', async () => {
    const connectors = createMockConnectors({
      bnfByIsbn: {
        '9782874242281': {
          source: 'bnf',
          isbn13: '9782874242281',
          title: 'Tintin au Congo',
          seriesName: 'Les archives Tintin',
          seriesLinkKind: 'marc_ensemble_460',
          bnfEnsembleId: '43615215',
          authors: ['Hergé'],
          scriptwriters: [],
          illustrators: [],
          publisher: 'Éd. Moulinsart',
          publishYear: '2010',
          pageCount: 120,
          rawSubjects: ['Bandes dessinées']
        }
      },
      wikidataByTitleAuthor: async (title, author, isbn13) => {
        if (title === 'Tintin au Congo' && author === 'Hergé') {
          return {
            source: 'wikidata',
            isbn13: isbn13 ?? '',
            title: 'Tintin au Congo',
            seriesName: 'Les Aventures de Tintin',
            seriesLinkKind: 'graph_p179',
            volumeNumber: '2',
            wikidataSeriesQid: 'Q744536',
            wikidataWorkQid: 'Q636870',
            authors: ['Hergé'],
            scriptwriters: [],
            illustrators: [],
            rawSubjects: []
          };
        }
        return null;
      },
      wikidataSeries: {
        Q744536: [
          { title: 'Tintin au pays des Soviets', volumeNumber: 1, volumeLabel: '1', sortOrder: 1, wikidataQid: 'Q10001', authors: ['Hergé'], isbn13s: ['9782203001008'], source: 'wikidata' },
          { title: 'Tintin au Congo', volumeNumber: 2, volumeLabel: '2', sortOrder: 2, wikidataQid: 'Q636870', authors: ['Hergé'], isbn13s: ['9782203001015'], source: 'wikidata' },
          { title: 'Tintin en Amérique', volumeNumber: 3, volumeLabel: '3', sortOrder: 3, wikidataQid: 'Q10003', authors: ['Hergé'], isbn13s: ['9782203001022'], source: 'wikidata' }
        ]
      },
      bnfEnsemble: {
        // Ne doit JAMAIS être appelé pour Les Aventures de Tintin !
        '43615215': [
          { title: 'Les exploits de Quick et Flupke', volumeNumber: 1, authors: ['Hergé'], isbn13s: ['9782874249999'], source: 'bnf' }
        ]
      }
    });

    const comparison = new ComparisonTableService({ connectors });
    const draft = await comparison.collectAndArbitrate('9782874242281');

    expect(draft).not.toBeNull();
    expect(draft!.seriesName).toBe('Les Aventures de Tintin');
    expect(draft!.seriesLinkKind).toBe('graph_p179');
    expect(draft!.volumeNumber).toBe(2);
    expect(draft!.wikidataSeriesQid).toBe('Q744536');
    // Critique : l'ensemble BnF "Les archives Tintin" NE DOIT PAS fuiter sur "Les Aventures de Tintin"
    expect(draft!.bnfEnsembleId).toBeNull();
    // Et "Les archives Tintin" est préservé proprement comme collection éditoriale de cette édition
    expect(draft!.collectionName).toBe('Les archives Tintin');

    // Vérification bout-en-bout jusqu'à l'expansion de série
    const seriesGraph = new SeriesGraphService({ catalogRepo, connectors });
    const ingestion = new IngestionService({
      catalogRepo,
      libraryRepo,
      jobRepo,
      logRepo,
      comparisonService: comparison,
      seriesGraphService: seriesGraph,
      coverService
    });

    const ingested = await ingestion.resolveIsbns({
      rawIsbns: ['9782874242281'],
      libraryId,
      userId,
      channel: 'barcode_simple',
      action: 'owned'
    });
    const seriesId = ingested.results[0].book!.seriesId!;
    await seriesGraph.expandSeriesByGraph(seriesId);

    const books = catalogRepo.listBooksBySeriesId(seriesId);
    expect(books.map((b) => b.title)).toEqual([
      'Tintin au pays des Soviets',
      'Tintin au Congo',
      'Tintin en Amérique'
    ]);
    expect(books.map((b) => b.volume_number)).toEqual([1, 2, 3]);
    expect(books.some((b) => /Quick et Flupke/i.test(b.title))).toBe(false);
  });

  it('Cas 3 (Mortelle Adèle) : Wikidata sans P1545 complété proprement par les numéros de tome BnF 460$v', async () => {
    const connectors = createMockConnectors({
      bnfByIsbn: {
        '9782848018416': {
          source: 'bnf',
          isbn13: '9782848018416',
          title: 'Un talent de monstre !',
          seriesName: 'Mortelle Adèle',
          seriesLinkKind: 'marc_ensemble_460',
          bnfEnsembleId: '42617173',
          volumeNumber: '6',
          authors: ['Mr Tan', 'Miss Prickly'],
          scriptwriters: [],
          illustrators: [],
          rawSubjects: ['Bandes dessinées']
        }
      },
      wikidataSeries: {
        Q65154822: [
          { title: 'Tout ça finira mal', volumeNumber: null, volumeLabel: null, sortOrder: null, wikidataQid: 'Q65154830', authors: ['Mr Tan'], isbn13s: [], source: 'wikidata' },
          { title: 'Un talent de monstre !', volumeNumber: null, volumeLabel: null, sortOrder: null, wikidataQid: 'Q65154836', authors: ['Mr Tan'], isbn13s: [], source: 'wikidata' }
        ]
      },
      bnfEnsemble: {
        '42617173': [
          { title: 'Tout ça finira mal', volumeNumber: 1, volumeLabel: '1', sortOrder: 1, authors: ['Mr Tan'], isbn13s: ['9782848016863'], source: 'bnf' },
          { title: 'Un talent de monstre !', volumeNumber: 6, volumeLabel: '6', sortOrder: 6, authors: ['Mr Tan'], isbn13s: ['9782848018416'], source: 'bnf' }
        ]
      }
    });

    const seriesGraph = new SeriesGraphService({ catalogRepo, connectors });
    const ingestion = new IngestionService({
      catalogRepo,
      libraryRepo,
      jobRepo,
      logRepo,
      comparisonService: new ComparisonTableService({ connectors }),
      seriesGraphService: seriesGraph,
      coverService
    });

    const ingested = await ingestion.resolveIsbns({
      rawIsbns: ['9782848018416'],
      libraryId,
      userId,
      channel: 'barcode_simple',
      action: 'owned'
    });
    const seriesId = ingested.results[0].book!.seriesId!;
    catalogRepo.mergeSeriesMetadataAutomatic(seriesId, {
      wikidataQid: 'Q65154822',
      now: new Date().toISOString()
    });

    await seriesGraph.expandSeriesByGraph(seriesId);
    const books = catalogRepo.listBooksBySeriesId(seriesId);
    expect(books).toHaveLength(2);
    expect(books.map((b) => ({ title: b.title, vol: b.volume_number, sort: b.sort_order }))).toEqual([
      { title: 'Tout ça finira mal', vol: 1, sort: 1 },
      { title: 'Un talent de monstre !', vol: 6, sort: 6 }
    ]);
  });

  it('Cas 4 (Astérix — couvertures .svg rejetées) : ignore les logos .svg Wikimedia et conserve les vraies couvertures', async () => {
    const fetchMock = vi.spyOn(coverService, 'resolveBestCoverFromCascade').mockResolvedValue(null);

    const connectors = createMockConnectors({
      wikidataSeries: {
        Q42490: [
          {
            title: 'Astérix le Gaulois',
            volumeNumber: 1,
            volumeLabel: '1',
            sortOrder: 1,
            wikidataQid: 'Q501999',
            authors: ['René Goscinny', 'Albert Uderzo'],
            isbn13s: [],
            coverUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Asterix.svg?width=400',
            source: 'wikidata'
          }
        ]
      },
      bnfEnsemble: {
        '34294500': [
          {
            title: 'Astérix le Gaulois',
            volumeNumber: 1,
            volumeLabel: '1',
            sortOrder: 1,
            authors: ['René Goscinny', 'Albert Uderzo'],
            isbn13s: ['9782012101333'],
            coverUrl: 'https://catalogue.bnf.fr/couverture?appName=NE&idImage=12345',
            source: 'bnf'
          }
        ]
      }
    });

    const seriesGraph = new SeriesGraphService({ catalogRepo, connectors, coverService });
    const now = new Date().toISOString();
    const { series } = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: "Les Aventures d'Astérix",
      wikidataSeriesQid: 'Q42490',
      bnfEnsembleId: '34294500',
      bookTitle: 'Astérix le Gaulois',
      volumeNumber: 1,
      isHorsSerie: false,
      isIntegral: false,
      authors: ['René Goscinny', 'Albert Uderzo'],
      now
    });

    await seriesGraph.expandSeriesByGraph(series.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callArg = fetchMock.mock.calls[0][0];
    expect(callArg.candidateUrls).toEqual(['https://catalogue.bnf.fr/couverture?appName=NE&idImage=12345']);
    expect((callArg.candidateUrls ?? []).some((u) => /\.svg/i.test(u))).toBe(false);
  });

  it('Cas 5 (Triple verrou Wikidata Titre+Auteur) : rejette les titres courts/génériques, les mauvais auteurs et les œuvres sans P179', async () => {
    const mockHttp = {
      async fetchJson<T>(opts: { url: string }): Promise<T | null> {
        if (opts.url.includes('action=wbsearchentities')) {
          if (opts.url.includes('Tintin%20au%20Congo')) {
            return {
              search: [
                { id: 'Q636870', label: 'Tintin au Congo', description: 'album de bande dessinée' },
                { id: 'Q999999', label: 'Tintin au Congo', description: 'article homonyme sans série' }
              ]
            } as T;
          }
          if (opts.url.includes('Papa')) {
            return {
              search: [{ id: 'Q888888', label: 'Papa', description: 'roman isolé' }]
            } as T;
          }
          return { search: [] } as T;
        }
        if (opts.url.includes('action=wbgetentities')) {
          if (opts.url.includes('Q636870')) {
            return {
              entities: {
                Q636870: {
                  id: 'Q636870',
                  labels: { fr: { value: 'Tintin au Congo' } },
                  claims: {
                    P179: [{ mainsnak: { datavalue: { value: { id: 'Q744536' } } }, qualifiers: { P1545: [{ datavalue: { value: '2' } }] } }],
                    P50: [{ mainsnak: { datavalue: { value: { id: 'Q52985' } } } }]
                  }
                },
                Q999999: {
                  id: 'Q999999',
                  labels: { fr: { value: 'Tintin au Congo' } },
                  claims: {
                    // Pas de P179 !
                    P50: [{ mainsnak: { datavalue: { value: { id: 'Q52985' } } } }]
                  }
                }
              }
            } as T;
          }
          if (opts.url.includes('Q888888')) {
            return {
              entities: {
                Q888888: {
                  id: 'Q888888',
                  labels: { fr: { value: 'Papa' } },
                  claims: {
                    // Pas de P179 !
                    P50: [{ mainsnak: { datavalue: { value: { id: 'Q777777' } } } }]
                  }
                }
              }
            } as T;
          }
          if (opts.url.includes('Q744536') || opts.url.includes('Q52985')) {
            return {
              entities: {
                Q744536: { id: 'Q744536', labels: { fr: { value: 'Les Aventures de Tintin' } } },
                Q52985: { id: 'Q52985', labels: { fr: { value: 'Hergé' } } }
              }
            } as T;
          }
        }
        return null;
      },
      async fetchText() {
        return null;
      }
    };

    const wd = createWikidataConnector(mockHttp as unknown as HttpClient);

    // 1. Titre court (< 4 car.) -> bloqué avant tout appel réseau
    expect(await wd.lookupWorkByTitleAndAuthor!('Bug', 'Enki Bilal')).toBeNull();

    // 2. Œuvre sans P179 ("Papa") -> rejetée par Verrou 2
    expect(await wd.lookupWorkByTitleAndAuthor!('Papa', 'Régis Loisel')).toBeNull();

    // 3. Mauvais auteur pour "Tintin au Congo" -> rejeté par Verrou 3
    expect(await wd.lookupWorkByTitleAndAuthor!('Tintin au Congo', 'Enki Bilal')).toBeNull();

    // 4. Titre exact + P179 présent + auteur exact ("Hergé") -> accepté !
    const valid = await wd.lookupWorkByTitleAndAuthor!('Tintin au Congo', 'Hergé', '9782874242281');
    expect(valid).not.toBeNull();
    expect(valid!.seriesName).toBe('Les Aventures de Tintin');
    expect(valid!.volumeNumber).toBe('2');
    expect(valid!.wikidataSeriesQid).toBe('Q744536');
    expect(valid!.wikidataWorkQid).toBe('Q636870');
  });

  it('Cas 6 (Compatibilité structurelle des noms de séries) : distingue collection éditoriale vs tronc de franchise', () => {
    expect(isCompatibleSeriesName('Les archives Tintin', 'Les Aventures de Tintin')).toBe(false);
    expect(isCompatibleSeriesName('Le secret de Tintin', 'Tintin')).toBe(false);
    expect(isCompatibleSeriesName('Astérix', "Les Aventures d'Astérix")).toBe(true);
    expect(isCompatibleSeriesName('Astérix, la grande collection', "Les Aventures d'Astérix")).toBe(true);
    expect(isCompatibleSeriesName('Mortelle Adèle', 'Mortelle Adèle')).toBe(true);
    expect(isCompatibleSeriesName('Folio', 'Les Misérables')).toBe(false);
  });
});
