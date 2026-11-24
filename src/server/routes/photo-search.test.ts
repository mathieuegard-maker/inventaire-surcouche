// src/server/routes/photo-search.test.ts
// Tests d'intégration Jalon 5 : Photo IA 100 % serveur (quota mensuel, arbitrage serveur, relance BnF serveur, commit) & Recherche catalogue exhaustive.

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
import type { GeminiConnector } from '../connectors/gemini.connector';

function extractCookie(res: Response): string {
  const raw = res.headers.get('set-cookie') || '';
  const m = raw.match(/biblio_session=([^;]+)/);
  if (!m) throw new Error('Cookie manquant');
  return `biblio_session=${m[1]}`;
}

async function makeShelfPhotoDataUrl(): Promise<string> {
  const buf = await sharp({
    create: { width: 200, height: 120, channels: 3, background: { r: 100, g: 120, b: 140 } }
  })
    .png()
    .toBuffer();
  return `data:image/png;base64,${buf.toString('base64')}`;
}

describe('Jalon 5 — Photo IA 100 % Serveur & Recherche Catalogue Exhaustive', () => {
  let db: SqliteDatabaseAdapter;
  let tmpCoversDir: string;
  let appCtx: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(db, path.resolve(process.cwd(), 'migrations'));
    tmpCoversDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblio-j5-covers-'));

    const mockGemini: GeminiConnector = {
      isConfigured: () => true,
      async extractBooksFromImage() {
        return [
          { title: 'Le Scorpion', series: 'Le Scorpion', volumeNumber: '1', author: 'Marini', confidence: 'high' },
          { title: 'Tranche floue illisible', confidence: 'low' }
        ];
      }
    };

    const mockConnectors: BibliographicConnectors = {
      bnf: {
        async lookupByIsbn(isbn13) {
          if (isbn13 === '9782871293019') {
            return {
              source: 'bnf',
              isbn13,
              title: 'La Marque du diable',
              seriesName: 'Le Scorpion',
              seriesLinkKind: 'marc_ensemble_460',
              volumeNumber: '1',
              authors: ['Stephen Desberg', 'Enrico Marini'],
              scriptwriters: ['Stephen Desberg'],
              illustrators: ['Enrico Marini'],
              publisher: 'Dargaud',
              rawSubjects: ['Bandes dessinées']
            };
          }
          if (isbn13 === '9782205051230') {
            return {
              source: 'bnf',
              isbn13,
              title: 'Blacksad : Quelque part entre les ombres',
              seriesName: 'Blacksad',
              seriesLinkKind: 'marc_ensemble_460',
              volumeNumber: '1',
              authors: ['Juan Díaz Canales', 'Juanjo Guarnido'],
              scriptwriters: [],
              illustrators: [],
              publisher: 'Dargaud',
              rawSubjects: ['Bandes dessinées']
            };
          }
          return null;
        },
        async searchByEnsembleId() {
          return [];
        },
        async sampleByCollectionName() {
          return [];
        },
        async searchByTitleAndAuthor(title, author) {
          const lower = title.toLowerCase();
          if (lower.includes('pappa in afrika')) {
            // Simule un auteur catalogué sous pseudonyme sur BnF : 0 résultat avec "Anton Kannemeyer", 1 hit sans filtre auteur !
            if (author) return [];
            return [
              {
                source: 'bnf',
                isbn13: '9782390080442',
                title: 'Pappa in Afrika',
                authors: ['Joe Dog', 'William Henne'],
                scriptwriters: [],
                illustrators: [],
                publisher: 'La 5e couche',
                rawSubjects: ['Bandes dessinées']
              }
            ];
          }
          if (lower.includes('scorpion')) {
            return [
              {
                source: 'bnf',
                isbn13: '9782871293019',
                title: 'La Marque du diable',
                seriesName: 'Le Scorpion',
                seriesLinkKind: 'marc_ensemble_460',
                volumeNumber: '1',
                authors: ['Stephen Desberg', 'Enrico Marini'],
                scriptwriters: [],
                illustrators: [],
                publisher: 'Dargaud',
                rawSubjects: []
              }
            ];
          }
          if (lower.includes('blacksad')) {
            return [
              {
                source: 'bnf',
                isbn13: '9782205051230',
                title: 'Blacksad : Quelque part entre les ombres',
                seriesName: 'Blacksad',
                seriesLinkKind: 'marc_ensemble_460',
                volumeNumber: '1',
                authors: ['Juan Díaz Canales', 'Juanjo Guarnido'],
                scriptwriters: [],
                illustrators: [],
                publisher: 'Dargaud',
                rawSubjects: []
              }
            ];
          }
          return [];
        }
      },
      sudoc: { async lookupByIsbn() { return null; } },
      inventaire: {
        async lookupByIsbn() { return null; },
        async fetchSeriesWorks() { return []; },
        async searchByText(query) {
          if (query.toLowerCase().includes('pappa in afrika')) {
            // Simule le bruit flou ElasticSearch d'Inventaire qui doit être filtré
            return [
              {
                source: 'inventaire',
                isbn13: '9782877141239',
                title: 'Le Père Goriot',
                authors: ['Honoré de Balzac'],
                scriptwriters: [],
                illustrators: [],
                rawSubjects: []
              }
            ];
          }
          return [];
        }
      },
      wikidata: {
        async lookupWorkByQid() { return null; },
        async fetchSeriesWorksByQid() { return []; }
      },
      googleBooks: { async lookupByIsbn() { return null; } },
      openLibrary: { async lookupByIsbn() { return null; } }
    };

    const config = loadServerConfig({
      NODE_ENV: 'test',
      COVERS_DIR: tmpCoversDir,
      MONTHLY_AI_QUOTA: '2'
    });

    appCtx = createApp({
      db,
      config,
      connectors: mockConnectors,
      geminiConnector: mockGemini,
      coverFetchImpl: (async () => new Response('', { status: 404 })) as typeof fetch
    });
  });

  afterEach(() => {
    appCtx.worker.stop();
    db.close();
    fs.rmSync(tmpCoversDir, { recursive: true, force: true });
  });

  it('exécute tout le cycle Photo IA 100 % serveur (quota, arbitrage persisté, relance BnF serveur, commit Collection)', async () => {
    const reg = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'PhotoTester',
        email: 'photo@biblio.test',
        password: 'Password123',
        gdprAccepted: true
      })
    });
    const cookie = extractCookie(reg);
    const dataUrl = await makeShelfPhotoDataUrl();

    // 1. Envoi photo #1 -> job photo_ocr créé + quota décrémenté (1/2)
    const createRes = await appCtx.app.request('/api/jobs/photo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ mode: 'shelf', imageDataUrl: dataUrl, mimeType: 'image/png' })
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      job: { id: string };
      quota: { used: number; limit: number; remaining: number };
    };
    expect(createBody.quota).toMatchObject({ used: 1, limit: 2, remaining: 1 });

    // 2. Exécution du worker serveur
    const ran = await appCtx.worker.processNextJob();
    expect(ran).toBe(true);

    const jobsRes = await appCtx.app.request('/api/jobs', { headers: { cookie } });
    const jobsBody = (await jobsRes.json()) as {
      jobs: Array<{
        id: string;
        status: string;
        result: {
          previewCoverKey: string | null;
          items: Array<{ id: string; status: string; selectedOptionIsbn13: string | null }>;
        };
      }>;
    };
    const job = jobsBody.jobs.find((j) => j.id === createBody.job.id)!;
    expect(job.status).toBe('done');
    expect(job.result.previewCoverKey).toMatch(/^cov_/);
    expect(job.result.items).toHaveLength(2);
    expect(job.result.items[0].status).toBe('identified');
    expect(job.result.items[0].selectedOptionIsbn13).toBe('9782871293019');
    expect(job.result.items[1].status).toBe('unresolved');

    const item1Id = job.result.items[0].id;
    const item2Id = job.result.items[1].id;

    // 3. Arbitrage persisté sur le serveur (intégrale sur item 1 -> survit au changement d'appareil)
    const patchRes = await appCtx.app.request(`/api/jobs/photo/${job.id}/items/${item1Id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ isIntegral: true, includedVolumes: ['1', '2', '3'] })
    });
    expect(patchRes.status).toBe(200);

    // 4. Relance BnF ciblée 100 % côté serveur sur l'item 2 non identifié
    const retryRes = await appCtx.app.request(`/api/jobs/photo/${job.id}/items/${item2Id}/retry-bnf`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title: 'Blacksad', author: 'Guarnido' })
    });
    expect(retryRes.status).toBe(200);
    const retryBody = (await retryRes.json()) as {
      item: { status: string; selectedOptionIsbn13: string | null; selected: boolean };
    };
    expect(retryBody.item.status).toBe('identified');
    expect(retryBody.item.selectedOptionIsbn13).toBe('9782205051230');
    expect(retryBody.item.selected).toBe(true);

    // 5. Validation du lot en Collection (`owned`)
    const commitRes = await appCtx.app.request(`/api/jobs/photo/${job.id}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ targetStatus: 'owned' })
    });
    expect(commitRes.status).toBe(200);
    const commitBody = (await commitRes.json()) as { committedCount: number };
    expect(commitBody.committedCount).toBe(2);

    // Vérification dans /api/sync/pull : les 2 livres sont possédés et Le Scorpion porte son intégrale T.1-3 !
    const pull = await appCtx.app.request('/api/sync/pull', { headers: { cookie } });
    const pullBody = (await pull.json()) as {
      books: Array<{ title: string; ownershipStatus: string; isIntegral: boolean; includedVolumes: string[] }>;
    };
    expect(pullBody.books).toHaveLength(2);
    const scorpion = pullBody.books.find((b) => b.title.includes('diable'))!;
    expect(scorpion.ownershipStatus).toBe('owned');
    expect(scorpion.isIntegral).toBe(true);
    expect(scorpion.includedVolumes).toEqual(['1', '2', '3']);

    // 6. Contrôle du quota mensuel : photo #2 OK, photo #3 -> 429 AI_QUOTA_EXCEEDED
    const secondRes = await appCtx.app.request('/api/jobs/photo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ mode: 'cover', imageDataUrl: dataUrl, mimeType: 'image/png' })
    });
    expect(secondRes.status).toBe(201);

    const thirdRes = await appCtx.app.request('/api/jobs/photo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ mode: 'cover', imageDataUrl: dataUrl, mimeType: 'image/png' })
    });
    expect(thirdRes.status).toBe(429);
  });

  it('retourne à la fois les séries locales, les livres locaux SQLite et les résultats externes BnF dédupliqués sur POST /api/search/catalog', async () => {
    const reg = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'SearchTester',
        email: 'search@biblio.test',
        password: 'Password123',
        gdprAccepted: true
      })
    });
    const cookie = extractCookie(reg);

    // Création locale d'une série "Le Scorpion" + 1 tome (sans ISBN 9782871293019, donc BnF doit aussi ressortir en externe)
    await appCtx.app.request('/api/books/manual', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        title: 'Le Secret du Pape',
        authors: ['Stephen Desberg', 'Enrico Marini'],
        seriesName: 'Le Scorpion',
        volumeNumber: 2,
        oneShot: false,
        ownershipStatus: 'owned'
      })
    });

    const searchRes = await appCtx.app.request('/api/search/catalog', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ series: 'Scorpion' })
    });
    expect(searchRes.status).toBe(200);
    const body = (await searchRes.json()) as {
      series: Array<{ canonicalName: string }>;
      books: Array<{ title: string }>;
      externalBooks: Array<{ isbn13: string; title: string }>;
    };

    expect(body.series.map((s) => s.canonicalName)).toContain('Le Scorpion');
    expect(body.books.map((b) => b.title)).toContain('Le Secret du Pape');
    expect(body.externalBooks.map((e) => e.isbn13)).toContain('9782871293019');
  });

  it('gère POST /api/books/lookup, POST /api/books/:id/replace (transfert statut/lecture/prêt) et commit asynchrone photo_commit', async () => {
    const reg = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'ReplaceTester',
        email: 'replace@biblio.test',
        password: 'Password123',
        gdprAccepted: true
      })
    });
    const cookie = extractCookie(reg);

    // 1. Ingestion initiale du mauvais livre (Le Scorpion) avec note de lecture + prêt actif
    const resolveRes = await appCtx.app.request('/api/books/resolve-isbn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ isbns: ['9782871293019'], channel: 'barcode_simple', action: 'owned' })
    });
    const resolvedBody = (await resolveRes.json()) as { results: Array<{ book: { id: string } }> };
    const oldBookId = resolvedBody.results[0].book.id;

    await appCtx.app.request(`/api/reading/${oldBookId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ status: 'read', rating: 5, notes: 'Super album !' })
    });
    await appCtx.app.request('/api/loans', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ bookIds: [oldBookId], borrowerName: 'Alice' })
    });

    // 2. Recherche partagée POST /api/books/lookup -> retrouve Blacksad
    const lookupRes = await appCtx.app.request('/api/books/lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title: 'Blacksad' })
    });
    expect(lookupRes.status).toBe(200);
    const lookupBody = (await lookupRes.json()) as { options: Array<{ isbn13: string }> };
    expect(lookupBody.options[0]?.isbn13).toBe('9782205051230');

    // 3. Remplacement dans le foyer POST /api/books/:oldBookId/replace -> transfère statut, lecture/notes et prêt actif !
    const replaceRes = await appCtx.app.request(`/api/books/${oldBookId}/replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ targetIsbn13: '9782205051230' })
    });
    expect(replaceRes.status).toBe(200);
    const replaceBody = (await replaceRes.json()) as {
      oldBookId: string;
      book: {
        id: string;
        ownershipStatus: string;
        readingState: { status: string; rating: number; notes: string } | null;
        activeLoan: { borrowerName: string } | null;
      };
    };
    expect(replaceBody.book.id).not.toBe(oldBookId);
    expect(replaceBody.book.ownershipStatus).toBe('owned');
    expect(replaceBody.book.readingState).toMatchObject({ status: 'read', rating: 5, notes: 'Super album !' });
    expect(replaceBody.book.activeLoan?.borrowerName).toBe('Alice');

    // L'ancien livre n'est plus dans le foyer mais reste intact dans le Catalogue Central
    const oldDetail = await appCtx.app.request(`/api/books/${oldBookId}`, { headers: { cookie } });
    const oldDetailBody = (await oldDetail.json()) as { book: { ownershipStatus: string; activeLoan: unknown } };
    expect(oldDetailBody.book.ownershipStatus).toBe('none');
    expect(oldDetailBody.book.activeLoan).toBeNull();

    // 4. Commit asynchrone `photo_commit` (réponse immédiate queued: true -> exécuté par BackgroundWorker)
    const dataUrl = await makeShelfPhotoDataUrl();
    const photoCreate = await appCtx.app.request('/api/jobs/photo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ mode: 'shelf', imageDataUrl: dataUrl, mimeType: 'image/png' })
    });
    const photoJobId = ((await photoCreate.json()) as { job: { id: string } }).job.id;
    while (await appCtx.worker.processNextJob()) {
      // dépiler les jobs series_expand + photo_ocr en attente
    }

    const asyncCommitRes = await appCtx.app.request(`/api/jobs/photo/${photoJobId}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ targetStatus: 'owned', async: true })
    });
    expect(asyncCommitRes.status).toBe(200);
    const asyncCommitBody = (await asyncCommitRes.json()) as { queued: boolean; commitJob: { id: string; type: string } };
    expect(asyncCommitBody.queued).toBe(true);
    expect(asyncCommitBody.commitJob.type).toBe('photo_commit');

    while (await appCtx.worker.processNextJob()) {
      // exécuter photo_commit
    }
    const jobsRes = await appCtx.app.request('/api/jobs', { headers: { cookie } });
    const jobsList = ((await jobsRes.json()) as { jobs: Array<{ id: string; status: string }> }).jobs;
    expect(jobsList.find((j) => j.id === asyncCommitBody.commitJob.id)?.status).toBe('done');

    // 5. Secours pseudonyme Photo IA / Lookup ("Pappa in Afrika" + "Anton Kannemeyer" -> filtre le bruit Inventaire et trouve Joe Dog)
    const pseudoRes = await appCtx.app.request('/api/books/lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title: 'Pappa in Afrika', author: 'Anton Kannemeyer' })
    });
    expect(pseudoRes.status).toBe(200);
    const pseudoBody = (await pseudoRes.json()) as { options: Array<{ isbn13: string; title: string }> };
    expect(pseudoBody.options).toHaveLength(1);
    expect(pseudoBody.options[0].isbn13).toBe('9782390080442');
  });

  it('gère POST /api/jobs/photo/:jobId/retry-ocr sans consommer de quota et applique la couverture de l’édition choisie en Couche 3 au commit', async () => {
    const dbLocal = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(dbLocal, path.resolve(process.cwd(), 'migrations'));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblio-j5-retry-'));
    try {
      let geminiAttempts = 0;
      const flakyGemini: GeminiConnector = {
        isConfigured: () => true,
        async extractBooksFromImage() {
          geminiAttempts++;
          if (geminiAttempts === 1) {
            throw new Error(
              'Le service de reconnaissance IA (Gemini) est temporairement saturé. Patientez quelques secondes puis cliquez sur « Réessayer ».'
            );
          }
          return [
            { title: 'La Marque du diable', series: 'Le Scorpion', volumeNumber: '1', author: 'Marini', confidence: 'high' }
          ];
        }
      };

      const redPng = await sharp({ create: { width: 120, height: 180, channels: 3, background: { r: 220, g: 30, b: 30 } } })
        .png({ compressionLevel: 0 })
        .toBuffer();
      const bluePng = await sharp({ create: { width: 120, height: 180, channels: 3, background: { r: 20, g: 60, b: 220 } } })
        .png({ compressionLevel: 0 })
        .toBuffer();

      const customConnectors: BibliographicConnectors = {
        bnf: {
          async lookupByIsbn(isbn13) {
            if (isbn13 === '9782871293019' || isbn13 === '9782871299998') {
              return {
                source: 'bnf',
                isbn13,
                title: 'La Marque du diable',
                seriesName: 'Le Scorpion',
                seriesLinkKind: 'marc_ensemble_460',
                volumeNumber: '1',
                authors: ['Stephen Desberg', 'Enrico Marini'],
                scriptwriters: [],
                illustrators: [],
                publisher: isbn13 === '9782871299998' ? 'Dargaud Collector' : 'Dargaud',
                coverUrl: isbn13 === '9782871299998' ? 'https://covers.test/collector.png' : 'https://covers.test/orig.png',
                rawSubjects: ['Bandes dessinées']
              };
            }
            return null;
          },
          async searchByEnsembleId() { return []; },
          async sampleByCollectionName() { return []; },
          async searchByTitleAndAuthor() {
            return [
              {
                source: 'bnf',
                isbn13: '9782871293019',
                title: 'La Marque du diable',
                seriesName: 'Le Scorpion',
                volumeNumber: '1',
                authors: ['Enrico Marini'],
                scriptwriters: [],
                illustrators: [],
                publisher: 'Dargaud',
                coverUrl: 'https://covers.test/orig.png',
                rawSubjects: []
              },
              {
                source: 'bnf',
                isbn13: '9782871299998',
                title: 'La Marque du diable',
                seriesName: 'Le Scorpion',
                volumeNumber: '1',
                authors: ['Enrico Marini'],
                scriptwriters: [],
                illustrators: [],
                publisher: 'Dargaud Collector',
                coverUrl: 'https://covers.test/collector.png',
                rawSubjects: []
              }
            ];
          }
        },
        sudoc: { async lookupByIsbn() { return null; } },
        inventaire: { async lookupByIsbn() { return null; }, async fetchSeriesWorks() { return []; } },
        wikidata: { async lookupWorkByQid() { return null; }, async fetchSeriesWorksByQid() { return []; } },
        googleBooks: { async lookupByIsbn() { return null; } },
        openLibrary: { async lookupByIsbn() { return null; } }
      };

      const ctxLocal = createApp({
        db: dbLocal,
        config: loadServerConfig({
          NODE_ENV: 'test',
          COVERS_DIR: tmpDir,
          AI_MONTHLY_QUOTA_DEFAULT: '1',
          CRON_ENABLED: 'false'
        }),
        connectors: customConnectors,
        geminiConnector: flakyGemini,
        coverFetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
          const url = String(input);
          if (url.includes('collector.png')) return new Response(new Uint8Array(bluePng), { status: 200, headers: { 'content-type': 'image/png' } });
          if (url.includes('orig.png')) return new Response(new Uint8Array(redPng), { status: 200, headers: { 'content-type': 'image/png' } });
          return new Response('', { status: 404 });
        }) as typeof fetch
      });

      const reg = await ctxLocal.app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'RetryTester',
          email: 'retry@biblio.test',
          password: 'Password123',
          gdprAccepted: true
        })
      });
      const cookie = extractCookie(reg);

      // 1. Envoi photo (consomme l'unique quota 1/1) -> Gemini échoue sur saturation 503
      const dataUrl = await makeShelfPhotoDataUrl();
      const createRes = await ctxLocal.app.request('/api/jobs/photo', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ mode: 'shelf', imageDataUrl: dataUrl, mimeType: 'image/png' })
      });
      expect(createRes.status).toBe(201);
      const jobId = ((await createRes.json()) as { job: { id: string } }).job.id;

      // Invariant strict V2 : zéro image base64 stockée dans SQLite (uniquement previewCoverKey WebP sur disque)
      const rawJobRow = dbLocal.get<{ payload_json: string }>(
        'SELECT payload_json FROM background_jobs WHERE id = ?',
        [jobId]
      );
      expect(rawJobRow?.payload_json).not.toContain('data:image/');
      expect(rawJobRow?.payload_json).toContain('previewCoverKey');

      await ctxLocal.worker.processNextJob();
      const afterFail = (await (await ctxLocal.app.request('/api/jobs', { headers: { cookie } })).json()) as {
        jobs: Array<{ id: string; status: string; errorMessage: string | null }>;
      };
      expect(afterFail.jobs.find((j) => j.id === jobId)?.status).toBe('error');
      expect(afterFail.jobs.find((j) => j.id === jobId)?.errorMessage).toMatch(/temporairement saturé/i);

      // 2. Réessai OCR sur le même lot (quota déjà à 1/1 -> ne consomme PAS de quota supplémentaire !)
      const retryOcrRes = await ctxLocal.app.request(`/api/jobs/photo/${jobId}/retry-ocr`, {
        method: 'POST',
        headers: { cookie }
      });
      expect(retryOcrRes.status).toBe(200);

      while (await ctxLocal.worker.processNextJob()) {
        // dépile le job photo_ocr relancé
      }

      const afterRetry = (await (await ctxLocal.app.request('/api/jobs', { headers: { cookie } })).json()) as {
        jobs: Array<{
          id: string;
          status: string;
          result: { items: Array<{ id: string; options: Array<{ isbn13: string; coverUrl: string | null }> }> };
        }>;
      };
      const doneJob = afterRetry.jobs.find((j) => j.id === jobId)!;
      expect(doneJob.status).toBe('done');
      const item = doneJob.result.items[0];
      expect(item.options).toHaveLength(2);
      const collectorOpt = item.options.find((o) => o.isbn13 === '9782871299998')!;
      expect(collectorOpt.coverUrl).toBeTruthy();

      // Pré-peupler le livre dans le Catalogue Central avec la 1ère édition (orig.png) pour vérifier
      // que choisir la 2e édition (collector.png) impose bien la couverture de la 2e édition en Couche 3 !
      const previewOrigRes = await ctxLocal.app.request('/api/books/resolve-isbn', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ isbns: ['9782871293019'], channel: 'barcode_simple', action: 'preview' })
      });
      const previewOrigBody = (await previewOrigRes.json()) as {
        results: Array<{ book: { coverUrl: string | null } }>;
      };
      const origCoverUrl = previewOrigBody.results[0].book.coverUrl;
      expect(origCoverUrl).toMatch(/^\/api\/covers\//);

      // 3. Sélection de la 2e édition (Dargaud Collector) + validation en Collection
      const patchOptRes = await ctxLocal.app.request(`/api/jobs/photo/${jobId}/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ selectedOptionIsbn13: '9782871299998', selected: true })
      });
      expect(patchOptRes.status).toBe(200);

      const commitRes = await ctxLocal.app.request(`/api/jobs/photo/${jobId}/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ targetStatus: 'owned' })
      });
      expect(commitRes.status).toBe(200);

      const pullRes = await ctxLocal.app.request('/api/sync/pull', { headers: { cookie } });
      const pullBody = (await pullRes.json()) as {
        books: Array<{ coverUrl: string | null; knownIsbns: string[]; hasUserOverrides: boolean }>;
      };
      expect(pullBody.books).toHaveLength(1);
      expect(pullBody.books[0].knownIsbns).toContain('9782871299998');
      expect(pullBody.books[0].coverUrl).toMatch(/^\/api\/covers\//);
      expect(pullBody.books[0].coverUrl).not.toBe(origCoverUrl);
      expect(pullBody.books[0].hasUserOverrides).toBe(true);

      ctxLocal.worker.stop();
    } finally {
      dbLocal.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
