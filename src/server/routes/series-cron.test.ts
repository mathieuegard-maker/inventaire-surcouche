// src/server/routes/series-cron.test.ts
// Tests d'intégration Jalon 6 : Séries (Franchise/Découpages, expand, attach, exclude), Auteurs, Nouveautés sans faux positif intégrales et CRON idempotent.

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
import type { MailSender } from '../connectors/resend.connector';
import type { WebPushSender } from '../connectors/webpush.connector';

function extractCookie(res: Response): string {
  const raw = res.headers.get('set-cookie') || '';
  const m = raw.match(/biblio_session=([^;]+)/);
  if (!m) throw new Error('Cookie manquant');
  return `biblio_session=${m[1]}`;
}

async function makePngBuffer(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({
    create: { width: 80, height: 120, channels: 3, background: { r, g, b } }
  })
    .png()
    .toBuffer();
}

describe('Jalon 6 — Séries, Auteurs, Nouveautés & CRON Calendaire Idempotent', () => {
  let db: SqliteDatabaseAdapter;
  let tmpCoversDir: string;
  let sentEmails: Array<{ to: string; subject: string }>;
  let sentPushes: Array<{ endpoint: string; title: string }>;
  let appCtx: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(db, path.resolve(process.cwd(), 'migrations'));
    tmpCoversDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblio-j6-covers-'));
    sentEmails = [];
    sentPushes = [];

    const mockMail: MailSender = {
      async sendEmail(params) {
        sentEmails.push({ to: params.to, subject: params.subject });
        return { sent: true, providerId: 'mail_1' };
      }
    };

    const mockPush: WebPushSender = {
      isConfigured: () => true,
      async sendNotification(target, message) {
        sentPushes.push({ endpoint: target.endpoint, title: message.title });
        return { sent: true };
      }
    };

    const mockConnectors: BibliographicConnectors = {
      bnf: {
        async lookupByIsbn() { return null; },
        async searchByEnsembleId() { return []; },
        async sampleByCollectionName() { return []; },
        async searchByTitleAndAuthor() { return []; }
      },
      sudoc: { async lookupByIsbn() { return null; } },
      inventaire: {
        async lookupByIsbn() { return null; },
        async fetchSeriesWorks() { return []; }
      },
      wikidata: {
        async lookupWorkByQid() { return null; },
        async fetchSeriesWorksByQid(qid) {
          if (qid !== 'Q999999') return [];
          return [
            {
              title: 'Tome 2 (déjà couvert par intégrale)',
              volumeNumber: 2,
              volumeLabel: '2',
              wikidataQid: 'Q999002',
              authors: ['Auteur Saga'],
              isbn13s: [],
              source: 'wikidata'
            },
            {
              title: 'Tome 4 (vraie nouveauté)',
              volumeNumber: 4,
              volumeLabel: '4',
              wikidataQid: 'Q999004',
              authors: ['Auteur Saga'],
              isbn13s: [],
              source: 'wikidata'
            }
          ];
        }
      },
      googleBooks: { async lookupByIsbn() { return null; } },
      openLibrary: { async lookupByIsbn() { return null; } }
    };

    const config = loadServerConfig({
      NODE_ENV: 'test',
      COVERS_DIR: tmpCoversDir,
      CRON_NIGHTLY_HOUR: '2'
    });

    appCtx = createApp({
      db,
      config,
      mailSender: mockMail,
      webPushSender: mockPush,
      connectors: mockConnectors
    });
  });

  afterEach(() => {
    appCtx.cronScheduler.stop();
    appCtx.worker.stop();
    db.close();
    fs.rmSync(tmpCoversDir, { recursive: true, force: true });
  });

  it('gère GET /api/series/:id (découpages frères Franchise), attach (HS 0.5), exclude Couche 3 et GET /api/authors/:name', async () => {
    const reg = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'SeriesTester',
        email: 'ser@biblio.test',
        password: 'Password123',
        gdprAccepted: true
      })
    });
    const cookie = extractCookie(reg);

    // Crée 2 découpages dans une même Franchise (Fables classique vs Fables Nomad)
    const cut1 = appCtx.services.seriesGraphService.resolveOrCreateSeriesCut({
      seriesName: 'Fables',
      bookTitle: 'La Marche des soldats de bois',
      volumeNumber: 4,
      isHorsSerie: false,
      isIntegral: false,
      pageCount: 216,
      collectionName: 'Vertigo Classiques',
      publisher: 'Urban Comics',
      authors: ['Bill Willingham']
    });
    const now = new Date().toISOString();
    const bClassic = appCtx.repos.catalogRepo.upsertBookAutomatic({
      id: 'bk_fab_4',
      workCanonicalId: 'w_fab_4',
      seriesId: cut1.series.id,
      title: 'La Marche des soldats de bois',
      normalizedTitle: 'la marche des soldats de bois',
      volumeNumber: 4,
      volumeLabel: '4',
      sortOrder: 4,
      isHorsSerie: false,
      isIntegral: false,
      includedVolumes: [],
      authors: ['Bill Willingham'],
      scriptwriters: [],
      illustrators: [],
      publisher: 'Urban Comics',
      collectionName: 'Vertigo Classiques',
      publishYear: '2005',
      pageCount: 216,
      description: null,
      language: 'fr',
      mainCategory: 'Comics',
      subgenres: [],
      coverKey: null,
      wikidataQid: null,
      inventaireUri: null,
      sourceOrigin: 'auto',
      now
    });

    const cut2 = appCtx.services.seriesGraphService.resolveOrCreateSeriesCut({
      seriesName: 'Fables',
      bookTitle: 'Les Mille et Une Nuits',
      volumeNumber: 4,
      isHorsSerie: false,
      isIntegral: false,
      pageCount: 440,
      collectionName: 'Urban Nomad',
      publisher: 'Urban Comics',
      authors: ['Bill Willingham']
    });

    // Crée un one-shot à rattacher en HS position 0.5
    const hsCreated = await appCtx.app.request('/api/books/manual', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        title: 'Fables — Prélude HS',
        authors: ['Bill Willingham'],
        oneShot: true,
        ownershipStatus: 'owned'
      })
    });
    const hsBookId = ((await hsCreated.json()) as { book: { id: string } }).book.id;

    // Rattache le HS en position 0.5 dans cut1
    const attachRes = await appCtx.app.request('/api/series/attach', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        bookIds: [hsBookId],
        targetSeriesId: cut1.series.id,
        volumeType: 'hors_serie',
        volumeLabel: 'HS',
        sortOrder: 0.5
      })
    });
    expect(attachRes.status).toBe(200);

    // GET /api/series/:id retourne les 2 tomes triés (HS 0.5 avant T.4) ET le découpage frère Urban Nomad !
    const detRes = await appCtx.app.request(`/api/series/${cut1.series.id}`, { headers: { cookie } });
    expect(detRes.status).toBe(200);
    const detBody = (await detRes.json()) as {
      series: { id: string };
      siblingCuts: Array<{ id: string }>;
      books: Array<{ id: string; isHorsSerie: boolean; sortOrder: number }>;
    };
    expect(detBody.siblingCuts.map((c) => c.id)).toEqual([cut2.series.id]);
    expect(detBody.books.map((b) => b.id)).toEqual([hsBookId, bClassic.id]);
    expect(detBody.books[0].isHorsSerie).toBe(true);

    // Exclusion Couche 3 de bClassic -> disparaît de la série pour ce foyer
    const excRes = await appCtx.app.request(`/api/series/${cut1.series.id}/exclude`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ bookIds: [bClassic.id] })
    });
    expect(excRes.status).toBe(200);

    const detAfter = await appCtx.app.request(`/api/series/${cut1.series.id}`, { headers: { cookie } });
    const detAfterBody = (await detAfter.json()) as { books: Array<{ id: string }> };
    expect(detAfterBody.books.map((b) => b.id)).toEqual([hsBookId]);

    // GET /api/authors/Bill Willingham
    const authorRes = await appCtx.app.request('/api/authors/Bill%20Willingham', { headers: { cookie } });
    expect(authorRes.status).toBe(200);
    const authorBody = (await authorRes.json()) as { series: unknown[]; books: unknown[] };
    expect(authorBody.series.length).toBeGreaterThanOrEqual(1);
    expect(authorBody.books.length).toBeGreaterThanOrEqual(2);

    // Fusion de toute une série en 1 appel (`bookIds: []` + `mergeEntireSourceSeriesId`)
    const mergeWholeRes = await appCtx.app.request('/api/series/attach', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        bookIds: [],
        targetSeriesId: cut2.series.id,
        mergeEntireSourceSeriesId: cut1.series.id
      })
    });
    expect(mergeWholeRes.status).toBe(200);
    const mergedTargetDet = await appCtx.app.request(`/api/series/${cut2.series.id}`, { headers: { cookie } });
    const mergedTargetBody = (await mergedTargetDet.json()) as { books: Array<{ id: string }> };
    expect(mergedTargetBody.books.map((b) => b.id)).toContain(hsBookId);

    // Déduplication intelligente lors d'une fusion complète de série :
    // Un tome possédé sans numéro dans la série source masque le doublon non possédé homonyme dans la cible et hérite de son numéro !
    const dupTargetCut = appCtx.services.seriesGraphService.resolveOrCreateSeriesCut({
      seriesName: 'Tintin Cible',
      bookTitle: 'Tintin en Amérique',
      volumeNumber: 3,
      isHorsSerie: false,
      isIntegral: false,
      authors: ['Hergé']
    });
    const unownedTargetBook = appCtx.repos.catalogRepo.upsertBookAutomatic({
      id: 'bk_target_amerique',
      workCanonicalId: 'wd:Q_TIN_AMERIQUE',
      seriesId: dupTargetCut.series.id,
      title: 'Tintin en Amérique',
      normalizedTitle: 'tintin en amerique',
      volumeNumber: 3,
      volumeLabel: '3',
      sortOrder: 3,
      isHorsSerie: false,
      isIntegral: false,
      includedVolumes: [],
      authors: ['Hergé'],
      scriptwriters: [],
      illustrators: [],
      publisher: 'Casterman',
      collectionName: null,
      publishYear: '1932',
      pageCount: 62,
      description: null,
      language: 'fr',
      mainCategory: 'BD',
      subgenres: [],
      coverKey: null,
      wikidataQid: 'Q_TIN_AMERIQUE',
      inventaireUri: null,
      sourceOrigin: 'auto',
      now
    });

    const ownedSourceRes = await appCtx.app.request('/api/books/manual', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        title: 'Les Aventures de Tintin en Amérique',
        authors: ['Hergé'],
        seriesName: 'Tintin Source',
        oneShot: false,
        ownershipStatus: 'owned'
      })
    });
    const ownedSource = ((await ownedSourceRes.json()) as { book: { id: string; seriesId: string } }).book;

    const dedupMergeRes = await appCtx.app.request('/api/series/attach', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        bookIds: [],
        targetSeriesId: dupTargetCut.series.id,
        mergeEntireSourceSeriesId: ownedSource.seriesId
      })
    });
    expect(dedupMergeRes.status).toBe(200);

    const dedupTargetDet = await appCtx.app.request(`/api/series/${dupTargetCut.series.id}`, { headers: { cookie } });
    const dedupTargetBody = (await dedupTargetDet.json()) as {
      books: Array<{ id: string; volumeNumber: number | null; ownershipStatus: string }>;
    };
    // Le doublon non possédé est masqué en Couche 3 et l'exemplaire possédé a hérité du tome #3 !
    expect(dedupTargetBody.books.map((b) => b.id)).toEqual([ownedSource.id]);
    expect(dedupTargetBody.books.map((b) => b.id)).not.toContain(unownedTargetBook.id);
    expect(dedupTargetBody.books[0].volumeNumber).toBe(3);
    expect(dedupTargetBody.books[0].ownershipStatus).toBe('owned');
  });

  it('exécute le CRON nocturne & horaire de manière idempotente (zéro faux positif intégrale, purge couvertures orphelines > 30j, envoi Push + E-mail)', async () => {
    const reg = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'CronTester',
        email: 'cron@biblio.test',
        password: 'Password123',
        gdprAccepted: true
      })
    });
    const cookie = extractCookie(reg);

    // Crée une série avec Q-ID Wikidata Q999999 et une Intégrale T.1-3 possédée par le foyer
    const created = await appCtx.app.request('/api/books/manual', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        title: 'Ma Saga — Intégrale T1-T3',
        authors: ['Auteur Saga'],
        seriesName: 'Ma Saga',
        oneShot: false,
        isIntegral: true,
        includedVolumes: ['1', '2', '3'],
        ownershipStatus: 'owned'
      })
    });
    const createdBody = (await created.json()) as { book: { seriesId: string } };
    db.run('UPDATE series SET wikidata_qid = ? WHERE id = ?', ['Q999999', createdBody.book.seriesId]);

    // Ajoute une couverture orpheline de > 40 jours et un vieux log > 40 jours
    const orphanCov = await appCtx.services.coverService.storeBufferAsWebp(await makePngBuffer(120, 40, 200));
    const oldDate = '2026-10-01T00:00:00.000Z';
    db.run('UPDATE covers SET last_referenced_at = ? WHERE cover_key = ?', [oldDate, orphanCov.coverKey]);
    appCtx.repos.logRepo.append({
      traceId: 'old_trace',
      channel: 'test',
      stage: 'old',
      step: 'old',
      status: 'ok',
      summary: 'Vieux log',
      now: oldDate
    });

    // 1. Passe nocturne à 02h15 UTC -> détecte uniquement Tome 4 (zéro faux positif sur Tome 2 couvert par l'intégrale !), purge 1 log et 1 couverture orpheline
    const nightDate = new Date('2026-11-23T02:15:00.000Z');
    const night1 = await appCtx.cronScheduler.runNightlyPass(nightDate);
    expect(night1.skipped).toBe(false);
    expect(night1.newAlertsCount).toBe(1);
    expect(night1.logsPurged).toBeGreaterThanOrEqual(1);
    expect(night1.orphanCoversDeleted).toBe(1);

    // Vérifie GET /api/releases : uniquement Tome 4 !
    const relRes = await appCtx.app.request('/api/releases', { headers: { cookie } });
    const relBody = (await relRes.json()) as { alerts: Array<{ book: { title: string; volumeNumber: number } }> };
    expect(relBody.alerts).toHaveLength(1);
    expect(relBody.alerts[0].book.volumeNumber).toBe(4);

    // 2. Idempotence : 2e passe nocturne le même jour -> skipped: true !
    const night2 = await appCtx.cronScheduler.runNightlyPass(new Date('2026-11-23T03:00:00.000Z'));
    expect(night2.skipped).toBe(true);

    // 3. Configure préférences notifications (quotidien, 09h UTC, push + email) + souscription Push
    await appCtx.app.request('/api/notifications/prefs', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        frequency: 'daily',
        dayOfWeek: 1,
        dayOfMonth: 1,
        hour: 9,
        timezone: 'UTC',
        channel: 'both'
      })
    });
    await appCtx.app.request('/api/notifications/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        endpoint: 'https://push.example.test/sub1',
        keys: { p256dh: 'key_p256dh', auth: 'key_auth' }
      })
    });

    // Passe horaire à 09h00 UTC -> 1 Push + 1 E-mail envoyés !
    const hourDate = new Date('2026-11-23T09:00:00.000Z');
    const hourly1 = await appCtx.cronScheduler.runHourlyPass(hourDate);
    expect(hourly1.skipped).toBe(false);
    expect(hourly1.notifiedUsers).toBe(1);
    expect(hourly1.pushSent).toBe(1);
    expect(hourly1.emailsSent).toBe(1);
    expect(sentPushes).toHaveLength(1);
    expect(sentEmails).toHaveLength(1);

    // Idempotence passe horaire sur la même heure -> skipped: true !
    const hourly2 = await appCtx.cronScheduler.runHourlyPass(new Date('2026-11-23T09:30:00.000Z'));
    expect(hourly2.skipped).toBe(true);
  });

  it('Lot 2 (Intégrales) : normalise la franchise depuis une intégrale, crée une œuvre intégrale distincte sans écraser T.1, couvre T.1-T.3 et calcule stats physiques + progression unitaire', async () => {
    const { extractFranchiseBaseName } = await import('../../shared/bibliographic/text-normalize.util');
    expect(extractFranchiseBaseName("L'intégrale Lucky Luke").normalizedKey).toBe('lucky luke');
    expect(extractFranchiseBaseName('Lucky Luke intégrale').normalizedKey).toBe('lucky luke');

    const reg = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'IntTester',
        email: 'int@biblio.test',
        password: 'Password123',
        gdprAccepted: true
      })
    });
    const cookie = extractCookie(reg);

    // Création d'une série Lucky Luke avec 4 tomes unitaires (non possédés)
    const now = new Date().toISOString();
    const { series } = appCtx.services.seriesGraphService.resolveOrCreateSeriesCut({
      seriesName: 'Lucky Luke',
      bookTitle: 'La Mine d’or de Dick Digger',
      volumeNumber: 1,
      isHorsSerie: false,
      isIntegral: false,
      authors: ['Morris'],
      now
    });

    for (const [n, title] of [
      [1, 'La Mine d’or de Dick Digger'],
      [2, 'Rodéo'],
      [3, 'Arizona'],
      [4, 'Sous le ciel de l’Ouest']
    ] as const) {
      appCtx.repos.catalogRepo.upsertBookAutomatic({
        id: `bk_ll_${n}`,
        workCanonicalId: `wd:Q_LL_${n}`,
        seriesId: series.id,
        title,
        normalizedTitle: title.toLowerCase(),
        volumeNumber: n,
        volumeLabel: String(n),
        sortOrder: n,
        isHorsSerie: false,
        isIntegral: false,
        includedVolumes: [],
        authors: ['Morris'],
        scriptwriters: [],
        illustrators: [],
        publisher: 'Dupuis',
        collectionName: null,
        publishYear: '1949',
        pageCount: 48,
        description: null,
        language: 'fr',
        mainCategory: 'BD',
        subgenres: [],
        coverKey: null,
        wikidataQid: `Q_LL_${n}`,
        inventaireUri: null,
        sourceOrigin: 'auto',
        now
      });
    }

    // L'utilisateur déclare une intégrale couvrant les tomes 1 à 3 depuis la série (ou depuis T.1)
    const intRes = await appCtx.app.request(`/api/series/${series.id}/integrals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        includedVolumes: ['1', '2', '3'],
        sourceBookId: 'bk_ll_1',
        ownershipStatus: 'owned'
      })
    });
    expect(intRes.status).toBe(201);
    const intBody = (await intRes.json()) as { book: { id: string; isIntegral: boolean; includedVolumes: string[] } };
    expect(intBody.book.isIntegral).toBe(true);
    expect(intBody.book.id).not.toBe('bk_ll_1'); // Le tome 1 unitaire n'a JAMAIS été écrasé !
    expect(intBody.book.includedVolumes).toEqual(['1', '2', '3']);

    // Vérification détail série : T.1..T.3 intacts et marqués ownedViaIntegral, progression unitaire = 3 / 4 !
    const detRes = await appCtx.app.request(`/api/series/${series.id}`, { headers: { cookie } });
    const detBody = (await detRes.json()) as {
      series: { ownedCount: number; knownVolumesCount: number };
      books: Array<{ id: string; isIntegral: boolean; ownedViaIntegral: { integralBookId: string } | null }>;
    };
    expect(detBody.series.ownedCount).toBe(3);
    expect(detBody.series.knownVolumesCount).toBe(4);
    const t1 = detBody.books.find((b) => b.id === 'bk_ll_1');
    const t3 = detBody.books.find((b) => b.id === 'bk_ll_3');
    const t4 = detBody.books.find((b) => b.id === 'bk_ll_4');
    expect(t1?.isIntegral).toBe(false);
    expect(t1?.ownedViaIntegral?.integralBookId).toBe(intBody.book.id);
    expect(t3?.ownedViaIntegral?.integralBookId).toBe(intBody.book.id);
    expect(t4?.ownedViaIntegral).toBeNull();

    // Stats globales : 1 livre physique possédé, couvrant 3 tomes !
    const statsRes = await appCtx.app.request('/api/stats', { headers: { cookie } });
    const statsBody = (await statsRes.json()) as {
      stats: { kpis: { ownedCount: number; coveredVolumesCount: number } };
    };
    expect(statsBody.stats.kpis.ownedCount).toBe(1);
    expect(statsBody.stats.kpis.coveredVolumesCount).toBe(3);
  });

  it('v2.4.1 — ne perd jamais les jobs actifs dans listJobsForUser, priorise priority:high, déduplique expandSeriesByGraph et annule proprement après purge', async () => {
    const reg = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'QueueGuard',
        email: 'queue@biblio.test',
        password: 'Password123',
        gdprAccepted: true
      })
    });
    const regBody = (await reg.json()) as {
      profile: { user: { id: string }; library: { id: string } };
    };
    const userId = regBody.profile.user.id;
    const libraryId = regBody.profile.library.id;
    const baseMs = Date.parse('2026-11-26T20:00:00.000Z');

    // 1. Créer 1 job running ancien + 1 job pending + 25 jobs terminés plus récents -> listJobsForUser(limit=10) garde TOUS les actifs en tête (running avant pending)
    appCtx.repos.jobRepo.createJob({
      id: 'job_old_running',
      type: 'series_enrich_volumes',
      userId,
      libraryId,
      payload: { seriesId: 'ser_run' },
      progressTotal: 10,
      now: new Date(baseMs).toISOString()
    });
    appCtx.repos.jobRepo.claimNextPendingJob(new Date(baseMs + 1000).toISOString(), ['series_enrich_volumes']);

    appCtx.repos.jobRepo.createJob({
      id: 'job_queued_normal',
      type: 'series_expand',
      userId,
      libraryId,
      payload: { seriesId: 'ser_norm' },
      progressTotal: 1,
      now: new Date(baseMs + 2000).toISOString()
    });
    appCtx.repos.jobRepo.createJob({
      id: 'job_queued_high',
      type: 'series_enrich_volumes',
      userId,
      libraryId,
      payload: { seriesId: 'ser_high', priority: 'high' },
      progressTotal: 4,
      now: new Date(baseMs + 3000).toISOString()
    });

    for (let i = 0; i < 25; i++) {
      const id = `job_done_${i}`;
      const ts = new Date(baseMs + 10_000 + i * 1000).toISOString();
      appCtx.repos.jobRepo.createJob({
        id,
        type: 'series_expand',
        userId,
        libraryId,
        payload: { seriesId: `ser_done_${i}` },
        progressTotal: 1,
        now: ts
      });
      appCtx.repos.jobRepo.completeJob(id, { ok: true }, 1, ts);
    }

    const listed = appCtx.repos.jobRepo.listJobsForUser(userId, libraryId, 10);
    expect(listed[0].id).toBe('job_old_running');
    expect(listed[0].status).toBe('running');
    expect(listed.some((j) => j.id === 'job_queued_normal')).toBe(true);
    expect(listed.some((j) => j.id === 'job_queued_high')).toBe(true);

    // 2. claimNextPendingJob choisit le job priority:high avant le job FIFO normal créé plus tôt
    const claimed = appCtx.repos.jobRepo.claimNextPendingJob(new Date(baseMs + 50_000).toISOString(), [
      'series_expand',
      'series_enrich_volumes'
    ]);
    expect(claimed?.id).toBe('job_queued_high');

    // 3. Déduplication en mémoire d'expandSeriesByGraph sur un même seriesId + protection si série supprimée en vol
    const nowIso = new Date().toISOString();
    const { series } = appCtx.services.seriesGraphService.resolveOrCreateSeriesCut({
      seriesName: 'Thorgal',
      bookTitle: 'La Magicienne trahie',
      volumeNumber: 1,
      isHorsSerie: false,
      isIntegral: false,
      authors: ['Rosinski'],
      now: nowIso
    });
    const [r1, r2] = await Promise.all([
      appCtx.services.seriesGraphService.expandSeriesByGraph(series.id),
      appCtx.services.seriesGraphService.expandSeriesByGraph(series.id)
    ]);
    expect(r1).toEqual(r2);

    // 4. Annulation coopérative via worker.cancelActiveJobs() : aucun crash si un job est annulé pendant son exécution
    let observedCancelled = false;
    appCtx.worker.registerHandler('book_enrich', async ({ isCancelled }) => {
      appCtx.worker.cancelActiveJobs();
      observedCancelled = isCancelled();
      return { result: { ok: true }, total: 1 };
    });
    appCtx.repos.jobRepo.createJob({
      id: 'job_cancel_test',
      type: 'book_enrich',
      userId,
      libraryId,
      payload: {},
      progressTotal: 1,
      now: nowIso
    });
    const ran = await appCtx.worker.processNextJob(['book_enrich']);
    expect(ran).toBe(true);
    expect(observedCancelled).toBe(true);
    // Un job annulé ne passe jamais en 'done'
    expect(appCtx.repos.jobRepo.findJobById('job_cancel_test')?.status).not.toBe('done');
  });

  it('v2.4.2 — isole collection_import sur sa propre voie pour que photo_ocr démarre immédiatement même pendant un gros import CSV', async () => {
    const reg = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'LaneTester',
        email: 'lane@biblio.test',
        password: 'Password123',
        gdprAccepted: true
      })
    });
    const regBody = (await reg.json()) as {
      profile: { user: { id: string }; library: { id: string } };
    };
    const userId = regBody.profile.user.id;
    const libraryId = regBody.profile.library.id;
    const nowIso = new Date().toISOString();

    let releaseImport!: () => void;
    const importStarted = new Promise<void>((resolve) => {
      appCtx.worker.registerHandler('collection_import', async () => {
        resolve();
        await new Promise<void>((done) => {
          releaseImport = done;
        });
        return { result: { ok: true }, total: 1 };
      });
    });

    let photoCompletedWhileImportRunning = false;
    let importStillRunning = true;
    appCtx.worker.registerHandler('photo_ocr', async () => {
      photoCompletedWhileImportRunning = importStillRunning;
      return { result: { items: [] }, total: 1 };
    });

    appCtx.repos.jobRepo.createJob({
      id: 'imp_long_csv',
      type: 'collection_import',
      userId,
      libraryId,
      payload: {},
      progressTotal: 50,
      now: nowIso
    });
    appCtx.repos.jobRepo.createJob({
      id: 'pjob_fast_ocr',
      type: 'photo_ocr',
      userId,
      libraryId,
      payload: {},
      progressTotal: 1,
      now: nowIso
    });

    appCtx.worker.start();
    try {
      await importStarted;
      // Attendre que photo_ocr termine PENDANT que collection_import est encore bloqué en running
      for (let i = 0; i < 40; i++) {
        const pRow = appCtx.repos.jobRepo.findJobById('pjob_fast_ocr');
        if (pRow?.status === 'done') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(appCtx.repos.jobRepo.findJobById('pjob_fast_ocr')?.status).toBe('done');
      expect(photoCompletedWhileImportRunning).toBe(true);
      expect(appCtx.repos.jobRepo.findJobById('imp_long_csv')?.status).toBe('running');
    } finally {
      importStillRunning = false;
      releaseImport?.();
      appCtx.worker.stop();
    }
  });
});
