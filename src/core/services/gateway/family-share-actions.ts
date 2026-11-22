// src/core/services/gateway/family-share-actions.ts
// Domaine métier : Foyer partagé, vitrine publique lecture seule, amis suivis et contacts de prêt.

import { resolveAuthSession } from '../d1-gateway.service';
import {
  addFriendConnectionForUser,
  extractShareToken,
  getOrCreateShareTokens,
  jsonResp,
  type GatewayActionContext
} from './gateway-context';

export async function handleFamilyShareGatewayAction(
  ctx: GatewayActionContext
): Promise<Response | null> {
  const { action, db, request, url, body, now } = ctx;

  switch (action) {
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

      await db.batch([
        db.prepare('DELETE FROM library_members WHERE user_id = ?').bind(auth.userId),
        db
          .prepare('INSERT INTO library_members (library_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
          .bind(tokenRow.library_id, auth.userId, tokenRow.target_role || 'editor', now)
      ]);

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
           WHERE UPPER(s.token) = ? AND s.token_type = 'public_collection_readonly'
           LIMIT 1`
        )
        .bind(shareToken)
        .first<{ library_id: string; token_type: string; token: string; library_name: string; owner_name: string | null }>();

      if (!tokenRow) return jsonResp({ error: 'Lien de partage invalide' }, 404);

      const v4Items = await db
        .prepare(
          `SELECT COALESCE(b.legacy_entity_uri, 'v4:' || b.id) as edition_id,
                  COALESCE(b.legacy_entity_uri, 'v4:' || b.id) as work_id,
                  CASE WHEN lb.is_owned = 1 THEN 'owned' ELSE 'wishlist' END as ownership_status,
                  NULL as location,
                  b.canonical_title as title,
                  b.series_id as series_uri,
                  b.series_name,
                  b.volume_label as series_number,
                  COALESCE(b.volume_number, 1000) as sort_order,
                  COALESCE(lb.selected_cover_url, b.selected_cover_url) as image_url,
                  b.main_category,
                  CASE WHEN lb.is_wished = 1 THEN u.display_name ELSE NULL END as wished_by_name,
                  (SELECT COUNT(*) FROM loans ln
                   WHERE ln.library_id = lb.library_id
                     AND ln.returned_at IS NULL
                     AND ln.deleted_at IS NULL
                     AND (
                       ln.library_item_id IN (b.legacy_entity_uri, 'v4:' || b.id, 'book:' || b.id, 'itm_' || lb.library_id || '_' || b.id)
                       OR EXISTS (SELECT 1 FROM book_isbn_index bi WHERE bi.book_id = b.id AND ln.library_item_id = 'isbn:' || bi.isbn13)
                       OR ln.library_item_id IN (
                         SELECT li2.id FROM library_items li2
                         WHERE li2.library_id = lb.library_id AND li2.deleted_at IS NULL
                           AND (li2.edition_id = b.legacy_entity_uri OR li2.work_id = b.legacy_entity_uri)
                       )
                     )
                  ) as is_lent
           FROM v4_library_books lb
           JOIN books b ON b.id = lb.book_id
           LEFT JOIN users u ON u.id = lb.wished_by_user_id
           WHERE lb.library_id = ? AND (lb.is_owned = 1 OR lb.is_wished = 1)
           ORDER BY COALESCE(b.series_name, b.canonical_title) ASC, COALESCE(b.volume_number, 1000) ASC, b.canonical_title ASC`
        )
        .bind(tokenRow.library_id)
        .all<Record<string, any>>()
        .catch(() => ({ results: [] as Record<string, any>[] }));

      const legacyItems = await db
        .prepare(
          `SELECT li.edition_id, li.work_id, li.ownership_status, li.location,
                  ce.label as title, ce.series_uri, se.label as series_name,
                  ce.series_number, ce.sort_order, ce.image_url, ce.main_category,
                  CASE WHEN li.ownership_status = 'wishlist' THEN u.display_name ELSE NULL END as wished_by_name,
                  (SELECT COUNT(*) FROM loans ln WHERE ln.library_item_id = li.id AND ln.returned_at IS NULL AND ln.deleted_at IS NULL) as is_lent
           FROM library_items li
           LEFT JOIN catalog_entities ce ON ce.uri = COALESCE(li.edition_id, li.work_id)
           LEFT JOIN catalog_entities se ON se.uri = ce.series_uri
           LEFT JOIN users u ON u.id = li.added_by_user_id
           WHERE li.library_id = ? AND li.deleted_at IS NULL
           ORDER BY COALESCE(se.label, ce.label) ASC, ce.sort_order ASC, ce.label ASC`
        )
        .bind(tokenRow.library_id)
        .all<Record<string, any>>();

      const combinedItems: Record<string, any>[] = [];
      const seenUris = new Set<string>();
      for (const item of [...(v4Items.results || []), ...(legacyItems.results || [])]) {
        const key = String(item.edition_id || item.work_id || item.title || '');
        if (!key || seenUris.has(key)) continue;
        seenUris.add(key);
        combinedItems.push(item);
      }

      return jsonResp({
        libraryName: tokenRow.library_name,
        ownerName: tokenRow.owner_name || tokenRow.library_name,
        token: tokenRow.token,
        tokenType: tokenRow.token_type,
        items: combinedItems
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
                  MAX(
                    (SELECT COUNT(*) FROM v4_library_books lb WHERE lb.library_id = fc.target_library_id AND lb.is_owned = 1),
                    (SELECT COUNT(*) FROM library_items li WHERE li.library_id = fc.target_library_id AND li.ownership_status = 'owned' AND li.deleted_at IS NULL)
                  ) as ownedCount,
                  MAX(
                    (SELECT COUNT(*) FROM v4_library_books lb WHERE lb.library_id = fc.target_library_id AND lb.is_wished = 1 AND lb.is_owned = 0),
                    (SELECT COUNT(*) FROM library_items li WHERE li.library_id = fc.target_library_id AND li.ownership_status = 'wishlist' AND li.deleted_at IS NULL)
                  ) as wishlistCount
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

    default:
      return null;
  }
}
