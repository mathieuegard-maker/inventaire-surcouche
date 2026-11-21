-- Migration 0006 : Suivi périodique des sorties de nouveaux tomes par série à l'ouverture
ALTER TABLE catalog_entities ADD COLUMN series_checked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_catalog_entities_series_check
  ON catalog_entities(entity_type, series_checked_at);

CREATE TABLE IF NOT EXISTS series_release_alerts (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  series_uri TEXT NOT NULL,
  series_title TEXT NOT NULL,
  volume_uri TEXT NOT NULL,
  volume_title TEXT NOT NULL,
  series_number TEXT,
  isbn13 TEXT,
  cover_url TEXT,
  detected_at TEXT NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_series_release_alerts_lib
  ON series_release_alerts(library_id, dismissed, detected_at);
