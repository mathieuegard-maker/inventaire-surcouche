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

## 3. Déploiement & Exploitation Serveur Auto-Hébergé (Debian + Docker)
* **Production active :** serveur personnel Debian 13 Trixie (Dell OptiPlex 3060 Micro), dossier `/srv/docker/inventaire-surcouche`, URL publique `https://biblio.mathieuegardtest.fr`, branche déployée `feat/self-hosted-server`.
* **Architecture réseau impérative :** tout le trafic public passe par **Cloudflare Tunnel (`cloudflared`)** vers `127.0.0.1:8082` → port `3000` du conteneur `biblio-collection-app` (non-root `node`, `cap_drop: [ALL]`, `no-new-privileges`, `mem_limit: 512m`).
  * **Ne jamais** utiliser `docker-compose.yml` (Caddy) ni toucher aux ports `80`, `443` ou `8081` (`effectif_MAR`). Toujours utiliser `docker-compose.tunnel.yml`.
* **Données & Sauvegardes :** `/srv/docker/inventaire-surcouche/data/` (`biblio.sqlite` + `covers/`) monté sur `/data` (ignoré par Git). Sauvegarde quotidienne automatique à 03h00 (`sqlite3 .backup` + `.env` + `covers/`) vers Google Drive via `/srv/backups/backup-serveur.sh`.
* **Migrations SQL (`migrations/*.sql`) :** toujours créer de nouvelles migrations incrémentales (`0013+`) ; **ne jamais** modifier un fichier de migration déjà appliqué (`0001` à `0012`).
* **Zéro secret dans Git :** `JWT_SECRET`, `GEMINI_API_KEY`, `RESEND_API_KEY` et `VAPID_PRIVATE_JWK` vivent uniquement dans `/srv/docker/inventaire-surcouche/.env` sur le serveur (`format: raw`).
* **En-têtes PWA & Caméra (`server/index.ts`) :** préserver `Cache-Control: no-cache, no-store, must-revalidate` sur `/sw.js` et `/sw-push.js`, `Content-Type: application/manifest+json; charset=utf-8` sur `/manifest.webmanifest`, et `Permissions-Policy: camera=(self)`.
* **Procédure de mise à jour serveur :**
  1. `npx tsc --noEmit && npm run typecheck:server && npx vitest run`
  2. `git push origin feat/self-hosted-server`
  3. `ssh serveur "/srv/docker/inventaire-surcouche/deploy.sh"` (Wi-Fi local) ou `ssh serveur-vpn "/srv/docker/inventaire-surcouche/deploy.sh"` (via Tailscale VPN).

## 4. Contrôle Qualité avant Clôture ou Déploiement
* Exécuter systématiquement `npx tsc --noEmit`, `npm run typecheck:server` et `npx vitest run` après modification de code et rapporter uniquement les résultats réellement observés.
* Répondre en **français** avec des liens cliquables vers les fichiers modifiés.
