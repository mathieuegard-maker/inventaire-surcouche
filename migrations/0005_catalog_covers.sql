-- Migration 0005 : Cache central de couvertures compressées WebP / binaires (repli D1 avant/avec R2)
CREATE TABLE IF NOT EXISTS catalog_covers (
  cover_key TEXT PRIMARY KEY,
  isbn13 TEXT,
  content_type TEXT NOT NULL,
  image_data TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalog_covers_isbn ON catalog_covers(isbn13);
