// src/server/db/migrator.ts
// Runner incrémental strict : applique chaque fichier migrations/XXXX_*.sql une seule fois dans une transaction.

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseAdapter } from './database.adapter';

export interface MigrationReport {
  applied: string[];
  skipped: number;
}

export function applySqlMigrations(db: DatabaseAdapter, migrationsDir: string): MigrationReport {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  if (!fs.existsSync(migrationsDir)) {
    return { applied: [], skipped: 0 };
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.+\.sql$/i.test(f))
    .sort((a, b) => a.localeCompare(b));

  const appliedRows = db.all<{ filename: string }>('SELECT filename FROM schema_migrations');
  const alreadyApplied = new Set(appliedRows.map((r) => r.filename));

  const applied: string[] = [];
  let skipped = 0;

  for (const file of files) {
    if (alreadyApplied.has(file)) {
      skipped++;
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const now = new Date().toISOString();

    db.transaction(() => {
      db.exec(sql);
      db.run('INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)', [file, now]);
    });

    applied.push(file);
  }

  return { applied, skipped };
}
