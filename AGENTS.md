# Règles Projet & Mémoire Continue — `inventaire-surcouche`

Ce document s'applique à toute session de travail sur ce dépôt. Son but est d'assurer la continuité architecturale et de maintenir une mémoire écrite durable des choix techniques et métier.

## 1. Documentation & Mémoire Projet (Obligatoire)
* **Source de vérité actuelle :** avant de modifier le pipeline d'acquisition, le schéma de données ou l'UX scanner, lire [`documentation/ETAT_PROJET.md`](./documentation/ETAT_PROJET.md) et consulter [`documentation/Architecture_Algorithme_Livres_AntiGravity-v4.md`](./documentation/Architecture_Algorithme_Livres_AntiGravity-v4.md).
* **Capturer le « pourquoi » au fil de l'eau :** dès qu'un choix d'architecture, un arbitrage UX ou la résolution d'un bug métier important est validé avec l'utilisateur, consigner la décision (contexte, décision, alternatives écartées et raison) dans `documentation/ETAT_PROJET.md`. Ne pas se limiter à décrire le diff.
* **Journal hebdomadaire versionné :** vérifier la date du dernier fichier dans `documentation/historique/` (`vXX_YYYY-MM-DD_<slug>.md`) et son `Dernier commit inclus`. Si **>= 7 jours** se sont écoulés depuis cette date (ou en fin d'un jalon majeur) et qu'il existe de nouveaux commits non documentés :
  1. Créer le fichier incrémental suivant `documentation/historique/v{XX+1}_{YYYY-MM-DD}_{slug}.md` couvrant **uniquement** les changements, tests réels, bugs découverts et décisions logiques depuis la borne précédente.
  2. Mettre à jour le tableau d'index, l'état courant et les éventuels nouveaux ADR dans `documentation/ETAT_PROJET.md`.

## 2. Invariants Techniques & Règles Bibliographiques (Ne jamais casser)
* **Modèle FRBR V4 (`books` + `book_isbn_index`) :**
  * La possession est portée au niveau de l'œuvre consolidée (`books`), avec indexation O(1) de tous les ISBN-13 FR sœurs dans `book_isbn_index`.
  * Conserver la portabilité de `src/core/services/v4-pipeline.service.ts` au-dessus de `DatabaseBinding` (`src/core/adapters/storage-db.interface.ts`) et `fetch()` standard — zéro dépendance directe aux bindings propriétaires Cloudflare dans le moteur V4.
* **Intégrales & Albums doubles :**
  * **Ne jamais** déduire `isIntegral = true` à partir du seul nombre de pages (ex. `pageCount >= 180` banni suite aux romans graphiques unitaires).
  * Toujours préserver la lecture BnF InterMarc `245$e/$h/$u` et le multi-`wdt:P629` d'Inventaire.io / Wikidata pour extraire les tomes inclus et différencier les volumes d'intégrales (`Intégrale 1`, `Intégrale 2`).
  * Lorsqu'un livre ou squelette C5 est upgradé vers un autre `book_id`, migrer `v4_library_books` et `book_isbn_index` (`replaceSkeletonBookId`).
* **Hors-séries & Séries BnF :**
  * Évaluer `is_hors_serie` uniquement **après** agrégation de toutes les éditions sœurs FR en Couche 4.
  * Priorité MARC : `460/461` > `245$p/$u` > `290` > `410/295` en filtrant les collections éditoriales de poche (`isEditorialPaperbackCollectionName`), et déduplication dans `catalog_entities` (`work`) sans `OR` entre `normalized_label` et `series_number`.
* **Cohérence Local-First IndexedDB ↔ D1 :**
  * Tout ajout V4 (`ingestIsbnsViaV4`, `ScanView.vue`, etc.) doit écrire à la fois dans `cache_books` (`saveBookToCache`) **et** dans le registre `inventory`/`wishlist` (`addRegistryEntry`).
  * En cas de changement incompatible du modèle local ou de remise à zéro D1 pour tests, incrémenter `DB_RESET_TOKEN` dans `src/core/orchestrators/sync.orchestrator.ts`.

## 3. Contrôle Qualité avant Clôture ou Déploiement
* Exécuter systématiquement `npx tsc --noEmit` et `npx vitest run` après modification de code et rapporter uniquement les résultats réellement observés.
* Répondre en **français** avec des liens cliquables vers les fichiers modifiés.
