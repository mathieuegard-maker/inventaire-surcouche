-- migrations/0011_v4_frbr_books_and_logs.sql
-- Architecture V4 : Fiches Livre FRBR consolidées, index relationnel book_isbn_index O(1),
-- intégrales bidirectionnelles, hors-séries, file Couche 5 différée et logs pipeline_logs.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS v4_series (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  normalized_core_key TEXT NOT NULL UNIQUE,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  primary_authors_json TEXT NOT NULL DEFAULT '[]',
  wikidata_qid TEXT,
  bnf_ensemble_ids_json TEXT NOT NULL DEFAULT '[]',
  is_complete_expanded INTEGER NOT NULL DEFAULT 0,
  known_volumes_count INTEGER NOT NULL DEFAULT 0,
  series_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_v4_series_core ON v4_series(normalized_core_key);
CREATE INDEX IF NOT EXISTS idx_v4_series_name ON v4_series(canonical_name);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  work_canonical_id TEXT NOT NULL UNIQUE,
  canonical_title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  series_id TEXT REFERENCES v4_series(id) ON DELETE SET NULL,
  series_name TEXT,
  volume_number INTEGER,
  volume_label TEXT,
  is_hors_serie INTEGER NOT NULL DEFAULT 0,
  hors_serie_label TEXT,
  is_integral INTEGER NOT NULL DEFAULT 0,
  integral_metadata_json TEXT NOT NULL DEFAULT '{"included_volume_numbers":[],"included_work_ids":[],"included_isbns":[]}',
  parent_integrals_json TEXT NOT NULL DEFAULT '[]',
  authors_json TEXT NOT NULL DEFAULT '[]',
  language TEXT NOT NULL DEFAULT 'fr',
  known_isbns_json TEXT NOT NULL DEFAULT '[]',
  editions_catalog_json TEXT NOT NULL DEFAULT '[]',
  selected_cover_url TEXT,
  main_category TEXT NOT NULL DEFAULT 'Autre',
  subgenres_json TEXT NOT NULL DEFAULT '[]',
  legacy_entity_uri TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_books_series_vol ON books(series_id, volume_number);
CREATE INDEX IF NOT EXISTS idx_books_norm_title ON books(normalized_title);
CREATE INDEX IF NOT EXISTS idx_books_updated_at ON books(updated_at);

CREATE TABLE IF NOT EXISTS book_isbn_index (
  isbn13 TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  is_integral INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_book_isbn_index_book_id ON book_isbn_index(book_id);

CREATE TABLE IF NOT EXISTS v4_library_books (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  is_owned INTEGER NOT NULL DEFAULT 0, -- 1 = possédé, 0 = pré-chargé non possédé (Couche 5 / Cron)
  is_wished INTEGER NOT NULL DEFAULT 0,
  source_channel TEXT,
  selected_cover_url TEXT,
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (library_id, book_id)
);

CREATE INDEX IF NOT EXISTS idx_v4_library_books_sync ON v4_library_books(library_id, updated_at);

CREATE TABLE IF NOT EXISTS enrichment_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT,
  isbn13 TEXT NOT NULL UNIQUE,
  series_id TEXT,
  priority INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'done', 'error'
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_enrichment_queue_status ON enrichment_queue(status, priority, created_at);

CREATE TABLE IF NOT EXISTS pipeline_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  user_id TEXT,
  source_channel TEXT,
  layer TEXT NOT NULL,      -- 'C1', 'C2', 'C3', 'C4', 'C5', 'CRON'
  step_name TEXT NOT NULL,
  status TEXT NOT NULL,     -- 'ok', 'warn', 'error'
  duration_ms INTEGER,
  summary TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pipeline_logs_trace ON pipeline_logs(trace_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_logs_created ON pipeline_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_logs_status_created ON pipeline_logs(status, created_at DESC);
