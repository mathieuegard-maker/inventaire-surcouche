-- ============================================================================
-- MIGRATION 0003 : SUPPRESSION DES FOREIGN KEYS OBSOLÈTES VERS works/editions
-- Nos entités (éditions, œuvres, séries, auteurs) vivent désormais dans `catalog_entities(uri)`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS library_items_v2 (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  edition_id TEXT,
  ownership_status TEXT NOT NULL DEFAULT 'owned',
  location TEXT,
  condition TEXT,
  acquired_at TEXT,
  gift_reserved_by TEXT,
  custom_overrides_json TEXT DEFAULT '{}',
  is_locally_edited INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO library_items_v2 SELECT * FROM library_items;
DROP TABLE library_items;
ALTER TABLE library_items_v2 RENAME TO library_items;

CREATE INDEX IF NOT EXISTS idx_library_items_sync ON library_items(library_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_library_items_work ON library_items(library_id, work_id);
CREATE INDEX IF NOT EXISTS idx_library_items_edition ON library_items(library_id, edition_id);

CREATE TABLE IF NOT EXISTS reading_statuses_v2 (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread',
  rating INTEGER,
  personal_notes TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(library_id, user_id, work_id)
);

INSERT OR IGNORE INTO reading_statuses_v2 SELECT * FROM reading_statuses;
DROP TABLE reading_statuses;
ALTER TABLE reading_statuses_v2 RENAME TO reading_statuses;

CREATE INDEX IF NOT EXISTS idx_reading_statuses_sync ON reading_statuses(library_id, updated_at);

CREATE TABLE IF NOT EXISTS loans_v2 (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  library_item_id TEXT NOT NULL,
  borrower_name TEXT NOT NULL,
  loaned_at TEXT NOT NULL,
  due_date TEXT,
  returned_at TEXT,
  notes TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO loans_v2 SELECT * FROM loans;
DROP TABLE loans;
ALTER TABLE loans_v2 RENAME TO loans;

CREATE INDEX IF NOT EXISTS idx_loans_sync ON loans(library_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_loans_active ON loans(library_id, returned_at);
