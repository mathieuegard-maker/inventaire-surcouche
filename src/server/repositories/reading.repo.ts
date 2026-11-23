// src/server/repositories/reading.repo.ts
// Repository SQL pur pour user_reading_states (Espace Compte — strictement individuel par user_id).

import type { DatabaseAdapter } from '../db/database.adapter';
import type { ReadingStatus } from '../../shared/types/domain.types';

export interface ReadingStateRow {
  user_id: string;
  book_id: string;
  status: ReadingStatus;
  rating: number;
  notes: string;
  updated_at: string;
}

export class ReadingRepository {
  private readonly db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.db = db;
  }

  findByUserAndBook(userId: string, bookId: string): ReadingStateRow | null {
    return this.db.get<ReadingStateRow>(
      'SELECT * FROM user_reading_states WHERE user_id = ? AND book_id = ? LIMIT 1',
      [userId, bookId]
    );
  }

  listByUser(userId: string, since?: string): ReadingStateRow[] {
    if (since) {
      return this.db.all<ReadingStateRow>(
        'SELECT * FROM user_reading_states WHERE user_id = ? AND updated_at > ?',
        [userId, since]
      );
    }
    return this.db.all<ReadingStateRow>(
      'SELECT * FROM user_reading_states WHERE user_id = ?',
      [userId]
    );
  }

  /**
   * Met à jour l'état de lecture individuel en respectant Last-Write-Wins si un timestamp antérieur arrive hors-ligne.
   */
  upsertReadingState(input: {
    userId: string;
    bookId: string;
    status: ReadingStatus;
    rating: number;
    notes: string;
    timestamp: string;
  }): { applied: boolean; row: ReadingStateRow } {
    const existing = this.findByUserAndBook(input.userId, input.bookId);
    if (existing && existing.updated_at > input.timestamp) {
      return { applied: false, row: existing };
    }

    this.db.run(
      `INSERT INTO user_reading_states (user_id, book_id, status, rating, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, book_id) DO UPDATE SET
         status = excluded.status,
         rating = excluded.rating,
         notes = excluded.notes,
         updated_at = excluded.updated_at`,
      [input.userId, input.bookId, input.status, input.rating, input.notes, input.timestamp]
    );

    return { applied: true, row: this.findByUserAndBook(input.userId, input.bookId)! };
  }
}
