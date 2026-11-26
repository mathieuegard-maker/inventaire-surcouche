// src/server/services/series-cover-edition.test.ts
// Tests d'intégration : cohérence automatique des couvertures d'édition par série,
// métadonnées d'édition en galerie, aperçu/propagation Couche 3 Foyer et job de fond Option B.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDatabaseAdapter } from '../db/sqlite.adapter';
import { applySqlMigrations } from '../db/migrator';
import { loadServerConfig } from '../config';
import { createApp } from '../app';
import type { BibliographicConnectors } from '../connectors/types';
import type {
  ApplySeriesEditionCoversResponse,
  BookView,
  CoverCandidateItem,
  SeriesEditionCoverPreviewResponse
} from '../../shared/types/domain.types';

function extractCookie(res: Response): string {
  const raw = res.headers.get('set-cookie') || '';
  const m = raw.match(/biblio_session=([^;]+)/);
  if (!m) throw new Error('Cookie manquant');
  return `biblio_session=${m[1]}`;
}

async function makePngBuffer(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({
    create: { width: 120, height: 180, channels: 3, background: { r, g, b } }
  })
    .png()
    .toBuffer();
}

describe('Cohérence des couvertures d’édition par série & Propagation Couche 3 (Option B)', () => {
  let db: SqliteDatabaseAdapter;
  let tmpCoversDir: string;
  let appCtx: ReturnType<typeof createApp>;
  let cookieA: string;
  let cookieB: string;
  let fetchedCoverPng: Buffer;

  beforeEach(async () => {
    db = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(db, path.resolve(process.cwd(), 'migrations'));
    tmpCoversDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblio-ed-cov-'));
    fetchedCoverPng = await makePngBuffer(210, 120, 45);

    const mockConnectors: BibliographicConnectors = {
      bnf: {
        async lookupByIsbn() {
          return null;
        },
        async searchByEnsembleId() {
          return [];
        },
        async sampleByCollectionName() {
          return [];
        },
        async searchByTitleAndAuthor(title) {
          if (title.toLowerCase().includes('tome 4') || title.toLowerCase().includes('l’empereur') || title.toLowerCase().includes('empereur')) {
            return [
              {
                source: 'bnf',
                isbn13: '9782266154147',
                title: 'L’Empereur-Dieu',
                seriesName: 'Dune',
                volumeNumber: '4',
                authors: ['Frank Herbert'],
                scriptwriters: [],
                illustrators: [],
                publisher: 'Pocket',
                collectionName: 'Science-fiction',
                publishYear: '2021',
                language: 'fr',
                coverUrl: 'https://covers.example.test/dune-4-pocket.png',
                rawSubjects: []
              }
            ];
          }
          return [];
        },
        async searchAnywhere() {
          return [];
        }
      },
      sudoc: { async lookupByIsbn() { return null; } },
      inventaire: {
        async lookupByIsbn() { return null; },
        async fetchSeriesWorks() { return []; }
      },
      wikidata: {
        async lookupWorkByQid() { return null; },
        async fetchSeriesWorksByQid() { return []; }
      },
      googleBooks: { async lookupByIsbn() { return null; } },
      openLibrary: { async lookupByIsbn() { return null; } }
    };

    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://covers.example.test/dune-4-pocket.png') {
        return new Response(new Uint8Array(fetchedCoverPng), {
          status: 200,
          headers: { 'content-type': 'image/png' }
        });
      }
      return new Response(null, { status: 404 });
    };

    appCtx = createApp({
      db,
      config: loadServerConfig({
        NODE_ENV: 'test',
        ADMIN_EMAIL: 'admin@test.local',
        JWT_SECRET: 'test-secret-key-edition-covers-12345',
        COVERS_DIR: tmpCoversDir
      }),
      connectors: mockConnectors,
      coverFetchImpl: mockFetch
    });

    const regA = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'foyerA',
        email: 'admin@test.local',
        password: 'Password123!',
        gdprAccepted: true
      })
    });
    cookieA = extractCookie(regA);

    const regB = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'foyerB',
        email: 'userb@test.local',
        password: 'Password123!',
        gdprAccepted: true
      })
    });
    cookieB = extractCookie(regB);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpCoversDir, { recursive: true, force: true });
  });

  async function seedDuneSeries() {
    const now = new Date().toISOString();
    const { catalogRepo, libraryRepo } = appCtx.repos;
    const { coverService } = appCtx.services;

    // 7 couvertures WebP distinctes
    const covR1 = (await coverService.storeBufferAsWebp(await makePngBuffer(10, 40, 120))).coverKey;
    const covR2 = (await coverService.storeBufferAsWebp(await makePngBuffer(15, 55, 140))).coverKey;
    const covR3 = (await coverService.storeBufferAsWebp(await makePngBuffer(20, 70, 160))).coverKey;
    const covR4 = (await coverService.storeBufferAsWebp(await makePngBuffer(25, 85, 180))).coverKey;
    const covP1 = (await coverService.storeBufferAsWebp(await makePngBuffer(200, 50, 30))).coverKey;
    const covP2 = (await coverService.storeBufferAsWebp(await makePngBuffer(220, 70, 40))).coverKey;
    const covP3 = (await coverService.storeBufferAsWebp(await makePngBuffer(240, 90, 50))).coverKey;
    const covInt = (await coverService.storeBufferAsWebp(await makePngBuffer(90, 20, 130))).coverKey;

    const series = catalogRepo.createSeries({
      id: 'ser_dune',
      franchiseId: null,
      canonicalName: 'Dune',
      normalizedKey: 'dune',
      editionSignature: '',
      aliases: [],
      primaryAuthors: ['Frank Herbert'],
      wikidataQid: null,
      bnfEnsembleIds: [],
      now
    });

    const makeBook = (p: {
      id: string;
      title: string;
      vol: number;
      isIntegral?: boolean;
      included?: string[];
      publisher: string;
      collection?: string | null;
      coverKey: string;
    }) => {
      catalogRepo.upsertBookAutomatic({
        id: p.id,
        workCanonicalId: `test:${p.id}`,
        seriesId: series.id,
        title: p.title,
        normalizedTitle: p.title.toLowerCase(),
        volumeNumber: p.vol,
        volumeLabel: String(p.vol),
        sortOrder: p.isIntegral ? 10000 + p.vol : p.vol,
        isHorsSerie: false,
        isIntegral: Boolean(p.isIntegral),
        includedVolumes: p.included ?? [],
        authors: ['Frank Herbert'],
        scriptwriters: [],
        illustrators: [],
        publisher: p.publisher,
        collectionName: p.collection ?? null,
        publishYear: '2020',
        pageCount: 600,
        description: null,
        language: 'fr',
        mainCategory: 'Roman',
        subgenres: ['Science-Fiction'],
        coverKey: p.coverKey,
        wikidataQid: null,
        inventaireUri: null,
        sourceOrigin: 'auto',
        now
      });
    };

    // T.1 : défaut Robert Laffont, possède aussi Pocket
    makeBook({ id: 'bk_1', title: 'Dune', vol: 1, publisher: 'Robert Laffont', coverKey: covR1 });
    catalogRepo.upsertBookEdition({ isbn13: '9782221249482', bookId: 'bk_1', publisher: 'Robert Laffont', collectionName: 'Ailleurs et Demain', publishYear: '2020', pageCount: 700, coverKey: covR1, source: 'bnf', now });
    catalogRepo.upsertBookEdition({ isbn13: '9782266154116', bookId: 'bk_1', publisher: 'Pocket', collectionName: 'Science-fiction', publishYear: '2020', pageCount: 800, coverKey: covP1, source: 'bnf', now });

    // T.2 : défaut Pocket (hétérogène !), mais possède aussi Robert Laffont (lignée dominante de la série)
    makeBook({ id: 'bk_2', title: 'Le Messie de Dune', vol: 2, publisher: 'Pocket', collection: 'Science-fiction', coverKey: covP2 });
    catalogRepo.upsertBookEdition({ isbn13: '9782266154123', bookId: 'bk_2', publisher: 'Pocket', collectionName: 'Science-fiction', publishYear: '2020', pageCount: 400, coverKey: covP2, source: 'bnf', now });
    catalogRepo.upsertBookEdition({ isbn13: '9782221249499', bookId: 'bk_2', publisher: 'Robert Laffont', collectionName: 'Ailleurs et Demain', publishYear: '2020', pageCount: 380, coverKey: covR2, source: 'bnf', now });

    // T.3 : défaut Robert Laffont, possède aussi Pocket
    makeBook({ id: 'bk_3', title: 'Les Enfants de Dune', vol: 3, publisher: 'Robert Laffont', coverKey: covR3 });
    catalogRepo.upsertBookEdition({ isbn13: '9782221249505', bookId: 'bk_3', publisher: 'Robert Laffont', collectionName: 'Ailleurs et Demain', publishYear: '2020', pageCount: 620, coverKey: covR3, source: 'bnf', now });
    catalogRepo.upsertBookEdition({ isbn13: '9782266154130', bookId: 'bk_3', publisher: 'Pocket', collectionName: 'Science-fiction', publishYear: '2020', pageCount: 650, coverKey: covP3, source: 'bnf', now });

    // T.4 : possède UNIQUEMENT Robert Laffont en base (Pocket manquant -> à chercher via Option B !)
    makeBook({ id: 'bk_4', title: 'L’Empereur-Dieu de Dune', vol: 4, publisher: 'Robert Laffont', coverKey: covR4 });
    catalogRepo.upsertBookEdition({ isbn13: '9782221249512', bookId: 'bk_4', publisher: 'Robert Laffont', collectionName: 'Ailleurs et Demain', publishYear: '2020', pageCount: 610, coverKey: covR4, source: 'bnf', now });

    // Intégrale 1-3 Pocket : ne doit JAMAIS être mélangée à la propagation des tomes unitaires
    makeBook({ id: 'bk_int', title: 'Dune Intégrale 1-3', vol: 1, isIntegral: true, included: ['1', '2', '3'], publisher: 'Pocket', coverKey: covInt });
    catalogRepo.upsertBookEdition({ isbn13: '9782266999999', bookId: 'bk_int', publisher: 'Pocket', collectionName: 'Science-fiction', publishYear: '2021', pageCount: 1500, coverKey: covInt, source: 'bnf', now });

    // Foyer A possède T.1
    const userA = appCtx.repos.userRepo.findByEmail('admin@test.local')!;
    const libA = libraryRepo.findLibraryByUserId(userA.id)!;
    libraryRepo.upsertLibraryBookStatus({ libraryId: libA.id, bookId: 'bk_1', status: 'owned', now });

    return { series, libA, covR1, covR2, covR3, covR4, covP1, covP2, covP3, covInt };
  }

  it('harmonise automatiquement l’affichage des couvertures vers l’édition dominante tout en respectant Couche 2 Admin et Couche 3 Foyer', async () => {
    const { series, covR2, covP2 } = await seedDuneSeries();

    // 1. Cohérence automatique : T.2 avait covP2 par défaut en base, mais Robert Laffont couvre 4/4 tomes -> affiche covR2 sans marquer hasUserOverrides !
    const res1 = await appCtx.app.request(`/api/series/${series.id}`, {
      headers: { cookie: cookieA }
    });
    expect(res1.status).toBe(200);
    const data1 = (await res1.json()) as { books: BookView[] };
    const bk2View1 = data1.books.find((b) => b.id === 'bk_2')!;
    expect(bk2View1.coverKey).toBe(covR2);
    expect(bk2View1.hasUserOverrides).toBe(false);

    // 2. Primauté Couche 2 Admin : si coverKey est verrouillé sur T.2, l'harmonisation automatique ne l'écrase jamais
    appCtx.repos.catalogRepo.setBookLockedFields('bk_2', ['coverKey'], new Date().toISOString());
    const res2 = await appCtx.app.request(`/api/series/${series.id}`, {
      headers: { cookie: cookieA }
    });
    const data2 = (await res2.json()) as { books: BookView[] };
    expect(data2.books.find((b) => b.id === 'bk_2')!.coverKey).toBe(covP2);

    // 3. Primauté absolue Couche 3 Foyer : un choix utilisateur prime même sur Couche 2 Admin
    const customCov = (await appCtx.services.coverService.storeBufferAsWebp(await makePngBuffer(11, 22, 33))).coverKey;
    const patchRes = await appCtx.app.request('/api/library/books/bk_2', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ coverKey: customCov })
    });
    expect(patchRes.status).toBe(200);

    const res3 = await appCtx.app.request(`/api/series/${series.id}`, {
      headers: { cookie: cookieA }
    });
    const data3 = (await res3.json()) as { books: BookView[] };
    expect(data3.books.find((b) => b.id === 'bk_2')!.coverKey).toBe(customCov);
    expect(data3.books.find((b) => b.id === 'bk_2')!.hasUserOverrides).toBe(true);
  });

  it('attache les métadonnées d’édition en galerie uniquement sur les éditions identifiables (jamais sur upload perso)', async () => {
    const { covP1 } = await seedDuneSeries();

    const customCov = (await appCtx.services.coverService.storeBufferAsWebp(await makePngBuffer(77, 88, 99))).coverKey;
    await appCtx.app.request('/api/library/books/bk_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ coverKey: customCov })
    });

    const res = await appCtx.app.request('/api/books/bk_1/covers', {
      headers: { cookie: cookieA }
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { covers: CoverCandidateItem[] };

    const customItem = body.covers.find((c) => c.coverKey === customCov);
    expect(customItem).toBeDefined();
    expect(customItem?.edition).toBeNull();

    const pocketItem = body.covers.find((c) => c.coverKey === covP1);
    expect(pocketItem).toBeDefined();
    expect(pocketItem?.edition?.publisher).toBe('Pocket');
    expect(pocketItem?.edition?.collectionName).toBe('Science-fiction');
    expect(pocketItem?.edition?.isbnPrefix).toBe('9782266');
  });

  it('prévisualise, propage sur sélection ou toute la série, et exécute le job Option B en Couche 3 isolée par foyer', async () => {
    const { series, covR1, covR3, covR4, covP1, covP2, covP3, covInt } = await seedDuneSeries();

    const pocketTarget = {
      isbn13: '9782266154116',
      publisher: 'Pocket',
      collectionName: 'Science-fiction',
      isbnPrefix: '9782266'
    };

    // 1. Aperçu Pocket depuis T.1 : T.2 et T.3 sont prêts (l'affichage actuel était Robert Laffont), T.4 est manquant, l'Intégrale est exclue
    const prevRes = await appCtx.app.request(`/api/series/${series.id}/covers/preview-edition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ sourceBookId: 'bk_1', targetEdition: pocketTarget })
    });
    expect(prevRes.status).toBe(200);
    const preview = (await prevRes.json()) as { ok: true } & SeriesEditionCoverPreviewResponse;
    expect(preview.totalCount).toBe(3); // T.2, T.3, T.4 (Intégrale exclue)
    expect(preview.readyCount).toBe(2); // T.2 & T.3
    expect(preview.missingCount).toBe(1); // T.4
    expect(preview.items.some((i) => i.bookId === 'bk_int')).toBe(false);
    expect(preview.items.find((i) => i.bookId === 'bk_2')?.matchStatus).toBe('ready');
    expect(preview.items.find((i) => i.bookId === 'bk_4')?.matchStatus).toBe('missing');

    // 2. Application sur une SÉLECTION de tomes uniquement (T.2 seulement, pas T.3 ni T.4)
    const selRes = await appCtx.app.request(`/api/series/${series.id}/covers/apply-edition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        sourceBookId: 'bk_1',
        sourceCoverKey: covP1,
        scope: 'selected',
        bookIds: ['bk_2'],
        targetEdition: pocketTarget,
        searchMissingInBackground: false
      })
    });
    expect(selRes.status).toBe(200);
    const selOutcome = (await selRes.json()) as { ok: true } & ApplySeriesEditionCoversResponse;
    expect(selOutcome.appliedBookIds.sort()).toEqual(['bk_1', 'bk_2']);
    expect(selOutcome.backgroundJobId).toBeNull();

    // T.3 est resté en Robert Laffont
    const serMid = await (await appCtx.app.request(`/api/series/${series.id}`, { headers: { cookie: cookieA } })).json() as { books: BookView[] };
    expect(serMid.books.find((b) => b.id === 'bk_1')?.coverKey).toBe(covP1);
    expect(serMid.books.find((b) => b.id === 'bk_2')?.coverKey).toBe(covP2);
    expect(serMid.books.find((b) => b.id === 'bk_3')?.coverKey).toBe(covR3);

    // 3. Application sur TOUTE LA SÉRIE avec Option B (recherche en arrière-plan pour T.4 manquant)
    const allRes = await appCtx.app.request(`/api/series/${series.id}/covers/apply-edition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        sourceBookId: 'bk_1',
        sourceCoverKey: covP1,
        scope: 'all',
        bookIds: [],
        targetEdition: pocketTarget,
        searchMissingInBackground: true
      })
    });
    expect(allRes.status).toBe(200);
    const allOutcome = (await allRes.json()) as { ok: true } & ApplySeriesEditionCoversResponse;
    expect(allOutcome.appliedBookIds.sort()).toEqual(['bk_1', 'bk_2', 'bk_3']);
    expect(allOutcome.missingBookIds).toEqual(['bk_4']);
    expect(allOutcome.backgroundJobId).toBeTruthy();

    // Exécute le job Option B dans le worker
    const ran = await appCtx.worker.processNextJob();
    expect(ran).toBe(true);

    const jobRow = appCtx.repos.jobRepo.findJobById(allOutcome.backgroundJobId!);
    expect(jobRow?.status).toBe('done');
    const jobResult = JSON.parse(jobRow!.result_json || '{}');
    expect(jobResult.updatedCount).toBe(1);
    expect(jobResult.stillMissingCount).toBe(0);

    // Vérifier que T.4 possède désormais l'édition Pocket en `book_editions` ET sa couverture Pocket en Couche 3 pour Foyer A !
    const editionsT4 = appCtx.repos.catalogRepo.listEditionsByBookId('bk_4');
    const pocketEdT4 = editionsT4.find((e) => e.isbn13 === '9782266154147');
    expect(pocketEdT4).toBeDefined();
    expect(pocketEdT4?.publisher).toBe('Pocket');
    expect(pocketEdT4?.cover_key).toBeTruthy();

    const serAfterA = await (await appCtx.app.request(`/api/series/${series.id}`, { headers: { cookie: cookieA } })).json() as { books: BookView[] };
    expect(serAfterA.books.find((b) => b.id === 'bk_1')?.coverKey).toBe(covP1);
    expect(serAfterA.books.find((b) => b.id === 'bk_2')?.coverKey).toBe(covP2);
    expect(serAfterA.books.find((b) => b.id === 'bk_3')?.coverKey).toBe(covP3);
    expect(serAfterA.books.find((b) => b.id === 'bk_4')?.coverKey).toBe(pocketEdT4?.cover_key);
    expect(serAfterA.books.find((b) => b.id === 'bk_int')?.coverKey).toBe(covInt);

    // Vérifier l'étanchéité Couche 3 : Foyer B et Catalogue Central (`books.cover_key`) ne sont PAS modifiés par le choix de Foyer A !
    expect(appCtx.repos.catalogRepo.findBookById('bk_1')?.cover_key).toBe(covR1);
    expect(appCtx.repos.catalogRepo.findBookById('bk_4')?.cover_key).toBe(covR4);

    const serAfterB = await (await appCtx.app.request(`/api/series/${series.id}`, { headers: { cookie: cookieB } })).json() as { books: BookView[] };
    // Foyer B n'a aucune surcharge Couche 3 -> garde la cohérence catalogue (et jamais les overrides de Foyer A)
    expect(serAfterB.books.find((b) => b.id === 'bk_1')?.hasUserOverrides).toBe(false);
    expect(serAfterB.books.find((b) => b.id === 'bk_4')?.hasUserOverrides).toBe(false);
  });
});
