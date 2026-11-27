-- migrations/0003_v2_6_1_ux.sql
-- Migration incrémentale v2.6.1 :
-- 1. Soft delete + restauration des amis suivis (`friend_connections.deleted_at`)
-- 2. Recalcul de `series.known_volumes_count` pour exclure les intégrales du compte de tomes unitaires

ALTER TABLE friend_connections ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_friend_connections_user_active
  ON friend_connections(user_id, deleted_at);

UPDATE series
SET known_volumes_count = COALESCE(
  (SELECT COUNT(*) FROM books b WHERE b.series_id = series.id AND b.is_integral = 0),
  0
)
WHERE EXISTS (SELECT 1 FROM books b WHERE b.series_id = series.id AND b.is_integral = 0);
