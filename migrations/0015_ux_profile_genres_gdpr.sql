-- Migration 0015 : Consentement RGPD, onboarding notifications, genres par défaut par utilisateur
-- et indexation individuelle des statuts de lecture / notes par compte (user_id).

ALTER TABLE users ADD COLUMN gdpr_accepted_at TEXT;
ALTER TABLE users ADD COLUMN onboarding_notif_seen INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS user_default_genres (
  user_id TEXT NOT NULL,
  genre_label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, genre_label)
);

CREATE INDEX IF NOT EXISTS idx_user_default_genres_user ON user_default_genres(user_id);
CREATE INDEX IF NOT EXISTS idx_reading_statuses_user ON reading_statuses(user_id, updated_at);
