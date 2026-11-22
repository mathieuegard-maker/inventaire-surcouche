-- Migration 0014: File de traitement Photo IA côté serveur (isolée par utilisateur et foyer)
CREATE TABLE IF NOT EXISTS photo_scan_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'shelf',
  status TEXT NOT NULL DEFAULT 'pending',
  image_data_url TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'image/webp',
  candidates_count INTEGER NOT NULL DEFAULT 0,
  progress_done INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photo_scan_jobs_user ON photo_scan_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_photo_scan_jobs_status ON photo_scan_jobs (status, updated_at ASC);
