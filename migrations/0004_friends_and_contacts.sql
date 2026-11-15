-- migrations/0004_friends_and_contacts.sql
-- Page dédiée Amis (bibliothèques suivies en lecture seule) + carnet de contacts de prêt

CREATE TABLE IF NOT EXISTS friend_connections (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  share_token TEXT NOT NULL,
  display_label TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, target_library_id)
);

CREATE INDEX IF NOT EXISTS idx_friend_connections_target ON friend_connections(target_library_id);

CREATE TABLE IF NOT EXISTS borrower_contacts (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'friend_share'
  created_at TEXT NOT NULL,
  UNIQUE(library_id, name)
);

CREATE INDEX IF NOT EXISTS idx_borrower_contacts_lib ON borrower_contacts(library_id);
