-- Migration 0013: Suivi du membre du foyer ayant ajouté un livre à la wishlist (v4_library_books + library_items)
ALTER TABLE v4_library_books ADD COLUMN wished_by_user_id TEXT;
ALTER TABLE library_items ADD COLUMN added_by_user_id TEXT;
