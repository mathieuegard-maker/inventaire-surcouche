// src/server/routes/books-reading.test.ts
// Tests d'intégration Jalon 4 : Lecture individuelle user_id, Primauté Couche 3 (couverture/titre + reset), isolation Catalogue Central et création manuelle + intégrales bidirectionnelles.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDatabaseAdapter } from '../db/sqlite.adapter';
import { applySqlMigrations } from '../db/migrator';
import { loadServerConfig } from '../config';
import { createApp } from '../app';

function extractCookie(res: Response): string {
  const raw = res.headers.get('set-cookie') || '';
  const m = raw.match(/biblio_session=([^;]+)/);
  if (!m) throw new Error('Cookie biblio_session absent');
  return `biblio_session=${m[1]}`;
}

async function makePngDataUrl(r: number, g: number, b: number): Promise<string> {
  const buf = await sharp({
    create: { width: 100, height: 150, channels: 3, background: { r, g, b } }
  })
    .png()
    .toBuffer();
  return `data:image/png;base64,${buf.toString('base64')}`;
}

describe('Jalon 4 — Fiche Livre, Primauté Couche 3, Lecture Individuelle, Intégrales & Création Manuelle', () => {
  let db: SqliteDatabaseAdapter;
  let tmpCoversDir: string;
  let appCtx: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(db, path.resolve(process.cwd(), 'migrations'));
    tmpCoversDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblio-j4-covers-'));
    const config = loadServerConfig({ NODE_ENV: 'test', COVERS_DIR: tmpCoversDir });
    appCtx = createApp({ db, config });
  });

  afterEach(() => {
    appCtx.worker.stop();
    db.close();
    fs.rmSync(tmpCoversDir, { recursive: true, force: true });
  });

  it('isole strictement les statuts de lecture, notes et notes perso entre 2 membres du même foyer (user_id)', async () => {
    const regA = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'LecteurA',
        email: 'la@biblio.test',
        password: 'Password123',
        gdprAccepted: true
      })
    });
    const cookieA = extractCookie(regA);
    const dataA = (await regA.json()) as { profile: { library: { familyInviteCode: string } } };

    const regB = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'LecteurB',
        email: 'lb@biblio.test',
        password: 'Password123',
        gdprAccepted: true,
        inviteCode: dataA.profile.library.familyInviteCode
      })
    });
    const cookieB = extractCookie(regB);

    // Création manuelle d'un livre dans le foyer
    const created = await appCtx.app.request('/api/books/manual', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        title: 'Dune',
        authors: ['Frank Herbert'],
        oneShot: true,
        ownershipStatus: 'owned'
      })
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { book: { id: string } };
    const bookId = createdBody.book.id;

    // Membre A note 5/5 et marque "Lu"
    const putA = await appCtx.app.request(`/api/reading/${bookId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ status: 'read', rating: 5, notes: 'Incroyable selon A' })
    });
    expect(putA.status).toBe(200);

    // Membre B note 3/5 et marque "En cours"
    const putB = await appCtx.app.request(`/api/reading/${bookId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: cookieB },
      body: JSON.stringify({ status: 'reading', rating: 3, notes: 'Chapitre 4 pour B' })
    });
    expect(putB.status).toBe(200);

    // Vérification stricte de l'isolation sur GET /api/books/:bookId
    const detA = await appCtx.app.request(`/api/books/${bookId}`, { headers: { cookie: cookieA } });
    const bodyA = (await detA.json()) as { book: { readingState: { status: string; rating: number; notes: string } } };
    expect(bodyA.book.readingState).toMatchObject({ status: 'read', rating: 5, notes: 'Incroyable selon A' });

    const detB = await appCtx.app.request(`/api/books/${bookId}`, { headers: { cookie: cookieB } });
    const bodyB = (await detB.json()) as { book: { readingState: { status: string; rating: number; notes: string } } };
    expect(bodyB.book.readingState).toMatchObject({ status: 'reading', rating: 3, notes: 'Chapitre 4 pour B' });
  });

  it('garantit la primauté Couche 3 (couverture & titre prioritaires dans fiche et vignette série, Catalogue Central intact, et réinitialisation)', async () => {
    // Foyer 1
    const reg1 = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'Foyer1',
        email: 'f1@biblio.test',
        password: 'Password123',
        gdprAccepted: true
      })
    });
    const cookie1 = extractCookie(reg1);

    // Foyer 2 (indépendant)
    const reg2 = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'Foyer2',
        email: 'f2@biblio.test',
        password: 'Password123',
        gdprAccepted: true
      })
    });
    const cookie2 = extractCookie(reg2);

    // Upload 2 couvertures WebP : une catalogue, une perso Couche 3
    const upCat = await appCtx.app.request('/api/covers/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie1 },
      body: JSON.stringify({ imageDataUrl: await makePngDataUrl(20, 40, 200) })
    });
    const catCover = ((await upCat.json()) as { coverKey: string }).coverKey;

    const upCustom = await appCtx.app.request('/api/covers/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie1 },
      body: JSON.stringify({ imageDataUrl: await makePngDataUrl(200, 80, 20) })
    });
    const customCover = ((await upCustom.json()) as { coverKey: string }).coverKey;

    // Création d'un livre de série avec couverture catalogue
    const created = await appCtx.app.request('/api/books/manual', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie1 },
      body: JSON.stringify({
        title: 'Thorgal : La Magicienne trahie',
        authors: ['Jean Van Hamme', 'Grzegorz Rosinski'],
        seriesName: 'Thorgal',
        volumeNumber: 1,
        oneShot: false,
        coverKey: catCover,
        ownershipStatus: 'owned'
      })
    });
    const bookId = ((await created.json()) as { book: { id: string } }).book.id;

    // Surcharge Couche 3 par Foyer 1 (couverture personnalisée + titre personnalisé)
    const patchRes = await appCtx.app.request(`/api/library/books/${bookId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookie1 },
      body: JSON.stringify({
        title: 'Mon édition collector Thorgal T1',
        coverKey: customCover
      })
    });
    expect(patchRes.status).toBe(200);

    // Foyer 1 voit la couverture Couche 3 sur la fiche ET dans la vignette série de /api/sync/pull !
    const pull1 = await appCtx.app.request('/api/sync/pull', { headers: { cookie: cookie1 } });
    const pull1Body = (await pull1.json()) as {
      books: Array<{ id: string; title: string; coverKey: string; hasUserOverrides: boolean }>;
      series: Array<{ canonicalName: string; coverUrl: string | null }>;
    };
    expect(pull1Body.books[0].title).toBe('Mon édition collector Thorgal T1');
    expect(pull1Body.books[0].coverKey).toBe(customCover);
    expect(pull1Body.books[0].hasUserOverrides).toBe(true);
    expect(pull1Body.series[0].coverUrl).toBe(`/api/covers/${customCover}`);

    // Foyer 2 voit le Catalogue Central intact (séparation stricte Moi ≠ Admin)
    const det2 = await appCtx.app.request(`/api/books/${bookId}`, { headers: { cookie: cookie2 } });
    const det2Body = (await det2.json()) as { book: { title: string; coverKey: string; hasUserOverrides: boolean } };
    expect(det2Body.book.title).toBe('Thorgal : La Magicienne trahie');
    expect(det2Body.book.coverKey).toBe(catCover);
    expect(det2Body.book.hasUserOverrides).toBe(false);

    // Galerie de couvertures dédupliquée contient bien les 2 couvertures pour Foyer 1
    const coversRes = await appCtx.app.request(`/api/books/${bookId}/covers`, { headers: { cookie: cookie1 } });
    const coversBody = (await coversRes.json()) as { covers: Array<{ coverKey?: string }> };
    expect(coversBody.covers.map((c) => c.coverKey)).toEqual([customCover, catCover]);

    // Réinitialisation explicite Couche 3 -> retour aux données automatiques
    const resetRes = await appCtx.app.request(`/api/library/books/${bookId}/overrides`, {
      method: 'DELETE',
      headers: { cookie: cookie1 }
    });
    expect(resetRes.status).toBe(200);
    const resetBody = (await resetRes.json()) as { book: { title: string; coverKey: string; hasUserOverrides: boolean } };
    expect(resetBody.book.title).toBe('Thorgal : La Magicienne trahie');
    expect(resetBody.book.coverKey).toBe(catCover);
    expect(resetBody.book.hasUserOverrides).toBe(false);
  });

  it('gère la création manuelle avec expansion série en job serveur et la couverture intégrale bidirectionnelle', async () => {
    const reg = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'IntegralTester',
        email: 'int@biblio.test',
        password: 'Password123',
        gdprAccepted: true
      })
    });
    const cookie = extractCookie(reg);

    // 1. Création manuelle d'une intégrale T.1-3 possédée avec `expandSeries: true`
    const intRes = await appCtx.app.request('/api/books/manual', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        title: 'Blacksad — Intégrale T1 à T3',
        authors: ['Juan Díaz Canales', 'Juanjo Guarnido'],
        seriesName: 'Blacksad',
        oneShot: false,
        expandSeries: true,
        isIntegral: true,
        includedVolumes: ['1', '2', '3'],
        ownershipStatus: 'owned'
      })
    });
    expect(intRes.status).toBe(201);
    const intBody = (await intRes.json()) as {
      book: { id: string; seriesId: string; isIntegral: boolean; includedVolumes: string[] };
      enqueuedSeriesExpandJobId: string | null;
    };
    expect(intBody.book.isIntegral).toBe(true);
    expect(intBody.book.includedVolumes).toEqual(['1', '2', '3']);
    expect(intBody.enqueuedSeriesExpandJobId).toBeTruthy();

    // 2. Création du Tome 2 non possédé dans la même série -> doit être détecté "Inclus dans l'intégrale" !
    const t2Res = await appCtx.app.request('/api/books/manual', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        title: 'Arctic-Nation',
        authors: ['Juan Díaz Canales', 'Juanjo Guarnido'],
        seriesId: intBody.book.seriesId,
        volumeNumber: 2,
        oneShot: false,
        ownershipStatus: 'none'
      })
    });
    const t2Body = (await t2Res.json()) as {
      book: { id: string; ownedViaIntegral: { integralBookId: string; title: string } | null };
    };
    expect(t2Body.book.ownedViaIntegral).toEqual({
      integralBookId: intBody.book.id,
      title: 'Blacksad — Intégrale T1 à T3',
      isbn13: undefined
    });
  });

  it('trouve des couvertures externes vérifiées sur GET /api/books/:id/covers?external=1 même pour un livre sans ISBN', async () => {
    const validPng = await sharp({
      create: {
        width: 240,
        height: 360,
        channels: 3,
        background: { r: 30, g: 90, b: 160 },
        noise: { type: 'gaussian', mean: 128, sigma: 35 }
      }
    })
      .png()
      .toBuffer();

    const customApp = createApp({
      db,
      config: loadServerConfig({ NODE_ENV: 'test', COVERS_DIR: tmpCoversDir }),
      connectors: {
        bnf: {
          async lookupByIsbn() { return null; },
          async searchByEnsembleId() { return []; },
          async sampleByCollectionName() { return []; },
          async searchByTitleAndAuthor() { return []; }
        },
        sudoc: { async lookupByIsbn() { return null; } },
        inventaire: {
          async lookupByIsbn() { return null; },
          async fetchSeriesWorks() { return []; },
          async fetchWorkEditions(workUri) {
            if (workUri === 'wd:Q3551257') {
              return {
                isbn13s: ['9782849465356'],
                coverUrls: [
                  'https://inventaire.io/img/entities/validhash1234567890',
                  'https://commons.wikimedia.org/wiki/Special:FilePath/ShouldIgnore.jpg'
                ]
              };
            }
            return { isbn13s: [], coverUrls: [] };
          }
        },
        wikidata: {
          async lookupWorkByQid() { return null; },
          async fetchSeriesWorksByQid() { return []; }
        },
        googleBooks: {
          async lookupByIsbn() { return null; },
          async searchByTitleAndAuthor() { return []; }
        },
        openLibrary: { async lookupByIsbn() { return null; } }
      },
      coverFetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('validhash1234567890') || url.includes('images-eu.ssl-images-amazon.com')) {
          return new Response(new Uint8Array(validPng), { status: 200, headers: { 'content-type': 'image/png' } });
        }
        return new Response('', { status: 404 });
      }) as typeof fetch
    });

    try {
      const reg = await customApp.app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'CoverTester',
          email: 'cov@biblio.test',
          password: 'Password123',
          gdprAccepted: true
        })
      });
      const cookie = extractCookie(reg);

      const now = new Date().toISOString();
      customApp.repos.catalogRepo.upsertBookAutomatic({
        id: 'bk_uw1_zero_isbn',
        workCanonicalId: 'wd:Q3551257',
        seriesId: null,
        title: 'La Genèse',
        normalizedTitle: 'la genese',
        volumeNumber: 1,
        volumeLabel: '1',
        sortOrder: 1,
        isHorsSerie: false,
        isIntegral: false,
        includedVolumes: [],
        authors: ['Denis Bajram'],
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
        wikidataQid: 'Q3551257',
        inventaireUri: 'wd:Q3551257',
        sourceOrigin: 'auto',
        now
      });

      const res = await customApp.app.request('/api/books/bk_uw1_zero_isbn/covers?external=1', {
        headers: { cookie }
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { covers: Array<{ url: string; label: string }> };
      expect(body.covers.some((c) => c.url.includes('validhash1234567890'))).toBe(true);
      expect(body.covers.some((c) => c.url.includes('images-eu.ssl-images-amazon.com'))).toBe(true);
      expect(body.covers.some((c) => c.url.includes('wikimedia.org'))).toBe(false);
    } finally {
      customApp.worker.stop();
    }
  });
});
