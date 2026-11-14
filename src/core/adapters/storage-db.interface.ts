// src/core/adapters/storage-db.interface.ts
// Couche d'abstraction DRY entre le code métier et l'infrastructure (Cloudflare D1 / R2 ou Docker SQLite / S3)

export interface SqlPreparedStatement {
  bind(...values: unknown[]): SqlPreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

/**
 * Interface minimale compatible nativement avec Cloudflare D1Database
 * et très facile à implémenter avec `better-sqlite3` ou `pg` en auto-hébergement Docker.
 */
export interface DatabaseBinding {
  prepare(query: string): SqlPreparedStatement;
  batch<T = unknown>(statements: SqlPreparedStatement[]): Promise<T[]>;
}

/**
 * Interface minimale compatible nativement avec Cloudflare R2Bucket
 * et facile à adapter vers un dossier disque local ou MinIO/S3.
 */
export interface CoverBucketBinding {
  get(key: string): Promise<{
    body: ReadableStream | null;
    httpMetadata?: { contentType?: string };
    etag?: string;
  } | null>;
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

/**
 * Environnement injecté automatiquement par Cloudflare Pages Functions (`context.env`)
 * ou par un serveur Node/Docker auto-hébergé.
 */
export interface AppBackendEnv {
  DB: DatabaseBinding;
  COVERS_BUCKET?: CoverBucketBinding;
  JWT_SECRET?: string;
}
