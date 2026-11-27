-- Migration 0004 : Politique de départ du foyer (member_choice | owner_only) + genres par défaut globaux gérés en Admin.

ALTER TABLE libraries ADD COLUMN detach_policy TEXT NOT NULL DEFAULT 'member_choice';

CREATE TABLE IF NOT EXISTS app_default_genres (
  genre_label TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO app_default_genres (genre_label, sort_order, created_at) VALUES
  ('BD', 0, '2026-01-01T00:00:00.000Z'),
  ('Manga', 1, '2026-01-01T00:00:00.000Z'),
  ('Comics', 2, '2026-01-01T00:00:00.000Z'),
  ('Roman', 3, '2026-01-01T00:00:00.000Z'),
  ('Jeunesse', 4, '2026-01-01T00:00:00.000Z'),
  ('Ados / Young Adult', 5, '2026-01-01T00:00:00.000Z'),
  ('Album illustré', 6, '2026-01-01T00:00:00.000Z'),
  ('Essai', 7, '2026-01-01T00:00:00.000Z'),
  ('Poésie / Théâtre', 8, '2026-01-01T00:00:00.000Z'),
  ('Pratique', 9, '2026-01-01T00:00:00.000Z'),
  ('Art / Beau livre', 10, '2026-01-01T00:00:00.000Z'),
  ('Fantasy / Fantastique', 11, '2026-01-01T00:00:00.000Z'),
  ('Science-Fiction', 12, '2026-01-01T00:00:00.000Z'),
  ('Aventure', 13, '2026-01-01T00:00:00.000Z'),
  ('Humour', 14, '2026-01-01T00:00:00.000Z'),
  ('Polar / Thriller', 15, '2026-01-01T00:00:00.000Z'),
  ('Historique', 16, '2026-01-01T00:00:00.000Z'),
  ('Romance', 17, '2026-01-01T00:00:00.000Z'),
  ('Biographie / Témoignage', 18, '2026-01-01T00:00:00.000Z'),
  ('Sciences & Nature', 19, '2026-01-01T00:00:00.000Z'),
  ('Philosophie', 20, '2026-01-01T00:00:00.000Z'),
  ('Société & Politique', 21, '2026-01-01T00:00:00.000Z'),
  ('Psychologie & Santé', 22, '2026-01-01T00:00:00.000Z');
