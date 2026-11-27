// src/server/routes/social-stats-admin.test.ts
// Tests d'intégration Jalon 7 sur SQLite :memory: :
// 1. Social Amis + Réservation Cadeau anti-spoiler (aucune fuite vers le foyer propriétaire, purge auto au passage 'owned')
// 2. Partage Foyer (join + révocation immédiate sur régénération de code)
// 3. Statistiques & Exports CSV (BOM UTF-8) / JSON
// 4. Console Admin (403 non-admin, Catalogue Maître Couche 2 locked_fields résistant aux robots, RAZ quota IA, maintenance)

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDatabaseAdapter } from '../db/sqlite.adapter';
import { applySqlMigrations } from '../db/migrator';
import { loadServerConfig } from '../config';
import { createApp } from '../app';

function extractCookie(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? '';
  return raw.split(';')[0] ?? '';
}

describe('Jalon 7 — Social anti-spoiler, Statistiques/Export & Administration Couche 2', () => {
  let db: SqliteDatabaseAdapter;
  let ctx: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(db, path.resolve(process.cwd(), 'migrations'));
    const config = loadServerConfig({
      NODE_ENV: 'test',
      ADMIN_EMAIL: 'admin@biblio.test',
      JWT_SECRET: 'test-secret-jalon7',
      CRON_ENABLED: 'false'
    });
    ctx = createApp({ db, config });
  });

  afterEach(() => {
    db.close();
  });

  async function registerUser(username: string, email: string, password = 'Password123!') {
    const res = await ctx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, email, password, gdprAccepted: true })
    });
    expect(res.status).toBe(201);
    const cookie = extractCookie(res);
    const body = (await res.json()) as {
      ok: true;
      profile: {
        user: { id: string; username: string; isAdmin: boolean };
        library: { id: string; familyInviteCode: string; friendShareToken: string };
      };
    };
    return { cookie, profile: body.profile };
  }

  async function createManualBook(
    cookie: string,
    input: { title: string; authors?: string[]; ownershipStatus: 'owned' | 'wish'; pageCount?: number }
  ) {
    const res = await ctx.app.request('/api/books/manual', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        title: input.title,
        authors: input.authors ?? ['Auteur Test'],
        publisher: 'Éditeur Test',
        pageCount: input.pageCount ?? 120,
        mainCategory: 'BD',
        genres: ['Aventure'],
        ownershipStatus: input.ownershipStatus
      })
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: true; book: { id: string; title: string } };
    return body.book;
  }

  it('garantit la réservation cadeau anti-spoiler (zéro fuite foyer, 409 doublon, purge au passage Possédé)', async () => {
    const owner = await registerUser('alice', 'alice@biblio.test');
    const friend1 = await registerUser('bob', 'bob@biblio.test');
    const friend2 = await registerUser('chloe', 'chloe@biblio.test');

    const wishBook = await createManualBook(owner.cookie, {
      title: 'Astérix le Gaulois',
      ownershipStatus: 'wish'
    });
    const ownedBook = await createManualBook(owner.cookie, {
      title: 'Tintin au Tibet',
      ownershipStatus: 'owned'
    });

    // Prêt sur ownedBook pour vérifier que le nom d'emprunteur n'est JAMAIS exposé dans la vitrine publique
    const lendRes = await ctx.app.request('/api/loans', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie },
      body: JSON.stringify({ bookIds: [ownedBook.id], borrowerName: 'SecretEmprunteur42' })
    });
    expect(lendRes.status).toBe(201);

    const shareToken = owner.profile.library.friendShareToken;

    // 1. Visiteur non connecté : lecture seule, pas de nom d'emprunteur, canReserveGifts = false
    const anonRes = await ctx.app.request(`/api/social/share/${shareToken}`);
    expect(anonRes.status).toBe(200);
    const anonText = await anonRes.text();
    expect(anonText).not.toContain('SecretEmprunteur42');
    const anonData = JSON.parse(anonText) as {
      shared: {
        canReserveGifts: boolean;
        books: Array<{ id: string; isLent: boolean; giftReservation: string | null }>;
      };
    };
    expect(anonData.shared.canReserveGifts).toBe(false);
    expect(anonData.shared.books.find((b) => b.id === ownedBook.id)?.isLent).toBe(true);
    expect(anonData.shared.books.find((b) => b.id === wishBook.id)?.giftReservation).toBeNull();

    // 2. Ami 1 (Bob) s'abonne et réserve le cadeau
    const followRes = await ctx.app.request('/api/social/friends', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: friend1.cookie },
      body: JSON.stringify({ shareToken })
    });
    expect(followRes.status).toBe(201);

    const reserveRes = await ctx.app.request(`/api/social/share/${shareToken}/reserve/${wishBook.id}`, {
      method: 'POST',
      headers: { cookie: friend1.cookie }
    });
    expect(reserveRes.status).toBe(201);
    const reserveJson = (await reserveRes.json()) as { status: string };
    expect(reserveJson.status).toBe('reserved_by_me');

    // 3. Ami 2 (Chloé) voit 'reserved_by_other' et obtient 409 si elle essaie de réserver
    const f2ViewRes = await ctx.app.request(`/api/social/share/${shareToken}`, {
      headers: { cookie: friend2.cookie }
    });
    const f2View = (await f2ViewRes.json()) as {
      shared: { books: Array<{ id: string; giftReservation: string | null }> };
    };
    expect(f2View.shared.books.find((b) => b.id === wishBook.id)?.giftReservation).toBe('reserved_by_other');

    const f2Conflict = await ctx.app.request(`/api/social/share/${shareToken}/reserve/${wishBook.id}`, {
      method: 'POST',
      headers: { cookie: friend2.cookie }
    });
    expect(f2Conflict.status).toBe(409);

    // 4. ANTI-SPOILER STRICT : Alice (propriétaire) ne voit JAMAIS aucune trace de réservation sur aucune route !
    const ownerSelfReserve = await ctx.app.request(`/api/social/share/${shareToken}/reserve/${wishBook.id}`, {
      method: 'POST',
      headers: { cookie: owner.cookie }
    });
    expect(ownerSelfReserve.status).toBe(403);

    for (const url of [
      '/api/me',
      '/api/sync/pull',
      `/api/books/${wishBook.id}`,
      `/api/social/share/${shareToken}`
    ]) {
      const r = await ctx.app.request(url, { headers: { cookie: owner.cookie } });
      expect(r.status).toBe(200);
      const bodyText = await r.text();
      expect(bodyText).not.toContain('reserved_by_me');
      expect(bodyText).not.toContain('reserved_by_other');
      expect(bodyText).not.toContain(friend1.profile.user.id);
    }

    // 5. Quand Alice marque le livre Possédé, la réservation cadeau est automatiquement purgée
    const ownRes = await ctx.app.request('/api/library/books/batch-status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie },
      body: JSON.stringify({ bookIds: [wishBook.id], status: 'owned' })
    });
    expect(ownRes.status).toBe(200);
    expect(ctx.repos.socialRepo.findReservation(owner.profile.library.id, wishBook.id)).toBeNull();
  });

  it('gère la jonction de foyer (FAM-...) et la révocation immédiate par régénération de code (PUB-...)', async () => {
    const alice = await registerUser('alice2', 'alice2@biblio.test');
    const bob = await registerUser('bob2', 'bob2@biblio.test');

    const oldShareToken = alice.profile.library.friendShareToken;

    // Régénération PUB-... -> l'ancien lien répond 404, le nouveau 200
    const regenRes = await ctx.app.request('/api/social/tokens/regenerate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: alice.cookie },
      body: JSON.stringify({ tokenType: 'friend' })
    });
    expect(regenRes.status).toBe(200);
    const regenJson = (await regenRes.json()) as { newCode: string };
    expect(regenJson.newCode).not.toBe(oldShareToken);

    const oldRes = await ctx.app.request(`/api/social/share/${oldShareToken}`);
    expect(oldRes.status).toBe(404);
    const newRes = await ctx.app.request(`/api/social/share/${regenJson.newCode}`);
    expect(newRes.status).toBe(200);

    // Jonction foyer FAM-...
    const joinRes = await ctx.app.request('/api/social/family/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: bob.cookie },
      body: JSON.stringify({ inviteCode: alice.profile.library.familyInviteCode })
    });
    expect(joinRes.status).toBe(200);
    const joinJson = (await joinRes.json()) as { targetLibraryId: string; profile: { library: { id: string } } };
    expect(joinJson.targetLibraryId).toBe(alice.profile.library.id);
    expect(joinJson.profile.library.id).toBe(alice.profile.library.id);
  });

  it('calcule les statistiques et génère des exports CSV (BOM UTF-8) et JSON valides', async () => {
    const user = await registerUser('statsuser', 'stats@biblio.test');
    const b1 = await createManualBook(user.cookie, {
      title: 'Dune',
      authors: ['Frank Herbert'],
      ownershipStatus: 'owned',
      pageCount: 540
    });
    await createManualBook(user.cookie, {
      title: 'Le Messie de Dune',
      authors: ['Frank Herbert'],
      ownershipStatus: 'wish',
      pageCount: 310
    });

    // État de lecture personnel
    const readRes = await ctx.app.request(`/api/reading/${b1.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: user.cookie },
      body: JSON.stringify({ status: 'read', rating: 5, notes: 'Chef-d’œuvre' })
    });
    expect(readRes.status).toBe(200);

    const statsRes = await ctx.app.request('/api/stats?periodDays=30', {
      headers: { cookie: user.cookie }
    });
    expect(statsRes.status).toBe(200);
    const { stats } = (await statsRes.json()) as {
      stats: {
        kpis: { ownedCount: number; wishedCount: number; totalPages: number };
        reading: { readCount: number; averageRating: number | null };
        tops: { authors: Array<{ label: string; count: number }> };
      };
    };
    expect(stats.kpis.ownedCount).toBe(1);
    expect(stats.kpis.wishedCount).toBe(1);
    expect(stats.kpis.totalPages).toBe(540);
    expect(stats.reading.readCount).toBe(1);
    expect(stats.reading.averageRating).toBe(5);
    expect(stats.tops.authors[0]).toEqual({ label: 'Frank Herbert', count: 1 });

    // Export CSV (octets bruts commencent bien par le BOM UTF-8 EF BB BF pour Excel)
    const csvRes = await ctx.app.request('/api/me/export?format=csv', {
      headers: { cookie: user.cookie }
    });
    expect(csvRes.status).toBe(200);
    const csvBuf = new Uint8Array(await csvRes.arrayBuffer());
    expect(Array.from(csvBuf.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const csvText = new TextDecoder('utf-8').decode(csvBuf);
    expect(csvText).toContain('Dune');
    expect(csvText).toContain('Chef-d’œuvre');

    // Export JSON
    const jsonRes = await ctx.app.request('/api/me/export?format=json', {
      headers: { cookie: user.cookie }
    });
    expect(jsonRes.status).toBe(200);
    const exported = (await jsonRes.json()) as { count: number; books: Array<{ titre: string }> };
    expect(exported.count).toBe(2);
    expect(exported.books.some((b) => b.titre === 'Dune')).toBe(true);
  });

  it('protège /api/admin/* (403 non-admin) et verrouille Couche 2 locked_fields contre les robots', async () => {
    const admin = await registerUser('superadmin', 'admin@biblio.test');
    const regular = await registerUser('normaluser', 'normal@biblio.test');
    expect(admin.profile.user.isAdmin).toBe(true);
    expect(regular.profile.user.isAdmin).toBe(false);

    // Non-admin bloqué (403)
    const forbiddenOverview = await ctx.app.request('/api/admin/overview', {
      headers: { cookie: regular.cookie }
    });
    expect(forbiddenOverview.status).toBe(403);

    const book = await createManualBook(admin.cookie, {
      title: 'Titre Brut Robot',
      authors: ['Auteur Initial'],
      ownershipStatus: 'owned'
    });

    // Mise à jour Couche 2 Admin via /api/admin/catalog/bulk
    const bulkRes = await ctx.app.request('/api/admin/catalog/bulk', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({
        bookIds: [book.id],
        patch: {
          title: 'Titre Corrigé Admin',
          publisher: 'Éditeur Officiel',
          mainCategory: 'Roman'
        }
      })
    });
    expect(bulkRes.status).toBe(200);
    const bulkJson = (await bulkRes.json()) as { updatedCount: number; lockedFieldsAdded: string[] };
    expect(bulkJson.updatedCount).toBe(1);
    expect(bulkJson.lockedFieldsAdded).toEqual(expect.arrayContaining(['title', 'publisher', 'mainCategory']));

    // Tentative d'écrasement par un robot (Couche 1 upsertBookAutomatic) -> les champs verrouillés résistent !
    const existingRow = ctx.repos.catalogRepo.findBookById(book.id)!;
    const afterRobot = ctx.repos.catalogRepo.upsertBookAutomatic({
      id: existingRow.id,
      workCanonicalId: existingRow.work_canonical_id,
      seriesId: null,
      title: 'Titre Écrasé Par Robot',
      normalizedTitle: 'titre ecrase par robot',
      volumeNumber: null,
      volumeLabel: null,
      sortOrder: null,
      isHorsSerie: false,
      isIntegral: false,
      includedVolumes: [],
      authors: ['Auteur Robot'],
      scriptwriters: [],
      illustrators: [],
      publisher: 'Éditeur Robot',
      collectionName: null,
      publishYear: '2025',
      pageCount: 200,
      description: 'Description robot',
      language: 'fr',
      mainCategory: 'Autre',
      subgenres: [],
      coverKey: null,
      wikidataQid: null,
      inventaireUri: null,
      sourceOrigin: 'auto',
      now: new Date().toISOString()
    });

    expect(afterRobot.title).toBe('Titre Corrigé Admin');
    expect(afterRobot.publisher).toBe('Éditeur Officiel');
    expect(afterRobot.main_category).toBe('Roman');
    // Un champ NON verrouillé (publish_year) reste enrichissable automatiquement :
    expect(afterRobot.publish_year).toBe('2025');

    // RAZ quota IA + Maintenance logs
    const resetRes = await ctx.app.request(`/api/admin/users/${regular.profile.user.id}/reset-ai-quota`, {
      method: 'POST',
      headers: { cookie: admin.cookie }
    });
    expect(resetRes.status).toBe(200);

    const maintRes = await ctx.app.request('/api/admin/maintenance/purge_logs', {
      method: 'POST',
      headers: { cookie: admin.cookie }
    });
    expect(maintRes.status).toBe(200);

    // Pagination Catalogue Maître jusqu'à 100 entrées/page
    const catRes = await ctx.app.request('/api/admin/catalog?page=1&pageSize=100', {
      headers: { cookie: admin.cookie }
    });
    expect(catRes.status).toBe(200);
    const catBody = (await catRes.json()) as { pageSize: number; items: Array<{ id: string }> };
    expect(catBody.pageSize).toBe(100);
    expect(catBody.items.some((b) => b.id === book.id)).toBe(true);

    // Bannissement réversible (soft delete) d'un utilisateur : interdit l'auto-ban, révoque la session et bloque la reconnexion
    const selfBanRes = await ctx.app.request(`/api/admin/users/${admin.profile.user.id}/ban`, {
      method: 'POST',
      headers: { cookie: admin.cookie }
    });
    expect(selfBanRes.status).toBe(400);

    const banRes = await ctx.app.request(`/api/admin/users/${regular.profile.user.id}/ban`, {
      method: 'POST',
      headers: { cookie: admin.cookie }
    });
    expect(banRes.status).toBe(200);

    const regularMeAfterBan = await ctx.app.request('/api/me', { headers: { cookie: regular.cookie } });
    expect(regularMeAfterBan.status).toBe(401);

    const regularLoginBanned = await ctx.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'normal@biblio.test', password: 'Password123!' })
    });
    expect(regularLoginBanned.status).toBe(403);

    // Réactivation du compte -> connexion de nouveau autorisée
    const unbanRes = await ctx.app.request(`/api/admin/users/${regular.profile.user.id}/unban`, {
      method: 'POST',
      headers: { cookie: admin.cookie }
    });
    expect(unbanRes.status).toBe(200);

    const regularLoginRestored = await ctx.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'normal@biblio.test', password: 'Password123!' })
    });
    expect(regularLoginRestored.status).toBe(200);
  });
});
