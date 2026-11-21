-- migrations/0001_initial_schema.sql
-- Architecture V2 : Catalogue commun dédupliqué (Zone 1) + Espaces privés & Foyers (Zone 2)
-- Compatible SQLite (Cloudflare D1 / PocketBase / SQLite Docker) et facilement portable vers PostgreSQL

PRAGMA foreign_keys = ON;

-- ============================================================================
-- ZONE 1 : CATALOGUE COMMUN PARTAGÉ & DÉDUPLIQUÉ (Séries, Œuvres, Éditions)
-- ============================================================================

CREATE TABLE IF NOT EXISTS series (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  main_category TEXT NOT NULL DEFAULT 'Autre', -- 'BD', 'Manga', 'Comics', 'Roman', 'Essai', 'Jeunesse', 'Pratique', 'Autre'
  subgenres_json TEXT NOT NULL DEFAULT '[]',   -- ex: '["SF", "Humour", "Historique"]'
  status TEXT NOT NULL DEFAULT 'ongoing',      -- 'ongoing', 'completed', 'abandoned', 'oneshot'
  known_volumes_count INTEGER DEFAULT 0,
  primary_authors_json TEXT NOT NULL DEFAULT '[]',
  bnf_ark TEXT,
  wikidata_qid TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_series_normalized_title ON series(normalized_title);
CREATE INDEX IF NOT EXISTS idx_series_category ON series(main_category);

CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  series_id TEXT REFERENCES series(id) ON DELETE SET NULL, -- NULL pour un roman/essai unitaire hors série
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  work_type TEXT NOT NULL DEFAULT 'standard',  -- 'standard', 'hors_serie', 'integrale', 'spinoff', 'coffret'
  volume_label TEXT,                           -- ex: '1', 'HS 1', '0', 'Intégrale 1-3' (NULL si livre unitaire)
  sort_order REAL NOT NULL DEFAULT 1000.0,     -- Permet d'intercaler un HS (ex: 1.5) ou de trier proprement
  contains_work_ids_json TEXT NOT NULL DEFAULT '[]', -- Pour les intégrales : liste des work_id inclus
  main_category TEXT NOT NULL DEFAULT 'Autre',
  subgenres_json TEXT NOT NULL DEFAULT '[]',
  dewey_code TEXT,                             -- Indice BnF 676$a
  rameau_tags_json TEXT NOT NULL DEFAULT '[]', -- Sujets BnF 606 / Forme 608
  authors_json TEXT NOT NULL DEFAULT '[]',     -- [{ name, role: 'author'|'scenarist'|'illustrator'|'colorist' }]
  summary TEXT,
  default_cover_url TEXT,
  bnf_work_ark TEXT,
  wikidata_qid TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_works_series_id ON works(series_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_works_normalized_title ON works(normalized_title);
CREATE INDEX IF NOT EXISTS idx_works_category ON works(main_category);

CREATE TABLE IF NOT EXISTS editions (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  isbn13 TEXT UNIQUE,
  isbn10 TEXT,
  title TEXT NOT NULL,
  publisher TEXT,
  collection_name TEXT,
  published_date TEXT,
  page_count INTEGER,
  format_binding TEXT,                         -- 'cartonné', 'broché', 'poche', 'intégrale'
  cover_r2_key TEXT,                           -- Clé de l'image WebP compressée dans Cloudflare R2
  cover_external_url TEXT,                     -- URL de secours (BnF / OpenLibrary / Google Books)
  sources_json TEXT NOT NULL DEFAULT '[]',     -- Trace des sources consolidées : ['bnf', 'googlebooks', 'openlibrary']
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_editions_isbn13 ON editions(isbn13);
CREATE INDEX IF NOT EXISTS idx_editions_isbn10 ON editions(isbn10);
CREATE INDEX IF NOT EXISTS idx_editions_work_id ON editions(work_id);

-- ============================================================================
-- ZONE 2 : UTILISATEURS, BIBLIOTHÈQUES FAMILIALES & DONNÉES PRIVÉES
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS libraries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                          -- ex: 'Bibliothèque Famille Egard'
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS library_members (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'editor',         -- 'owner', 'editor' (conjoint), 'contributor' (enfant), 'viewer'
  joined_at TEXT NOT NULL,
  PRIMARY KEY (library_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_library_members_user ON library_members(user_id);

-- Liens d'invitation foyer (QR Code) et liens de partage lecture seule (Amis / Wishlist Cadeaux)
CREATE TABLE IF NOT EXISTS share_tokens (
  token TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  token_type TEXT NOT NULL,                    -- 'invite_member', 'public_collection_readonly', 'public_wishlist_gifts'
  target_role TEXT DEFAULT 'viewer',           -- Rôle attribué si token_type = 'invite_member'
  label TEXT,                                  -- ex: 'Lien Amis', 'Invitation Enfants', 'Liste Noël'
  expires_at TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

-- Livres possédés ou en Wishlist dans une bibliothèque donnée
CREATE TABLE IF NOT EXISTS library_items (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  edition_id TEXT REFERENCES editions(id) ON DELETE SET NULL,
  ownership_status TEXT NOT NULL DEFAULT 'owned', -- 'owned', 'wishlist'
  location TEXT,                                  -- ex: 'Salon - Étagère B', 'Chambre Léo'
  condition TEXT,                                 -- 'neuf', 'bon', 'occasion', 'dédicacé'
  acquired_at TEXT,
  gift_reserved_by TEXT,                          -- Permet à un proche de marquer un item wishlist comme "Réservé"
  custom_overrides_json TEXT DEFAULT '{}',        -- Surcharges privées (titre perso, couverture perso, etc.)
  is_locally_edited INTEGER NOT NULL DEFAULT 0,   -- 1 = protégé contre l'écrasement automatique
  deleted_at TEXT,                                -- Soft-delete (tombstone) pour la synchro différentielle hors-ligne
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_library_items_sync ON library_items(library_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_library_items_work ON library_items(library_id, work_id);
CREATE INDEX IF NOT EXISTS idx_library_items_edition ON library_items(library_id, edition_id);

-- Statuts de lecture individuels et optionnels par membre du foyer
CREATE TABLE IF NOT EXISTS reading_statuses (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unread',       -- 'unread', 'reading', 'read', 'abandoned'
  rating INTEGER,                              -- 1 à 5 (optionnel)
  personal_notes TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(library_id, user_id, work_id)
);

CREATE INDEX IF NOT EXISTS idx_reading_statuses_sync ON reading_statuses(library_id, updated_at);

-- Suivi des prêts et historique
CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  borrower_name TEXT NOT NULL,
  loaned_at TEXT NOT NULL,
  due_date TEXT,
  returned_at TEXT,                            -- NULL tant que le livre est dehors
  notes TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loans_sync ON loans(library_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_loans_active ON loans(library_id, returned_at);
