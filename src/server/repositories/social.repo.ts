// src/server/repositories/social.repo.ts
// Repository SQL pur pour friend_connections, wishlist_reservations et gestion codes Foyer/Amis.

import type { DatabaseAdapter } from '../db/database.adapter';

export interface FriendConnectionDetailRow {
  target_library_id: string;
  library_name: string;
  owner_username: string;
  friend_share_token: string;
  connected_at: string;
  deleted_at: string | null;
  owned_count: number;
  wish_count: number;
}

export interface WishlistReservationRow {
  library_id: string;
  book_id: string;
  reserved_by_user_id: string;
  reserved_at: string;
}

export class SocialRepository {
  private readonly db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.db = db;
  }

  updateFamilyInviteCode(libraryId: string, newCode: string, now: string): void {
    this.db.run('UPDATE libraries SET family_invite_code = ?, updated_at = ? WHERE id = ?', [
      newCode,
      now,
      libraryId
    ]);
  }

  updateFriendShareToken(libraryId: string, newToken: string, now: string): void {
    this.db.run('UPDATE libraries SET friend_share_token = ?, updated_at = ? WHERE id = ?', [
      newToken,
      now,
      libraryId
    ]);
  }

  listFriendsForUser(userId: string): FriendConnectionDetailRow[] {
    return this.db.all<FriendConnectionDetailRow>(
      `SELECT
         fc.target_library_id,
         l.name AS library_name,
         u.username AS owner_username,
         l.friend_share_token,
         fc.created_at AS connected_at,
         fc.deleted_at,
         (SELECT COUNT(*) FROM library_books lb WHERE lb.library_id = l.id AND lb.status = 'owned' AND lb.deleted_at IS NULL) AS owned_count,
         (SELECT COUNT(*) FROM library_books lb WHERE lb.library_id = l.id AND lb.status = 'wish' AND lb.deleted_at IS NULL) AS wish_count
       FROM friend_connections fc
       JOIN libraries l ON l.id = fc.target_library_id
       JOIN users u ON u.id = l.owner_user_id
       WHERE fc.user_id = ? AND fc.deleted_at IS NULL
       ORDER BY u.username ASC`,
      [userId]
    );
  }

  listRemovedFriendsForUser(userId: string): FriendConnectionDetailRow[] {
    return this.db.all<FriendConnectionDetailRow>(
      `SELECT
         fc.target_library_id,
         l.name AS library_name,
         u.username AS owner_username,
         l.friend_share_token,
         fc.created_at AS connected_at,
         fc.deleted_at,
         (SELECT COUNT(*) FROM library_books lb WHERE lb.library_id = l.id AND lb.status = 'owned' AND lb.deleted_at IS NULL) AS owned_count,
         (SELECT COUNT(*) FROM library_books lb WHERE lb.library_id = l.id AND lb.status = 'wish' AND lb.deleted_at IS NULL) AS wish_count
       FROM friend_connections fc
       JOIN libraries l ON l.id = fc.target_library_id
       JOIN users u ON u.id = l.owner_user_id
       WHERE fc.user_id = ? AND fc.deleted_at IS NOT NULL
       ORDER BY fc.deleted_at DESC`,
      [userId]
    );
  }

  removeFriendConnection(userId: string, targetLibraryId: string, now: string): boolean {
    const res = this.db.run(
      'UPDATE friend_connections SET deleted_at = ? WHERE user_id = ? AND target_library_id = ? AND deleted_at IS NULL',
      [now, userId, targetLibraryId]
    );
    return res.changes > 0;
  }

  restoreFriendConnection(userId: string, targetLibraryId: string): boolean {
    const res = this.db.run(
      'UPDATE friend_connections SET deleted_at = NULL WHERE user_id = ? AND target_library_id = ?',
      [userId, targetLibraryId]
    );
    return res.changes > 0;
  }

  // ==================== WISHLIST RESERVATIONS (ANTI-SPOILER) ====================

  findReservation(libraryId: string, bookId: string): WishlistReservationRow | null {
    return this.db.get<WishlistReservationRow>(
      'SELECT * FROM wishlist_reservations WHERE library_id = ? AND book_id = ? LIMIT 1',
      [libraryId, bookId]
    );
  }

  listReservationsForLibrary(libraryId: string): WishlistReservationRow[] {
    return this.db.all<WishlistReservationRow>(
      'SELECT * FROM wishlist_reservations WHERE library_id = ?',
      [libraryId]
    );
  }

  createReservation(libraryId: string, bookId: string, userId: string, now: string): void {
    this.db.run(
      `INSERT INTO wishlist_reservations (library_id, book_id, reserved_by_user_id, reserved_at)
       VALUES (?, ?, ?, ?)`,
      [libraryId, bookId, userId, now]
    );
  }

  deleteReservationByUser(libraryId: string, bookId: string, userId: string): boolean {
    const res = this.db.run(
      'DELETE FROM wishlist_reservations WHERE library_id = ? AND book_id = ? AND reserved_by_user_id = ?',
      [libraryId, bookId, userId]
    );
    return res.changes > 0;
  }

  moveReservationToLibrary(fromLibraryId: string, toLibraryId: string, bookId: string): boolean {
    const existing = this.findReservation(fromLibraryId, bookId);
    if (!existing) return false;
    this.db.run(
      `INSERT INTO wishlist_reservations (library_id, book_id, reserved_by_user_id, reserved_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (library_id, book_id) DO NOTHING`,
      [toLibraryId, bookId, existing.reserved_by_user_id, existing.reserved_at]
    );
    this.db.run('DELETE FROM wishlist_reservations WHERE library_id = ? AND book_id = ?', [
      fromLibraryId,
      bookId
    ]);
    return true;
  }
}
