// src/server/db/database.adapter.ts
// Interface abstraite SQL standard (implémentée sur SQLite WAL, remplaçable par PostgreSQL sans toucher au métier).

export type SqlParam = string | number | boolean | null | Uint8Array;

export interface RunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

export interface DatabaseAdapter {
  /** Retourne la première ligne ou null. */
  get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): T | null;
  /** Retourne toutes les lignes. */
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): T[];
  /** Exécute une instruction INSERT / UPDATE / DELETE. */
  run(sql: string, params?: SqlParam[]): RunResult;
  /** Exécute un script DDL / multi-instructions (utilisé uniquement par le runner de migrations). */
  exec(sql: string): void;
  /** Exécute un bloc dans une transaction atomique (rollback automatique en cas d'exception). */
  transaction<T>(fn: () => T): T;
  /** Ferme proprement la connexion. */
  close(): void;
}
