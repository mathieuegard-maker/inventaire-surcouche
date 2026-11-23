// src/server/db/sqlite.adapter.ts
// Implémentation SQLite WAL (better-sqlite3) de l'interface DatabaseAdapter.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseAdapter, RunResult, SqlParam } from './database.adapter';

function normalizeParams(params?: SqlParam[]): unknown[] {
  if (!params || params.length === 0) return [];
  return params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

export class SqliteDatabaseAdapter implements DatabaseAdapter {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
    }
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
  }

  get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): T | null {
    const row = this.db.prepare(sql).get(...normalizeParams(params));
    return (row as T | undefined) ?? null;
  }

  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): T[] {
    return this.db.prepare(sql).all(...normalizeParams(params)) as T[];
  }

  run(sql: string, params?: SqlParam[]): RunResult {
    const info = this.db.prepare(sql).run(...normalizeParams(params));
    return {
      changes: info.changes,
      lastInsertRowid: info.lastInsertRowid
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    const wrapped = this.db.transaction(fn);
    return wrapped();
  }

  close(): void {
    this.db.close();
  }
}
