// server/adapters/sqlite-db.adapter.ts
// Adaptateur SQLite natif (`better-sqlite3`) implémentant `DatabaseBinding` (portable hors Cloudflare D1).

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseBinding, SqlPreparedStatement } from '../../src/core/adapters/storage-db.interface';

function normalizeBindParam(val: unknown): unknown {
  if (val === undefined || val === null) return null;
  if (typeof val === 'boolean') return val ? 1 : 0;
  if (val instanceof ArrayBuffer) return Buffer.from(val);
  if (ArrayBuffer.isView(val)) return Buffer.from(val.buffer, val.byteOffset, val.byteLength);
  return val;
}

class SqlitePreparedStatement implements SqlPreparedStatement {
  private readonly db: Database.Database;
  private readonly query: string;
  private readonly params: unknown[];

  constructor(db: Database.Database, query: string, params: unknown[] = []) {
    this.db = db;
    this.query = query;
    this.params = params;
  }

  bind(...values: unknown[]): SqlPreparedStatement {
    return new SqlitePreparedStatement(this.db, this.query, values.map(normalizeBindParam));
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.query);
    const row = stmt.get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (colName) {
      return (row[colName] as T) ?? null;
    }
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const stmt = this.db.prepare(this.query);
    const rows = stmt.all(...this.params) as T[];
    return { results: rows };
  }

  async run(): Promise<{ success: boolean }> {
    const stmt = this.db.prepare(this.query);
    stmt.run(...this.params);
    return { success: true };
  }

  /**
   * Exécution synchrone interne utilisée par `batch()` pour bénéficier d'une transaction SQLite atomique.
   */
  runSync(): { success: boolean } {
    const stmt = this.db.prepare(this.query);
    stmt.run(...this.params);
    return { success: true };
  }
}

export class SqliteDatabaseAdapter implements DatabaseBinding {
  public readonly raw: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.raw = new Database(dbPath);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('synchronous = NORMAL');
    this.raw.pragma('busy_timeout = 5000');
    this.raw.pragma('foreign_keys = ON');
  }

  prepare(query: string): SqlPreparedStatement {
    return new SqlitePreparedStatement(this.raw, query);
  }

  async batch<T = unknown>(statements: SqlPreparedStatement[]): Promise<T[]> {
    const runBatch = this.raw.transaction((stmts: SqlPreparedStatement[]) => {
      const results: unknown[] = [];
      for (const s of stmts) {
        if (s instanceof SqlitePreparedStatement) {
          results.push(s.runSync());
        } else {
          throw new Error('Unsupported SqlPreparedStatement passed to SqliteDatabaseAdapter.batch');
        }
      }
      return results;
    });
    return runBatch(statements) as T[];
  }

  /**
   * Applique de manière idempotente toutes les migrations SQL du dossier `migrations/`.
   */
  applyMigrations(migrationsDir: string): { applied: string[]; skipped: number } {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS d1_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    if (!fs.existsSync(migrationsDir)) {
      return { applied: [], skipped: 0 };
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));

    const existingRows = this.raw
      .prepare('SELECT name FROM d1_migrations')
      .all() as Array<{ name: string }>;
    const appliedSet = new Set(existingRows.map((r) => r.name));

    const applied: string[] = [];
    let skipped = 0;

    for (const file of files) {
      if (appliedSet.has(file)) {
        skipped++;
        continue;
      }
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      this.raw.pragma('foreign_keys = OFF');
      try {
        const tx = this.raw.transaction(() => {
          this.raw.exec(sql);
          this.raw.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(file);
        });
        tx();
        applied.push(file);
      } finally {
        this.raw.pragma('foreign_keys = ON');
      }
    }

    return { applied, skipped };
  }

  async backup(targetFilePath: string): Promise<void> {
    fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
    await this.raw.backup(targetFilePath);
  }

  close(): void {
    this.raw.close();
  }
}
