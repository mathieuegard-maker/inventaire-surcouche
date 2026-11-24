// src/server/repositories/library.repo.ts
// Repository SQL pur pour l'espace Foyer (libraries, library_members, friend_connections).

import type { DatabaseAdapter } from '../db/database.adapter';
import type { LibraryBookOverrides, LibraryMemberRole, OwnershipStatus } from '../../shared/types/domain.types';

export interface LibraryRow {
  id: string;
  name: string;
  owner_user_id: string;
  family_invite_code: string;
  friend_share_token: string;
  created_at: string;
  updated_at: string;
}

export interface LibraryMemberRow {
  library_id: string;
  user_id: string;
  role: LibraryMemberRole;
  joined_at: string;
  username?: string;
}

export interface LibraryBookRow {
  library_id: string;
  book_id: string;
  status: OwnershipStatus;
  wished_by_user_id: string | null;
  overrides_json: string;
  overrides_updated_at: string | null;
  added_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export class LibraryRepository {
  private readonly db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.db = db;
  }

  findLibraryById(id: string): LibraryRow | null {
    return this.db.get<LibraryRow>('SELECT * FROM libraries WHERE id = ? LIMIT 1', [id]);
  }

  findLibraryByUserId(userId: string): LibraryRow | null {
    return this.db.get<LibraryRow>(
      `SELECT l.* FROM libraries l
       JOIN library_members lm ON lm.library_id = l.id
       WHERE lm.user_id = ?
       ORDER BY lm.joined_at ASC
       LIMIT 1`,
      [userId]
    );
  }

  findByFamilyInviteCode(code: string): LibraryRow | null {
    return this.db.get<LibraryRow>(
      'SELECT * FROM libraries WHERE upper(family_invite_code) = upper(?) LIMIT 1',
      [code]
    );
  }

  findByFriendShareToken(token: string): LibraryRow | null {
    return this.db.get<LibraryRow>(
      'SELECT * FROM libraries WHERE upper(friend_share_token) = upper(?) LIMIT 1',
      [token]
    );
  }

  createLibrary(params: {
    id: string;
    name: string;
    ownerUserId: string;
    familyInviteCode: string;
    friendShareToken: string;
    now: string;
  }): void {
    this.db.run(
      `INSERT INTO libraries (id, name, owner_user_id, family_invite_code, friend_share_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        params.id,
        params.name,
        params.ownerUserId,
        params.familyInviteCode,
        params.friendShareToken,
        params.now,
        params.now
      ]
    );
    this.db.run(
      `INSERT INTO library_members (library_id, user_id, role, joined_at)
       VALUES (?, ?, 'owner', ?)`,
      [params.id, params.ownerUserId, params.now]
    );
  }

  addMember(libraryId: string, userId: string, role: LibraryMemberRole, now: string): void {
    this.db.run(
      `INSERT INTO library_members (library_id, user_id, role, joined_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (library_id, user_id) DO UPDATE SET
         role = excluded.role,
         joined_at = excluded.joined_at`,
      [libraryId, userId, role, now]
    );
  }

  listMembers(libraryId: string): LibraryMemberRow[] {
    return this.db.all<LibraryMemberRow>(
      `SELECT lm.library_id, lm.user_id, lm.role, lm.joined_at, u.username
       FROM library_members lm
       JOIN users u ON u.id = lm.user_id
       WHERE lm.library_id = ?
       ORDER BY lm.joined_at ASC`,
      [libraryId]
    );
  }

  removeMember(libraryId: string, userId: string): void {
    this.db.run('DELETE FROM library_members WHERE library_id = ? AND user_id = ?', [libraryId, userId]);
  }

  transferOwnership(libraryId: string, newOwnerUserId: string, now: string): void {
    this.db.run('UPDATE libraries SET owner_user_id = ?, updated_at = ? WHERE id = ?', [
      newOwnerUserId,
      now,
      libraryId
    ]);
    this.db.run(
      "UPDATE library_members SET role = CASE WHEN user_id = ? THEN 'owner' ELSE 'member' END WHERE library_id = ?",
      [newOwnerUserId, libraryId]
    );
  }

  deleteLibrary(libraryId: string): void {
    this.db.run('DELETE FROM libraries WHERE id = ?', [libraryId]);
  }

  addFriendConnection(userId: string, targetLibraryId: string, now: string): void {
    this.db.run(
      `INSERT INTO friend_connections (user_id, target_library_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT (user_id, target_library_id) DO NOTHING`,
      [userId, targetLibraryId, now]
    );
  }

  countActiveAlerts(libraryId: string): number {
    const row = this.db.get<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM series_release_alerts WHERE library_id = ? AND dismissed_at IS NULL',
      [libraryId]
    );
    return Number(row?.cnt ?? 0);
  }

  // ==================== LIBRARY BOOKS (Espace Foyer — Couche 3) ====================

  findLibraryBook(libraryId: string, bookId: string): LibraryBookRow | null {
    return this.db.get<LibraryBookRow>(
      'SELECT * FROM library_books WHERE library_id = ? AND book_id = ? LIMIT 1',
      [libraryId, bookId]
    );
  }

  /**
   * Met à jour le statut de possession/wishlist d'un livre dans le foyer
   * SANS JAMAIS écraser `overrides_json` (primauté absolue Couche 3).
   */
  upsertLibraryBookStatus(input: {
    libraryId: string;
    bookId: string;
    status: OwnershipStatus;
    wishedByUserId?: string | null;
    now: string;
  }): LibraryBookRow {
    const existing = this.findLibraryBook(input.libraryId, input.bookId);
    if (!existing) {
      this.db.run(
        `INSERT INTO library_books (
           library_id, book_id, status, wished_by_user_id, overrides_json,
           overrides_updated_at, added_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, '{}', NULL, ?, ?, NULL)`,
        [
          input.libraryId,
          input.bookId,
          input.status,
          input.status === 'wish' ? (input.wishedByUserId ?? null) : null,
          input.now,
          input.now
        ]
      );
    } else {
      const nextWishedBy =
        input.status === 'wish'
          ? (input.wishedByUserId ?? existing.wished_by_user_id)
          : null;
      this.db.run(
        `UPDATE library_books
         SET status = ?, wished_by_user_id = ?, deleted_at = NULL, updated_at = ?
         WHERE library_id = ? AND book_id = ?`,
        [input.status, nextWishedBy, input.now, input.libraryId, input.bookId]
      );
    }

    // Purge automatique de toute réservation cadeau dès que le livre passe en Possédé
    if (input.status === 'owned') {
      this.db.run('DELETE FROM wishlist_reservations WHERE library_id = ? AND book_id = ?', [
        input.libraryId,
        input.bookId
      ]);
    }

    return this.findLibraryBook(input.libraryId, input.bookId)!;
  }

  setLibraryBookOverrides(libraryId: string, bookId: string, overrides: LibraryBookOverrides, now: string): LibraryBookRow {
    const existing = this.findLibraryBook(libraryId, bookId);
    if (!existing) {
      this.db.run(
        `INSERT INTO library_books (
           library_id, book_id, status, wished_by_user_id, overrides_json,
           overrides_updated_at, added_at, updated_at, deleted_at
         ) VALUES (?, ?, 'none', NULL, ?, ?, ?, ?, NULL)`,
        [libraryId, bookId, JSON.stringify(overrides), now, now, now]
      );
    } else {
      this.db.run(
        `UPDATE library_books
         SET overrides_json = ?, overrides_updated_at = ?, updated_at = ?
         WHERE library_id = ? AND book_id = ?`,
        [JSON.stringify(overrides), now, now, libraryId, bookId]
      );
    }
    return this.findLibraryBook(libraryId, bookId)!;
  }

  listReferencedCoverKeysInOverrides(): Set<string> {
    const rows = this.db.all<{ overrides_json: string }>(
      "SELECT overrides_json FROM library_books WHERE overrides_json LIKE '%coverKey%'"
    );
    const keys = new Set<string>();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.overrides_json) as LibraryBookOverrides;
        if (parsed.coverKey && typeof parsed.coverKey === 'string') {
          keys.add(parsed.coverKey);
        }
      } catch {
        // ignore invalid json
      }
    }
    return keys;
  }

  listLibraryBooks(libraryId: string, since?: string): LibraryBookRow[] {
    if (since) {
      return this.db.all<LibraryBookRow>(
        'SELECT * FROM library_books WHERE library_id = ? AND updated_at > ? ORDER BY updated_at DESC',
        [libraryId, since]
      );
    }
    return this.db.all<LibraryBookRow>(
      "SELECT * FROM library_books WHERE library_id = ? AND deleted_at IS NULL AND status IN ('owned', 'wish') ORDER BY added_at DESC",
      [libraryId]
    );
  }

  /**
   * Met à jour le statut avec arbitrage Last-Write-Wins (LWW) basé sur le timestamp fourni.
   * Ne touche JAMAIS à `overrides_json` (Couche 3).
   */
  upsertLibraryBookStatusLww(input: {
    libraryId: string;
    bookId: string;
    status: OwnershipStatus;
    wishedByUserId?: string | null;
    timestamp: string;
  }): { applied: boolean; row: LibraryBookRow } {
    const existing = this.findLibraryBook(input.libraryId, input.bookId);
    if (existing && existing.updated_at > input.timestamp) {
      return { applied: false, row: existing };
    }

    const deletedAt = input.status === 'none' ? input.timestamp : null;
    if (!existing) {
      this.db.run(
        `INSERT INTO library_books (
           library_id, book_id, status, wished_by_user_id, overrides_json,
           overrides_updated_at, added_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, '{}', NULL, ?, ?, ?)`,
        [
          input.libraryId,
          input.bookId,
          input.status,
          input.status === 'wish' ? (input.wishedByUserId ?? null) : null,
          input.timestamp,
          input.timestamp,
          deletedAt
        ]
      );
    } else {
      const nextWishedBy =
        input.status === 'wish'
          ? (input.wishedByUserId ?? existing.wished_by_user_id)
          : null;
      this.db.run(
        `UPDATE library_books
         SET status = ?, wished_by_user_id = ?, deleted_at = ?, updated_at = ?
         WHERE library_id = ? AND book_id = ?`,
        [input.status, nextWishedBy, deletedAt, input.timestamp, input.libraryId, input.bookId]
      );
    }

    if (input.status === 'owned') {
      this.db.run('DELETE FROM wishlist_reservations WHERE library_id = ? AND book_id = ?', [
        input.libraryId,
        input.bookId
      ]);
    }

    return { applied: true, row: this.findLibraryBook(input.libraryId, input.bookId)! };
  }

  listFriendContactsForUser(userId: string): Array<{ libraryId: string; name: string }> {
    return this.db.all<{ libraryId: string; name: string }>(
      `SELECT l.id AS libraryId, u.username AS name
       FROM friend_connections fc
       JOIN libraries l ON l.id = fc.target_library_id
       JOIN users u ON u.id = l.owner_user_id
       WHERE fc.user_id = ?
       ORDER BY u.username ASC`,
      [userId]
    );
  }

  mapUsernamesByIds(userIds: string[]): Map<string, string> {
    const clean = Array.from(new Set(userIds.filter(Boolean)));
    const map = new Map<string, string>();
    if (clean.length === 0) return map;
    const placeholders = clean.map(() => '?').join(', ');
    const rows = this.db.all<{ id: string; username: string }>(
      `SELECT id, username FROM users WHERE id IN (${placeholders})`,
      clean
    );
    for (const r of rows) {
      map.set(r.id, r.username);
    }
    return map;
  }
}
