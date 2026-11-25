// src/server/routes/sync-library-loans.test.ts
// Tests d'intégration Jalon 3 : Sync PUSH->PULL LWW, isolation lecture user_id, prêts/contacts, batch genres et suppression mixte (3 non prêtés + 2 prêtés).

import path from 'node:path';
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

function seedCentralBooks(db: SqliteDatabaseAdapter, count: number): string[] {
  const now = '2026-01-01T10:00:00.000Z';
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = `bk_seed_${i}`;
    db.run(
      `INSERT INTO books (id, work_canonical_id, title, normalized_title, main_category, subgenres_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'BD', '["Aventure"]', ?, ?)`,
      [id, `work_seed_${i}`, `Album Test ${i}`, `album test ${i}`, now, now]
    );
    ids.push(id);
  }
  return ids;
}

describe('Jalon 3 — Sync Offline (PUSH -> PULL LWW), Prêts & Actions par Lot', () => {
  let db: SqliteDatabaseAdapter;
  let appCtx: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(db, path.resolve(process.cwd(), 'migrations'));
    const config = loadServerConfig({ NODE_ENV: 'test' });
    appCtx = createApp({ db, config });
  });

  afterEach(() => {
    appCtx.worker.stop();
    db.close();
  });

  it('garantit PUSH -> PULL sans écrasement hors-ligne, LWW par timestamp entre 2 membres et isolation stricte des lectures par user_id', async () => {
    const [book1] = seedCentralBooks(db, 1);

    // Membre A crée le foyer
    const regA = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'MembreA',
        email: 'a@biblio.test',
        password: 'Password123',
        gdprAccepted: true
      })
    });
    const cookieA = extractCookie(regA);
    const dataA = (await regA.json()) as { profile: { library: { familyInviteCode: string } } };

    // Membre B rejoint le même foyer
    const regB = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'MembreB',
        email: 'b@biblio.test',
        password: 'Password123',
        gdprAccepted: true,
        inviteCode: dataA.profile.library.familyInviteCode
      })
    });
    const cookieB = extractCookie(regB);

    // 1. Membre B achète le livre hors-ligne à T2 (12:05) -> PUSH prioritaire
    const pushB = await appCtx.app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieB },
      body: JSON.stringify({
        operations: [
          {
            id: 'op_b_buy',
            op: 'SET_STATUS',
            bookId: book1,
            status: 'owned',
            timestamp: '2026-11-23T12:05:00.000Z'
          },
          {
            id: 'op_b_read',
            op: 'SET_READING',
            bookId: book1,
            status: 'read',
            rating: 5,
            notes: 'Chef-d’œuvre selon B',
            timestamp: '2026-11-23T12:05:00.000Z'
          }
        ]
      })
    });
    expect(pushB.status).toBe(200);

    // 2. Membre A avait mis le même livre en wishlist hors-ligne plus tôt à T1 (12:00) et se reconnecte après B !
    // Le serveur doit arbitrer LWW : T1 < T2 -> le passage en 'wish' de A ne doit PAS écraser l'achat 'owned' de B !
    const pushA = await appCtx.app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        operations: [
          {
            id: 'op_a_old_wish',
            op: 'SET_STATUS',
            bookId: book1,
            status: 'wish',
            timestamp: '2026-11-23T12:00:00.000Z'
          },
          {
            id: 'op_a_read',
            op: 'SET_READING',
            bookId: book1,
            status: 'to_read',
            rating: 0,
            notes: 'Note privée de A',
            timestamp: '2026-11-23T12:06:00.000Z'
          }
        ]
      })
    });
    const pushABody = (await pushA.json()) as { results: Array<{ id: string; applied: boolean; reason?: string }> };
    expect(pushABody.results[0]).toEqual({ id: 'op_a_old_wish', applied: false, reason: 'stale_timestamp_lww' });
    expect(pushABody.results[1].applied).toBe(true);

    // 3. PULL de A : voit bien `owned` (LWW), mais sa propre lecture (`to_read`), JAMAIS la note de B !
    const pullA = await appCtx.app.request('/api/sync/pull', { headers: { cookie: cookieA } });
    const pullABody = (await pullA.json()) as {
      books: Array<{ id: string; ownershipStatus: string; readingState: { status: string; notes: string } | null }>;
    };
    expect(pullABody.books).toHaveLength(1);
    expect(pullABody.books[0].ownershipStatus).toBe('owned');
    expect(pullABody.books[0].readingState?.status).toBe('to_read');
    expect(pullABody.books[0].readingState?.notes).toBe('Note privée de A');

    // 4. PULL de B : voit `owned` ET sa propre lecture (`read` / 5 étoiles)
    const pullB = await appCtx.app.request('/api/sync/pull', { headers: { cookie: cookieB } });
    const pullBBody = (await pullB.json()) as {
      books: Array<{ id: string; ownershipStatus: string; readingState: { status: string; rating: number } | null }>;
    };
    expect(pullBBody.books[0].ownershipStatus).toBe('owned');
    expect(pullBBody.books[0].readingState?.status).toBe('read');
    expect(pullBBody.books[0].readingState?.rating).toBe(5);
  });

  it('gère la suppression par lot mixte (3 non prêtés + 2 prêtés avec décisions individuelles keep vs return_and_delete) et les genres en lot Couche 3', async () => {
    const bookIds = seedCentralBooks(db, 5);
    const [b1, b2, b3, bLentKeep, bLentDelete] = bookIds;

    const reg = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'LotTester',
        email: 'lot@biblio.test',
        password: 'Password123',
        gdprAccepted: true
      })
    });
    const cookie = extractCookie(reg);

    // Passe les 5 livres en Possédé
    const ownRes = await appCtx.app.request('/api/library/books/batch-status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ bookIds, status: 'owned' })
    });
    expect(ownRes.status).toBe(200);

    // Prête bLentKeep à Claire et bLentDelete à Marc
    const lend1 = await appCtx.app.request('/api/loans', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ bookIds: [bLentKeep], borrowerName: 'Claire' })
    });
    expect(lend1.status).toBe(201);

    const lend2 = await appCtx.app.request('/api/loans', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ bookIds: [bLentDelete], borrowerName: 'Marc' })
    });
    expect(lend2.status).toBe(201);

    // Ajout cumulatif de genres en lot sur bLentKeep
    const genresRes = await appCtx.app.request('/api/library/books/batch-genres', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ bookIds: [bLentKeep], genres: ['Humour', 'Historique'] })
    });
    expect(genresRes.status).toBe(200);

    // Suppression par lot mixte des 5 livres :
    // - b1, b2, b3 (non prêtés) -> supprimés
    // - bLentKeep -> 'keep' (conservé possédé + prêt actif intact)
    // - bLentDelete -> 'return_and_delete' (marqué rendu + supprimé)
    const delRes = await appCtx.app.request('/api/library/books/batch-status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        bookIds,
        status: 'none',
        lentDecisions: {
          [bLentKeep]: 'keep',
          [bLentDelete]: 'return_and_delete'
        }
      })
    });
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as {
      deletedIds: string[];
      keptLentIds: string[];
      returnedAndDeletedIds: string[];
    };

    expect(delBody.deletedIds.sort()).toEqual([b1, b2, b3, bLentDelete].sort());
    expect(delBody.keptLentIds).toEqual([bLentKeep]);
    expect(delBody.returnedAndDeletedIds).toEqual([bLentDelete]);

    // Vérification après PULL : seul bLentKeep subsiste, toujours prêté à Claire, avec ses genres Couche 3 intacts !
    const pull = await appCtx.app.request('/api/sync/pull', { headers: { cookie } });
    const pullBody = (await pull.json()) as {
      books: Array<{
        id: string;
        ownershipStatus: string;
        activeLoan: { borrowerName: string } | null;
        genres: string[];
        hasUserOverrides: boolean;
      }>;
      loans: Array<{ bookId: string; borrowerName: string }>;
      contacts: Array<{ name: string }>;
    };

    expect(pullBody.books).toHaveLength(1);
    expect(pullBody.books[0].id).toBe(bLentKeep);
    expect(pullBody.books[0].ownershipStatus).toBe('owned');
    expect(pullBody.books[0].activeLoan?.borrowerName).toBe('Claire');
    expect(pullBody.books[0].genres).toContain('Humour');
    expect(pullBody.books[0].genres).toContain('Historique');
    expect(pullBody.books[0].genres).toContain('Aventure');
    expect(pullBody.books[0].hasUserOverrides).toBe(true);

    expect(pullBody.loans).toHaveLength(1);
    expect(pullBody.loans[0].bookId).toBe(bLentKeep);
    expect(pullBody.contacts.map((c) => c.name)).toContain('Claire');
    expect(pullBody.contacts.map((c) => c.name)).toContain('Marc');
  });

  it('ne bloque jamais POST /api/sync/push sur un bookId inexistant (book_not_found au lieu de 500 FK)', async () => {
    const [validBookId] = seedCentralBooks(db, 1);
    const reg = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'SyncResilience',
        email: 'syncres@biblio.test',
        password: 'Password123',
        gdprAccepted: true
      })
    });
    const cookie = extractCookie(reg);

    const pushRes = await appCtx.app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        operations: [
          {
            id: 'op_orphan_1',
            op: 'SET_STATUS',
            bookId: 'bk_old_deleted_id',
            status: 'owned',
            timestamp: '2026-11-23T10:00:00.000Z'
          },
          {
            id: 'op_valid_2',
            op: 'SET_STATUS',
            bookId: validBookId,
            status: 'owned',
            timestamp: '2026-11-23T10:01:00.000Z'
          }
        ]
      })
    });

    expect(pushRes.status).toBe(200);
    const pushBody = (await pushRes.json()) as {
      results: Array<{ id: string; applied: boolean; reason?: string }>;
    };
    expect(pushBody.results).toEqual([
      { id: 'op_orphan_1', applied: false, reason: 'book_not_found' },
      { id: 'op_valid_2', applied: true }
    ]);

    const pull = await appCtx.app.request('/api/sync/pull', { headers: { cookie } });
    expect(pull.status).toBe(200);
    const pullBody = (await pull.json()) as { books: Array<{ id: string; ownershipStatus: string }> };
    expect(pullBody.books).toHaveLength(1);
    expect(pullBody.books[0].id).toBe(validBookId);
    expect(pullBody.books[0].ownershipStatus).toBe('owned');
  });

  it('force isFullSync=true sur GET /api/sync/pull?since=... si la bibliothèque est vide ou après un catalog_reset (purge automatique IndexedDB client)', async () => {
    const [b1, b2] = seedCentralBooks(db, 2);
    const reg = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'ResetSyncTester',
        email: 'resetsync@biblio.test',
        password: 'Password123',
        gdprAccepted: true
      })
    });
    const cookie = extractCookie(reg);

    // 1. Bibliothèque vide -> même avec ?since=..., le serveur force isFullSync=true pour purger tout ancien cache client
    const emptyPull = await appCtx.app.request('/api/sync/pull?since=2026-11-25T10:00:00.000Z', {
      headers: { cookie }
    });
    const emptyBody = (await emptyPull.json()) as { isFullSync: boolean; books: unknown[] };
    expect(emptyBody.isFullSync).toBe(true);
    expect(emptyBody.books).toHaveLength(0);

    // 2. Ajout d'un livre + enregistrement d'un catalog_reset ultérieur à `since` -> force isFullSync=true même si un nouveau livre existe déjà
    await appCtx.app.request('/api/library/books/batch-status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ bookIds: [b1, b2], status: 'owned' })
    });
    appCtx.repos.jobRepo.upsertCronRun({
      job_name: 'catalog_reset',
      last_run_key: '2026-11-25T12:00:00.000Z',
      last_run_at: '2026-11-25T12:00:00.000Z',
      status: 'ok',
      summary_json: '{}'
    });

    const staleClientPull = await appCtx.app.request('/api/sync/pull?since=2026-11-25T11:00:00.000Z', {
      headers: { cookie }
    });
    const staleBody = (await staleClientPull.json()) as { isFullSync: boolean; books: unknown[] };
    expect(staleBody.isFullSync).toBe(true);
    expect(staleBody.books).toHaveLength(2);

    // 3. Un client déjà synchronisé APRÈS le reset reste en delta (isFullSync=false)
    const freshClientPull = await appCtx.app.request('/api/sync/pull?since=2026-11-25T13:00:00.000Z', {
      headers: { cookie }
    });
    const freshBody = (await freshClientPull.json()) as { isFullSync: boolean };
    expect(freshBody.isFullSync).toBe(false);
  });
});
