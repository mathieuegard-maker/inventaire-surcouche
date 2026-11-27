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

async function makeGradientPng(direction: 'ltr' | 'rtl'): Promise<Buffer> {
  const w = 120;
  const h = 180;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 3;
      const v = direction === 'ltr' ? Math.floor((x / w) * 255) : Math.floor(((w - 1 - x) / w) * 255);
      raw[idx] = v;
      raw[idx + 1] = v;
      raw[idx + 2] = v;
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
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

    // 3. Arbitrage persisté sur le serveur (intégrale non destructive par défaut sur item 1 : conserve le Tome 1 intact)
    const patchRes = await appCtx.app.request(`/api/jobs/photo/${job.id}/items/${item1Id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ isIntegral: true, includedVolumes: ['1', '2', '3'] })
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as {
      job: { result: { items: Array<{ id: string; integralMode?: string }> } };
    };
    const patchedItem1 = patchBody.job.result.items.find((it) => it.id === item1Id)!;
    expect(patchedItem1.integralMode).toBe('create_separate');

    // 4. Relance BnF ciblée 100 % côté serveur sur l'item 2 non identifié -> passe directement en 'identified'
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

    // Vérification dans /api/sync/pull : l'intégrale séparée est possédée (T.1-3), Blacksad est possédé,
    // le Tome 1 « La Marque du diable » n'a PAS été écrasé en intégrale et la série compte 1 tome unitaire possédé / 1 total !
    const pull = await appCtx.app.request('/api/sync/pull', { headers: { cookie } });
    const pullBody = (await pull.json()) as {
      books: Array<{
        id: string;
        title: string;
        ownershipStatus: string;
        isIntegral: boolean;
        includedVolumes: string[];
      }>;
      series: Array<{ canonicalName: string; knownVolumesCount: number; ownedCount: number }>;
    };
    expect(pullBody.books).toHaveLength(2);
    const integralBook = pullBody.books.find((b) => b.isIntegral)!;
    expect(integralBook).toBeDefined();
    expect(integralBook.ownershipStatus).toBe('owned');
    expect(integralBook.includedVolumes).toEqual(['1', '2', '3']);
    const scorpionSeries = pullBody.series.find((s) => s.canonicalName === 'Le Scorpion')!;
    expect(scorpionSeries).toBeDefined();
    // Les intégrales ne gonflent plus le total de tomes unitaires de la série (1 tome unitaire connu, couvert par l'intégrale -> 1/1)
    expect(scorpionSeries.knownVolumesCount).toBe(1);
    expect(scorpionSeries.ownedCount).toBe(1);

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

      const redPng = await makeGradientPng('ltr');
      const bluePng = await makeGradientPng('rtl');

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
          result: {
            items: Array<{
              id: string;
              options: Array<{
                isbn13: string;
                siblingIsbns?: string[];
                editionCount?: number;
                coverUrl: string | null;
                coverOptions?: Array<{ coverKey: string | null; coverUrl: string; isbn13?: string | null }>;
              }>;
            }>;
          };
        }>;
      };
      const doneJob = afterRetry.jobs.find((j) => j.id === jobId)!;
      expect(doneJob.status).toBe('done');
      const item = doneJob.result.items[0];
      // Lot 4 : les 2 éditions (Dargaud + Dargaud Collector) d'un même album sont regroupées en 1 seule Œuvre abstraite avec leurs 2 couvertures distinctes !
      expect(item.options).toHaveLength(1);
      expect(item.options[0].editionCount).toBe(2);
      expect(item.options[0].siblingIsbns).toEqual(expect.arrayContaining(['9782871293019', '9782871299998']));
      const collectorCov = item.options[0].coverOptions?.find((c) => c.isbn13 === '9782871299998');
      expect(collectorCov?.coverUrl).toMatch(/^\/api\/covers\//);

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

  it('Lot 3 (Recherche textuelle Œuvre abstraite) : court-circuite internet si la série est déjà en base (tome + intégrale) et résout Série->Tome canonique + Intégrale sans polluer la DB si inconnue', async () => {
    const dbLocal = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(dbLocal, path.resolve(process.cwd(), 'migrations'));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblio-lot3-search-'));
    let bnfTextCalls = 0;

    try {
      const ctxLocal = createApp({
        db: dbLocal,
        config: loadServerConfig({ NODE_ENV: 'test', COVERS_DIR: tmpDir }),
        connectors: {
          bnf: {
            async lookupByIsbn() { return null; },
            async searchByEnsembleId() { return []; },
            async sampleByCollectionName() { return []; },
            async searchSeriesIntegrals(seriesName) {
              if (seriesName.toLowerCase().includes('lucky luke')) {
                return [
                  {
                    title: 'Lucky Luke — L’Intégrale 11 (Tomes 31 à 33)',
                    volumeNumber: 11,
                    volumeLabel: 'Int. 11',
                    sortOrder: 10011,
                    authors: ['Morris', 'René Goscinny'],
                    isbn13s: ['9782884719995'],
                    publisher: 'Lucky Comics',
                    isIntegral: true,
                    includedVolumes: ['31', '32', '33'],
                    source: 'bnf'
                  }
                ];
              }
              return [];
            },
            async searchByTitleAndAuthor(title) {
              bnfTextCalls++;
              if (title.toLowerCase().includes('diligence')) {
                return [
                  {
                    source: 'bnf',
                    isbn13: '9782205002324',
                    title: 'La Diligence',
                    seriesName: 'Lucky Luke',
                    volumeNumber: '32',
                    authors: ['Morris', 'René Goscinny'],
                    scriptwriters: [],
                    illustrators: [],
                    publisher: 'Dargaud',
                    language: 'fr',
                    rawSubjects: []
                  }
                ];
              }
              // Simule un piège BnF brut sur "Lucky Luke 32" qui renverrait à tort un Tome 1 réédité !
              return [
                {
                  source: 'bnf',
                  isbn13: '9782800101019',
                  title: 'La Mine d’or de Dick Digger',
                  seriesName: 'Lucky Luke',
                  volumeNumber: '1',
                  authors: ['Morris'],
                  scriptwriters: [],
                  illustrators: [],
                  publisher: 'Dupuis',
                  language: 'fr',
                  rawSubjects: []
                }
              ];
            }
          },
          sudoc: { async lookupByIsbn() { return null; } },
          inventaire: {
            async lookupByIsbn() { return null; },
            async fetchSeriesWorks() { return []; },
            async searchByText() { return []; }
          },
          wikidata: {
            async lookupWorkByQid() { return null; },
            async searchSeriesQids(name) {
              return name.toLowerCase().includes('lucky luke') ? ['Q137475'] : [];
            },
            async fetchSeriesWorksByQid(qid) {
              if (qid === 'Q137475') {
                return [
                  {
                    title: 'La Diligence',
                    volumeNumber: 32,
                    volumeLabel: '32',
                    sortOrder: 32,
                    wikidataQid: 'Q3208312',
                    authors: ['Morris', 'René Goscinny'],
                    isbn13s: [],
                    source: 'wikidata'
                  }
                ];
              }
              return [];
            }
          },
          googleBooks: { async lookupByIsbn() { return null; } },
          openLibrary: { async lookupByIsbn() { return null; } }
        },
        coverFetchImpl: (async () => new Response('', { status: 404 })) as typeof fetch
      });

      const reg = await ctxLocal.app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'SearchLot3',
          email: 'lot3@biblio.test',
          password: 'Password123',
          gdprAccepted: true
        })
      });
      const cookie = extractCookie(reg);

      // 1. Série absente de la base -> recherche "Lucky Luke" Tome 32 :
      //    Propose le VRAI Tome 32 canonique ("La Diligence") en #1 + l'intégrale couvrante en #2, SANS écrire en base !
      const extRes = await ctxLocal.app.request('/api/search/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ title: 'Lucky Luke', volumeNumber: '32' })
      });
      expect(extRes.status).toBe(200);
      const extBody = (await extRes.json()) as {
        externalBooks: Array<{ title: string; volumeNumber: string | null; isIntegral?: boolean; includedVolumes?: string[] }>;
      };
      expect(extBody.externalBooks[0].title).toBe('La Diligence');
      expect(extBody.externalBooks[0].volumeNumber).toBe('32');
      expect(extBody.externalBooks[0].isIntegral).toBe(false);
      expect(extBody.externalBooks[1].isIntegral).toBe(true);
      expect(extBody.externalBooks[1].includedVolumes).toContain('32');
      // Zéro pollution du Catalogue Central avant validation !
      expect(dbLocal.all('SELECT id FROM series')).toHaveLength(0);

      // 2. Une fois la série étendue en base locale, chercher "Lucky Luke" Tome 10 court-circuite totalement internet (0 appel BnF)
      //    et renvoie le tome unitaire #10 ET l'intégrale locale couvrant #10 !
      const now = new Date().toISOString();
      const { series } = ctxLocal.services.seriesGraphService.resolveOrCreateSeriesCut({
        seriesName: 'Lucky Luke',
        wikidataSeriesQid: 'Q137475',
        bookTitle: 'Alerte aux Pieds-Bleus',
        volumeNumber: 10,
        isHorsSerie: false,
        isIntegral: false,
        authors: ['Morris'],
        now
      });
      ctxLocal.repos.catalogRepo.mergeSeriesMetadataAutomatic(series.id, { isCompleteExpanded: true, now });
      ctxLocal.repos.catalogRepo.upsertBookAutomatic({
        id: 'bk_ll_10',
        workCanonicalId: 'wd:Q_LL_10',
        seriesId: series.id,
        title: 'Alerte aux Pieds-Bleus',
        normalizedTitle: 'alerte aux pieds bleus',
        volumeNumber: 10,
        volumeLabel: '10',
        sortOrder: 10,
        isHorsSerie: false,
        isIntegral: false,
        includedVolumes: [],
        authors: ['Morris'],
        scriptwriters: [],
        illustrators: [],
        publisher: 'Dupuis',
        collectionName: null,
        publishYear: '1958',
        pageCount: 46,
        description: null,
        language: 'fr',
        mainCategory: 'BD',
        subgenres: [],
        coverKey: null,
        wikidataQid: 'Q_LL_10',
        inventaireUri: null,
        sourceOrigin: 'auto',
        now
      });
      ctxLocal.repos.catalogRepo.upsertBookAutomatic({
        id: 'bk_ll_int4',
        workCanonicalId: 'ser:ll:int:10-12',
        seriesId: series.id,
        title: 'Lucky Luke — Intégrale 4',
        normalizedTitle: 'lucky luke integrale 4',
        volumeNumber: null,
        volumeLabel: 'Int. T.10-12',
        sortOrder: 10004,
        isHorsSerie: false,
        isIntegral: true,
        includedVolumes: ['10', '11', '12'],
        authors: ['Morris'],
        scriptwriters: [],
        illustrators: [],
        publisher: 'Dupuis',
        collectionName: null,
        publishYear: '2016',
        pageCount: 180,
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

      const callsBeforeLocal = bnfTextCalls;
      const locRes = await ctxLocal.app.request('/api/search/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ title: 'Lucky Luke', volumeNumber: '10' })
      });
      expect(locRes.status).toBe(200);
      const locBody = (await locRes.json()) as {
        books: Array<{ id: string; isIntegral: boolean }>;
        externalBooks: unknown[];
      };
      // Court-circuit 100 % local : 0 appel réseau BnF !
      expect(bnfTextCalls).toBe(callsBeforeLocal);
      expect(locBody.externalBooks).toHaveLength(0);
      // Tome 10 unitaire en première intention + Intégrale 4 couvrante juste après !
      expect(locBody.books.map((b) => b.id)).toEqual(['bk_ll_10', 'bk_ll_int4']);

      ctxLocal.worker.stop();
    } finally {
      dbLocal.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Lot 4 (Photo IA Œuvre abstraite) : court-circuite BnF si l’œuvre est déjà au Catalogue Central, expose les couvertures multi-éditions via /covers et applique selectedCoverKey en Couche 3 Foyer sans toucher au Catalogue Central', async () => {
    const dbLocal = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(dbLocal, path.resolve(process.cwd(), 'migrations'));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblio-lot4-photo-'));
    let bnfSearchCalls = 0;

    try {
      const covA = await makeGradientPng('ltr');
      const covB = await makeGradientPng('rtl');

      const mockGemini: GeminiConnector = {
        isConfigured: () => true,
        async extractBooksFromImage() {
          return [
            {
              title: 'Le Secret de La Licorne',
              series: 'Tintin',
              volumeNumber: '11',
              author: 'Hergé',
              confidence: 'high'
            }
          ];
        }
      };

      const ctxLocal = createApp({
        db: dbLocal,
        config: loadServerConfig({ NODE_ENV: 'test', COVERS_DIR: tmpDir, MONTHLY_AI_QUOTA: '5' }),
        geminiConnector: mockGemini,
        connectors: {
          bnf: {
            async lookupByIsbn() { return null; },
            async searchByEnsembleId() { return []; },
            async sampleByCollectionName() { return []; },
            async searchByTitleAndAuthor() {
              bnfSearchCalls++;
              return [];
            }
          },
          sudoc: { async lookupByIsbn() { return null; } },
          inventaire: { async lookupByIsbn() { return null; }, async fetchSeriesWorks() { return []; }, async searchByText() { return []; } },
          wikidata: { async lookupWorkByQid() { return null; }, async fetchSeriesWorksByQid() { return []; } },
          googleBooks: { async lookupByIsbn() { return null; } },
          openLibrary: { async lookupByIsbn() { return null; } }
        },
        coverFetchImpl: (async () => new Response('', { status: 404 })) as typeof fetch
      });

      const reg = await ctxLocal.app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'PhotoLot4',
          email: 'lot4@biblio.test',
          password: 'Password123',
          gdprAccepted: true
        })
      });
      const cookie = extractCookie(reg);

      // Pré-peupler Tintin T.11 dans le Catalogue Central avec 2 éditions + 2 couvertures WebP distinctes
      const now = new Date().toISOString();
      const storedCovA = await ctxLocal.services.coverService.storeBufferAsWebp(covA, 'https://covers.test/tintin-a.png');
      const storedCovB = await ctxLocal.services.coverService.storeBufferAsWebp(covB, 'https://covers.test/tintin-b.png');

      const { series } = ctxLocal.services.seriesGraphService.resolveOrCreateSeriesCut({
        seriesName: 'Les Aventures de Tintin',
        wikidataSeriesQid: 'Q744536',
        bookTitle: 'Le Secret de La Licorne',
        volumeNumber: 11,
        isHorsSerie: false,
        isIntegral: false,
        authors: ['Hergé'],
        now
      });
      ctxLocal.repos.catalogRepo.upsertBookAutomatic({
        id: 'bk_tintin_11',
        workCanonicalId: 'wd:Q_TINTIN_11',
        seriesId: series.id,
        title: 'Le Secret de La Licorne',
        normalizedTitle: 'le secret de la licorne',
        volumeNumber: 11,
        volumeLabel: '11',
        sortOrder: 11,
        isHorsSerie: false,
        isIntegral: false,
        includedVolumes: [],
        authors: ['Hergé'],
        scriptwriters: [],
        illustrators: [],
        publisher: 'Casterman',
        collectionName: null,
        publishYear: '1943',
        pageCount: 62,
        description: null,
        language: 'fr',
        mainCategory: 'BD',
        subgenres: [],
        coverKey: storedCovA.coverKey,
        wikidataQid: 'Q_TINTIN_11',
        inventaireUri: null,
        sourceOrigin: 'auto',
        now
      });
      ctxLocal.repos.catalogRepo.upsertBookEdition({
        isbn13: '9782203001107',
        bookId: 'bk_tintin_11',
        publisher: 'Casterman',
        collectionName: null,
        publishYear: '1993',
        pageCount: 62,
        coverKey: storedCovA.coverKey,
        source: 'bnf',
        now
      });
      ctxLocal.repos.catalogRepo.upsertBookEdition({
        isbn13: '9782203001114',
        bookId: 'bk_tintin_11',
        publisher: 'Casterman Fac-similé',
        collectionName: null,
        publishYear: '2006',
        pageCount: 62,
        coverKey: storedCovB.coverKey,
        source: 'bnf',
        now
      });

      // 1. Photo IA -> doit court-circuiter totalement BnF (0 appel réseau) et proposer 1 Œuvre abstraite locale
      const dataUrl = await makeShelfPhotoDataUrl();
      const createRes = await ctxLocal.app.request('/api/jobs/photo', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ mode: 'shelf', imageDataUrl: dataUrl, mimeType: 'image/png' })
      });
      expect(createRes.status).toBe(201);
      const jobId = ((await createRes.json()) as { job: { id: string } }).job.id;

      await ctxLocal.worker.processNextJob();
      expect(bnfSearchCalls).toBe(0);

      const jobsRes = await ctxLocal.app.request('/api/jobs', { headers: { cookie } });
      const job = ((await jobsRes.json()) as {
        jobs: Array<{
          id: string;
          result: {
            items: Array<{
              id: string;
              options: Array<{
                bookId?: string | null;
                source: string;
                editionCount?: number;
                coverOptions?: Array<{ coverKey: string | null; coverUrl: string }>;
              }>;
            }>;
          };
        }>;
      }).jobs.find((j) => j.id === jobId)!;

      expect(job.result.items).toHaveLength(1);
      const item = job.result.items[0];
      expect(item.options).toHaveLength(1);
      expect(item.options[0].source).toBe('local');
      expect(item.options[0].bookId).toBe('bk_tintin_11');
      expect(item.options[0].editionCount).toBe(2);
      expect(item.options[0].coverOptions).toHaveLength(2);

      // 2. Endpoint GET /api/jobs/photo/:jobId/items/:itemId/covers -> renvoie les 2 couvertures distinctes en 0 ms
      const covRes = await ctxLocal.app.request(`/api/jobs/photo/${jobId}/items/${item.id}/covers`, {
        headers: { cookie }
      });
      expect(covRes.status).toBe(200);
      const covBody = (await covRes.json()) as { covers: Array<{ coverKey: string | null; coverUrl: string }> };
      expect(covBody.covers.map((c) => c.coverKey)).toEqual([storedCovA.coverKey, storedCovB.coverKey]);

      // 3. L'utilisateur choisit explicitement la 2e couverture (Fac-similé) -> persistée et appliquée en Couche 3 Foyer au commit !
      const patchRes = await ctxLocal.app.request(`/api/jobs/photo/${jobId}/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ selectedCoverKey: storedCovB.coverKey, selected: true })
      });
      expect(patchRes.status).toBe(200);

      const commitRes = await ctxLocal.app.request(`/api/jobs/photo/${jobId}/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ targetStatus: 'owned' })
      });
      expect(commitRes.status).toBe(200);

      // Vérifie que le Foyer voit bien la couverture B (Couche 3) tandis que le Catalogue Central garde intacte la couverture A !
      const pullRes = await ctxLocal.app.request('/api/sync/pull', { headers: { cookie } });
      const pullBody = (await pullRes.json()) as {
        books: Array<{ id: string; coverKey: string | null; hasUserOverrides: boolean }>;
      };
      const userTintin = pullBody.books.find((b) => b.id === 'bk_tintin_11')!;
      expect(userTintin.coverKey).toBe(storedCovB.coverKey);
      expect(userTintin.hasUserOverrides).toBe(true);

      const catalogRow = ctxLocal.repos.catalogRepo.findBookById('bk_tintin_11')!;
      expect(catalogRow.cover_key).toBe(storedCovA.coverKey);

      ctxLocal.worker.stop();
    } finally {
      dbLocal.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('filet post-OCR voisinage (v2.3.0) : sauve une tranche penchée contaminée par la série, le tome ou l éditeur du voisin sans appel IA supplémentaire', async () => {
    const dbTilt = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(dbTilt, path.resolve(process.cwd(), 'migrations'));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblio-tilt-guard-'));
    let geminiCalls = 0;

    try {
      const mockGeminiTilt: GeminiConnector = {
        isConfigured: () => true,
        async extractBooksFromImage() {
          geminiCalls++;
          return [
            // Tranche 1 (penchée) : haut = "La Marque du diable" (Le Scorpion T.1), mais contaminée par le pied du voisin (series: Thorgal, volumeNumber: 14, publisher: Le Lombard)
            {
              spineIndex: 1,
              tilt: 'lean_right',
              spineColor: 'noir',
              topX: 250,
              bottomX: 180,
              title: 'La Marque du diable',
              series: 'Thorgal',
              volumeNumber: '14',
              publisher: 'Le Lombard',
              confidence: 'medium'
            },
            // Tranche 2 (voisin penché parallèle) : vrai Thorgal T.14 chez Le Lombard
            {
              spineIndex: 2,
              tilt: 'lean_right',
              spineColor: 'blanc',
              topX: 340,
              bottomX: 270,
              title: 'Aaricia',
              series: 'Thorgal',
              volumeNumber: '14',
              publisher: 'Le Lombard',
              confidence: 'high'
            },
            // Tranche 3 (penchée) : bon titre/série "Le Scorpion / La Marque du diable", mais tome 14 contaminé par le voisin -> BnF renvoie T.14 + T.1
            {
              spineIndex: 3,
              tilt: 'lean_right',
              spineColor: 'rouge',
              topX: 430,
              bottomX: 360,
              title: 'La Marque du diable',
              series: 'Le Scorpion',
              volumeNumber: '14',
              publisher: 'Le Lombard',
              confidence: 'high'
            }
          ];
        }
      };

      const mockConnTilt: BibliographicConnectors = {
        bnf: {
          async lookupByIsbn() { return null; },
          async searchByEnsembleId() { return []; },
          async sampleByCollectionName() { return []; },
          async searchByTitleAndAuthor(title) {
            const lower = title.toLowerCase();
            // Cas contaminé "Thorgal La Marque du diable" -> 0 résultat BnF
            if (lower.includes('thorgal') && lower.includes('marque du diable')) {
              return [];
            }
            if (lower.includes('thorgal') && (lower.includes('aaricia') || lower.includes('14'))) {
              return [
                {
                  source: 'bnf',
                  isbn13: '9782803607457',
                  title: 'Aaricia',
                  seriesName: 'Thorgal',
                  seriesLinkKind: 'marc_ensemble_460',
                  volumeNumber: '14',
                  authors: ['Jean Van Hamme', 'Grzegorz Rosinski'],
                  scriptwriters: [],
                  illustrators: [],
                  publisher: 'Le Lombard',
                  rawSubjects: ['Bandes dessinées']
                }
              ];
            }
            if (lower.includes('scorpion') && lower.includes('14')) {
              return [
                {
                  source: 'bnf',
                  isbn13: '9782505115342',
                  title: 'La Tombe d un dieu',
                  seriesName: 'Le Scorpion',
                  seriesLinkKind: 'marc_ensemble_460',
                  volumeNumber: '14',
                  authors: ['Stephen Desberg', 'Luigi Critone'],
                  scriptwriters: [],
                  illustrators: [],
                  publisher: 'Dargaud',
                  rawSubjects: ['Bandes dessinées']
                }
              ];
            }
            if (lower.includes('marque du diable')) {
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
                  rawSubjects: ['Bandes dessinées']
                }
              ];
            }
            return [];
          }
        },
        sudoc: { async lookupByIsbn() { return null; } },
        inventaire: { async lookupByIsbn() { return null; }, async fetchSeriesWorks() { return []; } },
        wikidata: { async lookupWorkByQid() { return null; }, async fetchSeriesWorksByQid() { return []; } },
        googleBooks: { async lookupByIsbn() { return null; } },
        openLibrary: { async lookupByIsbn() { return null; } }
      };

      const ctxTilt = createApp({
        db: dbTilt,
        config: loadServerConfig({ NODE_ENV: 'test', COVERS_DIR: tmpDir, MONTHLY_AI_QUOTA: '5' }),
        connectors: mockConnTilt,
        geminiConnector: mockGeminiTilt,
        coverFetchImpl: (async () => new Response('', { status: 404 })) as typeof fetch
      });

      const reg = await ctxTilt.app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'TiltUser',
          email: 'tilt@biblio.test',
          password: 'Password123',
          gdprAccepted: true
        })
      });
      const cookie = extractCookie(reg);
      const dataUrl = await makeShelfPhotoDataUrl();

      const createRes = await ctxTilt.app.request('/api/jobs/photo', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ mode: 'shelf', imageDataUrl: dataUrl, mimeType: 'image/png' })
      });
      expect(createRes.status).toBe(201);
      const jobId = ((await createRes.json()) as { job: { id: string } }).job.id;

      await ctxTilt.worker.processNextJob();
      expect(geminiCalls).toBe(1);

      const jobsRes = await ctxTilt.app.request('/api/jobs', { headers: { cookie } });
      const job = ((await jobsRes.json()) as {
        jobs: Array<{
          id: string;
          result: {
            items: Array<{
              status: string;
              selectedOptionIsbn13: string | null;
              options: Array<{ isbn13: string; title: string }>;
            }>;
          };
        }>;
      }).jobs.find((j) => j.id === jobId)!;

      expect(job.result.items).toHaveLength(3);
      // Tranche 1 : sauvée depuis 0 résultat en neutralisant série/tome/éditeur contaminés par le voisin -> statut 'doubt' avec le bon album !
      expect(job.result.items[0].status).toBe('doubt');
      expect(job.result.items[0].selectedOptionIsbn13).toBe('9782871293019');
      expect(job.result.items[0].options[0].title).toBe('La Marque du diable');

      // Tranche 2 : intacte, identifiée en haute confiance
      expect(job.result.items[1].status).toBe('identified');
      expect(job.result.items[1].selectedOptionIsbn13).toBe('9782803607457');

      // Tranche 3 : sauvée malgré le tome 14 contaminé qui faisait remonter "La Tombe d'un dieu" en #1 -> rétablie sur "La Marque du diable" !
      expect(job.result.items[2].status).toBe('doubt');
      expect(job.result.items[2].selectedOptionIsbn13).toBe('9782871293019');
      expect(job.result.items[2].options[0].title).toBe('La Marque du diable');

      ctxTilt.worker.stop();
    } finally {
      dbTilt.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('V2.6 Photo IA : mode auto unifié, secours F4 suggestions souples, archivage auto au commit et historique 30 jours', async () => {
    const dbV26 = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(dbV26, path.resolve(process.cwd(), 'migrations'));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblio-v26-photo-'));
    let receivedMode = '';

    try {
      const mockGeminiAuto: GeminiConnector = {
        isConfigured: () => true,
        async extractBooksFromImage(input) {
          receivedMode = input.mode ?? '';
          return [
            {
              title: 'Le Scorpion',
              series: 'Le Scorpion',
              volumeNumber: '1',
              author: 'Marini',
              confidence: 'high'
            },
            {
              title: 'Tranche abimee partielle',
              rawText: 'CHRONIQUES LUNE NOIRE',
              confidence: 'low'
            }
          ];
        }
      };

      const mockConnV26: BibliographicConnectors = {
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
                scriptwriters: [],
                illustrators: [],
                publisher: 'Dargaud',
                rawSubjects: ['Bandes dessinées']
              };
            }
            return null;
          },
          async searchByEnsembleId() { return []; },
          async sampleByCollectionName() { return []; },
          async searchByTitleAndAuthor(title) {
            if (title.toLowerCase().includes('scorpion')) {
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
                  rawSubjects: ['Bandes dessinées']
                }
              ];
            }
            return [];
          },
          async searchAnywhere(query) {
            if (query.toLowerCase().includes('chroniques')) {
              return [
                {
                  source: 'bnf',
                  isbn13: '9782205041231',
                  title: 'Le Signe des Ténèbres',
                  seriesName: 'Chroniques de la Lune Noire',
                  volumeNumber: '1',
                  authors: ['François Froideval', 'Olivier Ledroit'],
                  scriptwriters: [],
                  illustrators: [],
                  publisher: 'Dargaud',
                  rawSubjects: ['Bandes dessinées']
                }
              ];
            }
            return [];
          }
        },
        sudoc: { async lookupByIsbn() { return null; } },
        inventaire: { async lookupByIsbn() { return null; }, async fetchSeriesWorks() { return []; } },
        wikidata: { async lookupWorkByQid() { return null; }, async fetchSeriesWorksByQid() { return []; } },
        googleBooks: { async lookupByIsbn() { return null; } },
        openLibrary: { async lookupByIsbn() { return null; } }
      };

      const ctxV26 = createApp({
        db: dbV26,
        config: loadServerConfig({ NODE_ENV: 'test', COVERS_DIR: tmpDir, MONTHLY_AI_QUOTA: '5' }),
        connectors: mockConnV26,
        geminiConnector: mockGeminiAuto,
        coverFetchImpl: (async () => new Response('', { status: 404 })) as typeof fetch
      });

      const reg = await ctxV26.app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'V26User',
          email: 'v26@biblio.test',
          password: 'Password123',
          gdprAccepted: true
        })
      });
      const cookie = extractCookie(reg);
      const dataUrl = await makeShelfPhotoDataUrl();

      // 1. Mode omis -> bascule automatiquement sur 'auto'
      const createRes = await ctxV26.app.request('/api/jobs/photo', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ imageDataUrl: dataUrl, mimeType: 'image/png', notifyOnComplete: true })
      });
      expect(createRes.status).toBe(201);
      const jobId = ((await createRes.json()) as { job: { id: string } }).job.id;

      await ctxV26.worker.processNextJob();
      expect(receivedMode).toBe('auto');

      // 2. Vérifie que le secours F4 a proposé une suggestion souple non pré-cochée sur la tranche abîmée
      const jobsBefore = (await (await ctxV26.app.request('/api/jobs', { headers: { cookie } })).json()) as {
        jobs: Array<{
          id: string;
          archivedAt?: string | null;
          result: {
            items: Array<{
              id: string;
              status: string;
              selected: boolean;
              approximateMatch?: boolean;
              options: Array<{ isbn13: string }>;
            }>;
          };
        }>;
      };
      const doneJob = jobsBefore.jobs.find((j) => j.id === jobId)!;
      expect(doneJob.archivedAt ?? null).toBeNull();
      expect(doneJob.result.items[0].status).toBe('identified');
      expect(doneJob.result.items[1].status).toBe('doubt');
      expect(doneJob.result.items[1].selected).toBe(false);
      expect(doneJob.result.items[1].approximateMatch).toBe(true);
      expect(doneJob.result.items[1].options[0]?.isbn13).toBe('9782205041231');

      // 3. Commit -> auto-archivage activé par défaut + trace committedAction dans l'historique 30 jours
      const commitRes = await ctxV26.app.request(`/api/jobs/photo/${jobId}/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ targetStatus: 'owned' })
      });
      expect(commitRes.status).toBe(200);
      const commitBody = (await commitRes.json()) as {
        committedCount: number;
        job: { archivedAt: string | null; result: { items: Array<{ committedAction?: string | null }> } };
      };
      expect(commitBody.committedCount).toBe(1);
      expect(commitBody.job.archivedAt).toBeTruthy();
      expect(commitBody.job.result.items[0].committedAction).toBe('owned');

      // 4. GET /api/jobs/photo/history renvoie bien le lot archivé avec retentionDays = 30
      const historyRes = await ctxV26.app.request('/api/jobs/photo/history', { headers: { cookie } });
      expect(historyRes.status).toBe(200);
      const historyBody = (await historyRes.json()) as {
        retentionDays: number;
        jobs: Array<{ id: string; archivedAt: string | null }>;
      };
      expect(historyBody.retentionDays).toBe(30);
      expect(historyBody.jobs.some((j) => j.id === jobId && Boolean(j.archivedAt))).toBe(true);

      ctxV26.worker.stop();
    } finally {
      dbV26.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
