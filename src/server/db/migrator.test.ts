// src/server/db/migrator.test.ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteDatabaseAdapter } from './sqlite.adapter';
import { applySqlMigrations } from './migrator';

const EXPECTED_TABLES = [
  'covers',
  'franchises',
  'series',
  'books',
  'book_editions',
  'users',
  'sessions',
  'password_reset_tokens',
  'user_reading_states',
  'user_default_genres',
  'app_default_genres',
  'user_notification_prefs',
  'user_push_subscriptions',
  'user_ai_usage',
  'libraries',
  'library_members',
  'library_books',
  'loans',
  'borrower_contacts',
  'series_release_alerts',
  'wishlist_reservations',
  'friend_connections',
  'background_jobs',
  'external_cache',
  'cron_runs',
  'pipeline_logs',
  'schema_migrations'
];

describe('SQLite V2 Migrator & Schema Integrity', () => {
  const migrationsDir = path.resolve(process.cwd(), 'migrations');

  it('applique les migrations de 0001 à N sur SQLite :memory:, crée les 25 tables métier et reste idempotent', () => {
    const db = new SqliteDatabaseAdapter(':memory:');
    try {
      const firstRun = applySqlMigrations(db, migrationsDir);
      expect(firstRun.applied).toContain('0001_v2_initial.sql');
      expect(firstRun.applied).toContain('0002_ui_v2_6.sql');
      expect(firstRun.applied).toContain('0003_v2_6_1_ux.sql');
      expect(firstRun.applied).toContain('0004_v2_7_0_features.sql');
      expect(firstRun.applied).toContain('0005_colorists.sql');
      expect(firstRun.skipped).toBe(0);

      // Vérifie les colonnes ajoutées par les migrations 0002, 0003, 0004 et 0005
      const genreCols = db.all<{ name: string }>('PRAGMA table_info(user_default_genres)').map((c) => c.name);
      expect(genreCols).toContain('sort_order');
      const userCols = db.all<{ name: string }>('PRAGMA table_info(users)').map((c) => c.name);
      expect(userCols).toContain('banned_at');
      const jobCols = db.all<{ name: string }>('PRAGMA table_info(background_jobs)').map((c) => c.name);
      expect(jobCols).toContain('archived_at');
      const friendCols = db.all<{ name: string }>('PRAGMA table_info(friend_connections)').map((c) => c.name);
      expect(friendCols).toContain('deleted_at');
      const libraryCols = db.all<{ name: string }>('PRAGMA table_info(libraries)').map((c) => c.name);
      expect(libraryCols).toContain('detach_policy');
      const bookCols = db.all<{ name: string }>('PRAGMA table_info(books)').map((c) => c.name);
      expect(bookCols).toContain('colorists_json');
      const seededDefaultGenres = db.all<{ genre_label: string }>('SELECT genre_label FROM app_default_genres');
      expect(seededDefaultGenres.length).toBeGreaterThanOrEqual(20);

      const secondRun = applySqlMigrations(db, migrationsDir);
      expect(secondRun.applied).toEqual([]);
      expect(secondRun.skipped).toBe(firstRun.applied.length);

      const rows = db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      );
      const tableNames = rows.map((r) => r.name);
      for (const expected of EXPECTED_TABLES) {
        expect(tableNames).toContain(expected);
      }
      expect(tableNames.length).toBe(EXPECTED_TABLES.length);
    } finally {
      db.close();
    }
  });

  it('applique les contraintes FK ON DELETE CASCADE et les contraintes UNIQUE', () => {
    const db = new SqliteDatabaseAdapter(':memory:');
    try {
      applySqlMigrations(db, migrationsDir);
      const now = new Date().toISOString();

      db.run(
        `INSERT INTO books (id, work_canonical_id, title, normalized_title, created_at, updated_at)
         VALUES ('bk_1', 'work:1', 'Les Cigares du Pharaon', 'les cigares du pharaon', ?, ?)`,
        [now, now]
      );
      db.run(
        `INSERT INTO book_editions (isbn13, book_id, source, created_at)
         VALUES ('9782203001039', 'bk_1', 'bnf', ?)`,
        [now]
      );

      // Suppression du livre -> cascade sur book_editions
      db.run('DELETE FROM books WHERE id = ?', ['bk_1']);
      const editionAfter = db.get('SELECT isbn13 FROM book_editions WHERE isbn13 = ?', ['9782203001039']);
      expect(editionAfter).toBeNull();

      // Contrainte UNIQUE sur users.email
      db.run(
        `INSERT INTO users (id, username, email, password_hash, gdpr_accepted_at, created_at, updated_at)
         VALUES ('u1', 'mathieu', 'a@b.fr', 'hash', ?, ?, ?)`,
        [now, now, now]
      );
      expect(() =>
        db.run(
          `INSERT INTO users (id, username, email, password_hash, gdpr_accepted_at, created_at, updated_at)
           VALUES ('u2', 'autre', 'a@b.fr', 'hash', ?, ?, ?)`,
          [now, now, now]
        )
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
