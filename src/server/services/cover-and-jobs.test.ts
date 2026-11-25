// src/server/services/cover-and-jobs.test.ts
// Tests d'intégration Jalon 2 : Couvertures WebP disque, purge orphelins > 30j, BackgroundWorker, /api/books/resolve-isbn, /api/jobs et HttpClient 429.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDatabaseAdapter } from '../db/sqlite.adapter';
import { applySqlMigrations } from '../db/migrator';
import { loadServerConfig } from '../config';
import { createApp } from '../app';
import { CoverService } from './cover.service';
import { HttpClient } from '../connectors/http-client';
import type { BibliographicConnectors } from '../connectors/types';

function extractCookie(res: Response): string {
  const raw = res.headers.get('set-cookie') || '';
  const m = raw.match(/biblio_session=([^;]+)/);
  if (!m) throw new Error('Cookie manquant');
  return `biblio_session=${m[1]}`;
}

async function makeTinyPngBuffer(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({
    create: {
      width: 120,
      height: 180,
      channels: 3,
      background: { r, g, b }
    }
  })
    .png()
    .toBuffer();
}

describe('Jalon 2 — Couvertures WebP disque, Jobs Serveur & Routes Acquisition', () => {
  let db: SqliteDatabaseAdapter;
  let tmpCoversDir: string;
  let appCtx: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(db, path.resolve(process.cwd(), 'migrations'));
    tmpCoversDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblio-covers-j2-'));

    const mockConnectors: BibliographicConnectors = {
      bnf: {
        async lookupByIsbn(isbn13) {
          if (isbn13 !== '9782203001015') return null;
          return {
            source: 'bnf',
            isbn13,
            title: 'Tintin au Congo',
            seriesName: 'Les Aventures de Tintin',
            seriesLinkKind: 'marc_ensemble_460',
            volumeNumber: '2',
            bnfEnsembleId: '34210001',
            authors: ['Hergé'],
            scriptwriters: ['Hergé'],
            illustrators: ['Hergé'],
            publisher: 'Casterman',
            pageCount: 62,
            rawSubjects: ['Bandes dessinées']
          };
        },
        async searchByEnsembleId(ensId) {
          if (ensId !== '34210001') return [];
          return [
            {
              title: 'Tintin au pays des Soviets',
              volumeNumber: 1,
              volumeLabel: '1',
              authors: ['Hergé'],
              isbn13s: ['9782203001008'],
              publisher: 'Casterman',
              source: 'bnf'
            },
            {
              title: 'Tintin en Amérique',
              volumeNumber: 3,
              volumeLabel: '3',
              authors: ['Hergé'],
              isbn13s: ['9782203001022'],
              publisher: 'Casterman',
              source: 'bnf'
            }
          ];
        },
        async sampleByCollectionName() {
          return [];
        },
        async searchByTitleAndAuthor() {
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

    const config = loadServerConfig({
      NODE_ENV: 'test',
      COVERS_DIR: tmpCoversDir
    });

    appCtx = createApp({
      db,
      config,
      connectors: mockConnectors,
      coverFetchImpl: (async () => new Response('', { status: 404 })) as typeof fetch
    });
  });

  afterEach(() => {
    appCtx.worker.stop();
    db.close();
    fs.rmSync(tmpCoversDir, { recursive: true, force: true });
  });

  it('compresse en WebP sur disque, sert GET /api/covers/:key en immutable (zéro base64 SQLite) et purge uniquement les orphelins > 30j', async () => {
    const reg = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'CoverTester',
        email: 'cover@biblio.test',
        password: 'Password1234',
        gdprAccepted: true
      })
    });
    const cookie = extractCookie(reg);
    const regData = (await reg.json()) as { profile: { library: { id: string } } };

    // 1. Upload d'une image PNG -> convertie en WebP sur disque
    const png1 = await makeTinyPngBuffer(40, 120, 220);
    const dataUrl1 = `data:image/png;base64,${png1.toString('base64')}`;

    const up1 = await appCtx.app.request('/api/covers/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ imageDataUrl: dataUrl1 })
    });
    expect(up1.status).toBe(201);
    const body1 = (await up1.json()) as { coverKey: string; coverUrl: string; byteSize: number; reused: boolean };
    expect(body1.coverKey).toMatch(/^cov_/);
    expect(body1.reused).toBe(false);
    expect(fs.existsSync(path.join(tmpCoversDir, `${body1.coverKey}.webp`))).toBe(true);

    // 2. Ré-upload identique -> dédupliqué via SHA-256
    const upDup = await appCtx.app.request('/api/covers/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ imageDataUrl: dataUrl1 })
    });
    const bodyDup = (await upDup.json()) as { coverKey: string; reused: boolean };
    expect(bodyDup.coverKey).toBe(body1.coverKey);
    expect(bodyDup.reused).toBe(true);

    // 3. GET /api/covers/:coverKey -> WebP + Cache-Control immutable
    const getRes = await appCtx.app.request(body1.coverUrl);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('content-type')).toBe('image/webp');
    expect(getRes.headers.get('cache-control')).toContain('immutable');
    const servedBytes = Buffer.from(await getRes.arrayBuffer());
    expect(servedBytes.subarray(0, 4).toString('ascii')).toBe('RIFF');

    // 4. Deuxième couverture (orpheline > 30j) + troisième couverture (référencée uniquement en Couche 3 Foyer)
    const covOrphan = await appCtx.services.coverService.storeBufferAsWebp(await makeTinyPngBuffer(220, 40, 40));
    const covOverride = await appCtx.services.coverService.storeBufferAsWebp(await makeTinyPngBuffer(40, 200, 80));

    // Vieillir les 3 couvertures de 45 jours
    const oldIso = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    db.run('UPDATE covers SET last_referenced_at = ?', [oldIso]);

    // Référencer covOverride dans library_books.overrides_json (Couche 3) et body1 dans books
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO books (id, work_canonical_id, title, normalized_title, cover_key, created_at, updated_at)
       VALUES ('bk_cov_1', 'w_cov_1', 'Livre Couv', 'livre couv', ?, ?, ?)`,
      [body1.coverKey, now, now]
    );
    appCtx.repos.libraryRepo.setLibraryBookOverrides(
      regData.profile.library.id,
      'bk_cov_1',
      { coverKey: covOverride.coverKey },
      now
    );

    const purge = await appCtx.services.coverService.purgeOrphanCovers(30);
    expect(purge.deletedCount).toBe(1);
    expect(fs.existsSync(path.join(tmpCoversDir, `${covOrphan.coverKey}.webp`))).toBe(false);
    expect(fs.existsSync(path.join(tmpCoversDir, `${body1.coverKey}.webp`))).toBe(true);
    expect(fs.existsSync(path.join(tmpCoversDir, `${covOverride.coverKey}.webp`))).toBe(true);
  });

  it('résout un ISBN via POST /api/books/resolve-isbn, crée un job series_expand et le dépile proprement via BackgroundWorker', async () => {
    const reg = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'JobTester',
        email: 'job@biblio.test',
        password: 'Password1234',
        gdprAccepted: true
      })
    });
    const cookie = extractCookie(reg);

    const res = await appCtx.app.request('/api/books/resolve-isbn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        isbns: ['978-2-203-00101-5'],
        channel: 'barcode_simple',
        action: 'owned'
      })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      results: Array<{
        isbn13: string;
        found: boolean;
        book: { id: string; title: string; seriesId: string; ownershipStatus: string };
        enqueuedSeriesExpandJobId: string | null;
      }>;
    };

    expect(body.results[0].found).toBe(true);
    expect(body.results[0].book.title).toBe('Tintin au Congo');
    expect(body.results[0].book.ownershipStatus).toBe('owned');
    expect(body.results[0].enqueuedSeriesExpandJobId).toBeTruthy();

    // Exécution déterministe du worker continu
    const processed = await appCtx.worker.processNextJob();
    expect(processed).toBe(true);

    // Vérification via GET /api/jobs
    const jobsRes = await appCtx.app.request('/api/jobs', { headers: { cookie } });
    expect(jobsRes.status).toBe(200);
    const jobsBody = (await jobsRes.json()) as {
      jobs: Array<{ id: string; status: string; result: { addedCount: number; totalVolumes: number } }>;
    };
    const expandJob = jobsBody.jobs.find((j) => j.id === body.results[0].enqueuedSeriesExpandJobId);
    expect(expandJob?.status).toBe('done');
    expect(expandJob?.result.addedCount).toBe(2);
    expect(expandJob?.result.totalVolumes).toBe(3);
  });

  it('ouvre le circuit-breaker sur HTTP 429 (Google Books) afin d’éviter toute rafale bloquée', async () => {
    let calls = 0;
    const mockFetch: typeof fetch = async () => {
      calls++;
      return new Response('Too Many Requests', { status: 429 });
    };

    const http = new HttpClient({ fetchImpl: mockFetch });
    const first = await http.fetchJson({ source: 'google_books', url: 'https://example.test/gb1' });
    expect(first).toBeNull();
    expect(http.isCircuitOpen('google_books')).toBe(true);

    // 2e appel court-circuité sans toucher le réseau
    const second = await http.fetchJson({ source: 'google_books', url: 'https://example.test/gb2' });
    expect(second).toBeNull();
    expect(calls).toBe(1);
  });

  it('élit la couverture consensuelle multi-éditions par dHash serveur (majorité + netteté) et déduplique la galerie', async () => {
    const makeGradientPng = async (width: number, height: number, invert = false): Promise<Buffer> => {
      const raw = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 3;
          const v = Math.round(((invert ? width - 1 - x : x) / Math.max(1, width - 1)) * 240);
          raw[idx] = v;
          raw[idx + 1] = Math.min(255, v + 10);
          raw[idx + 2] = Math.max(0, 255 - v);
        }
      }
      return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
    };

    const mainSmall = await makeGradientPng(140, 200, false);
    const mainLarge = await makeGradientPng(320, 480, false);
    const outlier = await makeGradientPng(400, 600, true);

    const customCoverService = new CoverService({
      coversDir: tmpCoversDir,
      catalogRepo: appCtx.repos.catalogRepo,
      libraryRepo: appCtx.repos.libraryRepo,
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('ed-outlier')) return new Response(new Uint8Array(outlier), { status: 200, headers: { 'content-type': 'image/png' } });
        if (url.includes('ed-main-1')) return new Response(new Uint8Array(mainSmall), { status: 200, headers: { 'content-type': 'image/png' } });
        if (url.includes('ed-main-2')) return new Response(new Uint8Array(mainLarge), { status: 200, headers: { 'content-type': 'image/png' } });
        if (url.includes('ed-main-3')) return new Response(new Uint8Array(mainSmall), { status: 200, headers: { 'content-type': 'image/png' } });
        return new Response('', { status: 404 });
      }) as typeof fetch
    });

    const consensus = await customCoverService.electBestCoverFromMultiEditions({
      isbn13s: [],
      candidateUrls: [
        'https://cdn.example.test/ed-outlier.png',
        'https://cdn.example.test/ed-main-1.png',
        'https://cdn.example.test/ed-main-2.png',
        'https://cdn.example.test/ed-main-3.png'
      ]
    });

    expect(consensus.winner).not.toBeNull();
    // 2 groupes visuels distincts : le groupe majoritaire (3 éditions) gagne devant l'outlier isolé (1 édition)
    expect(consensus.distinctCovers).toHaveLength(2);
    expect(consensus.distinctCovers[0].clusterSize).toBe(3);
    expect(consensus.distinctCovers[0].sourceUrl).toBe('https://cdn.example.test/ed-main-2.png');
    expect(consensus.distinctCovers[1].clusterSize).toBe(1);
    expect(consensus.distinctCovers[1].sourceUrl).toBe('https://cdn.example.test/ed-outlier.png');

    // Déduplication galerie externe face à la couverture locale gagnante : seule la variante distincte (outlier) reste proposée !
    const deduped = await customCoverService.deduplicateExternalCandidatesVisually(
      [
        { url: 'https://cdn.example.test/ed-main-1.png', label: 'Copie 1', minBytes: 200 },
        { url: 'https://cdn.example.test/ed-outlier.png', label: 'Édition alternative', minBytes: 200 }
      ],
      [consensus.winner!.coverKey]
    );
    expect(deduped).toHaveLength(1);
    expect(deduped[0].url).toBe('https://cdn.example.test/ed-outlier.png');
  });

  it('applique la cascade couvertures multi-éditions avant iTunes (franchise locale -> édition sœur -> iTunes 429) et respecte payload.runAfter', async () => {
    const rawGrad = Buffer.alloc(240 * 360 * 3);
    for (let i = 0; i < rawGrad.length; i++) {
      rawGrad[i] = (i * 37 + (i >> 5)) & 0xff;
    }
    const dupuisPng = await sharp(rawGrad, { raw: { width: 240, height: 360, channels: 3 } }).png().toBuffer();
    const localPng = await makeTinyPngBuffer(180, 60, 40);
    const itunesCalls: string[] = [];

    const customConnectors: BibliographicConnectors = {
      bnf: {
        async lookupByIsbn() { return null; },
        async searchByEnsembleId() { return []; },
        async sampleByCollectionName() { return []; },
        async searchByTitleAndAuthor(title) {
          if (title.toLowerCase().includes('mourir')) {
            return [
              {
                source: 'bnf',
                isbn13: '9782800136943',
                title: "L'homme qui ne voulait pas mourir",
                seriesName: 'Spirou et Fantasio',
                volumeNumber: '48',
                authors: ['Jean-David Morvan', 'José Luis Munuera'],
                scriptwriters: ['Jean-David Morvan'],
                illustrators: ['José Luis Munuera'],
                rawSubjects: ['Bandes dessinées'],
                language: 'fr',
                contentKind: 'illustrated'
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
        async fetchWorkEditions() { return { isbn13s: [], coverUrls: [] }; }
      },
      wikidata: {
        async lookupWorkByQid() { return null; },
        async fetchSeriesWorksByQid() { return []; }
      },
      googleBooks: { async lookupByIsbn() { return null; } },
      openLibrary: { async lookupByIsbn() { return null; } }
    };

    const customApp = createApp({
      db,
      config: loadServerConfig({ NODE_ENV: 'test', COVERS_DIR: tmpCoversDir }),
      connectors: customConnectors,
      coverFetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('itunes.apple.com')) {
          itunesCalls.push(url);
          return new Response('Rate Limited', { status: 429 });
        }
        // L'édition kiosque 9782815206xxx est absente des CDN, mais l'édition Dupuis sœur 9782800136943 répond !
        if (url.includes('9782800136943') || url.includes('2800136946')) {
          return new Response(new Uint8Array(dupuisPng), { status: 200, headers: { 'content-type': 'image/png' } });
        }
        return new Response('', { status: 404 });
      }) as typeof fetch
    });

    try {
      const now = new Date().toISOString();
      const storedLocal = await customApp.services.coverService.storeBufferAsWebp(localPng, 'https://local.test/bouddha.png');

      // Série canonique déjà couverte en base ("Spirou et Fantasio en albums")
      db.run(
        `INSERT INTO franchises (id, canonical_name, normalized_key, created_at, updated_at)
         VALUES ('fra_spirou_albums', 'Spirou et Fantasio en albums', 'spirou et fantasio en albums', ?, ?),
                ('fra_spirou_kiosque', 'La collection Spirou et Fantasio', 'la collection spirou et fantasio', ?, ?)`,
        [now, now, now, now]
      );
      db.run(
        `INSERT INTO series (id, franchise_id, canonical_name, normalized_key, created_at, updated_at)
         VALUES ('ser_spirou_albums', 'fra_spirou_albums', 'Spirou et Fantasio en albums', 'spirou et fantasio en albums', ?, ?),
                ('ser_spirou_kiosque', 'fra_spirou_kiosque', 'La collection Spirou et Fantasio', 'la collection spirou et fantasio', ?, ?)`,
        [now, now, now, now]
      );

      // Livre canonique déjà couvert en local
      db.run(
        `INSERT INTO books (id, work_canonical_id, series_id, title, normalized_title, volume_number, authors_json, main_category, cover_key, created_at, updated_at)
         VALUES ('bk_canon_bouddha', 'w_canon_1', 'ser_spirou_albums', 'Le prisonnier du Bouddha', 'le prisonnier du bouddha', 14, '["André Franquin"]', 'BD', ?, ?, ?)`,
        [storedLocal.coverKey, now, now]
      );

      // 3 livres kiosque sans couverture
      db.run(
        `INSERT INTO books (id, work_canonical_id, series_id, title, normalized_title, volume_number, authors_json, main_category, cover_key, created_at, updated_at)
         VALUES ('bk_kiosk_a', 'w_kiosk_a', 'ser_spirou_kiosque', 'Le prisonnier du Bouddha', 'le prisonnier du bouddha', 14, '["André Franquin"]', 'BD', NULL, ?, ?),
                ('bk_kiosk_b', 'w_kiosk_b', 'ser_spirou_kiosque', 'L''homme qui ne voulait pas mourir', 'l homme qui ne voulait pas mourir', 37, '["Jean-David Morvan"]', 'BD', NULL, ?, ?),
                ('bk_kiosk_c', 'w_kiosk_c', 'ser_spirou_kiosque', 'Album introuvable rare', 'album introuvable rare', 99, '["Inconnu"]', 'BD', NULL, ?, ?)`,
        [now, now, now, now, now, now]
      );
      db.run(
        `INSERT INTO book_editions (isbn13, book_id, source, created_at)
         VALUES ('9782815206142', 'bk_kiosk_a', 'bnf', ?),
                ('9782815206371', 'bk_kiosk_b', 'bnf', ?),
                ('9782815206999', 'bk_kiosk_c', 'bnf', ?)`,
        [now, now, now]
      );

      const report = await customApp.services.ingestionService.enrichIncompleteSeriesVolumes('ser_spirou_kiosque');
      expect(report.processed).toBe(3);
      expect(report.coversAdded).toBe(2);
      expect(report.rateLimitedCount).toBe(1);

      // Livre A : réutilisation locale 0 ms (exactement le même cover_key WebP que la série canonique)
      const bookA = customApp.repos.catalogRepo.findBookById('bk_kiosk_a');
      expect(bookA?.cover_key).toBe(storedLocal.coverKey);

      // Livre B : couvert via l'édition sœur Dupuis (9782800136943) découverte avant iTunes + enregistrée dans book_editions
      const bookB = customApp.repos.catalogRepo.findBookById('bk_kiosk_b');
      expect(bookB?.cover_key).toBeTruthy();
      const editionsB = customApp.repos.catalogRepo.listEditionsByBookId('bk_kiosk_b').map((e) => e.isbn13);
      expect(editionsB).toContain('9782800136943');

      // iTunes n'a été appelé QU'UNE SEULE FOIS (uniquement pour Livre C après échec des niveaux 1, 2a et 2b !)
      expect(itunesCalls).toHaveLength(1);
      expect(itunesCalls[0]).toContain('Album%20introuvable%20rare');

      // Vérification de la reprise différée `runAfter` dans JobRepository.claimNextPendingJob
      const t0 = '2026-11-25T16:00:00.000Z';
      const tFuture = '2026-11-25T16:01:15.000Z';
      const tAfter = '2026-11-25T16:02:00.000Z';
      customApp.repos.jobRepo.createJob({
        id: 'job_delayed_1',
        type: 'series_enrich_volumes',
        userId: null,
        libraryId: null,
        payload: { seriesId: 'ser_spirou_kiosque', retryAttempt: 1, runAfter: tFuture },
        now: t0
      });

      // Avant runAfter : non réclamé
      expect(customApp.repos.jobRepo.claimNextPendingJob(t0, ['series_enrich_volumes'])).toBeNull();
      // Après runAfter : réclamé proprement
      const claimed = customApp.repos.jobRepo.claimNextPendingJob(tAfter, ['series_enrich_volumes']);
      expect(claimed?.id).toBe('job_delayed_1');
      expect(claimed?.status).toBe('running');
    } finally {
      customApp.worker.stop();
    }
  });
});
