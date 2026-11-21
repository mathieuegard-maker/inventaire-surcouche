-- Option B : Surcharges privées par foyer/bibliothèque sur les fiches V4
-- Le catalogue commun `books` reste immuable après création ; chaque foyer stocke
-- ses propres choix (couverture, titre, série, tome, genres) dans `v4_library_books`.

ALTER TABLE v4_library_books ADD COLUMN custom_overrides_json TEXT;
