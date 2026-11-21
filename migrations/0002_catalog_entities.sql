-- migrations/0002_catalog_entities.sql
-- Table d'indexation rapide des entités bibliographiques (Éditions, Œuvres, Séries, Auteurs, Genres)
-- Permet de répondre aux requêtes par URI, ISBN, Série (P179), Œuvre (P629) et Recherche plein-texte en < 2 ms sur Cloudflare D1.

CREATE TABLE IF NOT EXISTS catalog_entities (
  uri TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,                  -- 'edition', 'work', 'serie', 'human', 'genre', 'publisher', 'collection'
  label TEXT NOT NULL,
  normalized_label TEXT NOT NULL,
  isbn13 TEXT,
  work_uri TEXT,
  series_uri TEXT,
  series_number TEXT,
  sort_order REAL DEFAULT 1000.0,
  author_uris_json TEXT NOT NULL DEFAULT '[]',
  main_category TEXT NOT NULL DEFAULT 'Autre',
  subgenres_json TEXT NOT NULL DEFAULT '[]',
  image_url TEXT,
  entity_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalog_entities_isbn13 ON catalog_entities(isbn13);
CREATE INDEX IF NOT EXISTS idx_catalog_entities_work_uri ON catalog_entities(work_uri);
CREATE INDEX IF NOT EXISTS idx_catalog_entities_series_uri ON catalog_entities(series_uri, sort_order);
CREATE INDEX IF NOT EXISTS idx_catalog_entities_type_norm ON catalog_entities(entity_type, normalized_label);
