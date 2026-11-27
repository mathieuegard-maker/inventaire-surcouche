// src/server/routes/auth-profile.test.ts
// Tests d'intégration Jalon 1 : Auth stricte HttpOnly, auto-admin ADMIN_EMAIL, profil, genres, reset et succession Foyer.

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDatabaseAdapter } from '../db/sqlite.adapter';
import { applySqlMigrations } from '../db/migrator';
import { loadServerConfig } from '../config';
import { createApp } from '../app';
import type { MailSender } from '../connectors/resend.connector';

interface SentMail {
  to: string;
  subject: string;
  html: string;
}

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/biblio_session=([^;]+)/);
  if (!match) {
    throw new Error(`Cookie biblio_session introuvable dans Set-Cookie: "${setCookie}"`);
  }
  return `biblio_session=${match[1]}`;
}

describe('Jalon 1 — Routes Auth & Profil (Hono + SQLite :memory:)', () => {
  let db: SqliteDatabaseAdapter;
  let sentMails: SentMail[];
  let app: ReturnType<typeof createApp>['app'];

  beforeEach(() => {
    db = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(db, path.resolve(process.cwd(), 'migrations'));
    sentMails = [];

    const mockMailSender: MailSender = {
      async sendEmail(input) {
        sentMails.push(input);
        return { sent: true, providerId: 'test-mail-id' };
      }
    };

    const config = loadServerConfig({
      NODE_ENV: 'test',
      ADMIN_EMAIL: 'admin@biblio.test',
      JWT_SECRET: 'test-secret-key'
    });

    app = createApp({ db, config, mailSender: mockMailSender }).app;
  });

  afterEach(() => {
    db.close();
  });

  it('refuse GET /api/me sans cookie même si ?userUri est passé (zéro fallback userUri)', async () => {
    const res1 = await app.request('/api/me');
    expect(res1.status).toBe(401);

    const res2 = await app.request('/api/me?userUri=usr_fake123', {
      headers: { 'x-user-uri': 'usr_fake123' }
    });
    expect(res2.status).toBe(401);
  });

  it('inscrit un compte (RGPD requis), émet un cookie HttpOnly et attribue automatiquement isAdmin via ADMIN_EMAIL', async () => {
    // Refus si RGPD non accepté
    const badRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'AdminUser',
        email: 'admin@biblio.test',
        password: 'SuperPassword123',
        gdprAccepted: false
      })
    });
    expect(badRes.status).toBe(400);

    // Inscription valide avec l'email ADMIN_EMAIL
    const regRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'AdminUser',
        email: 'ADMIN@biblio.test',
        password: 'SuperPassword123',
        gdprAccepted: true
      })
    });

    expect(regRes.status).toBe(201);
    const setCookie = regRes.headers.get('set-cookie') || '';
    expect(setCookie).toContain('biblio_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const body = (await regRes.json()) as {
      ok: boolean;
      profile: {
        user: { username: string; email: string; isAdmin: boolean; theme: string };
        library: { id: string; role: string; familyInviteCode: string; friendShareToken: string };
        defaultGenres: string[];
      };
    };

    expect(body.ok).toBe(true);
    expect(body.profile.user.isAdmin).toBe(true);
    expect(body.profile.user.email).toBe('admin@biblio.test');
    expect(body.profile.library.role).toBe('owner');
    expect(body.profile.defaultGenres.length).toBeGreaterThan(0);

    // Vérification GET /api/me avec cookie
    const cookie = extractSessionCookie(regRes);
    const meRes = await app.request('/api/me', { headers: { cookie } });
    expect(meRes.status).toBe(200);
  });

  it('gère le changement de thème sans mot de passe, la mise à jour d’identité avec mot de passe, et les genres par défaut', async () => {
    const regRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'Alice',
        email: 'alice@biblio.test',
        password: 'Password123!',
        gdprAccepted: true
      })
    });
    const cookie = extractSessionCookie(regRes);

    // Changement de thème sans currentPassword
    const themeRes = await app.request('/api/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ theme: 'dark' })
    });
    expect(themeRes.status).toBe(200);
    const themeBody = (await themeRes.json()) as { profile: { user: { theme: string } } };
    expect(themeBody.profile.user.theme).toBe('dark');

    // Changement de nom sans currentPassword -> 403
    const failRename = await app.request('/api/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ username: 'AliceRenamed' })
    });
    expect(failRename.status).toBe(403);

    // Changement de nom avec currentPassword -> 200
    const okRename = await app.request('/api/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ username: 'AliceRenamed', currentPassword: 'Password123!' })
    });
    expect(okRename.status).toBe(200);
    const renameBody = (await okRename.json()) as { profile: { user: { username: string } } };
    expect(renameBody.profile.user.username).toBe('AliceRenamed');

    // Genres par défaut : ajout, suppression, reset
    const addGenreRes = await app.request('/api/me/genres', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ action: 'add', genre: 'Steampunk' })
    });
    expect(addGenreRes.status).toBe(200);
    const added = (await addGenreRes.json()) as { defaultGenres: string[] };
    expect(added.defaultGenres).toContain('Steampunk');

    const removeGenreRes = await app.request('/api/me/genres', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ action: 'remove', genre: 'Steampunk' })
    });
    const removed = (await removeGenreRes.json()) as { defaultGenres: string[] };
    expect(removed.defaultGenres).not.toContain('Steampunk');

    const resetGenreRes = await app.request('/api/me/genres', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ action: 'reset' })
    });
    expect(resetGenreRes.status).toBe(200);
    const resetData = (await resetGenreRes.json()) as { defaultGenres: string[] };
    expect(resetData.defaultGenres.length).toBeGreaterThan(2);

    // Réordonnancement manuel des genres par défaut (PUT /api/me/genres/reorder)
    const reversed = [...resetData.defaultGenres].reverse();
    const reorderRes = await app.request('/api/me/genres/reorder', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ genres: reversed })
    });
    expect(reorderRes.status).toBe(200);
    const reorderData = (await reorderRes.json()) as { defaultGenres: string[] };
    expect(reorderData.defaultGenres).toEqual(reversed);

    const meAfterReorder = await app.request('/api/me', { headers: { cookie } });
    const meBody = (await meAfterReorder.json()) as { profile: { defaultGenres: string[] } };
    expect(meBody.profile.defaultGenres).toEqual(reversed);
  });

  it('exécute la récupération de mot de passe en 2 étapes et révoque les anciennes sessions', async () => {
    const regRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'Bob',
        email: 'bob@biblio.test',
        password: 'OldPassword123',
        gdprAccepted: true
      })
    });
    const oldCookie = extractSessionCookie(regRes);

    // Étape 1 : demande de code
    const forgotRes = await app.request('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'bob@biblio.test' })
    });
    expect(forgotRes.status).toBe(200);
    expect(sentMails.length).toBe(1);
    const codeMatch = sentMails[0].html.match(/<strong>(\d{6})<\/strong>/);
    expect(codeMatch).not.toBeNull();
    const code = codeMatch![1];

    // Étape 2 : validation du nouveau mot de passe
    const resetRes = await app.request('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identifier: 'Bob',
        code,
        newPassword: 'NewPassword456'
      })
    });
    expect(resetRes.status).toBe(200);

    // L'ancienne session doit être révoquée
    const oldMeRes = await app.request('/api/me', { headers: { cookie: oldCookie } });
    expect(oldMeRes.status).toBe(401);

    // Connexion possible avec le nouveau mot de passe
    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identifier: 'Bob',
        password: 'NewPassword456'
      })
    });
    expect(loginRes.status).toBe(200);
  });

  it('promeut automatiquement le membre le plus ancien en owner quand le propriétaire d’un foyer partagé supprime son compte, sans toucher au Catalogue Central', async () => {
    const now = new Date().toISOString();
    // Insérer un livre dans le Catalogue Central
    db.run(
      `INSERT INTO books (id, work_canonical_id, title, normalized_title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['book_central_1', 'work_central_1', 'Astérix le Gaulois', 'asterix le gaulois', now, now]
    );

    // Propriétaire crée son foyer
    const ownerRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'OwnerOne',
        email: 'owner@biblio.test',
        password: 'OwnerPassword1',
        gdprAccepted: true
      })
    });
    const ownerCookie = extractSessionCookie(ownerRes);
    const ownerBody = (await ownerRes.json()) as {
      profile: { library: { id: string; familyInviteCode: string } };
    };
    const familyCode = ownerBody.profile.library.familyInviteCode;
    const libraryId = ownerBody.profile.library.id;

    // Membre 2 rejoint le foyer via inviteCode
    const member2Res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'MemberTwo',
        email: 'member2@biblio.test',
        password: 'MemberPassword2',
        gdprAccepted: true,
        inviteCode: familyCode
      })
    });
    const member2Cookie = extractSessionCookie(member2Res);
    const member2Body = (await member2Res.json()) as {
      profile: { user: { id: string }; library: { id: string; role: string } };
    };
    expect(member2Body.profile.library.id).toBe(libraryId);
    expect(member2Body.profile.library.role).toBe('member');

    // Suppression du compte owner
    const delRes = await app.request('/api/me', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ password: 'OwnerPassword1' })
    });
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { deletedLibrary: boolean; promotedOwnerUserId: string | null };
    expect(delBody.deletedLibrary).toBe(false);
    expect(delBody.promotedOwnerUserId).toBe(member2Body.profile.user.id);

    // MemberTwo est maintenant owner du même foyer
    const member2Me = await app.request('/api/me', { headers: { cookie: member2Cookie } });
    expect(member2Me.status).toBe(200);
    const updatedMember2 = (await member2Me.json()) as {
      profile: { library: { id: string; role: string; members: Array<{ userId: string }> } };
    };
    expect(updatedMember2.profile.library.id).toBe(libraryId);
    expect(updatedMember2.profile.library.role).toBe('owner');
    expect(updatedMember2.profile.library.members).toHaveLength(1);

    // Le livre du Catalogue Central est intact
    const centralBook = db.get<{ id: string }>('SELECT id FROM books WHERE id = ?', ['book_central_1']);
    expect(centralBook?.id).toBe('book_central_1');
  });

  it('supprime le foyer solo quand son unique membre supprime son compte, en laissant le Catalogue Central intact', async () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO books (id, work_canonical_id, title, normalized_title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['book_central_2', 'work_central_2', 'Tintin au Tibet', 'tintin au tibet', now, now]
    );

    const soloRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'SoloUser',
        email: 'solo@biblio.test',
        password: 'SoloPassword123',
        gdprAccepted: true
      })
    });
    const soloCookie = extractSessionCookie(soloRes);
    const soloBody = (await soloRes.json()) as { profile: { library: { id: string } } };
    const soloLibId = soloBody.profile.library.id;

    const delRes = await app.request('/api/me', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', cookie: soloCookie },
      body: JSON.stringify({ password: 'SoloPassword123' })
    });
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { deletedLibrary: boolean; promotedOwnerUserId: string | null };
    expect(delBody.deletedLibrary).toBe(true);
    expect(delBody.promotedOwnerUserId).toBeNull();

    // Foyer supprimé
    const libRow = db.get<{ id: string }>('SELECT id FROM libraries WHERE id = ?', [soloLibId]);
    expect(libRow).toBeNull();

    // Catalogue Central intact
    const centralBook = db.get<{ id: string }>('SELECT id FROM books WHERE id = ?', ['book_central_2']);
    expect(centralBook?.id).toBe('book_central_2');
  });
});
