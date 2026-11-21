-- migrations/0009_user_ai_quota.sql
-- Suivi du quota d'analyses photo IA offertes par utilisateur (onboarding + mensuel).

CREATE TABLE IF NOT EXISTS user_ai_usage (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_used INTEGER NOT NULL DEFAULT 0,
  month_key TEXT NOT NULL,
  month_used INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
