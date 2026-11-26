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
import { parseMarcRecord } from '../../../shared/bibliographic/intermarc-parser';
import { isCompatibleSeriesName, matchesAuthorName } from '../../../shared/bibliographic/text-normalize.util';

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

  it('Cas 7 (Auteurs avec accents & tirets) : retrouve Hergé et Jean-Pierre Gibrat en base locale SQLite', () => {
    const now = new Date().toISOString();
    catalogRepo.upsertBookAutomatic({
      id: 'bk_herge_1',
      workCanonicalId: 'wd:Q636870',
      seriesId: null,
      title: 'Tintin au Congo',
      normalizedTitle: 'tintin au congo',
      volumeNumber: 2,
      volumeLabel: '2',
      sortOrder: 2,
      isHorsSerie: false,
      isIntegral: false,
      includedVolumes: [],
      authors: ['Hergé'],
      scriptwriters: [],
      illustrators: [],
      publisher: 'Casterman',
      collectionName: null,
      publishYear: '1931',
      pageCount: 62,
      description: null,
      language: 'fr',
      mainCategory: 'BD',
      subgenres: [],
      coverKey: null,
      wikidataQid: 'Q636870',
      inventaireUri: null,
      sourceOrigin: 'auto',
      now
    });
    catalogRepo.upsertBookAutomatic({
      id: 'bk_gibrat_1',
      workCanonicalId: 'ser:matteo:1',
      seriesId: null,
      title: 'Première époque (1914-1915)',
      normalizedTitle: 'premiere epoque 1914 1915',
      volumeNumber: 1,
      volumeLabel: '1',
      sortOrder: 1,
      isHorsSerie: false,
      isIntegral: false,
      includedVolumes: [],
      authors: ['Jean-Pierre Gibrat'],
      scriptwriters: [],
      illustrators: [],
      publisher: 'Futuropolis',
      collectionName: null,
      publishYear: '2008',
      pageCount: 64,
      description: null,
      language: 'fr',
      mainCategory: 'BD',
      subgenres: [],
      coverKey: null,
      wikidataQid: null,
      inventaireUri: null,
      sourceOrigin: 'auto',
      now
    });

    expect(matchesAuthorName('Hergé', 'herge')).toBe(true);
    expect(matchesAuthorName('Jean-Pierre Gibrat', 'Gibrat, Jean-Pierre')).toBe(true);

    const hergeRes = catalogRepo.searchLocalCatalog({ authorNorm: 'herge' });
    expect(hergeRes.books.map((b) => b.id)).toEqual(['bk_herge_1']);

    const gibratRes = catalogRepo.searchLocalCatalog({ authorNorm: 'jean pierre gibrat' });
    expect(gibratRes.books.map((b) => b.id)).toEqual(['bk_gibrat_1']);
  });

  it('Cas 8 (Anti-doublon Nom (Nom) & non-pollution BnF sur graphe Wikidata) : ignore collection identique à la série et notices étrangères/non numérotées', async () => {
    const connectors = createMockConnectors({
      wikidataSeries: {
        Q744536: [
          { title: 'Tintin au Congo', volumeNumber: 2, volumeLabel: '2', sortOrder: 2, wikidataQid: 'Q636870', authors: ['Hergé'], isbn13s: ['9782203001015'], source: 'wikidata' },
          { title: 'Tintin en Amérique', volumeNumber: 3, volumeLabel: '3', sortOrder: 3, wikidataQid: 'Q10003', authors: ['Hergé'], isbn13s: ['9782203001022'], source: 'wikidata' }
        ]
      },
      bnfEnsemble: {
        '9990001': [
          { title: 'Le singe', volumeNumber: null, authors: ['Hergé'], isbn13s: ['9782874240805'], language: 'fr', source: 'bnf' },
          { title: "La templo de l'suno", volumeNumber: 14, authors: ['Hergé'], isbn13s: ['9782203060678'], language: 'epo', source: 'bnf' },
          { title: 'Les Cigares du pharaon', volumeNumber: 4, volumeLabel: '4', sortOrder: 4, authors: ['Hergé'], isbn13s: ['9782203003064'], language: 'fr', source: 'bnf' }
        ]
      }
    });

    const seriesGraph = new SeriesGraphService({ catalogRepo, connectors });
    const now = new Date().toISOString();

    // 1. collectionName === seriesName ne doit JAMAIS créer un 2e découpage "De cape et de crocs (De cape et de crocs)"
    const firstCut = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'De cape et de crocs',
      bookTitle: 'Le secret du janissaire',
      volumeNumber: 1,
      isHorsSerie: false,
      isIntegral: false,
      collectionName: null,
      publisher: 'Delcourt',
      authors: ['Alain Ayroles', 'Jean-Luc Masbou'],
      now
    });
    const secondCut = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'De cape et de crocs',
      bookTitle: 'Pavillon noir !',
      volumeNumber: 2,
      isHorsSerie: false,
      isIntegral: false,
      collectionName: 'De cape et de crocs',
      publisher: 'Delcourt',
      authors: ['Alain Ayroles', 'Jean-Luc Masbou'],
      now
    });
    expect(secondCut.series.id).toBe(firstCut.series.id);

    // 2. Sur une série ancrée Wikidata, BnF enrichit les tomes FR numérotés sans ajouter espéranto ni imagiers non numérotés
    const { series: tintinSeries } = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'Les Aventures de Tintin',
      wikidataSeriesQid: 'Q744536',
      bnfEnsembleId: '9990001',
      bookTitle: 'Tintin au Congo',
      volumeNumber: 2,
      isHorsSerie: false,
      isIntegral: false,
      authors: ['Hergé'],
      now
    });
    await seriesGraph.expandSeriesByGraph(tintinSeries.id);
    const books = catalogRepo.listBooksBySeriesId(tintinSeries.id);
    expect(books.map((b) => b.title)).toEqual([
      'Tintin au Congo',
      'Tintin en Amérique',
      'Les Cigares du pharaon'
    ]);
  });

  it('Cas 9 (Priorité couvertures) : relègue commons.wikimedia.org après la cascade ISBN éditeur', async () => {
    const calledUrls: string[] = [];
    const customCoverService = new CoverService({
      coversDir: tmpCoversDir,
      catalogRepo,
      libraryRepo,
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        calledUrls.push(url);
        if (url.includes('images-eu.ssl-images-amazon.com')) {
          const sharp = (await import('sharp')).default;
          const buf = await sharp({
            create: {
              width: 240,
              height: 360,
              channels: 3,
              background: { r: 20, g: 80, b: 140 },
              noise: { type: 'gaussian', mean: 128, sigma: 40 }
            }
          })
            .png()
            .toBuffer();
          return new Response(new Uint8Array(buf), { status: 200, headers: { 'content-type': 'image/png' } });
        }
        return new Response('', { status: 404 });
      }) as typeof fetch
    });

    const stored = await customCoverService.resolveBestCoverFromCascade({
      isbn13: '9782203003057',
      candidateUrls: ['https://commons.wikimedia.org/wiki/Special:FilePath/Gare_Du_Midi.jpg?width=400'],
      skipTitleFallback: true
    });

    expect(stored).not.toBeNull();
    // La cascade Amazon ISBN doit avoir été testée et retenue AVANT Wikimedia Commons !
    expect(calledUrls.some((u) => u.includes('images-eu.ssl-images-amazon.com'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('commons.wikimedia.org'))).toBe(false);
  });

  it('Cas 10 (Duos d’auteurs multi-séparateurs) : matche Cuzor/Y.Sente, Fournier/Lax et Ayroles & Masbou sans rejeter les notices', () => {
    expect(matchesAuthorName('Steve Cuzor', 'Cuzor/Y.Sente')).toBe(true);
    expect(matchesAuthorName('Yves Sente', 'Cuzor/Y.Sente')).toBe(true);
    expect(matchesAuthorName('Jean-Claude Fournier', 'Fournier/Lax')).toBe(true);
    expect(matchesAuthorName('Christian Lax', 'Fournier/Lax')).toBe(true);
    expect(matchesAuthorName('Alain Ayroles', 'Ayroles & Masbou')).toBe(true);
    expect(matchesAuthorName('Jean-Luc Masbou', 'Ayroles & Masbou')).toBe(true);
    expect(matchesAuthorName('Hergé', 'Ayroles & Masbou')).toBe(false);
  });

  it('Cas 11 (Astérix Luxe 126 p. + Séparation média RDA 051 Nestor Burma BD vs Romans vs DVD) : évite les faux découpages et la pollution entre médias', async () => {
    const { parseMarcRecord } = await import('../../../shared/bibliographic/intermarc-parser');

    // 1. Parseur InterMarc ISO/RDA 051 : DVD M6 (tdi / Multimédia multisupport) -> isNonBook; BD (txt+sti) -> illustrated; Roman (txt seul) -> text_only
    const dvdXml = `
      <mxc:record>
        <mxc:datafield tag="038"><mxc:subfield code="a">3780284510996</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="051"><mxc:subfield code="a">txt</mxc:subfield><mxc:subfield code="a">tdi</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="245"><mxc:subfield code="a">Les cadavres de la plaine Monceau</mxc:subfield><mxc:subfield code="d">Multimédia multisupport</mxc:subfield></mxc:datafield>
      </mxc:record>`;
    expect(parseMarcRecord(dvdXml)?.isNonBook).toBe(true);

    const bdXml = `
      <mxc:record>
        <mxc:datafield tag="020"><mxc:subfield code="a">978-2-203-14964-9</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="051"><mxc:subfield code="a">txt</mxc:subfield><mxc:subfield code="a">sti</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="245"><mxc:subfield code="a">Le soleil naît derrière le Louvre</mxc:subfield></mxc:datafield>
      </mxc:record>`;
    expect(parseMarcRecord(bdXml)?.contentKind).toBe('illustrated');

    const romanXml = `
      <mxc:record>
        <mxc:datafield tag="020"><mxc:subfield code="a">978-2-221-10635-8</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="051"><mxc:subfield code="a">txt</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="245"><mxc:subfield code="a">Dernières enquêtes</mxc:subfield></mxc:datafield>
      </mxc:record>`;
    expect(parseMarcRecord(romanXml)?.contentKind).toBe('text_only');

    // 2. Astérix 48 p. + Astérix en Lusitanie Luxe 126 p. (vol: null, sans collection distincte) -> reste dans 1 seule série !
    const now = new Date().toISOString();
    const connectors = createMockConnectors({
      bnfBySeriesName: {
        'nestor burma': {
          discoveredEnsembleIds: ['34314610', '44273020'],
          works: [
            {
              title: 'Nestor Burma contre CQFD',
              volumeNumber: 2,
              bnfEnsembleId: '34314610',
              authors: ['Léo Malet'],
              isbn13s: ['9782285003211'],
              publisher: 'Presses de la Cité',
              pageCount: 219,
              contentKind: 'text_only',
              source: 'bnf'
            },
            {
              title: 'Boulevard ossements',
              volumeNumber: 8,
              bnfEnsembleId: '44273020',
              authors: ['Nicolas Barral', 'Léo Malet'],
              isbn13s: ['9782203163737'],
              publisher: 'Casterman',
              pageCount: 86,
              contentKind: 'illustrated',
              source: 'bnf'
            }
          ]
        }
      },
      bnfEnsemble: {
        '34314610': [
          {
            title: 'Le Cinquième procédé',
            volumeNumber: 5,
            bnfEnsembleId: '34314610',
            authors: ['Léo Malet'],
            isbn13s: ['9782285003372'],
            publisher: 'Presses de la Cité',
            pageCount: 217,
            contentKind: 'text_only',
            source: 'bnf'
          }
        ],
        '44273020': [
          {
            title: 'Boulevard ossements',
            volumeNumber: 8,
            bnfEnsembleId: '44273020',
            authors: ['Nicolas Barral', 'Léo Malet'],
            isbn13s: ['9782203163737'],
            publisher: 'Casterman',
            pageCount: 86,
            contentKind: 'illustrated',
            source: 'bnf'
          }
        ]
      }
    });

    const seriesGraph = new SeriesGraphService({ catalogRepo, connectors });
    const ast1 = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'Astérix',
      wikidataSeriesQid: 'Q42490',
      bookTitle: 'Astérix le Gaulois',
      volumeNumber: 1,
      isHorsSerie: false,
      isIntegral: false,
      pageCount: 48,
      publisher: 'Hachette',
      mainCategory: 'BD',
      authors: ['René Goscinny', 'Albert Uderzo'],
      now
    });
    catalogRepo.upsertBookAutomatic({
      id: 'bk_ast_1',
      workCanonicalId: 'wd:Q501999',
      seriesId: ast1.series.id,
      title: 'Astérix le Gaulois',
      normalizedTitle: 'asterix le gaulois',
      volumeNumber: 1,
      volumeLabel: '1',
      sortOrder: 1,
      isHorsSerie: false,
      isIntegral: false,
      includedVolumes: [],
      authors: ['René Goscinny', 'Albert Uderzo'],
      scriptwriters: [],
      illustrators: [],
      publisher: 'Hachette',
      collectionName: null,
      publishYear: '1961',
      pageCount: 48,
      description: null,
      language: 'fr',
      mainCategory: 'BD',
      subgenres: [],
      coverKey: null,
      wikidataQid: 'Q501999',
      inventaireUri: null,
      sourceOrigin: 'auto',
      now
    });

    const astLuxe = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'Astérix',
      bookTitle: 'Astérix en Lusitanie',
      volumeNumber: null,
      isHorsSerie: false,
      isIntegral: false,
      pageCount: 126,
      collectionName: null,
      publisher: 'Hachette livre',
      mainCategory: 'BD',
      authors: ['Fabcaro', 'Didier Conrad'],
      now
    });
    expect(astLuxe.series.id).toBe(ast1.series.id);

    // 3. Nestor Burma BD : l'expansion BnF rejette l'ensemble Roman (text_only) et ne conserve que les BD Casterman (illustrated)
    const burmaBd = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'Nestor Burma',
      bookTitle: 'Le soleil naît derrière le Louvre',
      volumeNumber: 6,
      isHorsSerie: false,
      isIntegral: false,
      pageCount: 69,
      publisher: 'Casterman',
      mainCategory: 'BD',
      authors: ['Emmanuel Moynot', 'Léo Malet'],
      now
    });
    catalogRepo.upsertBookAutomatic({
      id: 'bk_burma_bd_6',
      workCanonicalId: 'isbn:9782203149649',
      seriesId: burmaBd.series.id,
      title: 'Le soleil naît derrière le Louvre',
      normalizedTitle: 'le soleil nait derriere le louvre',
      volumeNumber: 6,
      volumeLabel: '6',
      sortOrder: 6,
      isHorsSerie: false,
      isIntegral: false,
      includedVolumes: [],
      authors: ['Emmanuel Moynot', 'Léo Malet'],
      scriptwriters: [],
      illustrators: ['Emmanuel Moynot'],
      publisher: 'Casterman',
      collectionName: null,
      publishYear: '2018',
      pageCount: 69,
      description: null,
      language: 'fr',
      mainCategory: 'BD',
      subgenres: [],
      coverKey: null,
      wikidataQid: null,
      inventaireUri: null,
      sourceOrigin: 'auto',
      now
    });

    await seriesGraph.expandSeriesByGraph(burmaBd.series.id);
    const expandedBurmaBooks = catalogRepo.listBooksBySeriesId(burmaBd.series.id);
    expect(expandedBurmaBooks.map((b) => b.title)).toContain('Boulevard ossements');
    expect(expandedBurmaBooks.some((b) => /CQFD|Cinquième procédé/i.test(b.title))).toBe(false);

    // 4. Nestor Burma Roman (Léo Malet) -> séparé proprement de la série BD dans la même Franchise !
    const burmaRoman = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'Les Aventures de Nestor Burma',
      bookTitle: 'Dernières enquêtes',
      volumeNumber: 4,
      isHorsSerie: false,
      isIntegral: false,
      pageCount: 888,
      publisher: 'R. Laffont',
      mainCategory: 'Roman',
      authors: ['Léo Malet'],
      now
    });
    expect(burmaRoman.franchise.id).toBe(burmaBd.franchise.id);
    expect(burmaRoman.series.id).not.toBe(burmaBd.series.id);
  });

  it('Cas 13 (Boule & Bill et Tintin décalé Casterman/Wikidata) : unifie "&"/"et" et empêche toute collision de numéro décalé', async () => {
    // 1. Unification "Boule & Bill" === "Boule et Bill"
    const { extractFranchiseBaseName } = await import('../../../shared/bibliographic/text-normalize.util');
    expect(extractFranchiseBaseName('Boule & Bill').normalizedKey).toBe(
      extractFranchiseBaseName('Boule et Bill').normalizedKey
    );

    // 2. Tintin : Wikidata numérote Soviets=#1, Congo=#2, Amérique=#3, Cigares=#4.
    // Une réédition Casterman sans QID numérote Congo=#1, Amérique=#2, Oreille cassée=#4 :
    // elle ne doit JAMAIS écraser Soviets=#1 ni Cigares=#4, ni créer un faux découpage "Tintin (Casterman)".
    const now = new Date().toISOString();
    const connectors = createMockConnectors({
      bnfByIsbn: {
        '9782203001015': {
          source: 'bnf',
          isbn13: '9782203001015',
          title: 'Tintin au Congo',
          seriesName: 'Les Aventures de Tintin',
          seriesLinkKind: 'marc_ensemble_460',
          volumeNumber: '1', // Numérotation décalée Casterman !
          authors: ['Hergé'],
          scriptwriters: [],
          illustrators: [],
          publisher: 'Casterman',
          pageCount: 62,
          rawSubjects: ['Bandes dessinées']
        },
        '9782203001022': {
          source: 'bnf',
          isbn13: '9782203001022',
          title: 'Les Aventures de Tintin en Amérique',
          seriesName: 'Les Aventures de Tintin',
          seriesLinkKind: 'marc_ensemble_460',
          volumeNumber: '2', // Numérotation décalée Casterman !
          authors: ['Hergé'],
          scriptwriters: [],
          illustrators: [],
          publisher: 'Casterman',
          pageCount: 62,
          rawSubjects: ['Bandes dessinées']
        },
        '9782203001053': {
          source: 'bnf',
          isbn13: '9782203001053',
          title: "L'Oreille cassée",
          seriesName: 'Les Aventures de Tintin',
          seriesLinkKind: 'marc_ensemble_460',
          volumeNumber: '4', // Entre en collision avec Cigares (#4 Wikidata) si on ne compare pas le titre !
          authors: ['Hergé'],
          scriptwriters: [],
          illustrators: [],
          publisher: 'Casterman',
          pageCount: 62,
          rawSubjects: ['Bandes dessinées']
        }
      }
    });

    const seriesGraph = new SeriesGraphService({ catalogRepo, connectors });
    const { series: tintinSeries } = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'Les Aventures de Tintin',
      wikidataSeriesQid: 'Q744536',
      bookTitle: 'Tintin au pays des Soviets',
      volumeNumber: 1,
      isHorsSerie: false,
      isIntegral: false,
      pageCount: 141,
      publisher: 'Casterman',
      mainCategory: 'BD',
      authors: ['Hergé'],
      now
    });

    const seedTintin = (id: string, qid: string, title: string, vol: number) => {
      catalogRepo.upsertBookAutomatic({
        id,
        workCanonicalId: `wd:${qid}`,
        seriesId: tintinSeries.id,
        title,
        normalizedTitle: title.toLowerCase(),
        volumeNumber: vol,
        volumeLabel: String(vol),
        sortOrder: vol,
        isHorsSerie: false,
        isIntegral: false,
        includedVolumes: [],
        authors: ['Hergé'],
        scriptwriters: [],
        illustrators: [],
        publisher: 'Casterman',
        collectionName: null,
        publishYear: '1930',
        pageCount: 62,
        description: null,
        language: 'fr',
        mainCategory: 'BD',
        subgenres: [],
        coverKey: null,
        wikidataQid: qid,
        inventaireUri: null,
        sourceOrigin: 'auto',
        now
      });
    };

    seedTintin('bk_tin_1', 'Q629032', 'Tintin au pays des Soviets', 1);
    seedTintin('bk_tin_2', 'Q636870', 'Tintin au Congo', 2);
    seedTintin('bk_tin_3', 'Q629489', 'Tintin en Amérique', 3);
    seedTintin('bk_tin_4', 'Q768104', 'Les Cigares du pharaon', 4);
    seedTintin('bk_tin_6', 'Q1199184', "L'Oreille cassée", 6);

    const ingestion = new IngestionService({
      catalogRepo,
      libraryRepo,
      jobRepo,
      logRepo,
      comparisonService: new ComparisonTableService({ connectors }),
      seriesGraphService: seriesGraph,
      coverService
    });

    const res = await ingestion.resolveIsbns({
      rawIsbns: ['9782203001015', '9782203001022', '9782203001053'],
      channel: 'barcode_simple',
      action: 'owned',
      userId,
      libraryId
    });

    expect(res.results.every((r) => r.found && r.book !== null)).toBe(true);
    // Congo (#1 Casterman) s'est bien rattaché à bk_tin_2 (#2 Wikidata), sans écraser Soviets (#1) !
    expect(res.results[0].book?.id).toBe('bk_tin_2');
    expect(res.results[0].book?.volumeNumber).toBe(2);
    // Amérique (#2 Casterman) s'est bien rattaché à bk_tin_3 (#3 Wikidata) via correspondance tronc de titre !
    expect(res.results[1].book?.id).toBe('bk_tin_3');
    expect(res.results[1].book?.volumeNumber).toBe(3);
    // L'Oreille cassée (#4 Casterman) s'est bien rattaché à bk_tin_6 (#6 Wikidata), sans toucher Les Cigares (#4) !
    expect(res.results[2].book?.id).toBe('bk_tin_6');
    expect(res.results[2].book?.volumeNumber).toBe(6);

    // Soviets (#1) et Cigares (#4) sont strictement intacts, et aucune 2e série Tintin (Casterman) n'a été créée !
    expect(catalogRepo.findBookById('bk_tin_1')?.title).toBe('Tintin au pays des Soviets');
    expect(catalogRepo.findBookById('bk_tin_4')?.title).toBe('Les Cigares du pharaon');
    const allTintinSeries = db.all<{ id: string; canonical_name: string }>(
      "SELECT id, canonical_name FROM series WHERE lower(canonical_name) LIKE '%tintin%'"
    );
    expect(allTintinSeries).toHaveLength(1);
  });

  it('Cas 14 (MARC 280$c BD pré-2015 + verrouillage Q-ID par la preuve + trous BnF) : Le Petit Spirou complet, Astérix Q42490, Nestor Burma Roman préservé', async () => {
    const { parseMarcRecord } = await import('../../../shared/bibliographic/intermarc-parser');
    const { classifyBookMetadata } = await import('../../../shared/bibliographic/category-classifier');

    // 1. Notices BnF pré-2015 avec 051$a=txt seul mais 280$c="ill. en coul." -> BD (illustrated)
    const petitSpirouT15Xml = `
      <mxc:record>
        <mxc:datafield tag="020"><mxc:subfield code="a">978-2-8001-4968-4</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="051"><mxc:subfield code="a">txt</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="245"><mxc:subfield code="a">Tiens-toi droit !</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="280"><mxc:subfield code="a">1 vol.</mxc:subfield><mxc:subfield code="c">ill. en coul.</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="460"><mxc:subfield code="3">38941816</mxc:subfield><mxc:subfield code="t">Le petit Spirou</mxc:subfield><mxc:subfield code="v">15</mxc:subfield></mxc:datafield>
      </mxc:record>`;
    const parsedSpirou = parseMarcRecord(petitSpirouT15Xml);
    expect(parsedSpirou?.contentKind).toBe('illustrated');
    expect(
      classifyBookMetadata({
        title: parsedSpirou?.title,
        series: parsedSpirou?.ensembleSeriesName,
        contentKind: parsedSpirou?.contentKind
      }).mainCategory
    ).toBe('BD');

    // Roman Nestor Burma : 051$a=txt + 280$c="couv. ill. en coul." (couverture seule !) -> reste text_only (Roman)
    const nestorRomanXml = `
      <mxc:record>
        <mxc:datafield tag="020"><mxc:subfield code="a">978-2-221-10635-8</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="051"><mxc:subfield code="a">txt</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="245"><mxc:subfield code="a">Dernières enquêtes</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="280"><mxc:subfield code="a">1 vol. (XXIX-888 p.)</mxc:subfield><mxc:subfield code="c">couv. ill. en coul.</mxc:subfield></mxc:datafield>
      </mxc:record>`;
    const parsedBurmaRoman = parseMarcRecord(nestorRomanXml);
    expect(parsedBurmaRoman?.contentKind).toBe('text_only');
    expect(
      classifyBookMetadata({
        title: parsedBurmaRoman?.title,
        series: 'Nestor Burma',
        contentKind: parsedBurmaRoman?.contentKind
      }).mainCategory
    ).toBe('Roman');

    // Roman illustré avec Dewey 843 + 280$c="ill." sans sti -> reste text_only (pas faux positif BD)
    const romanDewey843Xml = `
      <mxc:record>
        <mxc:datafield tag="020"><mxc:subfield code="a">978-2-07-041111-5</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="051"><mxc:subfield code="a">txt</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="245"><mxc:subfield code="a">Vingt mille lieues sous les mers</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="280"><mxc:subfield code="a">1 vol. (512 p.)</mxc:subfield><mxc:subfield code="c">ill.</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="676"><mxc:subfield code="a">843</mxc:subfield></mxc:datafield>
      </mxc:record>`;
    expect(parseMarcRecord(romanDewey843Xml)?.contentKind).toBe('text_only');

    // 2. Verrouillage Q-ID par la preuve : Q105030970 (0 œuvre) est ignoré au profit du candidat suivant Q42490 (œuvres réelles)
    const now = new Date().toISOString();
    const connectors = createMockConnectors({
      wikidataSeries: {
        Q105030970: [],
        Q42490: [
          { title: 'Astérix le Gaulois', volumeNumber: 1, volumeLabel: '1', sortOrder: 1, wikidataQid: 'Q501999', authors: ['René Goscinny', 'Albert Uderzo'], isbn13s: [], source: 'wikidata' },
          { title: 'Astérix chez Rahàzade', volumeNumber: 28, volumeLabel: '28', sortOrder: 28, wikidataQid: 'Q599154', authors: ['Albert Uderzo'], isbn13s: [], source: 'wikidata' },
          { title: "L'Iris blanc", volumeNumber: 40, volumeLabel: '40', sortOrder: 40, wikidataQid: 'Q117226890', authors: ['Fabcaro', 'Didier Conrad'], isbn13s: [], source: 'wikidata' }
        ]
      },
      bnfEnsemble: {
        '38941816': [
          { title: 'Tiens-toi droit !', volumeNumber: 15, volumeLabel: '15', sortOrder: 15, bnfEnsembleId: '38941816', authors: ['Tome', 'Janry'], isbn13s: ['9782800149684'], contentKind: 'illustrated', source: 'bnf' },
          { title: 'T’es gonflé !', volumeNumber: 16, volumeLabel: '16', sortOrder: 16, bnfEnsembleId: '38941816', authors: ['Tome', 'Janry'], isbn13s: ['9782800151588'], contentKind: 'illustrated', source: 'bnf' }
        ],
        '34314264': [
          { title: 'Dis bonjour à la dame !', volumeNumber: 1, volumeLabel: '1', sortOrder: 1, bnfEnsembleId: '34314264', authors: ['Tome', 'Janry'], isbn13s: ['9782800117270'], contentKind: 'illustrated', source: 'bnf' },
          { title: 'Tu veux mon doigt ?', volumeNumber: 2, volumeLabel: '2', sortOrder: 2, bnfEnsembleId: '34314264', authors: ['Tome', 'Janry'], isbn13s: ['9782800118482'], contentKind: 'illustrated', source: 'bnf' }
        ]
      },
      bnfBySeriesName: {
        'le petit spirou': {
          discoveredEnsembleIds: ['38941816', '34314264'],
          works: [
            { title: 'Dis bonjour à la dame !', volumeNumber: 1, volumeLabel: '1', sortOrder: 1, bnfEnsembleId: '34314264', authors: ['Tome', 'Janry'], isbn13s: ['9782800117270'], contentKind: 'illustrated', source: 'bnf' }
          ]
        }
      }
    });
    connectors.wikidata.searchSeriesQids = async (name) =>
      name.toLowerCase().includes('ast') ? ['Q105030970', 'Q42490'] : [];

    const seriesGraph = new SeriesGraphService({ catalogRepo, connectors });

    const { series: astSeries } = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'Astérix',
      bookTitle: 'Astérix le Gaulois',
      volumeNumber: 1,
      isHorsSerie: false,
      isIntegral: false,
      mainCategory: 'BD',
      authors: ['René Goscinny', 'Albert Uderzo'],
      now
    });
    await seriesGraph.expandSeriesByGraph(astSeries.id);
    expect(catalogRepo.findSeriesById(astSeries.id)?.wikidata_qid).toBe('Q42490');
    expect(catalogRepo.listBooksBySeriesId(astSeries.id).map((b) => b.volume_number)).toEqual([1, 28, 40]);

    // 3. Trou de numérotation BnF (tomes 15 & 16 sans graphe Wikidata/Inventaire) -> déclenche la découverte des autres ensembles BnF (tomes 1 & 2) !
    const { series: spirouSeries } = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'Le Petit Spirou',
      bnfEnsembleId: '38941816',
      bookTitle: 'Tiens-toi droit !',
      volumeNumber: 15,
      isHorsSerie: false,
      isIntegral: false,
      mainCategory: 'BD',
      authors: ['Tome', 'Janry'],
      now
    });
    await seriesGraph.expandSeriesByGraph(spirouSeries.id);
    expect(
      catalogRepo
        .listBooksBySeriesId(spirouSeries.id)
        .map((b) => b.volume_number)
        .sort((a, b) => (a ?? 0) - (b ?? 0))
    ).toEqual([1, 2, 15, 16]);
  });

  it('Cas 15 (Phase 3A multi-dossiers BnF sans verrou auteur + règle Zéro trou silencieux + rejet collections kiosque)', async () => {
    const now = new Date().toISOString();
    expect(isCompatibleSeriesName('La collection Spirou et Fantasio', 'Spirou et Fantasio')).toBe(false);
    expect(isCompatibleSeriesName('Diptyque Spirou et Fantasio', 'Spirou et Fantasio')).toBe(false);
    expect(isCompatibleSeriesName('Les aventures de Spirou et Fantasio', 'Spirou et Fantasio')).toBe(true);

    let capturedSeriesSearchAuthor: string | undefined = 'SHOULD_BE_UNDEFINED';
    const connectors = createMockConnectors({
      wikidataSeries: {
        // Wikidata ne connaît que les tomes 1, 2, 4 (trou sur le 3, et le tome 5 récent manque !) — sans ISBN
        Q102237771: [
          { title: '4 aventures de Spirou et Fantasio', volumeNumber: 1, volumeLabel: '1', sortOrder: 1, wikidataQid: 'Q1', authors: ['André Franquin'], isbn13s: [], source: 'wikidata' },
          { title: 'Il y a un sorcier à Champignac', volumeNumber: 2, volumeLabel: '2', sortOrder: 2, wikidataQid: 'Q2', authors: ['André Franquin'], isbn13s: [], source: 'wikidata' },
          { title: 'Spirou et les Héritiers', volumeNumber: 4, volumeLabel: '4', sortOrder: 4, wikidataQid: 'Q4', authors: ['André Franquin'], isbn13s: [], source: 'wikidata' }
        ]
      },
      bnfEnsemble: {
        '45703820': [
          { title: '4 aventures de Spirou et Fantasio', volumeNumber: 1, volumeLabel: '1', sortOrder: 1, bnfEnsembleId: '45703820', authors: ['André Franquin'], isbn13s: ['9782800100036'], contentKind: 'illustrated', source: 'bnf' }
        ],
        '34308390': [
          { title: 'Il y a un sorcier à Champignac', volumeNumber: 2, volumeLabel: '2', sortOrder: 2, bnfEnsembleId: '34308390', authors: ['André Franquin'], isbn13s: ['9782800100043'], contentKind: 'illustrated', source: 'bnf' }
        ]
      }
    });

    connectors.bnf.searchBySeriesName = async (_name, author) => {
      capturedSeriesSearchAuthor = author;
      return {
        discoveredEnsembleIds: ['34308390'],
        works: [
          { title: 'Il y a un sorcier à Champignac', volumeNumber: 2, volumeLabel: '2', sortOrder: 2, bnfEnsembleId: '34308390', authors: ['André Franquin'], isbn13s: ['9782800100043'], contentKind: 'illustrated', source: 'bnf' }
        ]
      };
    };

    connectors.bnf.searchSeriesVolume = async (_name, vol) => {
      if (vol === 3) {
        return [
          {
            title: 'Les Chapeaux noirs',
            volumeNumber: 3,
            volumeLabel: '3',
            sortOrder: 3,
            bnfEnsembleId: '34308390',
            authors: ['André Franquin'],
            isbn13s: ['9782800100050'],
            contentKind: 'illustrated',
            source: 'bnf'
          }
        ];
      }
      if (vol === 5) {
        return [
          {
            title: 'Les Voleurs du marsupilami',
            volumeNumber: 5,
            volumeLabel: '5',
            sortOrder: 5,
            bnfEnsembleId: '34308390',
            authors: ['André Franquin'],
            isbn13s: ['9782800100074'],
            contentKind: 'illustrated',
            source: 'bnf'
          }
        ];
      }
      return [];
    };

    const seriesGraph = new SeriesGraphService({ catalogRepo, connectors });
    const { series } = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'Spirou et Fantasio',
      wikidataSeriesQid: 'Q102237771',
      bnfEnsembleId: '45703820',
      bookTitle: '4 aventures de Spirou et Fantasio',
      volumeNumber: 1,
      isHorsSerie: false,
      isIntegral: false,
      mainCategory: 'BD',
      authors: ['André Franquin'],
      now
    });

    const report = await seriesGraph.expandSeriesByGraph(series.id);

    // Découverte multi-dossiers sans verrouillage sur le seul auteur du T.1 !
    expect(capturedSeriesSearchAuthor).toBeUndefined();
    // Continuité parfaite 1..5 : trou #3 comblé et suite récente #5 découverte !
    const saved = catalogRepo.listBooksBySeriesId(series.id).sort((a, b) => (a.volume_number ?? 0) - (b.volume_number ?? 0));
    expect(saved.map((b) => b.volume_number)).toEqual([1, 2, 3, 4, 5]);
    // Le tome 4 (sans ISBN ni couverture) est bien comptabilisé pour la Phase 3B/3C en arrière-plan
    expect(report.incompleteVolumeCount).toBeGreaterThanOrEqual(1);
  });

  it('Cas 16 (BnF 460$v corrompu en année vs SUDOC 461$v exact — ex. Animal Jack T.8) : SUDOC corrige le numéro de tome et le titre dans ComparisonTableService et en Phase 3A', async () => {
    const bnfXmlCorrupted460 = `
      <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
        <mxc:controlfield tag="008">230928s                      f     fre        </mxc:controlfield>
        <mxc:datafield tag="020"><mxc:subfield code="a">979-10-347-6873-8</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="245">
          <mxc:subfield code="a">Animal Jack</mxc:subfield>
          <mxc:subfield code="h">7</mxc:subfield>
          <mxc:subfield code="i">Un tout petit mondes</mxc:subfield>
        </mxc:datafield>
        <mxc:datafield tag="460">
          <mxc:subfield code="3">45670690</mxc:subfield>
          <mxc:subfield code="a">Animal Jack</mxc:subfield>
          <mxc:subfield code="v">2023</mxc:subfield>
        </mxc:datafield>
        <mxc:datafield tag="700"><mxc:subfield code="a">Toussaint</mxc:subfield><mxc:subfield code="m">Kid</mxc:subfield></mxc:datafield>
      </mxc:record>
    `;
    const sudocXmlClean = `
      <record>
        <datafield tag="010"><subfield code="a">979-10-347-6873-8</subfield></datafield>
        <datafield tag="200">
          <subfield code="a">Animal Jack</subfield>
          <subfield code="h">8</subfield>
          <subfield code="i">Un tout petit monde</subfield>
        </datafield>
        <datafield tag="461">
          <subfield code="t">Animal Jack</subfield>
          <subfield code="v">8</subfield>
        </datafield>
        <datafield tag="700"><subfield code="a">Toussaint</subfield><subfield code="b">Kid</subfield></datafield>
      </record>
    `;

    const parsedBnf = parseMarcRecord(bnfXmlCorrupted460);
    const parsedSudoc = parseMarcRecord(sudocXmlClean);
    expect(parsedBnf?.hasStructuredEnsembleVolume).toBe(false);
    expect(parsedBnf?.ensembleVolumeNumber).toBe('7');
    expect(parsedSudoc?.hasStructuredEnsembleVolume).toBe(true);
    expect(parsedSudoc?.ensembleVolumeNumber).toBe('8');

    const now = new Date().toISOString();
    const connectors = createMockConnectors({
      bnfByIsbn: {
        '9791034768738': {
          source: 'bnf',
          isbn13: '9791034768738',
          title: parsedBnf!.title,
          seriesName: parsedBnf!.ensembleSeriesName,
          seriesLinkKind: 'marc_ensemble_460',
          volumeNumber: parsedBnf!.ensembleVolumeNumber,
          hasStructuredEnsembleVolume: parsedBnf!.hasStructuredEnsembleVolume,
          bnfEnsembleId: parsedBnf!.bnfEnsembleId,
          authors: parsedBnf!.authors,
          scriptwriters: [],
          illustrators: [],
          rawSubjects: []
        }
      },
      bnfEnsemble: {
        '45670690': [
          {
            title: 'Face à la meute',
            volumeNumber: 6,
            volumeLabel: '6',
            hasStructuredEnsembleVolume: true,
            sortOrder: 6,
            bnfEnsembleId: '45670690',
            authors: ['Kid Toussaint'],
            isbn13s: ['9791034762729'],
            source: 'bnf'
          },
          {
            title: 'Un tout petit mondes',
            volumeNumber: 7,
            volumeLabel: '7',
            hasStructuredEnsembleVolume: false,
            sortOrder: 7,
            bnfEnsembleId: '45670690',
            authors: ['Kid Toussaint'],
            isbn13s: ['9791034768738'],
            source: 'bnf'
          },
          {
            title: 'Terre des dragons',
            volumeNumber: 9,
            volumeLabel: '9',
            hasStructuredEnsembleVolume: true,
            sortOrder: 9,
            bnfEnsembleId: '45670690',
            authors: ['Kid Toussaint'],
            isbn13s: ['9782808503419'],
            source: 'bnf'
          }
        ]
      }
    });
    connectors.sudoc.lookupByIsbn = async (isbn13: string) => {
      if (isbn13 !== '9791034768738') return null;
      return {
        source: 'sudoc',
        isbn13,
        title: parsedSudoc!.title,
        seriesName: parsedSudoc!.ensembleSeriesName,
        seriesLinkKind: 'marc_ensemble_460',
        volumeNumber: parsedSudoc!.ensembleVolumeNumber,
        hasStructuredEnsembleVolume: parsedSudoc!.hasStructuredEnsembleVolume,
        authors: parsedSudoc!.authors,
        scriptwriters: [],
        illustrators: [],
        rawSubjects: []
      };
    };

    // 1. Arbitrage Étage 2 : SUDOC (461$v=8 structuré) corrige BnF (460$v=2023 corrompu + 245$h=7)
    const comparison = new ComparisonTableService({ connectors });
    const draft = await comparison.collectAndArbitrate('9791034768738');
    expect(draft?.volumeNumber).toBe(8);
    expect(draft?.title).toBe('Un tout petit monde');

    // 2. Expansion Phase 3A : la notice BnF suspecte est vérifiée au SUDOC -> rangée en T.8 et non en T.7 !
    const seriesGraph = new SeriesGraphService({ catalogRepo, connectors });
    const { series } = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'Animal Jack',
      bnfEnsembleId: '45670690',
      bookTitle: 'Face à la meute',
      volumeNumber: 6,
      isHorsSerie: false,
      isIntegral: false,
      mainCategory: 'BD',
      authors: ['Kid Toussaint'],
      now
    });
    await seriesGraph.expandSeriesByGraph(series.id);
    const saved = catalogRepo.listBooksBySeriesId(series.id).sort((a, b) => (a.volume_number ?? 0) - (b.volume_number ?? 0));
    const vol8 = saved.find((b) => b.volume_number === 8);
    expect(vol8?.title).toBe('Un tout petit monde');
    expect(saved.find((b) => b.volume_number === 7)).toBeUndefined();
  });

  it('Cas 17 (Dragon Ball redécoupages + Manga + coffret 2 vol.) : isole Glénat 42 tomes face à Viz EN, Hachette, Double et Full Color', async () => {
    const { parseMarcRecord } = await import('../../../shared/bibliographic/intermarc-parser');
    const now = '2026-11-25T20:00:00.000Z';

    // 1. MARC 280$a "2 vol. (384 p.)" -> isIntegralHint = true ; "1 vol. (362 p.)" -> false
    const coffretXml = `
      <mxc:record>
        <mxc:datafield tag="020"><mxc:subfield code="a">978-2-7234-5000-3</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="245"><mxc:subfield code="a">Dragon Ball</mxc:subfield><mxc:subfield code="e">coffret</mxc:subfield><mxc:subfield code="h">10</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="280"><mxc:subfield code="a">2 vol. (384 p.)</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="460"><mxc:subfield code="3">34338439</mxc:subfield><mxc:subfield code="t">Dragon Ball</mxc:subfield><mxc:subfield code="v">10</mxc:subfield></mxc:datafield>
      </mxc:record>`;
    expect(parseMarcRecord(coffretXml)?.isIntegralHint).toBe(true);

    // 2. Classification Manga préservée même si SUDOC a collectionName="Dragon Ball" (BnF 410$t="Collection Manga")
    const connectors = createMockConnectors({
      bnfByIsbn: {
        '9782723418584': {
          source: 'bnf',
          isbn13: '9782723418584',
          title: 'Chi-Chi',
          seriesName: 'Dragon Ball',
          seriesLinkKind: 'marc_ensemble_460',
          volumeNumber: '15',
          hasStructuredEnsembleVolume: true,
          bnfEnsembleId: '34338439',
          collectionName: 'Collection Manga (Grenoble)',
          authors: ['Akira Toriyama'],
          scriptwriters: [],
          illustrators: [],
          publisher: 'Glénat',
          pageCount: 184,
          rawSubjects: [],
          contentKind: 'illustrated'
        }
      },
      bnfEnsemble: {
        // Dossier graine : Glénat 42 tomes (~184 p., + T.42 244 p. Glénat à conserver, + coffret 2 vol. en intégrale, + outlier 362 p. à écarter)
        '34338439': [
          {
            title: 'Sangoku',
            volumeNumber: 1,
            authors: ['Akira Toriyama'],
            isbn13s: ['9782723415774'],
            publisher: 'Glénat',
            pageCount: 182,
            bnfEnsembleId: '34338439',
            contentKind: 'illustrated',
            source: 'bnf'
          },
          {
            title: 'La menace',
            volumeNumber: 7,
            authors: ['Akira Toriyama'],
            isbn13s: ['9782723418508'],
            publisher: 'Glénat',
            pageCount: 180,
            bnfEnsembleId: '34338439',
            contentKind: 'illustrated',
            source: 'bnf'
          },
          {
            title: 'Chi-Chi',
            volumeNumber: 15,
            authors: ['Akira Toriyama'],
            isbn13s: ['9782723418584'],
            publisher: 'Glénat',
            pageCount: 184,
            bnfEnsembleId: '34338439',
            contentKind: 'illustrated',
            source: 'bnf'
          },
          {
            title: 'Les androïdes',
            volumeNumber: 29,
            authors: ['Akira Toriyama'],
            isbn13s: ['9782723423472'],
            publisher: 'Glénat',
            pageCount: 191,
            bnfEnsembleId: '34338439',
            contentKind: 'illustrated',
            source: 'bnf'
          },
          {
            title: 'Bye bye dragon world',
            volumeNumber: 42,
            authors: ['Akira Toriyama'],
            isbn13s: ['9782723434621'],
            publisher: 'Glénat',
            pageCount: 244,
            bnfEnsembleId: '34338439',
            contentKind: 'illustrated',
            source: 'bnf'
          },
          {
            title: 'Dragon Ball Coffret 10',
            volumeNumber: 10,
            authors: ['Akira Toriyama'],
            isbn13s: ['9782723450003'],
            publisher: 'Glénat',
            pageCount: 384,
            isIntegral: true,
            bnfEnsembleId: '34338439',
            contentKind: 'illustrated',
            source: 'bnf'
          },
          {
            title: 'Outlier Double Glénat',
            volumeNumber: 4,
            authors: ['Akira Toriyama'],
            isbn13s: ['9782723499999'],
            publisher: 'Glénat',
            pageCount: 362,
            bnfEnsembleId: '34338439',
            contentKind: 'illustrated',
            source: 'bnf'
          }
        ],
        // Dossier rival #1 : Glénat Double (365 p., titres décalés : "La menace" en T.4 et "Les androïdes" en T.15 !)
        '38839216': [
          {
            title: 'La menace',
            volumeNumber: 4,
            authors: ['Akira Toriyama'],
            isbn13s: ['9782723434041'],
            publisher: 'Glénat',
            pageCount: 362,
            bnfEnsembleId: '38839216',
            contentKind: 'illustrated',
            source: 'bnf'
          },
          {
            title: 'Les androïdes',
            volumeNumber: 15,
            authors: ['Akira Toriyama'],
            isbn13s: ['9782723434157'],
            publisher: 'Glénat',
            pageCount: 373,
            bnfEnsembleId: '38839216',
            contentKind: 'illustrated',
            source: 'bnf'
          }
        ],
        // Dossier rival #2 : Hachette Collections (240 p., autre éditeur + pagination +30 %)
        '39250101': [
          {
            title: 'Le terrible commando Ginyu',
            volumeNumber: 19,
            authors: ['Akira Toriyama'],
            isbn13s: ['9782019991191'],
            publisher: 'Hachette collections',
            pageCount: 241,
            bnfEnsembleId: '39250101',
            contentKind: 'illustrated',
            source: 'bnf'
          },
          {
            title: 'Les cyborgs se réveillent !',
            volumeNumber: 24,
            authors: ['Akira Toriyama'],
            isbn13s: ['9782019991245'],
            publisher: 'Hachette collections',
            pageCount: 247,
            bnfEnsembleId: '39250101',
            contentKind: 'illustrated',
            source: 'bnf'
          }
        ],
        // Dossier rival #3 : Full Color (245 p., tag d'édition distinct)
        '45623035': [
          {
            title: 'Dragon Ball - full color',
            volumeNumber: 3,
            authors: ['Akira Toriyama'],
            isbn13s: ['9782344012031'],
            publisher: 'Glénat',
            pageCount: 245,
            bnfEnsembleId: '45623035',
            contentKind: 'illustrated',
            source: 'bnf'
          }
        ]
      },
      // Graphe Wikidata/Inventaire anglais Viz Media -> doit être rejeté !
      wikidataSeries: {
        Q15051307: [
          { title: 'The Red Ribbon Army', volumeNumber: 5, authors: ['Akira Toriyama'], isbn13s: [], source: 'wikidata' },
          { title: 'Bulma Returns!', volumeNumber: 6, authors: ['Akira Toriyama'], isbn13s: [], source: 'wikidata' },
          { title: 'General Blue and the Pirate Treasure', volumeNumber: 7, authors: ['Akira Toriyama'], isbn13s: [], source: 'wikidata' },
          { title: 'Dragon Ball Z, Vol. 10', volumeNumber: 10, authors: ['Akira Toriyama'], isbn13s: [], source: 'wikidata' },
          { title: 'The Demon King Piccolo', volumeNumber: 12, authors: ['Akira Toriyama'], isbn13s: [], source: 'wikidata' }
        ]
      }
    });

    connectors.sudoc.lookupByIsbn = async (isbn13: string) => {
      if (isbn13 !== '9782723418584') return null;
      return {
        source: 'sudoc',
        isbn13,
        title: 'Chi-Chi',
        seriesName: 'Dragon Ball',
        seriesLinkKind: 'marc_ensemble_460',
        collectionName: 'Dragon Ball',
        volumeNumber: '15',
        hasStructuredEnsembleVolume: true,
        authors: ['Akira Toriyama'],
        scriptwriters: [],
        illustrators: [],
        publisher: 'Glénat',
        pageCount: 184,
        rawSubjects: []
      };
    };

    connectors.bnf.searchBySeriesName = async () => ({
      discoveredEnsembleIds: ['38839216', '39250101', '45623035'],
      works: [
        {
          title: 'La menace',
          volumeNumber: 4,
          authors: ['Akira Toriyama'],
          isbn13s: ['9782723434041'],
          publisher: 'Glénat',
          pageCount: 362,
          bnfEnsembleId: '38839216',
          contentKind: 'illustrated',
          source: 'bnf'
        },
        {
          title: 'Le terrible commando Ginyu',
          volumeNumber: 19,
          authors: ['Akira Toriyama'],
          isbn13s: ['9782019991191'],
          publisher: 'Hachette collections',
          pageCount: 241,
          bnfEnsembleId: '39250101',
          contentKind: 'illustrated',
          source: 'bnf'
        },
        {
          title: 'Dragon Ball - full color',
          volumeNumber: 3,
          authors: ['Akira Toriyama'],
          isbn13s: ['9782344012031'],
          publisher: 'Glénat',
          pageCount: 245,
          bnfEnsembleId: '45623035',
          contentKind: 'illustrated',
          source: 'bnf'
        }
      ]
    });

    connectors.bnf.searchSeriesVolume = async (_s: string, vol: number) => {
      if (vol === 8) {
        return [
          {
            title: 'Le terrible commando Ginyu',
            volumeNumber: 8,
            authors: ['Akira Toriyama'],
            isbn13s: ['9782019991191'],
            publisher: 'Hachette collections',
            pageCount: 241,
            bnfEnsembleId: '39250101',
            contentKind: 'illustrated',
            source: 'bnf'
          },
          {
            title: 'Le grand combat',
            volumeNumber: 8,
            authors: ['Akira Toriyama'],
            isbn13s: ['9782723418515'],
            publisher: 'Glénat',
            pageCount: 180,
            bnfEnsembleId: '34338439',
            contentKind: 'illustrated',
            source: 'bnf'
          }
        ];
      }
      return [];
    };

    const comparison = new ComparisonTableService({ connectors });
    const draft = await comparison.collectAndArbitrate('9782723418584');
    expect(draft?.mainCategory).toBe('Manga');

    const seriesGraph = new SeriesGraphService({ catalogRepo, connectors });
    const { series } = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'Dragon Ball',
      wikidataSeriesQid: 'Q15051307',
      bnfEnsembleId: '34338439',
      bookTitle: 'Chi-Chi',
      volumeNumber: 15,
      isHorsSerie: false,
      isIntegral: false,
      pageCount: 184,
      publisher: 'Glénat',
      mainCategory: 'Manga',
      authors: ['Akira Toriyama'],
      now
    });

    catalogRepo.upsertBookAutomatic({
      id: 'bk_db_seed_15',
      workCanonicalId: 'isbn:9782723418584',
      seriesId: series.id,
      title: 'Chi-Chi',
      normalizedTitle: 'chi chi',
      volumeNumber: 15,
      volumeLabel: '15',
      sortOrder: 15,
      isHorsSerie: false,
      isIntegral: false,
      includedVolumes: [],
      authors: ['Akira Toriyama'],
      scriptwriters: [],
      illustrators: [],
      publisher: 'Glénat',
      collectionName: 'Collection Manga',
      publishYear: '1996',
      pageCount: 184,
      description: null,
      language: 'fr',
      mainCategory: 'Manga',
      subgenres: [],
      coverKey: null,
      wikidataQid: null,
      inventaireUri: null,
      sourceOrigin: 'auto',
      now
    });
    catalogRepo.upsertBookEdition({
      isbn13: '9782723418584',
      bookId: 'bk_db_seed_15',
      publisher: 'Glénat',
      collectionName: 'Collection Manga',
      publishYear: '1996',
      pageCount: 184,
      coverKey: null,
      source: 'bnf',
      now
    });

    await seriesGraph.expandSeriesByGraph(series.id);

    const saved = catalogRepo.listBooksBySeriesId(series.id);
    const unitary = saved.filter((b) => b.is_integral === 0);
    const integrals = saved.filter((b) => b.is_integral === 1);

    // Tous les tomes unitaires doivent être 100 % Glénat 42 tomes en français !
    expect(unitary.map((b) => `${b.volume_number}:${b.title}`).sort()).toEqual([
      '15:Chi-Chi',
      '1:Sangoku',
      '29:Les androïdes',
      '42:Bye bye dragon world',
      '7:La menace',
      '8:Le grand combat'
    ]);
    // Zéro anglais Viz Media, zéro Hachette, zéro Full Color, zéro Double 362 p.
    expect(unitary.some((b) => /Red Ribbon|Bulma|Ginyu|full color|Outlier/i.test(b.title))).toBe(false);
    // Le coffret 2 vol. a bien été isolé en intégrale !
    expect(integrals).toHaveLength(1);
    expect(integrals[0].title).toContain('Coffret 10');
    // Les dossiers rivaux n'ont PAS pollué series.bnf_ensemble_ids_json
    const updatedSeries = catalogRepo.findSeriesById(series.id)!;
    const savedEns = JSON.parse(updatedSeries.bnf_ensemble_ids_json) as string[];
    expect(savedEns).toEqual(['34338439']);
  });

  it('Cas 18 (Zéro régression Romans grand format <-> poche, BD multi-éditeurs & Intégrale en 1er livre)', async () => {
    const now = '2026-11-25T20:05:00.000Z';

    // 1. Roman Dune : Grand format Robert Laffont (540 p.) + Poche Pocket (760 p., ratio 1.41, éditeur différent) -> 1 SEULE série !
    const connectorsRoman = createMockConnectors();
    const seriesGraphRoman = new SeriesGraphService({ catalogRepo, connectors: connectorsRoman });
    const { series: duneCut1 } = seriesGraphRoman.resolveOrCreateSeriesCut({
      seriesName: 'Dune',
      bookTitle: 'Dune',
      volumeNumber: 1,
      isHorsSerie: false,
      isIntegral: false,
      pageCount: 540,
      publisher: 'Robert Laffont',
      collectionName: 'Ailleurs et demain',
      mainCategory: 'Roman',
      authors: ['Frank Herbert'],
      now
    });
    catalogRepo.upsertBookAutomatic({
      id: 'bk_dune_1',
      workCanonicalId: 'isbn:9782221000001',
      seriesId: duneCut1.id,
      title: 'Dune',
      normalizedTitle: 'dune',
      volumeNumber: 1,
      volumeLabel: '1',
      sortOrder: 1,
      isHorsSerie: false,
      isIntegral: false,
      includedVolumes: [],
      authors: ['Frank Herbert'],
      scriptwriters: [],
      illustrators: [],
      publisher: 'Robert Laffont',
      collectionName: 'Ailleurs et demain',
      publishYear: '1970',
      pageCount: 540,
      description: null,
      language: 'fr',
      mainCategory: 'Roman',
      subgenres: [],
      coverKey: null,
      wikidataQid: null,
      inventaireUri: null,
      sourceOrigin: 'auto',
      now
    });

    const { series: duneCut2 } = seriesGraphRoman.resolveOrCreateSeriesCut({
      seriesName: 'Dune',
      bookTitle: 'Le Messie de Dune',
      volumeNumber: 2,
      isHorsSerie: false,
      isIntegral: false,
      pageCount: 760,
      publisher: 'Pocket',
      collectionName: 'Science-fiction',
      mainCategory: 'Roman',
      authors: ['Frank Herbert'],
      now
    });
    expect(duneCut2.id).toBe(duneCut1.id);

    // 2. BD Franco-belge démarrée par une INTÉGRALE seule (160 p.) + 2 dossiers BnF Dupuis & Dargaud aux mêmes titres -> tout déploie et fusionne !
    const connectorsBd = createMockConnectors({
      bnfEnsemble: {
        '40000001': [
          {
            title: 'La Mine d’or de Dick Digger',
            volumeNumber: 1,
            authors: ['Morris'],
            isbn13s: ['9782800100012'],
            publisher: 'Dupuis',
            pageCount: 48,
            bnfEnsembleId: '40000001',
            contentKind: 'illustrated',
            source: 'bnf'
          },
          {
            title: 'Rodéo',
            volumeNumber: 2,
            authors: ['Morris'],
            isbn13s: ['9782800100029'],
            publisher: 'Dupuis',
            pageCount: 48,
            bnfEnsembleId: '40000001',
            contentKind: 'illustrated',
            source: 'bnf'
          }
        ],
        '40000002': [
          {
            title: 'La Mine d’or de Dick Digger',
            volumeNumber: 1,
            authors: ['Morris'],
            isbn13s: ['9782205000016'],
            publisher: 'Dargaud',
            pageCount: 48,
            bnfEnsembleId: '40000002',
            contentKind: 'illustrated',
            source: 'bnf'
          },
          {
            title: 'Rodéo',
            volumeNumber: 2,
            authors: ['Morris'],
            isbn13s: ['9782205000023'],
            publisher: 'Dargaud',
            pageCount: 48,
            bnfEnsembleId: '40000002',
            contentKind: 'illustrated',
            source: 'bnf'
          },
          {
            title: 'La Diligence',
            volumeNumber: 32,
            authors: ['Morris', 'René Goscinny'],
            isbn13s: ['9782205000320'],
            publisher: 'Dargaud',
            pageCount: 48,
            bnfEnsembleId: '40000002',
            contentKind: 'illustrated',
            source: 'bnf'
          }
        ]
      }
    });
    connectorsBd.bnf.searchBySeriesName = async () => ({
      discoveredEnsembleIds: ['40000001', '40000002'],
      works: [
        {
          title: 'La Mine d’or de Dick Digger',
          volumeNumber: 1,
          authors: ['Morris'],
          isbn13s: ['9782800100012'],
          publisher: 'Dupuis',
          pageCount: 48,
          bnfEnsembleId: '40000001',
          contentKind: 'illustrated',
          source: 'bnf'
        },
        {
          title: 'La Diligence',
          volumeNumber: 32,
          authors: ['Morris', 'René Goscinny'],
          isbn13s: ['9782205000320'],
          publisher: 'Dargaud',
          pageCount: 48,
          bnfEnsembleId: '40000002',
          contentKind: 'illustrated',
          source: 'bnf'
        }
      ]
    });

    const seriesGraphBd = new SeriesGraphService({ catalogRepo, connectors: connectorsBd });
    const { series: llSeries } = seriesGraphBd.resolveOrCreateSeriesCut({
      seriesName: "Lucky Luke — L'Intégrale",
      bookTitle: "Lucky Luke Intégrale T.1",
      volumeNumber: 1,
      isHorsSerie: false,
      isIntegral: true,
      pageCount: 160,
      publisher: 'Dupuis',
      mainCategory: 'BD',
      authors: ['Morris'],
      now
    });

    // Seule l'intégrale 160 p. existe en base avant l'expansion
    catalogRepo.upsertBookAutomatic({
      id: 'bk_ll_int_1',
      workCanonicalId: 'isbn:9782800160009',
      seriesId: llSeries.id,
      title: 'Lucky Luke Intégrale T.1',
      normalizedTitle: 'lucky luke integrale t 1',
      volumeNumber: 1,
      volumeLabel: 'Int. 1',
      sortOrder: 10001,
      isHorsSerie: false,
      isIntegral: true,
      includedVolumes: ['1', '2'],
      authors: ['Morris'],
      scriptwriters: [],
      illustrators: [],
      publisher: 'Dupuis',
      collectionName: null,
      publishYear: '2016',
      pageCount: 160,
      description: null,
      language: 'fr',
      mainCategory: 'BD',
      subgenres: [],
      coverKey: null,
      wikidataQid: null,
      inventaireUri: null,
      sourceOrigin: 'auto',
      now
    });

    await seriesGraphBd.expandSeriesByGraph(llSeries.id);
    const llBooks = catalogRepo.listBooksBySeriesId(llSeries.id);
    const llUnitary = llBooks.filter((b) => b.is_integral === 0);
    const llIntegrals = llBooks.filter((b) => b.is_integral === 1);

    // L'intégrale 160 p. n'a bloqué aucun tome unitaire (48 p.) et Dupuis + Dargaud ont fusionné proprement !
    expect(llUnitary.map((b) => b.volume_number).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2, 32]);
    expect(llIntegrals).toHaveLength(1);
    expect(llIntegrals[0].id).toBe('bk_ll_int_1');
  });

  it('Cas 19 (Vague 1 — Catégorisation 2 paliers + langue originale MARC 041$h + protection anti-écrasement series_expand)', async () => {
    const { parseMarcRecord } = await import('../../../shared/bibliographic/intermarc-parser');
    const { classifyBookMetadata } = await import('../../../shared/bibliographic/category-classifier');

    // 1. MARC 041$h=jpn + 051$a=sti -> Manga ; MARC 041$h=jpn + Dewey 895.63 -> Roman (zéro faux positif Manga sur roman japonais)
    const vinlandXml = `
      <mxc:record>
        <mxc:datafield tag="020"><mxc:subfield code="a">978-2-35142-932-7</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="041"><mxc:subfield code="a">fre</mxc:subfield><mxc:subfield code="h">jpn</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="051"><mxc:subfield code="a">sti</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="245"><mxc:subfield code="a">Vinland saga</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="460"><mxc:subfield code="t">Vinland saga</mxc:subfield><mxc:subfield code="v">13</mxc:subfield></mxc:datafield>
      </mxc:record>`;
    const parsedVinland = parseMarcRecord(vinlandXml);
    expect(parsedVinland?.originalLanguage).toBe('jpn');
    expect(
      classifyBookMetadata({
        title: parsedVinland?.title,
        series: parsedVinland?.ensembleSeriesName,
        contentKind: parsedVinland?.contentKind,
        originalLanguage: parsedVinland?.originalLanguage
      })
    ).toMatchObject({ mainCategory: 'Manga', confidence: 'explicit' });

    const murakamiXml = `
      <mxc:record>
        <mxc:datafield tag="020"><mxc:subfield code="a">978-2-264-04507-2</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="041"><mxc:subfield code="a">fre</mxc:subfield><mxc:subfield code="h">jpn</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="051"><mxc:subfield code="a">txt</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="245"><mxc:subfield code="a">Kafka sur le rivage</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="676"><mxc:subfield code="a">895.63</mxc:subfield></mxc:datafield>
      </mxc:record>`;
    const parsedMurakami = parseMarcRecord(murakamiXml);
    expect(
      classifyBookMetadata({
        title: parsedMurakami?.title,
        deweyCode: parsedMurakami?.deweyCode,
        contentKind: parsedMurakami?.contentKind,
        originalLanguage: parsedMurakami?.originalLanguage
      }).mainCategory
    ).toBe('Roman');

    // 2. BD française avec BISAC Google Books "Comics & Graphic Novels" reste BD ; comics US traduit de l'anglais (041$h=eng + 741.5) -> Comics
    expect(
      classifyBookMetadata({
        title: "Peau d'homme",
        publisher: 'Glénat',
        deweyCode: '741.5',
        rawSubjects: ['Bandes dessinées', 'Comics & Graphic Novels'],
        contentKind: 'illustrated'
      }).mainCategory
    ).toBe('BD');

    expect(
      classifyBookMetadata({
        title: 'Au nom du diable',
        series: 'Hellboy',
        deweyCode: '741.5',
        rawSubjects: ['Bandes dessinées'],
        contentKind: 'illustrated',
        originalLanguage: 'eng'
      }).mainCategory
    ).toBe('Comics');

    // 3. Essai Dewey 330 dont la description cite "récit" et "adapté en bande dessinée" reste Essai
    expect(
      classifyBookMetadata({
        title: 'Le Capital au XXIe siècle',
        deweyCode: '330.1',
        description: 'Un grand récit économique qui a même été adapté en bande dessinée.'
      }).mainCategory
    ).toBe('Essai');

    // 4. expandSeriesByGraph ne rétrograde JAMAIS un tome Manga ou Roman en BD et propage la catégorie de la graine aux squelettes
    const now = new Date().toISOString();
    const connectors = createMockConnectors({
      wikidataSeries: {
        Q100001: [
          { title: 'Vinland Saga, tome 1', volumeNumber: 1, volumeLabel: '1', sortOrder: 1, wikidataQid: 'Q100101', authors: ['Makoto Yukimura'], isbn13s: [], source: 'wikidata' },
          { title: 'Vinland Saga, tome 13', volumeNumber: 13, volumeLabel: '13', sortOrder: 13, wikidataQid: 'Q100113', authors: ['Makoto Yukimura'], isbn13s: ['9782351429327'], source: 'wikidata' }
        ]
      }
    });
    const seriesGraph = new SeriesGraphService({ catalogRepo, connectors });
    const { series: vsSeries } = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'Vinland Saga',
      bookTitle: 'Vinland Saga, tome 13',
      volumeNumber: 13,
      isHorsSerie: false,
      isIntegral: false,
      wikidataSeriesQid: 'Q100001',
      mainCategory: 'Manga',
      authors: ['Makoto Yukimura'],
      now
    });
    catalogRepo.upsertBookAutomatic({
      id: 'bk_vs_13',
      workCanonicalId: 'wd:Q100113',
      seriesId: vsSeries.id,
      title: 'Vinland Saga, tome 13',
      normalizedTitle: 'vinland saga tome 13',
      volumeNumber: 13,
      volumeLabel: '13',
      sortOrder: 13,
      isHorsSerie: false,
      isIntegral: false,
      includedVolumes: [],
      authors: ['Makoto Yukimura'],
      scriptwriters: [],
      illustrators: [],
      publisher: 'Kurokawa',
      collectionName: null,
      publishYear: '2014',
      pageCount: 208,
      description: 'Manga historique viking.',
      language: 'fr',
      mainCategory: 'Manga',
      subgenres: ['Historique'],
      coverKey: null,
      wikidataQid: 'Q100113',
      inventaireUri: null,
      sourceOrigin: 'auto',
      now
    });

    await seriesGraph.expandSeriesByGraph(vsSeries.id);
    const vsBooks = catalogRepo.listBooksBySeriesId(vsSeries.id);
    expect(vsBooks).toHaveLength(2);
    expect(vsBooks.every((b) => b.main_category === 'Manga')).toBe(true);
  });

  it('Cas 20 (Vague 1 — PhotoAiService.searchBookCandidates : anti-hors-sujet, séparation média (BD), passe relâchée Deluxe et départage éditeur)', async () => {
    const { PhotoAiService } = await import('../photo-ai.service');
    const now = new Date().toISOString();

    // Pré-insère le ROMAN "La Horde du Contrevent" dans le catalogue local :
    // une recherche "La Horde du Contrevent (BD) Tome 1" NE doit PAS court-circuiter sur le roman local !
    catalogRepo.upsertBookAutomatic({
      id: 'bk_horde_roman',
      workCanonicalId: 'isbn:9782070342266',
      seriesId: null,
      title: 'La Horde du Contrevent',
      normalizedTitle: 'la horde du contrevent',
      volumeNumber: null,
      volumeLabel: null,
      sortOrder: null,
      isHorsSerie: false,
      isIntegral: false,
      includedVolumes: [],
      authors: ['Alain Damasio'],
      scriptwriters: [],
      illustrators: [],
      publisher: 'Folio SF',
      collectionName: 'Folio SF',
      publishYear: '2007',
      pageCount: 736,
      description: 'Roman de science-fiction.',
      language: 'fr',
      mainCategory: 'Roman',
      subgenres: ['Science-Fiction'],
      coverKey: null,
      wikidataQid: null,
      inventaireUri: null,
      sourceOrigin: 'auto',
      now
    });
    catalogRepo.upsertBookEdition({
      isbn13: '9782070342266',
      bookId: 'bk_horde_roman',
      publisher: 'Folio SF',
      collectionName: 'Folio SF',
      publishYear: '2007',
      pageCount: 736,
      coverKey: null,
      source: 'bnf',
      now
    });

    const mockConnectors = createMockConnectors({});
    mockConnectors.bnf.searchByTitleAndAuthor = async (query: string) => {
      const q = query.toLowerCase();
      // Cas Blast Tome II -> BnF renvoie un faux résultat hors-sujet "Persepolis - Tome II"
      if (q.includes('blast')) {
        return [
          {
            source: 'bnf',
            isbn13: '9782844140791',
            title: 'Persepolis',
            seriesName: 'Persepolis',
            volumeNumber: '2',
            authors: ['Marjane Satrapi'],
            scriptwriters: [],
            illustrators: ['Marjane Satrapi'],
            publisher: "L'Association",
            rawSubjects: ['Bandes dessinées'],
            contentKind: 'illustrated'
          }
        ];
      }
      // Cas La Horde du Contrevent (BD) Tome 1
      if (q.includes('horde du contrevent')) {
        return [
          {
            source: 'bnf',
            isbn13: '9782070342266',
            title: 'La Horde du Contrevent',
            authors: ['Alain Damasio'],
            scriptwriters: [],
            illustrators: [],
            publisher: 'Folio SF',
            deweyCode: '843',
            rawSubjects: ['Roman'],
            contentKind: 'text_only'
          },
          {
            source: 'bnf',
            isbn13: '9782756067254',
            title: 'Le cosmos est mon campement',
            seriesName: 'La Horde du Contrevent',
            volumeNumber: '1',
            authors: ['Éric Henninot', 'Alain Damasio'],
            scriptwriters: [],
            illustrators: ['Éric Henninot'],
            publisher: 'Delcourt',
            deweyCode: '741.5',
            rawSubjects: ['Bandes dessinées'],
            contentKind: 'illustrated'
          }
        ];
      }
      // Cas bleach deluxe t2 -> strict échoue, passe relâchée "bleach 2" renvoie classique + Deluxe
      if (q === 'bleach deluxe') return [];
      if (q.includes('bleach')) {
        return [
          {
            source: 'bnf',
            isbn13: '9782723442282',
            title: 'Goodbye Parakeet, Goodnite My Sista',
            seriesName: 'Bleach',
            volumeNumber: '2',
            authors: ['Tite Kubo'],
            scriptwriters: [],
            illustrators: ['Tite Kubo'],
            publisher: 'Glénat',
            originalLanguage: 'jpn',
            rawSubjects: ['Mangas'],
            contentKind: 'illustrated'
          },
          {
            source: 'bnf',
            isbn13: '9782344058121',
            title: 'Bleach Deluxe',
            seriesName: 'Bleach',
            volumeNumber: '2',
            authors: ['Tite Kubo'],
            scriptwriters: [],
            illustrators: ['Tite Kubo'],
            publisher: 'Glénat',
            collectionName: 'Shonen Deluxe',
            originalLanguage: 'jpn',
            rawSubjects: ['Mangas'],
            contentKind: 'illustrated'
          }
        ];
      }
      // Cas guide dérivé vs roman original ("Eragon") et France Loisirs vs Gallimard ("Chanson douce")
      if (q.includes('eragon')) {
        return [
          {
            source: 'bnf',
            isbn13: '9782747021111',
            title: "Les mondes magiques d'Eragon",
            authors: ['Lois H. Gresh'],
            scriptwriters: [],
            illustrators: [],
            publisher: 'Bayard',
            rawSubjects: ['Guide'],
            contentKind: 'text_only'
          },
          {
            source: 'bnf',
            isbn13: '9782747014403',
            title: 'Eragon',
            authors: ['Christopher Paolini'],
            scriptwriters: [],
            illustrators: [],
            publisher: 'Bayard Jeunesse',
            rawSubjects: ['Roman'],
            contentKind: 'text_only'
          }
        ];
      }
      if (q.includes('chanson douce')) {
        return [
          {
            source: 'bnf',
            isbn13: '9782298127003',
            title: 'Chanson douce',
            authors: ['Leïla Slimani'],
            scriptwriters: [],
            illustrators: [],
            publisher: 'Éditions France loisirs',
            rawSubjects: ['Roman'],
            contentKind: 'text_only'
          },
          {
            source: 'bnf',
            isbn13: '9782070196678',
            title: 'Chanson douce',
            authors: ['Leïla Slimani'],
            scriptwriters: [],
            illustrators: [],
            publisher: 'Gallimard',
            rawSubjects: ['Roman'],
            contentKind: 'text_only'
          }
        ];
      }
      return [];
    };

    const photoAi = new PhotoAiService({
      config: { monthlyAiQuota: 30 } as never,
      gemini: { isConfigured: () => false } as never,
      connectors: mockConnectors,
      userRepo: {} as never,
      catalogRepo,
      libraryRepo: {} as never,
      jobRepo: {} as never,
      coverService: {
        ingestFromExternalUrl: async () => null,
        resolveBestCoverFromCascade: async () => null,
        readCoverBinary: async () => null
      } as never,
      ingestionService: {} as never,
      libraryService: {} as never
    });

    // 1. Anti-hors-sujet : "Blast Tome II" rejette "Persepolis - Tome II"
    const blastOpts = await photoAi.searchBookCandidates({ title: 'Blast Tome II', author: 'Manu Larcenet' });
    expect(blastOpts).toHaveLength(0);

    // 2. Séparation média : "La Horde du Contrevent (BD) Tome 1" sélectionne la BD Delcourt et NON le roman local
    const hordeOpts = await photoAi.searchBookCandidates({ title: 'La Horde du Contrevent (BD) Tome 1' });
    expect(hordeOpts[0]?.isbn13).toBe('9782756067254');

    // 3. Passe relâchée + bonus qualificatif : "bleach deluxe t2" retrouve l'édition Deluxe en #1
    const bleachOpts = await photoAi.searchBookCandidates({ title: 'bleach deluxe t2', publisher: 'Glenat' });
    expect(bleachOpts[0]?.isbn13).toBe('9782344058121');

    // 4. Pénalité guide dérivé : "Eragon" bat "Les mondes magiques d'Eragon"
    const eragonOpts = await photoAi.searchBookCandidates({ title: 'Eragon', author: 'Christopher Paolini' });
    expect(eragonOpts[0]?.isbn13).toBe('9782747014403');

    // 5. Départage club : Gallimard bat France Loisirs à pertinence égale (sans jamais fusionner/bloquer si seul)
    const chansonOpts = await photoAi.searchBookCandidates({ title: 'Chanson douce', author: 'Leïla Slimani' });
    expect(chansonOpts[0]?.isbn13).toBe('9782070196678');
  });

  it('Cas 21 (Vague 2 — Collection Blanche / Bibliothèque Charpentier, anti-fragmentation La Comédie humaine & Beastars, intégrales 300$a)', async () => {
    const { CollectionGuardService } = await import('./collection-guard.service');
    const { ComparisonTableService } = await import('./comparison-table.service');
    const now = new Date().toISOString();

    // 1. CollectionGuard : "Collection Blanche" (P179) et "Bibliothèque Charpentier" (460) sont testés par hétérogénéité d'auteurs et rejetés,
    //    tandis qu'une vraie série mono-auteur "La Bibliothèque invisible" est acceptée !
    const guard = new CollectionGuardService();
    const blancheVerdict = await guard.evaluateCandidate({
      candidateName: 'Collection Blanche',
      linkKind: 'graph_p179',
      allColumns: [
        {
          source: 'wikidata',
          isbn13: '9782070196678',
          title: 'Chanson douce',
          seriesName: 'Collection Blanche',
          seriesLinkKind: 'graph_p179',
          authors: ['Leïla Slimani'],
          scriptwriters: [],
          illustrators: [],
          rawSubjects: []
        }
      ],
      preloadedSample: [
        { title: 'Chanson douce', authors: ['Leïla Slimani'] },
        { title: 'La Plus Secrète Mémoire des hommes', authors: ['Mohamed Mbougar Sarr'] },
        { title: 'Le Lambeau', authors: ['Philippe Lançon'] },
        { title: 'Sérotonine', authors: ['Michel Houellebecq'] }
      ]
    });
    expect(blancheVerdict.verdict).toBe('collection');

    const invisibleLibVerdict = await guard.evaluateCandidate({
      candidateName: 'La Bibliothèque invisible',
      linkKind: 'graph_p179',
      volumeNumber: '1',
      allColumns: [],
      preloadedSample: [
        { title: 'The Invisible Library', authors: ['Genevieve Cogman'], volumeNumber: '1' },
        { title: 'The Masked City', authors: ['Genevieve Cogman'], volumeNumber: '2' },
        { title: 'The Burning Page', authors: ['Genevieve Cogman'], volumeNumber: '3' }
      ]
    });
    expect(invisibleLibVerdict.verdict).toBe('series');

    // 2. Anti-fragmentation cycle prose : "La Comédie humaine" (Folio + Le Livre de poche. Classique) -> 1 seule série !
    const connectors = createMockConnectors({});
    const seriesGraph = new SeriesGraphService({ catalogRepo, connectors });
    const cut1 = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'La Comédie humaine',
      bookTitle: 'Le Père Goriot',
      volumeNumber: 1,
      isHorsSerie: false,
      isIntegral: false,
      publisher: 'Gallimard',
      collectionName: 'Collection Folio',
      pageCount: 380,
      mainCategory: 'Roman',
      authors: ['Honoré de Balzac'],
      now
    });
    catalogRepo.upsertBookAutomatic({
      id: 'bk_balzac_1',
      workCanonicalId: 'isbn:9782070360017',
      seriesId: cut1.series.id,
      title: 'Le Père Goriot',
      normalizedTitle: 'le pere goriot',
      volumeNumber: 1,
      volumeLabel: '1',
      sortOrder: 1,
      isHorsSerie: false,
      isIntegral: false,
      includedVolumes: [],
      authors: ['Honoré de Balzac'],
      scriptwriters: [],
      illustrators: [],
      publisher: 'Gallimard',
      collectionName: 'Collection Folio',
      publishYear: '1995',
      pageCount: 380,
      description: null,
      language: 'fr',
      mainCategory: 'Roman',
      subgenres: [],
      coverKey: null,
      wikidataQid: null,
      inventaireUri: null,
      sourceOrigin: 'auto',
      now
    });
    const cut2 = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'La Comédie humaine',
      bookTitle: 'Illusions perdues',
      volumeNumber: 1, // Numérotation divergente d'une autre collection poche !
      isHorsSerie: false,
      isIntegral: false,
      publisher: 'Le Livre de poche',
      collectionName: 'Le Livre de poche. Classique',
      pageCount: 780,
      mainCategory: 'Roman',
      authors: ['Honoré de Balzac'],
      now
    });
    expect(cut2.series.id).toBe(cut1.series.id);

    // 3. Anti-duplication manga même éditeur & pagination identique : Beastars (squelette Wikidata sans collection + BnF Ki-oon seinen 192p) -> 1 seule série !
    const beast1 = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'Beastars',
      bookTitle: 'Beastars, vol. 1',
      volumeNumber: 1,
      isHorsSerie: false,
      isIntegral: false,
      publisher: 'Ki-oon',
      collectionName: null,
      pageCount: 192,
      mainCategory: 'Manga',
      authors: ['Paru Itagaki'],
      now
    });
    catalogRepo.upsertBookAutomatic({
      id: 'bk_beast_1',
      workCanonicalId: 'wd:Q555001',
      seriesId: beast1.series.id,
      title: 'Beastars, vol. 1',
      normalizedTitle: 'beastars vol 1',
      volumeNumber: 1,
      volumeLabel: '1',
      sortOrder: 1,
      isHorsSerie: false,
      isIntegral: false,
      includedVolumes: [],
      authors: ['Paru Itagaki'],
      scriptwriters: [],
      illustrators: ['Paru Itagaki'],
      publisher: 'Ki-oon',
      collectionName: null,
      publishYear: '2019',
      pageCount: 192,
      description: null,
      language: 'fr',
      mainCategory: 'Manga',
      subgenres: [],
      coverKey: null,
      wikidataQid: 'Q555001',
      inventaireUri: null,
      sourceOrigin: 'auto',
      now
    });
    const beast2 = seriesGraph.resolveOrCreateSeriesCut({
      seriesName: 'Beastars',
      bookTitle: 'Legoshi le loup',
      volumeNumber: 1,
      isHorsSerie: false,
      isIntegral: false,
      publisher: 'Ki-oon',
      collectionName: 'Ki-oon seinen',
      pageCount: 196,
      mainCategory: 'Manga',
      authors: ['Paru Itagaki'],
      now
    });
    expect(beast2.series.id).toBe(beast1.series.id);

    // 4. ComparisonTableService : extrait includedVolumes ['1'..'9'] depuis integralNotes MARC 300$a pour Les Passagers du vent
    const tableSvc = new ComparisonTableService({ connectors, collectionGuard: guard });
    const draft = await tableSvc.arbitrateColumns('9782413081692', [
      {
        source: 'bnf',
        isbn13: '9782413081692',
        title: 'Les Passagers du vent',
        seriesName: "Les Passagers du vent : l'intégrale",
        seriesLinkKind: 'marc_ensemble_460',
        authors: ['François Bourgeon'],
        scriptwriters: ['François Bourgeon'],
        illustrators: ['François Bourgeon'],
        publisher: 'Delcourt',
        pageCount: 612,
        deweyCode: '741.5',
        rawSubjects: ['Bandes dessinées'],
        isIntegralHint: true,
        integralNotes: 'Éd. intégrale ; Réunit les tomes 1 à 9.',
        contentKind: 'illustrated'
      }
    ]);
    expect(draft?.isIntegral).toBe(true);
    expect(draft?.includedVolumes).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  it('Cas 22 (Vague 3 — Catégories BD/895.1/séries, Œuvres complètes, entonnoir omnibox + Google Books / Open Library)', async () => {
    const { classifyBookMetadata } = await import('../../../shared/bibliographic/category-classifier');
    const { CollectionGuardService } = await import('./collection-guard.service');
    const { PhotoAiService } = await import('../photo-ai.service');

    // 1. Open Library "Comic books, strips, etc." sur BD franco-belge reste BD (pas Comics !)
    expect(
      classifyBookMetadata({
        title: "Un océan d'amour",
        publisher: 'Delcourt',
        rawSubjects: ['Romans graphiques', 'Comic books, strips, etc.', 'Graphic novels'],
        contentKind: 'illustrated'
      }).mainCategory
    ).toBe('BD');

    // 2. Dewey 895.13 (littérature chinoise : Liu Cixin) -> Roman (pas Poésie / Théâtre !), tandis que 841.91 -> Poésie / Théâtre
    expect(
      classifyBookMetadata({
        title: 'Le Problème à trois corps',
        deweyCode: '895.13',
        contentKind: 'text_only'
      }).mainCategory
    ).toBe('Roman');
    expect(
      classifyBookMetadata({
        title: 'Alcools',
        deweyCode: '841.91',
        contentKind: 'text_only'
      }).mainCategory
    ).toBe('Poésie / Théâtre');

    // 3. Un titre d'album contenant "histoire" / "philosophie" dans une série BD/Manga ne bascule pas en Essai
    expect(
      classifyBookMetadata({
        title: "L'histoire de Nathan",
        series: 'Louca',
        publisher: 'Dupuis',
        contentKind: 'illustrated'
      }).mainCategory
    ).toBe('BD');
    expect(
      classifyBookMetadata({
        title: 'La philosophie des hommes',
        series: 'Rookies',
        originalLanguage: 'jpn',
        contentKind: 'illustrated'
      }).mainCategory
    ).toBe('Manga');

    // 4. CollectionGuard rejette "Œuvres complètes / Roberto Bolaño" et "Collection RPG" sans échantillon homogène
    const guard = new CollectionGuardService();
    const oeuvresVerdict = await guard.evaluateCandidate({
      candidateName: 'Œuvres complètes / Roberto Bolaño',
      linkKind: 'marc_ensemble_460',
      allColumns: []
    });
    expect(oeuvresVerdict.verdict).toBe('collection');

    const colRpgVerdict = await guard.evaluateCandidate({
      candidateName: 'Collection RPG',
      linkKind: 'marc_ensemble_460',
      allColumns: []
    });
    expect(colRpgVerdict.verdict).toBe('collection');

    // 5. PhotoAiService entonnoir Vague 3 : anti-hors-sujet mots génériques, rejet EAN presse 378 & japonais plein cadre,
    //    fallback bib.anywhere, découpage Titre/Auteur, ultime recours Google Books / Open Library, et roman original vs BD
    const mockConnectors = createMockConnectors({});
    mockConnectors.bnf.searchByTitleAndAuthor = async (title: string, author?: string) => {
      const q = title.toLowerCase();
      const a = (author ?? '').toLowerCase();
      // Cas "Les Innommables - Intégrale Cycle zéro" : BnF renvoie un faux hit "Fondation Intégrale Tome 1"
      if (q.includes('innommables') || q.includes('cycle')) {
        return [
          {
            source: 'bnf',
            isbn13: '9782070463626',
            title: 'Le cycle de Fondation Intégrale Tome 1',
            seriesName: 'Cycle de Fondation',
            authors: ['Isaac Asimov'],
            scriptwriters: [],
            illustrators: [],
            publisher: 'Gallimard',
            rawSubjects: ['Roman'],
            isIntegralHint: true,
            language: 'fre',
            contentKind: 'text_only'
          }
        ];
      }
      // Cas rejet EAN presse 378... et titre japonais non-latin
      if (q.includes('bois maury')) {
        return [
          {
            source: 'bnf',
            isbn13: '3780551512999',
            title: 'Les Tours de Bois-Maury',
            authors: ['Hermann'],
            scriptwriters: [],
            illustrators: [],
            rawSubjects: ['Bandes dessinées']
          },
          {
            source: 'bnf',
            isbn13: '9782723407748',
            title: 'ＭＦゴースト（５）',
            authors: ['Hermann'],
            scriptwriters: [],
            illustrators: [],
            rawSubjects: ['Mangas']
          }
        ];
      }
      // Cas découpage Titre/Auteur (Secours F2) : "Les Contes de la rue Broca" + "Pierre Gripari"
      if (q.includes('contes de la rue broca') && a.includes('gripari')) {
        return [
          {
            source: 'bnf',
            isbn13: '9782710300250',
            title: 'Les Contes de la rue Broca',
            authors: ['Pierre Gripari'],
            scriptwriters: [],
            illustrators: [],
            publisher: 'La Table ronde',
            language: 'fre',
            rawSubjects: ['Jeunesse'],
            contentKind: 'text_only'
          }
        ];
      }
      // Cas roman original vs adaptation BD ("L'île du docteur Moreau" + "H.G. Wells")
      if (q.includes('docteur moreau')) {
        return [
          {
            source: 'bnf',
            isbn13: '9782344042007',
            title: "L'Île du docteur Moreau",
            authors: ['Stéphane Betbeder', 'Fabrizio Fiorentino', 'Herbert George Wells'],
            scriptwriters: ['Stéphane Betbeder'],
            illustrators: ['Fabrizio Fiorentino'],
            publisher: 'Glénat',
            language: 'fre',
            deweyCode: '741.5',
            rawSubjects: ['Bandes dessinées'],
            contentKind: 'illustrated'
          },
          {
            source: 'bnf',
            isbn13: '9782070401789',
            title: "L'Île du docteur Moreau",
            authors: ['Herbert George Wells'],
            scriptwriters: [],
            illustrators: [],
            publisher: 'Gallimard',
            language: 'fre',
            deweyCode: '823',
            rawSubjects: ['Roman'],
            contentKind: 'text_only'
          }
        ];
      }
      return [];
    };

    mockConnectors.bnf.searchAnywhere = async (query: string) => {
      if (query.toLowerCase().includes('sisyphe') && query.toLowerCase().includes('camus')) {
        return [
          {
            source: 'bnf',
            isbn13: '9782070322886',
            title: 'Le Mythe de Sisyphe',
            authors: ['Albert Camus'],
            scriptwriters: [],
            illustrators: [],
            publisher: 'Gallimard',
            language: 'fre',
            deweyCode: '194',
            rawSubjects: ['Philosophie'],
            contentKind: 'text_only'
          }
        ];
      }
      return [];
    };

    mockConnectors.googleBooks.searchByText = async (query: string) => {
      if (query.toLowerCase().includes('spqr') || query.toLowerCase().includes('s p q r')) {
        return [
          {
            source: 'google_books',
            isbn13: '9782262048716',
            title: "SPQR : Histoire de l'ancienne Rome",
            authors: ['Mary Beard'],
            scriptwriters: [],
            illustrators: [],
            publisher: 'Perrin',
            language: 'fr',
            rawSubjects: ['History']
          }
        ];
      }
      return [];
    };

    const photoAi = new PhotoAiService({
      config: { monthlyAiQuota: 30 } as never,
      gemini: { isConfigured: () => false } as never,
      connectors: mockConnectors,
      userRepo: {} as never,
      catalogRepo,
      libraryRepo: {} as never,
      jobRepo: {} as never,
      coverService: {
        ingestFromExternalUrl: async () => null,
        resolveBestCoverFromCascade: async () => null,
        readCoverBinary: async () => null
      } as never,
      ingestionService: {} as never,
      libraryService: {} as never
    });

    // 5a. Mots génériques ("Intégrale Cycle zéro") ne matchent PLUS Fondation si la série est "Les Innommables"
    const innomOpts = await photoAi.searchBookCandidates({
      title: 'Intégrale Cycle zéro',
      series: 'Les Innommables',
      isIntegral: true
    });
    expect(innomOpts).toHaveLength(0);

    // 5b. EAN presse 378... et titre japonais plein cadre sont bloqués par toOption
    const boisOpts = await photoAi.searchBookCandidates({ title: 'Les Tours de Bois-Maury', author: 'Hermann' });
    expect(boisOpts).toHaveLength(0);

    // 5c. Secours F1 bib.anywhere : "mythe de sisyphe camus" trouve Le Mythe de Sisyphe d'Albert Camus
    const camusOpts = await photoAi.searchBookCandidates({ title: 'mythe de sisyphe camus' });
    expect(camusOpts[0]?.isbn13).toBe('9782070322886');

    // 5d. Secours F2 découpage Titre/Auteur : "Les Contes de la rue Broca Pierre Gripari"
    const gripariOpts = await photoAi.searchBookCandidates({ title: 'Les Contes de la rue Broca Pierre Gripari' });
    expect(gripariOpts[0]?.isbn13).toBe('9782710300250');

    // 5e. Secours F3 Google Books officiel quand la BnF renvoie 0
    const spqrOpts = await photoAi.searchBookCandidates({
      title: "S.P.Q.R. : Histoire de l'ancienne Rome",
      author: 'Mary Beard'
    });
    expect(spqrOpts[0]?.isbn13).toBe('9782262048716');

    // 5f. Roman original préféré devant son adaptation BD quand l'utilisateur n'a pas demandé "(BD)"
    const moreauOpts = await photoAi.searchBookCandidates({
      title: "L'île du docteur Moreau",
      author: 'Herbert George Wells'
    });
    expect(moreauOpts[0]?.isbn13).toBe('9782070401789');
  });
});
