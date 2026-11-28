-- Migration 0005 : Support dédié du rôle Coloriste sur le Catalogue Central (complète scriptwriters_json et illustrators_json).

ALTER TABLE books ADD COLUMN colorists_json TEXT NOT NULL DEFAULT '[]';
