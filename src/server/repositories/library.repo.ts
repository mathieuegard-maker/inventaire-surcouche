// src/server/repositories/library.repo.ts
// Repository SQL pur pour l'espace Foyer (libraries, library_members, friend_connections).

import type { DatabaseAdapter } from '../db/database.adapter';
import type { LibraryMemberRole } from '../../shared/types/domain.types';

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
      `INSERT OR REPLACE INTO library_members (library_id, user_id, role, joined_at)
       VALUES (?, ?, ?, ?)`,
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
      'INSERT OR IGNORE INTO friend_connections (user_id, target_library_id, created_at) VALUES (?, ?, ?)',
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
}
