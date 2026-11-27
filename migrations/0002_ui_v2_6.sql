-- Migration V2.6.0 : ordre personnalisé des genres, soft-ban réversible admin, archivage / historique Photo IA 30 jours glissants.
-- Migration incrémentale stricte (ne jamais modifier 0001_v2_initial.sql).

ALTER TABLE user_default_genres ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users ADD COLUMN banned_at TEXT;

ALTER TABLE background_jobs ADD COLUMN archived_at TEXT;

CREATE INDEX IF NOT EXISTS idx_background_jobs_photo_history
  ON background_jobs(type, user_id, library_id, created_at DESC);
