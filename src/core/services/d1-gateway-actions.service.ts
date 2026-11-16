// src/core/services/d1-gateway-actions.service.ts
// Actions complètes du Gateway D1 (KISS, DRY, SOLID) :
// Authentification, Foyer & Partage, Inventaire, Wishlist, Prêts, Catalogue, Séries/Hors-séries, Statuts de lecture.

import type { AppBackendEnv, DatabaseBinding } from '../adapters/storage-db.interface';
import { normalizeSeriesNumber, normalizeTextKey } from '../resolvers/bnf.resolver';
import { classifyBookMetadata } from '../utils/category-classifier.util';
import { isbnUtil } from '../utils/isbn.util';
import {
  expandSeriesVolumesInD1,
  rehydrateAllCatalogEntitiesInD1,
  resolveAndStoreIsbnInD1,
  resolveAuthSession,
  resolveBestCoverUrl,
  upsertCatalogEntity
} from './d1-gateway.service';

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateShortCode(len = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join('');
}

function jsonResp(
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

function extractShareToken(raw: string): string {
  const trimmed = String(raw || '').trim();
  const match = /((?:PUB|FAM)-[A-Z0-9]{4,12})/i.exec(trimmed);
  return (match ? match[1] : trimmed).toUpperCase();
}

async function addFriendConnectionForUser(
  db: DatabaseBinding,
  userId: string,
  rawToken: string
): Promise<{ ok: boolean; error?: string; friend?: Record<string, unknown> }> {
  const shareToken = extractShareToken(rawToken);
  if (!shareToken) return { ok: false, error: 'Code ou lien ami requis.' };

  const tokenRow = await db
    .prepare(
      `SELECT s.token, s.library_id, l.name as library_name, u.display_name as owner_name
       FROM share_tokens s
       JOIN libraries l ON l.id = s.library_id
       LEFT JOIN users u ON u.id = l.owner_user_id
       WHERE UPPER(s.token) = ? AND s.token_type = 'public_collection_readonly'
       LIMIT 1`
    )
    .bind(shareToken)
    .first<{ token: string; library_id: string; library_name: string; owner_name: string | null }>();

  if (!tokenRow) {
    return { ok: false, error: 'Lien ou code Vitrine Amis introuvable.' };
  }

  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR REPLACE INTO friend_connections (user_id, target_library_id, share_token, display_label, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(userId, tokenRow.library_id, tokenRow.token, tokenRow.library_name, now)
    .run();

  return {
    ok: true,
    friend: {
      libraryId: tokenRow.library_id,
      libraryName: tokenRow.library_name,
      ownerName: tokenRow.owner_name || tokenRow.library_name,
      shareToken: tokenRow.token
    }
  };
}

async function getOrCreateShareTokens(
  db: DatabaseBinding,
  libraryId: string,
  userId: string
): Promise<{ inviteCode: string; publicReadonlyToken: string }> {
  const now = new Date().toISOString();
  const existing = await db
    .prepare('SELECT token, token_type FROM share_tokens WHERE library_id = ?')
    .bind(libraryId)
    .all<{ token: string; token_type: string }>();

  let inviteCode = existing.results.find((r) => r.token_type === 'invite_member')?.token;
  let publicReadonlyToken = existing.results.find(
    (r) => r.token_type === 'public_collection_readonly'
  )?.token;

  if (!inviteCode) {
    inviteCode = `FAM-${generateShortCode(6)}`;
    await db
      .prepare(
        `INSERT OR IGNORE INTO share_tokens (token, library_id, token_type, target_role, label, created_by_user_id, created_at)
         VALUES (?, ?, 'invite_member', 'editor', 'Invitation Famille', ?, ?)`
      )
      .bind(inviteCode, libraryId, userId, now)
      .run();
  }

  if (!publicReadonlyToken) {
    publicReadonlyToken = `PUB-${generateShortCode(8)}`;
    await db
      .prepare(
        `INSERT OR IGNORE INTO share_tokens (token, library_id, token_type, target_role, label, created_by_user_id, created_at)
         VALUES (?, ?, 'public_collection_readonly', 'viewer', 'Lien Public Amis', ?, ?)`
      )
      .bind(publicReadonlyToken, libraryId, userId, now)
      .run();
  }

  return { inviteCode, publicReadonlyToken };
}

export async function handleD1GatewayAction(
  action: string,
  request: Request,
  env: AppBackendEnv,
  body: Record<string, any> | null
): Promise<Response | null> {
  const db = env.DB;
  if (!db) return null;

  const url = new URL(request.url);
  const now = new Date().toISOString();

  switch (action) {
    // ========================================================================
    // 1. AUTHENTIFICATION AUTONOME & GESTION FOYER / BIBLIOTHÈQUE PARTAGÉE
    // ========================================================================
    case 'auth-login':
    case 'auth-register': {
      const rawUsername = String(body?.username || '').trim();
      const rawPassword = String(body?.password || '');
      const inviteCode = String(body?.inviteCode || '').trim().toUpperCase();
      const mode = body?.mode || (action === 'auth-register' ? 'register' : 'auto');

      if (!rawUsername || !rawPassword) {
        return jsonResp({ error: 'Identifiant et mot de passe requis.' }, 400);
      }

      const emailKey = rawUsername.toLowerCase();
      const passHash = await sha256Hex(`biblio_salt_v2:${rawPassword}`);

      let userRow = await db
        .prepare('SELECT id, email, display_name, password_hash FROM users WHERE email = ? LIMIT 1')
        .bind(emailKey)
        .first<{ id: string; email: string; display_name: string; password_hash: string }>();

      if (userRow) {
        if (mode === 'register') {
          return jsonResp({ error: 'Cet identifiant existe déjà. Connectez-vous.' }, 409);
        }
        if (userRow.password_hash !== passHash) {
          return jsonResp({ error: 'Mot de passe incorrect.' }, 401);
        }
      } else {
        // Création automatique du compte utilisateur
        const userId = `usr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
        await db
          .prepare(
            'INSERT INTO users (id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .bind(userId, emailKey, rawUsername, passHash, now, now)
          .run();

        userRow = {
          id: userId,
          email: emailKey,
          display_name: rawUsername,
          password_hash: passHash
        };
      }

      // Vérifie si un code d'invitation famille a été fourni
      let targetLibraryId: string | null = null;
      if (inviteCode) {
        const tokenRow = await db
          .prepare(
            "SELECT library_id, target_role FROM share_tokens WHERE UPPER(token) = ? AND token_type = 'invite_member' LIMIT 1"
          )
          .bind(inviteCode)
          .first<{ library_id: string; target_role: string }>();
        if (tokenRow?.library_id) {
          targetLibraryId = tokenRow.library_id;
          await db
            .prepare(
              'INSERT OR REPLACE INTO library_members (library_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
            )
            .bind(targetLibraryId, userRow.id, tokenRow.target_role || 'editor', now)
            .run();
        }
      }

      // Récupère ou crée la bibliothèque du foyer de l'utilisateur
      if (!targetLibraryId) {
        const memberRow = await db
          .prepare('SELECT library_id FROM library_members WHERE user_id = ? LIMIT 1')
          .bind(userRow.id)
          .first<{ library_id: string }>();

        if (memberRow?.library_id) {
          targetLibraryId = memberRow.library_id;
        } else {
          targetLibraryId = `lib_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
          const libName = `Bibliothèque de ${userRow.display_name}`;
          await db
            .prepare(
              'INSERT INTO libraries (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
            )
            .bind(targetLibraryId, libName, userRow.id, now, now)
            .run();
          await db
            .prepare(
              'INSERT INTO library_members (library_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
            )
            .bind(targetLibraryId, userRow.id, 'owner', now)
            .run();
        }
      }

      // Création de la session
      const rawSessionToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
      const tokenHash = await sha256Hex(rawSessionToken);
      const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

      await db
        .prepare(
          'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
        )
        .bind(tokenHash, userRow.id, expiresAt, now)
        .run();

      // Si l'utilisateur arrive depuis un QR code "Vitrine Amis", on mémorise cet ami sur son compte
      // sans jamais mélanger sa collection personnelle avec celle de son ami
      const friendToken = String(body?.friendToken || '').trim();
      let followedFriend: Record<string, unknown> | undefined;
      if (friendToken) {
        const res = await addFriendConnectionForUser(db, userRow.id, friendToken);
        if (res.ok && res.friend) {
          followedFriend = res.friend;
        }
      }

      const tokens = await getOrCreateShareTokens(db, targetLibraryId, userRow.id);
      const isHttps = url.protocol === 'https:';
      const cookieStr = `biblio_session=${rawSessionToken}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${isHttps ? '; Secure' : ''}`;

      return jsonResp(
        {
          uri: `user:${targetLibraryId}`,
          id: userRow.id,
          username: userRow.display_name,
          libraryId: targetLibraryId,
          sessionToken: rawSessionToken,
          inviteCode: tokens.inviteCode,
          publicReadonlyToken: tokens.publicReadonlyToken,
          ...(followedFriend ? { followedFriend } : {})
        },
        200,
        { 'Set-Cookie': cookieStr }
      );
    }

    case 'user-get': {
      const auth = await resolveAuthSession(db, request, url.searchParams.get('uri'));
      if (!auth) {
        return jsonResp({ error: 'Session invalide' }, 401);
      }
      const tokens = await getOrCreateShareTokens(db, auth.libraryId, auth.userId);
      const members = await db
        .prepare(
          `SELECT u.display_name as username, lm.role, lm.joined_at
           FROM library_members lm
           JOIN users u ON u.id = lm.user_id
           WHERE lm.library_id = ?`
        )
        .bind(auth.libraryId)
        .all<{ username: string; role: string; joined_at: string }>();

      return jsonResp({
        uri: `user:${auth.libraryId}`,
        id: auth.userId,
        username: auth.username,
        libraryId: auth.libraryId,
        libraryName: auth.libraryName,
        role: auth.role,
        inviteCode: tokens.inviteCode,
        publicReadonlyToken: tokens.publicReadonlyToken,
        members: members.results || []
      });
    }

    case 'family-join': {
      const auth = await resolveAuthSession(db, request, body?.userUri);
      const inviteCode = String(body?.inviteCode || '').trim().toUpperCase();
      if (!auth || !inviteCode) {
        return jsonResp({ error: 'Code famille requis' }, 400);
      }
      const tokenRow = await db
        .prepare(
          "SELECT library_id, target_role FROM share_tokens WHERE UPPER(token) = ? AND token_type = 'invite_member' LIMIT 1"
        )
        .bind(inviteCode)
        .first<{ library_id: string; target_role: string }>();

      if (!tokenRow?.library_id) {
        return jsonResp({ error: 'Code famille introuvable ou expiré.' }, 404);
      }

      // Bascule l'utilisateur sur la bibliothèque partagée
      await db
        .prepare('DELETE FROM library_members WHERE user_id = ?')
        .bind(auth.userId)
        .run();
      await db
        .prepare(
          'INSERT INTO library_members (library_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
        )
        .bind(tokenRow.library_id, auth.userId, tokenRow.target_role || 'editor', now)
        .run();

      const tokens = await getOrCreateShareTokens(db, tokenRow.library_id, auth.userId);
      return jsonResp({
        ok: true,
        uri: `user:${tokenRow.library_id}`,
        libraryId: tokenRow.library_id,
        inviteCode: tokens.inviteCode,
        publicReadonlyToken: tokens.publicReadonlyToken
      });
    }

    case 'public-share-get': {
      const shareToken = extractShareToken(String(url.searchParams.get('token') || ''));
      if (!shareToken) return jsonResp({ error: 'Jeton requis' }, 400);

      const tokenRow = await db
        .prepare(
          `SELECT s.library_id, s.token_type, s.token, l.name as library_name, u.display_name as owner_name
           FROM share_tokens s
           JOIN libraries l ON l.id = s.library_id
           LEFT JOIN users u ON u.id = l.owner_user_id
           WHERE UPPER(s.token) = ? LIMIT 1`
        )
        .bind(shareToken)
        .first<{ library_id: string; token_type: string; token: string; library_name: string; owner_name: string | null }>();

      if (!tokenRow) return jsonResp({ error: 'Lien de partage invalide' }, 404);

      const items = await db
        .prepare(
          `SELECT li.edition_id, li.work_id, li.ownership_status, li.location,
                  ce.label as title, ce.series_uri, se.label as series_name,
                  ce.series_number, ce.sort_order, ce.image_url, ce.main_category,
                  (SELECT COUNT(*) FROM loans ln WHERE ln.library_item_id = li.id AND ln.returned_at IS NULL AND ln.deleted_at IS NULL) as is_lent
           FROM library_items li
           LEFT JOIN catalog_entities ce ON ce.uri = COALESCE(li.edition_id, li.work_id)
           LEFT JOIN catalog_entities se ON se.uri = ce.series_uri
           WHERE li.library_id = ? AND li.deleted_at IS NULL
           ORDER BY COALESCE(se.label, ce.label) ASC, ce.sort_order ASC, ce.label ASC`
        )
        .bind(tokenRow.library_id)
        .all();

      return jsonResp({
        libraryId: tokenRow.library_id,
        libraryName: tokenRow.library_name,
        ownerName: tokenRow.owner_name || tokenRow.library_name,
        token: tokenRow.token,
        tokenType: tokenRow.token_type,
        items: items.results || []
      });
    }

    case 'friends-list': {
      const auth = await resolveAuthSession(db, request, url.searchParams.get('uri'));
      if (!auth) return jsonResp({ error: 'Session invalide' }, 401);

      const rows = await db
        .prepare(
          `SELECT fc.target_library_id as libraryId,
                  COALESCE(fc.display_label, l.name) as libraryName,
                  u.display_name as ownerName,
                  fc.share_token as shareToken,
                  fc.created_at as createdAt,
                  (SELECT COUNT(*) FROM library_items li WHERE li.library_id = fc.target_library_id AND li.ownership_status = 'owned' AND li.deleted_at IS NULL) as ownedCount,
                  (SELECT COUNT(*) FROM library_items li WHERE li.library_id = fc.target_library_id AND li.ownership_status = 'wishlist' AND li.deleted_at IS NULL) as wishlistCount
           FROM friend_connections fc
           JOIN libraries l ON l.id = fc.target_library_id
           LEFT JOIN users u ON u.id = l.owner_user_id
           WHERE fc.user_id = ?
           ORDER BY fc.created_at DESC`
        )
        .bind(auth.userId)
        .all();

      return jsonResp({ friends: rows.results || [] });
    }

    case 'friends-add': {
      const auth = await resolveAuthSession(db, request, body?.userUri);
      if (!auth) return jsonResp({ error: 'Session invalide' }, 401);
      const token = String(body?.token || body?.shareToken || '');
      const result = await addFriendConnectionForUser(db, auth.userId, token);
      if (!result.ok) {
        return jsonResp({ error: result.error || 'Code ami invalide.' }, 400);
      }
      return jsonResp(result);
    }

    case 'friends-remove': {
      const auth = await resolveAuthSession(db, request, body?.userUri);
      if (!auth) return jsonResp({ error: 'Session invalide' }, 401);
      const targetLibraryId = String(body?.targetLibraryId || '').trim();
      if (targetLibraryId) {
        await db
          .prepare('DELETE FROM friend_connections WHERE user_id = ? AND target_library_id = ?')
          .bind(auth.userId, targetLibraryId)
          .run();
      }
      return jsonResp({ ok: true });
    }

    case 'loan-contacts-list': {
      const auth = await resolveAuthSession(db, request, url.searchParams.get('uri'));
      if (!auth) return jsonResp({ contacts: [] });

      const contactMap = new Map<string, { name: string; source: 'friend_share' | 'borrower' }>();
      const isPlaceholderContact = (name: string) => {
        const low = name.toLowerCase();
        return (
          low === 'prêt' ||
          low === 'pret' ||
          low === 'prêts' ||
          low === 'prets' ||
          low === 'ami' ||
          low === 'inconnu' ||
          low.startsWith('inconnu (') ||
          low === auth.username.toLowerCase()
        );
      };
      const addContact = (rawName: string | null | undefined, source: 'friend_share' | 'borrower') => {
        const clean = String(rawName || '').trim();
        if (!clean || isPlaceholderContact(clean)) return;
        const key = clean.toLowerCase();
        const existing = contactMap.get(key);
        if (!existing || (source === 'friend_share' && existing.source !== 'friend_share')) {
          contactMap.set(key, { name: clean, source });
        }
      };

      // 1. Amis connus par partage (bibliothèques suivies + personnes qui suivent ma bibliothèque)
      const followedOwners = await db
        .prepare(
          `SELECT u.display_name as name
           FROM friend_connections fc
           JOIN libraries l ON l.id = fc.target_library_id
           JOIN users u ON u.id = l.owner_user_id
           WHERE fc.user_id = ?`
        )
        .bind(auth.userId)
        .all<{ name: string }>();
      for (const r of followedOwners.results || []) addContact(r.name, 'friend_share');

      const followers = await db
        .prepare(
          `SELECT u.display_name as name
           FROM friend_connections fc
           JOIN users u ON u.id = fc.user_id
           WHERE fc.target_library_id = ?`
        )
        .bind(auth.libraryId)
        .all<{ name: string }>();
      for (const r of followers.results || []) addContact(r.name, 'friend_share');

      // 2. Personnes déjà enregistrées dans le carnet ou sur d'anciens prêts
      const savedContacts = await db
        .prepare('SELECT name, source FROM borrower_contacts WHERE library_id = ? ORDER BY name ASC')
        .bind(auth.libraryId)
        .all<{ name: string; source: 'friend_share' | 'borrower' }>();
      for (const r of savedContacts.results || []) {
        addContact(r.name, r.source === 'friend_share' ? 'friend_share' : 'borrower');
      }

      const prevLoans = await db
        .prepare('SELECT DISTINCT borrower_name FROM loans WHERE library_id = ? AND deleted_at IS NULL')
        .bind(auth.libraryId)
        .all<{ borrower_name: string }>();
      for (const r of prevLoans.results || []) addContact(r.borrower_name, 'borrower');

      const contacts = Array.from(contactMap.values()).sort((a, b) =>
        a.name.localeCompare(b.name, 'fr')
      );
      return jsonResp({ contacts });
    }

    // ========================================================================
    // 2. INVENTAIRE (COLLECTION DU FOYER) DANS D1
    // ========================================================================
    case 'inventory-list': {
      const userUri = url.searchParams.get('uri');
      const auth = await resolveAuthSession(db, request, userUri);
      const libraryId =
        auth?.libraryId ||
        (userUri?.startsWith('user:') ? userUri.slice(5) : userUri) ||
        'lib_default';

      const rows = await db
        .prepare(
          `SELECT id, COALESCE(edition_id, work_id) as entity, ownership_status, location, condition, created_at
           FROM library_items
           WHERE library_id = ? AND ownership_status = 'owned' AND deleted_at IS NULL`
        )
        .bind(libraryId)
        .all<{ id: string; entity: string; ownership_status: string; location: string; created_at: string }>();

      const items = (rows.results || []).map((r) => ({
        _id: r.id,
        id: r.id,
        entity: r.entity,
        location: r.location,
        created: r.created_at
      }));

      return jsonResp({ items });
    }

    case 'inventory-add': {
      const auth = await resolveAuthSession(db, request, body?.userUri);
      const libraryId = auth?.libraryId || 'lib_default';
      const entityUri = String(body?.uri || '').trim();
      if (!entityUri) return jsonResp({ error: 'URI requise' }, 400);

      const existing = await db
        .prepare(
          "SELECT id FROM library_items WHERE library_id = ? AND (edition_id = ? OR work_id = ?) AND ownership_status = 'owned' AND deleted_at IS NULL LIMIT 1"
        )
        .bind(libraryId, entityUri, entityUri)
        .first<{ id: string }>();

      const itemId = existing?.id || `itm_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      if (!existing) {
        await db
          .prepare(
            `INSERT INTO library_items (id, library_id, work_id, edition_id, ownership_status, acquired_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'owned', ?, ?, ?)`
          )
          .bind(itemId, libraryId, entityUri, entityUri, now, now, now)
          .run();
      }

      return jsonResp({ item: { _id: itemId, entity: entityUri }, _id: itemId });
    }

    case 'inventory-bulk': {
      const auth = await resolveAuthSession(db, request, body?.userUri);
      const libraryId = auth?.libraryId || 'lib_default';
      const uris: string[] = Array.isArray(body?.uris) ? body.uris : [];
      if (!uris.length) return jsonResp({ error: 'Tableau uris requis' }, 400);

      const addedItems: Array<{ uri: string; itemId: string }> = [];

      for (const rawUri of uris) {
        const entityUri = String(rawUri || '').trim();
        if (!entityUri) continue;
        const existing = await db
          .prepare(
            "SELECT id FROM library_items WHERE library_id = ? AND (edition_id = ? OR work_id = ?) AND ownership_status = 'owned' AND deleted_at IS NULL LIMIT 1"
          )
          .bind(libraryId, entityUri, entityUri)
          .first<{ id: string }>();

        if (existing?.id) {
          addedItems.push({ uri: entityUri, itemId: existing.id });
          continue;
        }

        const itemId = `itm_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
        await db
          .prepare(
            `INSERT INTO library_items (id, library_id, work_id, edition_id, ownership_status, acquired_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'owned', ?, ?, ?)`
          )
          .bind(itemId, libraryId, entityUri, entityUri, now, now, now)
          .run();
        addedItems.push({ uri: entityUri, itemId });
      }

      return jsonResp({
        success: true,
        added: addedItems.length,
        addedItems,
        errors: []
      });
    }

    case 'inventory-delete': {
      const auth = await resolveAuthSession(db, request, body?.userUri);
      const libraryId = auth?.libraryId || 'lib_default';
      const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];
      const uris: string[] = Array.isArray(body?.uris) ? body.uris : [];

      for (const id of ids) {
        await db
          .prepare('DELETE FROM library_items WHERE id = ? AND library_id = ?')
          .bind(id, libraryId)
          .run();
      }
      for (const u of uris) {
        await db
          .prepare(
            'DELETE FROM library_items WHERE library_id = ? AND (edition_id = ? OR work_id = ?)'
          )
          .bind(libraryId, u, u)
          .run();
      }
      return jsonResp({ ok: true });
    }

    // ========================================================================
    // 3. WISHLIST DANS D1
    // ========================================================================
    case 'lists-by-creator': {
      const userIdParam = url.searchParams.get('userId') || '';
      const auth = await resolveAuthSession(db, request, `user:${userIdParam}`);
      const libraryId = auth?.libraryId || userIdParam || 'lib_default';
      return jsonResp({
        lists: [{ _id: `wish_${libraryId}`, name: 'Wishlist', type: 'work' }]
      });
    }

    case 'lists-create': {
      const auth = await resolveAuthSession(db, request, null);
      const libraryId = auth?.libraryId || 'lib_default';
      return jsonResp({ list: { _id: `wish_${libraryId}`, name: 'Wishlist' } });
    }

    case 'lists-get': {
      const listId = url.searchParams.get('id') || '';
      const libraryId = listId.startsWith('wish_') ? listId.slice(5) : listId || 'lib_default';
      const rows = await db
        .prepare(
          "SELECT DISTINCT COALESCE(edition_id, work_id) as uri FROM library_items WHERE library_id = ? AND ownership_status = 'wishlist' AND deleted_at IS NULL"
        )
        .bind(libraryId)
        .all<{ uri: string }>();

      const elements = (rows.results || []).map((r) => ({ uri: r.uri, element: r.uri }));
      return jsonResp({ list: { _id: listId, elements }, elements });
    }

    case 'lists-add-elements': {
      const listId = String(body?.id || '');
      const auth = await resolveAuthSession(db, request, null);
      const libraryId =
        (listId.startsWith('wish_') ? listId.slice(5) : '') || auth?.libraryId || 'lib_default';
      const uris: string[] = Array.isArray(body?.uris) ? body.uris : [];

      await db.prepare('PRAGMA foreign_keys = OFF').run();
      for (const u of uris) {
        const entityUri = String(u || '').trim();
        if (!entityUri) continue;
        // Évite toute duplication dans library_items pour un même ouvrage
        await db
          .prepare(
            "DELETE FROM library_items WHERE library_id = ? AND ownership_status = 'wishlist' AND (edition_id = ? OR work_id = ?)"
          )
          .bind(libraryId, entityUri, entityUri)
          .run();
        const itemId = `wishitm_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
        await db
          .prepare(
            `INSERT INTO library_items (id, library_id, work_id, edition_id, ownership_status, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'wishlist', ?, ?)`
          )
          .bind(itemId, libraryId, entityUri, entityUri, now, now)
          .run();
      }
      return jsonResp({ ok: true });
    }

    case 'lists-remove-elements': {
      const listId = String(body?.id || '');
      const auth = await resolveAuthSession(db, request, null);
      const libraryId =
        (listId.startsWith('wish_') ? listId.slice(5) : '') || auth?.libraryId || 'lib_default';
      const uris: string[] = Array.isArray(body?.uris) ? body.uris : [];

      for (const u of uris) {
        await db
          .prepare(
            "DELETE FROM library_items WHERE library_id = ? AND ownership_status = 'wishlist' AND (edition_id = ? OR work_id = ?)"
          )
          .bind(libraryId, u, u)
          .run();
      }
      return jsonResp({ ok: true });
    }

    // ========================================================================
    // 4. PRÊTS (SHELVES / LOANS) DANS D1
    // ========================================================================
    case 'shelves': {
      const subPath = url.searchParams.get('path') || '';
      const ownersParam = url.searchParams.get('owners') || '';
      const auth = await resolveAuthSession(db, request, ownersParam);
      const libraryId =
        auth?.libraryId ||
        (ownersParam.startsWith('user:') ? ownersParam.slice(5) : ownersParam) ||
        'lib_default';

      if (subPath === 'by-owners') {
        const rows = await db
          .prepare(
            'SELECT id, library_item_id, borrower_name, loaned_at, notes FROM loans WHERE library_id = ? AND returned_at IS NULL AND deleted_at IS NULL'
          )
          .bind(libraryId)
          .all<{
            id: string;
            library_item_id: string;
            borrower_name: string;
            loaned_at: string;
            notes: string;
          }>();

        const shelves: Record<string, any> = {};
        for (const r of rows.results || []) {
          shelves[r.id] = {
            _id: r.id,
            name: `Prêts - ${r.borrower_name}`,
            description: r.notes || String(new Date(r.loaned_at).getTime()),
            items: [r.library_item_id]
          };
        }
        return jsonResp({ shelves });
      }

      if (subPath === 'by-ids') {
        const ids = (url.searchParams.get('ids') || '').split('|').filter(Boolean);
        const shelves: Record<string, any> = {};
        for (const id of ids) {
          const r = await db
            .prepare('SELECT id, library_item_id, borrower_name, loaned_at, notes FROM loans WHERE id = ? LIMIT 1')
            .bind(id)
            .first<{
              id: string;
              library_item_id: string;
              borrower_name: string;
              loaned_at: string;
              notes: string;
            }>();
          if (r) {
            shelves[r.id] = {
              _id: r.id,
              name: `Prêts - ${r.borrower_name}`,
              description: r.notes || String(new Date(r.loaned_at).getTime()),
              items: [r.library_item_id]
            };
          }
        }
        return jsonResp({ shelves });
      }

      if (!subPath && request.method === 'POST') {
        const rawName = String(body?.name || '');
        const borrowerName = rawName.replace(/^Prêts?\s*[-:]?\s*/i, '').trim();
        const effectiveBorrower = borrowerName || 'Inconnu';
        const description = String(body?.description || Date.now());
        const items: string[] = Array.isArray(body?.items) ? body.items : [];
        const itemRef = items[0] || '';
        const loanId = `loan_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

        await db.prepare('PRAGMA foreign_keys = OFF').run();
        await db
          .prepare(
            `INSERT INTO loans (id, library_id, library_item_id, borrower_name, loaned_at, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(loanId, libraryId, itemRef, effectiveBorrower, now, description, now, now)
          .run();

        // N'enregistre le contact que s'il s'agit d'un vrai nom (pas d'un libellé générique)
        if (
          effectiveBorrower.toLowerCase() !== 'inconnu' &&
          effectiveBorrower.toLowerCase() !== 'ami' &&
          !/^prêts?$/i.test(effectiveBorrower)
        ) {
          const contactId = `cnt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
          await db
            .prepare(
              `INSERT OR IGNORE INTO borrower_contacts (id, library_id, name, source, created_at)
               VALUES (?, ?, ?, 'manual', ?)`
            )
            .bind(contactId, libraryId, effectiveBorrower, now)
            .run();
        }

        return jsonResp({
          shelf: { _id: loanId, name: `Prêts - ${effectiveBorrower}`, description, items }
        });
      }

      if (subPath === 'add-items') {
        const loanId = String(body?.id || '');
        const items: string[] = Array.isArray(body?.items) ? body.items : [];
        if (loanId && items[0]) {
          await db
            .prepare('UPDATE loans SET library_item_id = ?, updated_at = ? WHERE id = ?')
            .bind(items[0], now, loanId)
            .run();
        }
        return jsonResp({ ok: true });
      }

      if (subPath === 'remove-items' || subPath === 'delete') {
        const loanId = String(body?.id || (Array.isArray(body?.ids) ? body.ids[0] : '') || '');
        if (loanId) {
          await db
            .prepare('UPDATE loans SET returned_at = ?, updated_at = ? WHERE id = ?')
            .bind(now, now, loanId)
            .run();
        }
        return jsonResp({ ok: true });
      }

      return jsonResp({ shelves: {} });
    }

    // ========================================================================
    // 5. CATALOGUE COMMUN, ENTITÉS, RECHERCHE & SÉRIES DANS D1
    // ========================================================================
    case 'rehydrate-catalog': {
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 6);
      const result = await rehydrateAllCatalogEntitiesInD1(db, { offset, limit });
      return jsonResp({ ok: true, ...result });
    }

    case 'entities-by-uris': {
      const rawUris = (url.searchParams.get('uris') || '')
        .split('|')
        .map((u) => u.trim())
        .filter(Boolean);
      const relatives = (url.searchParams.get('relatives') || '').includes('P629');
      const forceRefresh = url.searchParams.get('refresh') === '1';
      const attributesParam = url.searchParams.get('attributes') || '';
      const wantsImage = !attributesParam || attributesParam.includes('image');

      const entities: Record<string, any> = {};

      for (const requestedUri of rawUris) {
        let row = await db
          .prepare('SELECT uri, isbn13, work_uri, image_url, entity_json FROM catalog_entities WHERE uri = ? LIMIT 1')
          .bind(requestedUri)
          .first<{ uri: string; isbn13: string | null; work_uri: string | null; image_url: string | null; entity_json: string }>();

        const hasBrokenArkCover = Boolean(row?.image_url && row.image_url.includes('idArk='));

        // Si on cherche par ISBN et qu'il n'est pas encore dans D1 (ou si refresh=1 / couverture idArk cassée), auto-résolution !
        if ((!row || forceRefresh || hasBrokenArkCover) && (requestedUri.startsWith('isbn:') || row?.isbn13)) {
          const rawIsbn = requestedUri.startsWith('isbn:') ? requestedUri.slice(5) : (row?.isbn13 || '');
          const normIsbn13 = isbnUtil.toIsbn13(isbnUtil.normalize(rawIsbn)) || isbnUtil.normalize(rawIsbn);
          if (!row) {
            row = await db
              .prepare('SELECT uri, isbn13, work_uri, image_url, entity_json FROM catalog_entities WHERE isbn13 = ? OR uri = ? LIMIT 1')
              .bind(normIsbn13, `isbn:${normIsbn13}`)
              .first<{ uri: string; isbn13: string | null; work_uri: string | null; image_url: string | null; entity_json: string }>();
          }

          if (!row || forceRefresh || (row.image_url && row.image_url.includes('idArk='))) {
            if (row?.image_url && row.image_url.includes('idArk=')) {
              await db
                .prepare("UPDATE catalog_entities SET image_url = NULL WHERE uri = ? OR uri = ?")
                .bind(row.uri, row.work_uri || '')
                .run();
            }
            const autoResolved = await resolveAndStoreIsbnInD1(db, normIsbn13);
            if (autoResolved) {
              entities[requestedUri] = autoResolved;
              const workUri = (autoResolved.claims as any)?.['wdt:P629']?.[0];
              if (relatives && workUri) {
                const wRow = await db
                  .prepare('SELECT entity_json FROM catalog_entities WHERE uri = ? LIMIT 1')
                  .bind(workUri)
                  .first<{ entity_json: string }>();
                if (wRow) entities[workUri] = JSON.parse(wRow.entity_json);
              }
              continue;
            }
          }
        }

        if (row) {
          const parsed = JSON.parse(row.entity_json);
          if (
            !row.image_url &&
            wantsImage &&
            (requestedUri.startsWith('isbn:') || row.isbn13)
          ) {
            const rawIsbn = row.isbn13 || (requestedUri.startsWith('isbn:') ? requestedUri.slice(5) : '');
            const normIsbn13 = isbnUtil.toIsbn13(isbnUtil.normalize(rawIsbn)) || isbnUtil.normalize(rawIsbn);
            if (normIsbn13.length === 13) {
              const repairedCover = await resolveBestCoverUrl(normIsbn13, {
                title: parsed?.label || parsed?.labels?.fr
              });
              if (repairedCover) {
                parsed.image = { url: repairedCover };
                parsed.claims = {
                  ...(parsed.claims || {}),
                  'invp:P2': [repairedCover]
                };
                await db
                  .prepare('UPDATE catalog_entities SET image_url = ?, entity_json = ? WHERE uri = ?')
                  .bind(repairedCover, JSON.stringify(parsed), row.uri)
                  .run();
                if (row.work_uri) {
                  await db
                    .prepare("UPDATE catalog_entities SET image_url = COALESCE(image_url, ?) WHERE uri = ?")
                    .bind(repairedCover, row.work_uri)
                    .run();
                }
              }
            }
          }
          entities[requestedUri] = parsed;
          if (relatives && row.work_uri) {
            const wRow = await db
              .prepare('SELECT entity_json FROM catalog_entities WHERE uri = ? LIMIT 1')
              .bind(row.work_uri)
              .first<{ entity_json: string }>();
            if (wRow) entities[row.work_uri] = JSON.parse(wRow.entity_json);
          }
        }
      }

      return jsonResp({ entities });
    }

    case 'entities-create': {
      const claims = { ...((body?.claims || {}) as Record<string, any[]>) };
      const label =
        body?.labels?.fr ||
        body?.labels?.en ||
        body?.label ||
        claims['wdt:P1476']?.[0] ||
        'Sans titre';

      const p31 = claims['wdt:P31']?.[0];
      const isbn13 = claims['wdt:P212']?.[0]
        ? isbnUtil.normalize(String(claims['wdt:P212'][0]))
        : undefined;
      const workUri = claims['wdt:P629']?.[0] ? String(claims['wdt:P629'][0]) : undefined;
      const seriesUri = claims['wdt:P179']?.[0] ? String(claims['wdt:P179'][0]) : undefined;
      const seriesNumber = claims['wdt:P1545']?.[0]
        ? normalizeSeriesNumber(String(claims['wdt:P1545'][0]))
        : undefined;
      const authorUris: string[] = Array.isArray(claims['wdt:P50'])
        ? claims['wdt:P50'].map(String)
        : [];
      const imageUrl = claims['invp:P2']?.[0] || claims['wdt:P18']?.[0] || body?.imageUrl;

      let entityType: 'edition' | 'work' | 'serie' | 'human' = 'work';
      if (isbn13 || workUri) entityType = 'edition';
      else if (p31 === 'wd:Q277759' || p31 === 'wd:Q14406742') entityType = 'serie';
      else if (p31 === 'wd:Q5') entityType = 'human';

      const publisherLabel = typeof body?.publisher === 'string' ? body.publisher.trim() : '';
      if (publisherLabel && !claims['wdt:P123']?.length) {
        const pubUri = await upsertCatalogEntity(db, {
          entityType: 'publisher',
          label: publisherLabel,
          claims: {}
        });
        claims['wdt:P123'] = [pubUri];
      }

      const providedGenres: string[] = Array.isArray(body?.genres)
        ? body.genres.map((g: unknown) => String(g).trim()).filter(Boolean)
        : [];

      let mainCategory: string;
      let subgenres: string[];
      if (providedGenres.length > 0) {
        const gUris: string[] = [];
        for (const gLabel of providedGenres) {
          const gUri = await upsertCatalogEntity(db, {
            entityType: 'genre',
            label: gLabel,
            claims: {}
          });
          gUris.push(gUri);
        }
        claims['wdt:P136'] = gUris;
        mainCategory = providedGenres[0];
        subgenres = providedGenres.slice(1);
      } else {
        const classification = classifyBookMetadata({
          title: String(label),
          series: seriesUri ? String(label) : undefined,
          publisher: publisherLabel || undefined
        });
        mainCategory = classification.mainCategory;
        subgenres = classification.subgenres;
      }

      const createdUri = await upsertCatalogEntity(db, {
        entityType,
        label: String(label),
        isbn13,
        workUri,
        seriesUri,
        seriesNumber,
        authorUris,
        mainCategory,
        subgenres,
        imageUrl: imageUrl ? String(imageUrl) : undefined,
        descriptions:
          body?.descriptions && typeof body.descriptions === 'object' ? body.descriptions : {},
        claims
      });

      return jsonResp({
        uri: createdUri,
        entity: { uri: createdUri, labels: { fr: label }, claims }
      });
    }

    case 'entities-update-claim': {
      const uri = String(body?.uri || '').trim();
      const property = String(body?.property || '').trim();
      const newValue = body?.['new-value'] !== undefined ? body['new-value'] : body?.newValue;
      if (!uri || !property) return jsonResp({ error: 'uri et property requis' }, 400);

      const row = await db
        .prepare('SELECT * FROM catalog_entities WHERE uri = ? LIMIT 1')
        .bind(uri)
        .first<Record<string, any>>();

      if (!row) return jsonResp({ ok: true });

      const entityObj = JSON.parse(row.entity_json);
      entityObj.claims = entityObj.claims || {};
      if (newValue === null || newValue === undefined || newValue === '') {
        delete entityObj.claims[property];
      } else {
        entityObj.claims[property] = Array.isArray(newValue) ? newValue : [newValue];
      }

      const seriesUri =
        property === 'wdt:P179' ? (newValue ? String(newValue) : null) : row.series_uri;
      const seriesNumber =
        property === 'wdt:P1545'
          ? newValue
            ? normalizeSeriesNumber(String(newValue))
            : null
          : row.series_number;
      const sortOrder =
        seriesNumber && /^\d+(\.\d+)?$/.test(seriesNumber)
          ? parseFloat(seriesNumber)
          : row.sort_order;

      await db
        .prepare(
          'UPDATE catalog_entities SET series_uri = ?, series_number = ?, sort_order = ?, entity_json = ?, updated_at = ? WHERE uri = ?'
        )
        .bind(seriesUri, seriesNumber, sortOrder, JSON.stringify(entityObj), now, uri)
        .run();

      return jsonResp({ ok: true });
    }

    case 'entities-update-label': {
      const uri = String(body?.uri || '').trim();
      const value = String(body?.value || '').trim();
      if (!uri || !value) return jsonResp({ error: 'uri et value requis' }, 400);

      const row = await db
        .prepare('SELECT entity_json FROM catalog_entities WHERE uri = ? LIMIT 1')
        .bind(uri)
        .first<{ entity_json: string }>();

      if (row) {
        const entityObj = JSON.parse(row.entity_json);
        entityObj.label = value;
        entityObj.labels = { ...(entityObj.labels || {}), fr: value, en: value };
        await db
          .prepare(
            'UPDATE catalog_entities SET label = ?, normalized_label = ?, entity_json = ?, updated_at = ? WHERE uri = ?'
          )
          .bind(value, normalizeTextKey(value), JSON.stringify(entityObj), now, uri)
          .run();
      }
      return jsonResp({ ok: true });
    }

    case 'entities-update-genres': {
      const targetUris = new Set(
        [String(body?.uri || '').trim(), String(body?.workUri || '').trim()].filter(Boolean)
      );
      const cleanGenres: string[] = Array.isArray(body?.genres)
        ? body.genres.map((g: unknown) => String(g).trim()).filter(Boolean)
        : [];
      if (targetUris.size === 0) return jsonResp({ error: 'uri requis' }, 400);

      let resolvedSeriesUri = String(body?.seriesUri || '').trim();
      if (!resolvedSeriesUri) {
        for (const u of targetUris) {
          const sLookup = await db
            .prepare('SELECT series_uri FROM catalog_entities WHERE uri = ? AND series_uri IS NOT NULL LIMIT 1')
            .bind(u)
            .first<{ series_uri: string | null }>();
          if (sLookup?.series_uri) {
            resolvedSeriesUri = sLookup.series_uri;
            break;
          }
        }
      }

      if (resolvedSeriesUri && body?.propagateSeries !== false) {
        targetUris.add(resolvedSeriesUri);
        const seriesRows = await db
          .prepare('SELECT uri FROM catalog_entities WHERE series_uri = ?')
          .bind(resolvedSeriesUri)
          .all<{ uri: string }>();
        for (const sr of seriesRows.results || []) {
          if (sr.uri) targetUris.add(sr.uri);
        }
      }

      const genreUris: string[] = [];
      for (const gLabel of cleanGenres) {
        const gUri = await upsertCatalogEntity(db, {
          entityType: 'genre',
          label: gLabel,
          claims: {}
        });
        genreUris.push(gUri);
      }

      const mainCategory = cleanGenres[0] || 'Autre';
      const subgenres = cleanGenres.slice(1);
      const subgenresJson = JSON.stringify(subgenres);

      for (const targetUri of targetUris) {
        const row = await db
          .prepare('SELECT entity_json FROM catalog_entities WHERE uri = ? LIMIT 1')
          .bind(targetUri)
          .first<{ entity_json: string }>();
        if (!row) continue;

        const entityObj = JSON.parse(row.entity_json);
        entityObj.claims = entityObj.claims || {};
        entityObj.mainCategory = mainCategory;
        entityObj.subgenres = subgenres;
        if (genreUris.length > 0) {
          entityObj.claims['wdt:P136'] = genreUris;
        } else {
          delete entityObj.claims['wdt:P136'];
        }

        await db
          .prepare(
            'UPDATE catalog_entities SET main_category = ?, subgenres_json = ?, entity_json = ?, updated_at = ? WHERE uri = ?'
          )
          .bind(mainCategory, subgenresJson, JSON.stringify(entityObj), now, targetUri)
          .run();
      }

      return jsonResp({
        ok: true,
        genres: cleanGenres,
        genreUris,
        propagatedSeriesUri: resolvedSeriesUri || null
      });
    }

    case 'entities-patch': {
      const editionUri = String(body?.editionUri || '').trim();
      const workUri = String(body?.workUri || '').trim();
      if (!editionUri) return jsonResp({ error: 'editionUri requis' }, 400);

      const title = typeof body?.title === 'string' ? body.title.trim() : '';
      const seriesUri = typeof body?.seriesUri === 'string' ? body.seriesUri.trim() : '';
      const rawSeriesNumber =
        typeof body?.seriesNumber === 'string' ? body.seriesNumber.trim() : '';
      const seriesNumber = rawSeriesNumber ? normalizeSeriesNumber(rawSeriesNumber) : null;
      const sortOrder =
        seriesNumber && /^\d+(\.\d+)?$/.test(seriesNumber) ? parseFloat(seriesNumber) : 1000.0;
      const authorUris: string[] | null = Array.isArray(body?.authorUris)
        ? body.authorUris.map(String).filter(Boolean)
        : null;
      const publisherLabel =
        typeof body?.publisher === 'string' ? body.publisher.trim() : undefined;
      const publishDate =
        typeof body?.publishDate === 'string' ? body.publishDate.trim() : undefined;
      const pageCount =
        body?.pageCount !== undefined && body?.pageCount !== null && body?.pageCount !== ''
          ? Number(body.pageCount)
          : undefined;
      const coverUrl =
        typeof body?.coverUrl === 'string' ? body.coverUrl.trim() : undefined;

      let publisherUri: string | null | undefined = undefined;
      if (publisherLabel !== undefined) {
        publisherUri = publisherLabel
          ? await upsertCatalogEntity(db, {
              entityType: 'publisher',
              label: publisherLabel,
              claims: {}
            })
          : null;
      }

      const targetEntries: Array<{ uri: string; isEdition: boolean }> = [
        { uri: editionUri, isEdition: true }
      ];
      if (workUri && workUri !== editionUri) {
        targetEntries.push({ uri: workUri, isEdition: false });
      }

      for (const entry of targetEntries) {
        const row = await db
          .prepare('SELECT * FROM catalog_entities WHERE uri = ? LIMIT 1')
          .bind(entry.uri)
          .first<Record<string, any>>();
        if (!row) continue;

        const entityObj = JSON.parse(row.entity_json);
        entityObj.claims = entityObj.claims || {};

        if (title) {
          entityObj.label = title;
          entityObj.labels = { ...(entityObj.labels || {}), fr: title, en: title };
          if (entry.isEdition) entityObj.claims['wdt:P1476'] = [title];
        }
        if (seriesUri) {
          entityObj.claims['wdt:P179'] = [seriesUri];
        } else if (body?.seriesUri === '') {
          delete entityObj.claims['wdt:P179'];
        }
        if (seriesNumber) {
          entityObj.claims['wdt:P1545'] = [seriesNumber];
        } else if (body?.seriesNumber === '') {
          delete entityObj.claims['wdt:P1545'];
        }
        if (authorUris) {
          if (authorUris.length > 0) entityObj.claims['wdt:P50'] = authorUris;
          else delete entityObj.claims['wdt:P50'];
        }

        if (entry.isEdition) {
          if (publisherUri) entityObj.claims['wdt:P123'] = [publisherUri];
          else if (publisherUri === null) delete entityObj.claims['wdt:P123'];

          if (publishDate) entityObj.claims['wdt:P577'] = [publishDate];
          else if (publishDate === '') delete entityObj.claims['wdt:P577'];

          if (pageCount && Number.isFinite(pageCount) && pageCount > 0) {
            entityObj.claims['wdt:P1104'] = [pageCount];
          } else if (body?.pageCount === null || body?.pageCount === '') {
            delete entityObj.claims['wdt:P1104'];
          }
        }

        let nextImageUrl = row.image_url;
        if (coverUrl !== undefined) {
          const isDataUrl = coverUrl.startsWith('data:');
          if (!coverUrl) {
            nextImageUrl = null;
            delete entityObj.image;
            delete entityObj.claims['invp:P2'];
          } else if (!isDataUrl) {
            nextImageUrl = coverUrl;
            entityObj.image = { url: coverUrl, value: coverUrl };
            entityObj.claims['invp:P2'] = [coverUrl];
          }
        }

        const finalLabel = title || row.label;
        const finalWorkUri =
          entry.isEdition && workUri ? workUri : row.work_uri;
        const finalSeriesUri =
          body?.seriesUri !== undefined ? (seriesUri || null) : row.series_uri;
        const finalSeriesNumber =
          body?.seriesNumber !== undefined ? seriesNumber : row.series_number;
        const finalSortOrder =
          body?.seriesNumber !== undefined ? sortOrder : row.sort_order;
        const finalAuthorJson = authorUris ? JSON.stringify(authorUris) : row.author_uris_json;

        await db
          .prepare(
            `UPDATE catalog_entities
             SET label = ?, normalized_label = ?, work_uri = ?, series_uri = ?, series_number = ?, sort_order = ?,
                 author_uris_json = ?, image_url = ?, entity_json = ?, updated_at = ?
             WHERE uri = ?`
          )
          .bind(
            finalLabel,
            normalizeTextKey(finalLabel),
            finalWorkUri,
            finalSeriesUri,
            finalSeriesNumber,
            finalSortOrder,
            finalAuthorJson,
            nextImageUrl,
            JSON.stringify(entityObj),
            now,
            entry.uri
          )
          .run();
      }

      return jsonResp({ ok: true });
    }

    case 'reverse-claims':
    case 'series-list': {
      const property =
        action === 'series-list' ? 'wdt:P179' : String(url.searchParams.get('property') || '');
      const value =
        action === 'series-list'
          ? String(url.searchParams.get('seriesId') || '')
          : String(url.searchParams.get('value') || '');

      if (!value) return jsonResp({ uris: [] });

      if (property === 'wdt:P179') {
        const sRow = await db
          .prepare('SELECT entity_json, series_checked_at FROM catalog_entities WHERE uri = ? LIMIT 1')
          .bind(value)
          .first<{ entity_json: string | null; series_checked_at?: string | null }>();

        let isAlreadyExpanded = false;
        if (sRow?.entity_json) {
          try {
            const parsedS = JSON.parse(sRow.entity_json);
            isAlreadyExpanded = parsedS?.claims?.['invp:bnfExpanded']?.[0] === 'true';
          } catch {
            isAlreadyExpanded = false;
          }
        }

        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const isCheckStale = !sRow?.series_checked_at || sRow.series_checked_at < sevenDaysAgo;

        let rows = await db
          .prepare(
            "SELECT uri FROM catalog_entities WHERE series_uri = ? AND entity_type = 'work' ORDER BY sort_order ASC, label ASC"
          )
          .bind(value)
          .all<{ uri: string }>();

        // Si la série n'a pas encore été expansée via BnF (ou a moins de 2 tomes en base D1, ou n'a pas été vérifiée depuis 7 jours),
        // on déclenche automatiquement l'expansion relationnelle BnF (460$3 / bib.ens2bib / bib.recordtype="ens").
        if (!isAlreadyExpanded || (rows.results || []).length < 2 || isCheckStale) {
          await expandSeriesVolumesInD1(db, value);
          rows = await db
            .prepare(
              "SELECT uri FROM catalog_entities WHERE series_uri = ? AND entity_type = 'work' ORDER BY sort_order ASC, label ASC"
            )
            .bind(value)
            .all<{ uri: string }>();
        }

        return jsonResp({ uris: (rows.results || []).map((r) => r.uri) });
      }

      if (property === 'wdt:P629') {
        const rows = await db
          .prepare(
            "SELECT uri FROM catalog_entities WHERE work_uri = ? AND entity_type = 'edition' ORDER BY updated_at DESC"
          )
          .bind(value)
          .all<{ uri: string }>();
        return jsonResp({ uris: (rows.results || []).map((r) => r.uri) });
      }

      return jsonResp({ uris: [] });
    }

    case 'author-works': {
      const authorUri = String(url.searchParams.get('authorUri') || '');
      const rows = await db
        .prepare(
          "SELECT uri, series_uri FROM catalog_entities WHERE author_uris_json LIKE ? AND entity_type = 'work'"
        )
        .bind(`%${authorUri}%`)
        .all<{ uri: string; series_uri: string | null }>();

      const works = (rows.results || []).map((r) => ({ uri: r.uri }));
      const seriesSet = new Set(
        (rows.results || []).map((r) => r.series_uri).filter(Boolean) as string[]
      );
      return jsonResp({
        works,
        series: Array.from(seriesSet).map((uri) => ({ uri })),
        articles: []
      });
    }

    case 'search-text': {
      const q = String(url.searchParams.get('q') || '').trim();
      if (!q) return jsonResp({ results: [] });
      const normQ = `%${normalizeTextKey(q)}%`;

      const localRows = await db
        .prepare(
          `SELECT uri, entity_type, label, image_url
           FROM catalog_entities
           WHERE normalized_label LIKE ? AND entity_type IN ('work', 'serie', 'human', 'edition')
           ORDER BY CASE entity_type WHEN 'serie' THEN 1 WHEN 'work' THEN 2 WHEN 'edition' THEN 3 ELSE 4 END
           LIMIT 30`
        )
        .bind(normQ)
        .all<{ uri: string; entity_type: string; label: string; image_url: string | null }>();

      const results = (localRows.results || []).map((r) => ({
        uri: r.uri,
        type: r.entity_type === 'serie' ? 'series' : r.entity_type === 'work' ? 'works' : r.entity_type === 'human' ? 'humans' : 'works',
        label: r.label,
        image: r.image_url || undefined
      }));

      // Si peu de résultats en D1, on enrichit à la volée avec Google Books pour que la recherche par mots-clés ou auteur trouve n'importe quel livre !
      if (results.length < 5 && q.length >= 3) {
        try {
          const gbRes = await fetch(
            `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=8`
          );
          if (gbRes.ok) {
            const gbData = await gbRes.json();
            for (const item of gbData.items || []) {
              const info = item.volumeInfo;
              const identifiers: Array<{ type: string; identifier: string }> =
                info?.industryIdentifiers || [];
              const isbn13 =
                identifiers.find((id) => id.type === 'ISBN_13')?.identifier ||
                isbnUtil.toIsbn13(
                  identifiers.find((id) => id.type === 'ISBN_10')?.identifier || ''
                );
              if (isbn13 && info?.title) {
                const uri = `isbn:${isbn13}`;
                if (!results.some((r) => r.uri === uri)) {
                  const thumb = (
                    info.imageLinks?.thumbnail ||
                    info.imageLinks?.smallThumbnail ||
                    ''
                  ).replace(/^http:\/\//i, 'https://');
                  results.push({
                    uri,
                    type: 'works',
                    label: `${info.title}${info.authors?.length ? ' — ' + info.authors[0] : ''}`,
                    image: thumb || undefined
                  });
                }
              }
            }
          }
        } catch {
          // Ignore erreur réseau externe
        }
      }

      return jsonResp({ results });
    }

    // ========================================================================
    // 6. RATTACHEMENT HORS-SÉRIE & FUSION DE SÉRIES EN 1 CLIC
    // ========================================================================
    case 'series-merge': {
      const targetSeriesTitle = String(body?.targetSeriesTitle || '').trim();
      const targetSeriesIdInput = String(body?.targetSeriesId || '').trim();
      const sourceSeriesId = String(body?.sourceSeriesId || '').trim();
      const bookUris: string[] = Array.isArray(body?.bookUris) ? body.bookUris : [];
      const customVolumeLabel =
        body?.volumeLabel !== undefined ? String(body.volumeLabel).trim() : undefined;
      const customSortOrder =
        body?.sortOrder !== undefined ? Number(body.sortOrder) : undefined;

      if (!targetSeriesTitle && !targetSeriesIdInput) {
        return jsonResp({ error: 'Série cible requise' }, 400);
      }

      let finalSeriesUri = targetSeriesIdInput;
      let finalSeriesLabel = targetSeriesTitle;

      if (!finalSeriesUri && finalSeriesLabel) {
        finalSeriesUri = await upsertCatalogEntity(db, {
          entityType: 'serie',
          label: finalSeriesLabel,
          claims: { 'wdt:P31': ['wd:Q277759'] }
        });
      } else if (finalSeriesUri && !finalSeriesLabel) {
        const sRow = await db
          .prepare('SELECT label FROM catalog_entities WHERE uri = ? LIMIT 1')
          .bind(finalSeriesUri)
          .first<{ label: string }>();
        finalSeriesLabel = sRow?.label || 'Série';
      }

      // Si on fusionne toute une série source vers la série cible
      if (sourceSeriesId && sourceSeriesId !== finalSeriesUri) {
        const sourceWorks = await db
          .prepare('SELECT uri, entity_json FROM catalog_entities WHERE series_uri = ?')
          .bind(sourceSeriesId)
          .all<{ uri: string; entity_json: string }>();

        for (const w of sourceWorks.results || []) {
          const obj = JSON.parse(w.entity_json);
          obj.claims = obj.claims || {};
          obj.claims['wdt:P179'] = [finalSeriesUri];
          await db
            .prepare(
              'UPDATE catalog_entities SET series_uri = ?, entity_json = ?, updated_at = ? WHERE uri = ?'
            )
            .bind(finalSeriesUri, JSON.stringify(obj), now, w.uri)
            .run();
        }
      }

      // Rattachement des livres / hors-séries sélectionnés
      for (const bUri of bookUris) {
        const row = await db
          .prepare('SELECT uri, work_uri, series_number, sort_order, entity_json FROM catalog_entities WHERE uri = ? OR work_uri = ?')
          .bind(bUri, bUri)
          .all<{
            uri: string;
            work_uri: string | null;
            series_number: string | null;
            sort_order: number;
            entity_json: string;
          }>();

        for (const r of row.results || []) {
          const obj = JSON.parse(r.entity_json);
          obj.claims = obj.claims || {};
          obj.claims['wdt:P179'] = [finalSeriesUri];
          const volLabel =
            customVolumeLabel !== undefined ? customVolumeLabel : r.series_number;
          if (volLabel) {
            obj.claims['wdt:P1545'] = [volLabel];
          }
          const sortVal =
            customSortOrder !== undefined && !Number.isNaN(customSortOrder)
              ? customSortOrder
              : volLabel && /^\d+(\.\d+)?$/.test(volLabel)
              ? parseFloat(volLabel)
              : r.sort_order || 999;

          await db
            .prepare(
              'UPDATE catalog_entities SET series_uri = ?, series_number = ?, sort_order = ?, entity_json = ?, updated_at = ? WHERE uri = ?'
            )
            .bind(finalSeriesUri, volLabel || null, sortVal, JSON.stringify(obj), now, r.uri)
            .run();
        }
      }

      return jsonResp({
        ok: true,
        seriesId: finalSeriesUri,
        seriesTitle: finalSeriesLabel
      });
    }

    case 'series-check-releases': {
      const auth = await resolveAuthSession(db, request, null);
      if (!auth) {
        return jsonResp({ ok: true, checkedCount: 0, alerts: [] });
      }
      const limit = Math.min(Math.max(Number(body?.limit ?? 3), 0), 5);
      const staleDays = Math.min(Math.max(Number(body?.staleDays ?? 7), 1), 30);
      const staleCutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();

      let checkedCount = 0;
      if (limit > 0) {
        try {
          const staleSeries = await db
            .prepare(
              `SELECT DISTINCT s.uri, s.label
               FROM library_items li
               JOIN catalog_entities ce ON (ce.uri = li.edition_id OR ce.uri = li.work_id)
               JOIN catalog_entities s ON s.uri = ce.series_uri
               WHERE li.library_id = ?
                 AND ce.series_uri IS NOT NULL
                 AND s.entity_type = 'serie'
                 AND (s.series_checked_at IS NULL OR s.series_checked_at < ?)
               ORDER BY s.series_checked_at IS NOT NULL ASC, s.series_checked_at ASC
               LIMIT ?`
            )
            .bind(auth.libraryId, staleCutoff, limit)
            .all<{ uri: string; label: string }>();

          for (const s of staleSeries.results || []) {
            checkedCount++;
            const expandRes = await expandSeriesVolumesInD1(db, s.uri, s.label);
            if (expandRes.wasAlreadyExpanded && expandRes.addedVolumes.length > 0) {
              for (const vol of expandRes.addedVolumes) {
                const alertId = `${auth.libraryId}:${vol.workUri}`;
                await db
                  .prepare(
                    `INSERT OR IGNORE INTO series_release_alerts (
                       id, library_id, series_uri, series_title, volume_uri, volume_title,
                       series_number, isbn13, cover_url, detected_at, dismissed
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
                  )
                  .bind(
                    alertId,
                    auth.libraryId,
                    s.uri,
                    s.label,
                    vol.editionUri || vol.workUri,
                    vol.title,
                    vol.seriesNumber || null,
                    vol.isbn13 || null,
                    vol.coverUrl || null,
                    now
                  )
                  .run();
              }
            }
          }
        } catch (err) {
          console.warn('[SERIES RELEASE CHECK] Erreur non bloquante :', err);
        }
      }

      try {
        const alertRows = await db
          .prepare(
            `SELECT a.id, a.series_uri, a.series_title, a.volume_uri, a.volume_title,
                    a.series_number, a.isbn13, a.cover_url, a.detected_at
             FROM series_release_alerts a
             WHERE a.library_id = ?
               AND a.dismissed = 0
               AND NOT EXISTS (
                 SELECT 1 FROM library_items li
                 WHERE li.library_id = a.library_id
                   AND (li.edition_id = a.volume_uri OR li.work_id = a.volume_uri OR (a.isbn13 IS NOT NULL AND li.edition_id = ('isbn:' || a.isbn13)))
               )
             ORDER BY a.detected_at DESC
             LIMIT 20`
          )
          .bind(auth.libraryId)
          .all<{
            id: string;
            series_uri: string;
            series_title: string;
            volume_uri: string;
            volume_title: string;
            series_number: string | null;
            isbn13: string | null;
            cover_url: string | null;
            detected_at: string;
          }>();

        const alerts = (alertRows.results || []).map((r) => ({
          id: r.id,
          seriesUri: r.series_uri,
          seriesTitle: r.series_title,
          volumeUri: r.volume_uri,
          volumeTitle: r.volume_title,
          seriesNumber: r.series_number || undefined,
          isbn13: r.isbn13 || undefined,
          coverUrl: r.cover_url || undefined,
          detectedAt: r.detected_at
        }));

        return jsonResp({ ok: true, checkedCount, alerts });
      } catch {
        return jsonResp({ ok: true, checkedCount, alerts: [] });
      }
    }

    case 'series-dismiss-alert': {
      const auth = await resolveAuthSession(db, request, null);
      if (!auth) return jsonResp({ error: 'Non authentifié' }, 401);

      const alertId = String(body?.alertId || '').trim();
      const dismissAll = Boolean(body?.dismissAll);
      try {
        if (dismissAll) {
          await db
            .prepare('UPDATE series_release_alerts SET dismissed = 1 WHERE library_id = ?')
            .bind(auth.libraryId)
            .run();
        } else if (alertId) {
          await db
            .prepare('UPDATE series_release_alerts SET dismissed = 1 WHERE id = ? AND library_id = ?')
            .bind(alertId, auth.libraryId)
            .run();
        }
      } catch {
        // ignore if table not present
      }
      return jsonResp({ ok: true });
    }

    default:
      return null;
  }
}
