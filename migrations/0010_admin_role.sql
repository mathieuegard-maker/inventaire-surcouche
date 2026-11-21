-- migrations/0010_admin_role.sql
-- Ajoute le rôle administrateur sur les comptes utilisateurs (désigné pour le créateur).

ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

UPDATE users SET is_admin = 1 WHERE id = 'usr_b031428f0c88479f';
