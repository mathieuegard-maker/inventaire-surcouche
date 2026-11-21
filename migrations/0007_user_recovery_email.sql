-- migrations/0007_user_recovery_email.sql
-- Ajoute l'adresse e-mail de récupération obligatoire pour les comptes et les jetons de réinitialisation de mot de passe.

ALTER TABLE users ADD COLUMN recovery_email TEXT;

CREATE INDEX IF NOT EXISTS idx_users_recovery_email ON users(recovery_email);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
