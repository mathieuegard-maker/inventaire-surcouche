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
      connectors: mockConnectors
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
});
