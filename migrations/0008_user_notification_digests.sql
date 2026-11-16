-- migrations/0008_user_notification_digests.sql
-- Préférences de digest de nouveautés par utilisateur et abonnements Web Push (PWA).

CREATE TABLE IF NOT EXISTS user_notification_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  digest_frequency TEXT NOT NULL DEFAULT 'off',
  digest_hour INTEGER NOT NULL DEFAULT 9,
  digest_weekday INTEGER NOT NULL DEFAULT 6,
  digest_day_of_month INTEGER NOT NULL DEFAULT 1,
  digest_timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
  digest_channel TEXT NOT NULL DEFAULT 'email',
  last_notified_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_push_subscriptions_user_id ON user_push_subscriptions(user_id);
