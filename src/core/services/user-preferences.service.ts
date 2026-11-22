// src/core/services/user-preferences.service.ts
// Données strictement individuelles par compte (Étage 3 : user_id) :
// 1. Statut de lecture, note (1-5) et notes personnelles par œuvre (`reading_statuses`)
// 2. Liste personnalisée des genres par défaut (`user_default_genres`)

import type { DatabaseBinding } from '../adapters/storage-db.interface';
import { SUGGESTED_GENRE_CHIPS } from '../utils/category-classifier.util';

export type IndividualReadingStatus = 'none' | 'to_read' | 'reading' | 'read' | 'abandoned';

export interface UserBookReadingRecord {
  workId: string;
  status: IndividualReadingStatus;
  rating: number;
  personalNotes: string;
  updatedAt: string;
}

const ALLOWED_STATUSES = new Set<IndividualReadingStatus>([
  'none',
  'to_read',
  'reading',
  'read',
  'abandoned'
]);

const CUSTOMIZED_MARKER = '__CUSTOMIZED__';

function normalizeStatus(raw: unknown): IndividualReadingStatus {
  const s = String(raw || 'none').trim().toLowerCase();
  if (s === 'unread') return 'to_read';
  if (ALLOWED_STATUSES.has(s as IndividualReadingStatus)) {
    return s as IndividualReadingStatus;
  }
  return 'none';
}

export async function getUserReadingStatus(
  db: DatabaseBinding,
  userId: string,
  libraryId: string,
  workId: string
): Promise<UserBookReadingRecord | null> {
  const row = await db
    .prepare(
      `SELECT work_id, status, rating, personal_notes, updated_at
       FROM reading_statuses
       WHERE user_id = ? AND library_id = ? AND work_id = ?
       LIMIT 1`
    )
    .bind(userId, libraryId, workId)
    .first<{
      work_id: string;
      status: string;
      rating: number | null;
      personal_notes: string | null;
      updated_at: string;
    }>();

  if (!row) return null;
  return {
    workId: row.work_id,
    status: normalizeStatus(row.status),
    rating: Number(row.rating) || 0,
    personalNotes: row.personal_notes || '',
    updatedAt: row.updated_at
  };
}

export async function listUserReadingStatuses(
  db: DatabaseBinding,
  userId: string,
  libraryId: string
): Promise<UserBookReadingRecord[]> {
  const rows = await db
    .prepare(
      `SELECT work_id, status, rating, personal_notes, updated_at
       FROM reading_statuses
       WHERE user_id = ? AND library_id = ?
       ORDER BY updated_at DESC`
    )
    .bind(userId, libraryId)
    .all<{
      work_id: string;
      status: string;
      rating: number | null;
      personal_notes: string | null;
      updated_at: string;
    }>();

  return (rows.results || []).map((row) => ({
    workId: row.work_id,
    status: normalizeStatus(row.status),
    rating: Number(row.rating) || 0,
    personalNotes: row.personal_notes || '',
    updatedAt: row.updated_at
  }));
}

export async function upsertUserReadingStatus(
  db: DatabaseBinding,
  params: {
    userId: string;
    libraryId: string;
    workId: string;
    status: string;
    rating?: number | null;
    personalNotes?: string | null;
  }
): Promise<UserBookReadingRecord> {
  const now = new Date().toISOString();
  const status = normalizeStatus(params.status);
  const rawRating = Number(params.rating ?? 0);
  const rating = Number.isFinite(rawRating) && rawRating >= 1 && rawRating <= 5 ? Math.trunc(rawRating) : 0;
  const personalNotes = String(params.personalNotes ?? '').trim().slice(0, 4000);
  const id = `rd_${params.userId.slice(0, 12)}_${params.workId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}`;

  await db
    .prepare(
      `INSERT INTO reading_statuses (id, library_id, user_id, work_id, status, rating, personal_notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(library_id, user_id, work_id) DO UPDATE SET
         status = excluded.status,
         rating = excluded.rating,
         personal_notes = excluded.personal_notes,
         updated_at = excluded.updated_at`
    )
    .bind(
      id,
      params.libraryId,
      params.userId,
      params.workId,
      status,
      rating > 0 ? rating : null,
      personalNotes || null,
      now
    )
    .run();

  return {
    workId: params.workId,
    status,
    rating,
    personalNotes,
    updatedAt: now
  };
}

export async function getUserDefaultGenres(
  db: DatabaseBinding,
  userId: string
): Promise<{ genres: string[]; isCustomized: boolean }> {
  const rows = await db
    .prepare(
      `SELECT genre_label
       FROM user_default_genres
       WHERE user_id = ?
       ORDER BY created_at ASC, genre_label ASC`
    )
    .bind(userId)
    .all<{ genre_label: string }>();

  const labels = (rows.results || []).map((r) => r.genre_label).filter(Boolean);
  if (labels.length === 0) {
    return { genres: [...SUGGESTED_GENRE_CHIPS], isCustomized: false };
  }
  return {
    genres: labels.filter((l) => l !== CUSTOMIZED_MARKER),
    isCustomized: true
  };
}

async function ensureGenresSeededForUser(db: DatabaseBinding, userId: string): Promise<void> {
  const existing = await db
    .prepare('SELECT COUNT(*) as cnt FROM user_default_genres WHERE user_id = ?')
    .bind(userId)
    .first<{ cnt: number }>();

  if ((existing?.cnt || 0) > 0) return;

  const now = new Date().toISOString();
  const stmts = [
    db
      .prepare('INSERT OR IGNORE INTO user_default_genres (user_id, genre_label, created_at) VALUES (?, ?, ?)')
      .bind(userId, CUSTOMIZED_MARKER, now),
    ...SUGGESTED_GENRE_CHIPS.map((g, idx) =>
      db
        .prepare('INSERT OR IGNORE INTO user_default_genres (user_id, genre_label, created_at) VALUES (?, ?, ?)')
        .bind(userId, g, `${now.slice(0, 19)}.${String(idx).padStart(3, '0')}Z`)
    )
  ];
  await db.batch(stmts);
}

export async function updateUserDefaultGenres(
  db: DatabaseBinding,
  userId: string,
  action: 'add' | 'remove' | 'reset',
  rawGenre?: string
): Promise<{ genres: string[]; isCustomized: boolean }> {
  if (action === 'reset') {
    await db.prepare('DELETE FROM user_default_genres WHERE user_id = ?').bind(userId).run();
    return { genres: [...SUGGESTED_GENRE_CHIPS], isCustomized: false };
  }

  const clean = String(rawGenre || '').trim().slice(0, 60);
  if (!clean || clean === CUSTOMIZED_MARKER) {
    return getUserDefaultGenres(db, userId);
  }

  await ensureGenresSeededForUser(db, userId);

  if (action === 'add') {
    // Éviter les doublons insensibles à la casse
    const current = await getUserDefaultGenres(db, userId);
    const exists = current.genres.some((g) => g.toLowerCase() === clean.toLowerCase());
    if (!exists) {
      await db
        .prepare('INSERT OR IGNORE INTO user_default_genres (user_id, genre_label, created_at) VALUES (?, ?, ?)')
        .bind(userId, clean, new Date().toISOString())
        .run();
    }
  } else if (action === 'remove') {
    await db
      .prepare('DELETE FROM user_default_genres WHERE user_id = ? AND LOWER(genre_label) = LOWER(?)')
      .bind(userId, clean)
      .run();
  }

  return getUserDefaultGenres(db, userId);
}
