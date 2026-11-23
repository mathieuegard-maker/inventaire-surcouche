-- migrations/0001_v2_initial.sql
-- Schéma SQLite V2 Clean Room (25 tables propres en 4 espaces étanches, SQL standard portable PostgreSQL).

-- ============================================================================
-- ESPACE 1 : CATALOGUE CENTRAL (Commun à tous — Couches 1 Robots & 2 Admin)
-- ============================================================================

CREATE TABLE covers (
  cover_key TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  source_url TEXT,
  mime_type TEXT NOT NULL DEFAULT 'image/webp',
  byte_size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  created_at TEXT NOT NULL,
  last_referenced_at TEXT NOT NULL
);

CREATE TABLE franchises (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  normalized_key TEXT NOT NULL UNIQUE,
  wikidata_qid TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE series (
  id TEXT PRIMARY KEY,
  franchise_id TEXT REFERENCES franchises(id) ON DELETE SET NULL,
  canonical_name TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  edition_signature TEXT NOT NULL DEFAULT '',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  primary_authors_json TEXT NOT NULL DEFAULT '[]',
  wikidata_qid TEXT,
  bnf_ensemble_ids_json TEXT NOT NULL DEFAULT '[]',
  is_complete_expanded INTEGER NOT NULL DEFAULT 0,
  known_volumes_count INTEGER NOT NULL DEFAULT 0,
  locked_fields_json TEXT NOT NULL DEFAULT '[]',
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (normalized_key, edition_signature)
);

CREATE TABLE books (
  id TEXT PRIMARY KEY,
  work_canonical_id TEXT NOT NULL UNIQUE,
  series_id TEXT REFERENCES series(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  volume_number INTEGER,
  volume_label TEXT,
  sort_order REAL,
  is_hors_serie INTEGER NOT NULL DEFAULT 0,
  is_integral INTEGER NOT NULL DEFAULT 0,
  included_volumes_json TEXT NOT NULL DEFAULT '[]',
  authors_json TEXT NOT NULL DEFAULT '[]',
  scriptwriters_json TEXT NOT NULL DEFAULT '[]',
  illustrators_json TEXT NOT NULL DEFAULT '[]',
  publisher TEXT,
  collection_name TEXT,
  publish_year TEXT,
  page_count INTEGER,
  description TEXT,
  language TEXT NOT NULL DEFAULT 'fr',
  main_category TEXT NOT NULL DEFAULT 'Autre',
  subgenres_json TEXT NOT NULL DEFAULT '[]',
  cover_key TEXT REFERENCES covers(cover_key) ON DELETE SET NULL,
  wikidata_qid TEXT,
  inventaire_uri TEXT,
  source_origin TEXT NOT NULL DEFAULT 'auto',
  locked_fields_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE book_editions (
  isbn13 TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  publisher TEXT,
  collection_name TEXT,
  publish_year TEXT,
  page_count INTEGER,
  cover_key TEXT REFERENCES covers(cover_key) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'auto',
  created_at TEXT NOT NULL
);

-- ============================================================================
-- ESPACE 3 (déclaré avant Espace 2 pour les FK users) : COMPTE / UTILISATEUR
-- ============================================================================

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  theme TEXT NOT NULL DEFAULT 'editorial-light',
  locale TEXT NOT NULL DEFAULT 'fr',
  gdpr_accepted_at TEXT NOT NULL,
  onboarding_notif_seen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE user_reading_states (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'none',
  rating INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, book_id)
);

CREATE TABLE user_default_genres (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  genre_label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, genre_label)
);

CREATE TABLE user_notification_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  frequency TEXT NOT NULL DEFAULT 'weekly',
  day_of_week INTEGER NOT NULL DEFAULT 6,
  day_of_month INTEGER NOT NULL DEFAULT 1,
  hour INTEGER NOT NULL DEFAULT 9,
  timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
  channel TEXT NOT NULL DEFAULT 'push',
  last_notified_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE user_ai_usage (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  month_key TEXT NOT NULL,
  month_used INTEGER NOT NULL DEFAULT 0,
  total_used INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- ============================================================================
-- ESPACE 2 : FOYER & PARTAGE (library_id — Couche 3 Souveraine)
-- ============================================================================

CREATE TABLE libraries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  family_invite_code TEXT NOT NULL UNIQUE,
  friend_share_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE library_members (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL,
  PRIMARY KEY (library_id, user_id)
);

CREATE TABLE library_books (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'none',
  wished_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  overrides_json TEXT NOT NULL DEFAULT '{}',
  overrides_updated_at TEXT,
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (library_id, book_id)
);

CREATE TABLE loans (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  borrower_name TEXT NOT NULL,
  loaned_at TEXT NOT NULL,
  returned_at TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE borrower_contacts (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY (library_id, name)
);

CREATE TABLE series_release_alerts (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  detected_at TEXT NOT NULL,
  dismissed_at TEXT,
  UNIQUE (library_id, book_id)
);

CREATE TABLE wishlist_reservations (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  reserved_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reserved_at TEXT NOT NULL,
  PRIMARY KEY (library_id, book_id)
);

CREATE TABLE friend_connections (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, target_library_id)
);

-- ============================================================================
-- ESPACE 4 : TECHNIQUE, JOBS SERVEUR & OBSERVABILITÉ
-- ============================================================================

CREATE TABLE background_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  library_id TEXT REFERENCES libraries(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  progress_done INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE external_cache (
  cache_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  response_json TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE cron_runs (
  job_name TEXT PRIMARY KEY,
  last_run_key TEXT NOT NULL,
  last_run_at TEXT NOT NULL,
  status TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE pipeline_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  user_id TEXT,
  channel TEXT NOT NULL,
  stage TEXT NOT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  summary TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

-- ============================================================================
-- INDEX DE PERFORMANCE
-- ============================================================================

CREATE INDEX idx_series_franchise ON series(franchise_id);
CREATE INDEX idx_series_wikidata ON series(wikidata_qid);
CREATE INDEX idx_books_series_vol ON books(series_id, volume_number);
CREATE INDEX idx_books_norm_title ON books(normalized_title);
CREATE INDEX idx_books_updated ON books(updated_at);
CREATE INDEX idx_book_editions_book ON book_editions(book_id);
CREATE INDEX idx_covers_last_ref ON covers(last_referenced_at);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_library_members_user ON library_members(user_id);
CREATE INDEX idx_library_books_sync ON library_books(library_id, updated_at);
CREATE INDEX idx_library_books_status ON library_books(library_id, status);
CREATE INDEX idx_loans_active ON loans(library_id, returned_at);
CREATE INDEX idx_reading_sync ON user_reading_states(user_id, updated_at);
CREATE INDEX idx_alerts_library ON series_release_alerts(library_id, dismissed_at);
CREATE INDEX idx_jobs_status ON background_jobs(status, created_at);
CREATE INDEX idx_jobs_user ON background_jobs(user_id, updated_at);
CREATE INDEX idx_ext_cache_expires ON external_cache(expires_at);
CREATE INDEX idx_pipeline_logs_created ON pipeline_logs(created_at);
CREATE INDEX idx_pipeline_logs_trace ON pipeline_logs(trace_id);
