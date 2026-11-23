# Plan d’Exécution V2 — Feuille de Route par Jalons (`biblio-collection`)

> **Rôle de ce document :** Dérouler la construction **Clean Room** de la V2 en **8 jalons incrémentaux, testables et vérifiables**, en s’appuyant sur le Blueprint [`04_ARCHITECTURE_TECHNIQUE_V2.md`](./04_ARCHITECTURE_TECHNIQUE_V2.md) et en garantissant **100 % de bijection** avec les 52 fonctionnalités de [`03_MATRICE_BIJECTION_V1_V2.md`](./03_MATRICE_BIJECTION_V1_V2.md).
>
> **Règle de progression :** On ne passe jamais au jalon `N+1` tant que le jalon `N` n’a pas :
> 1. `npx tsc --noEmit` + `npm run typecheck:server` à **0 erreur**,
> 2. Toute la suite Vitest (unitaires + intégration SQLite `:memory:`) au vert,
> 3. Ses lignes correspondantes cochées (`☑`) dans `03_MATRICE_BIJECTION_V1_V2.md`.

---

## Stratégie Git & Environnement
1. La V1 en production reste intacte sur le tag `v1.0-archive` (base & couvertures archivées dans `/srv/docker/inventaire-surcouche/backups/v1-archive-2026-11-23/`).
2. La V2 est construite sur une branche dédiée **`v2`** (créée à partir de `HEAD`), sur laquelle on nettoie l'ancien `src/` / `functions/` / `wrangler.toml` pour installer l'arborescence propre `src/shared/`, `src/server/`, `src/client/`.
3. **Déploiement sur base vierge** uniquement au **Jalon 7** après recette complète en local (et ajout de `ADMIN_EMAIL` dans le `.env` du serveur).

---

## Jalon 0 — Socle Clean Room, `src/shared/`, `DatabaseAdapter` & Migrations SQLite

### Objectif
Poser les fondations saines (zéro dette V1, zéro vestige Cloudflare) et prouver que le schéma SQLite V2 complet s'applique et se teste en mémoire.

### Livrables
* **Nettoyage projet & stack :**
  * Création branche `v2` ; suppression de `wrangler`, `functions/`, `workers/`, `wrangler.toml`, `api/`, et des anciens fichiers V1.
  * Mise à jour `package.json` (`zod` + `@hono/zod-validator` ajoutés ; scripts `dev`, `build`, `start:server`, `typecheck`, `test`).
  * Configuration `tsconfig.json` (client + shared) et `tsconfig.server.json` (server + shared) interdisant tout import `server -> client`.
* **Couche `src/shared/` :**
  * Dictionnaire `locales/fr.ts` + helper typé `t()`.
  * Schémas Zod de base (`auth`, `book`, `library`, `series`, `social`, `jobs`, `sync`, `admin`) + types domaine.
  * Algorithmes purs portés et nettoyés depuis V1 (avec 0 import externe) : `isbn.util.ts`, `text-normalize.util.ts`, `intermarc-parser.ts` (InterMarc + UNIMARC avec filtrage `100$a`), `integral.util.ts`, `category-classifier.ts`, `batch-actions.util.ts`.
* **Couche `src/server/db/` :**
  * Interface `DatabaseAdapter` (SQL standard portable SQLite ↔ PostgreSQL) + `SqliteDatabaseAdapter` (`better-sqlite3` WAL, `foreign_keys = ON`, transactions).
  * `migrations/0001_v2_initial.sql` (les 25 tables propres + index).
  * `migrator.ts` incrémental strict (`schema_migrations`).

### Critères de validation (Tests Vitest obligatoires)
* Rejeu automatique des migrations `0001 → N` sur SQLite `:memory:` (vérifie toutes les tables, FK et contraintes `UNIQUE`).
* Tests unitaires complets sur `isbn.util`, `intermarc-parser` (BnF InterMarc + SUDOC UNIMARC sans `100$a`), `integral.util`, `batch-actions.util`.

---

## Jalon 1 — Authentification Stricte, Profil, Design System Multi-Thèmes & Coquille PWA

### Objectif
Avoir une application démarrable de bout en bout (serveur Hono + PWA Vue 3 + Pinia) avec comptes sécurisés, thèmes commutables, `i18n` 100 % centralisée et modales/toasts socles.

### Livrables
* **Backend (`auth`, `profile`, `middleware`) :**
  * `auth.middleware.ts` : cookie `HttpOnly; Secure; SameSite=Lax` strict (**zéro fallback `userUri`**) + `requireAdmin`.
  * `auth.service.ts` + `auth.routes.ts` : inscription (RGPD obligatoire, `?invite`, `?friend`, auto-admin via `ADMIN_EMAIL` dans `.env`), connexion, déconnexion, mot de passe oublié / reset 6 chiffres (Resend), édition profil, suppression compte sécurisée (mot de passe requis, promotion auto du membre le plus ancien en `owner` si foyer partagé, catalogue central intact).
  * `profile.routes.ts` : `GET/PATCH /api/me` (thème, locale, onboarding), `PUT /api/me/genres` (genres par défaut `user_id`).
* **Frontend (`styles`, `components/base`, `stores/auth`, `stores/ui`) :**
  * Design System CSS modulaire (`tokens.css` avec 3 thèmes `[data-theme="editorial-light" | "dark" | "warm"]`, `base.css`, `primitives.css`, `layouts.css`). **Zéro couleur ni texte en dur dans les `.vue`.**
  * Composants socles : `<BaseModal>`, `<ToastHost>`, `<AppHeader>` (nav desktop 6+2 + barre basse ergonomique mobile), `<PwaReloadPrompt>`.
  * Ergonomie transverse : directive/listener global d'auto-sélection du texte au focus (`main.ts`), installation PWA (`beforeinstallprompt` + astuce iOS).
  * Vues : `LoginView.vue`, `ProfileView.vue` (onglets *Compte & Thème*, *Genres par défaut*).

### Bijection couverte (`03_MATRICE_BIJECTION_V1_V2.md`)
* **`1.1` à `1.10`** (Auth, RGPD, liens invitation, reset mdp, profil, logout, suppression compte, PWA install/update, auto-select focus), **`2.1`** (Menu), **`8.2`** (Genres par défaut) + **Apports V2** (`ADMIN_EMAIL` auto-admin, multi-thèmes, succession `owner`).

### Critères de validation
* Tests d'intégration Hono + SQLite `:memory:` : rejet 401 sans cookie, auto-promotion `ADMIN_EMAIL`, suppression compte solo vs foyer partagé (succession `owner`, préservation catalogue).

---

## Jalon 2 — Moteur Bibliographique 3 Étages, Couvertures WebP & Worker Jobs Serveur

### Objectif
Construire le cœur serveur propre : résolution ISBN 3 étages, Tableau Comparatif, garde anti-collections poche, modèle Franchise → Découpage, stockage WebP disque et moteur générique `background_jobs`.

### Livrables
* **Connecteurs (`src/server/connectors/`) :**
  * `http-client.ts` (timeouts, throttle BnF, circuit-breaker Google Books 429, cache SQL `external_cache`).
  * `bnf.connector.ts` (**HTTP port 80** `http://catalogue.bnf.fr/api/SRU`), `sudoc.connector.ts` (UNIMARC), `inventaire.connector.ts`, `wikidata.connector.ts` (`P179`/`P1545`), `google-books.connector.ts`, `openlibrary.connector.ts`.
* **Moteur d'acquisition (`src/server/services/acquisition/`) :**
  * `comparison-table.service.ts` : collecte parallèle → remplissage du tableau comparatif normalisé champ par champ → arbitre déterministe.
  * `collection-guard.service.ts` : détection algorithmique anti-fausses séries (MARC `460` vs `225/410` + confrontation Œuvre/Édition + test hétérogénéité auteurs sans bloquer les séries anthologiques ancrées `P179`/`460`).
  * `series-graph.service.ts` : modèle **Franchise → Découpage** (fusion/séparation par contenu `Tome + Titre + Pagination`, jamais par libellé seul) + expansion par le graphe Wikidata/Inventaire d'abord (tomes créés même avant ISBN FR) + filet BnF `460$3`.
  * `ingestion.service.ts` : `POST /api/books/resolve-isbn` + respect strict `locked_fields` (Couche 2) et `overrides_json` (Couche 3).
* **Couvertures (`cover.service.ts` + `covers.routes.ts`) :**
  * Téléchargement unique → compression WebP (~15–35 Ko) → disque `/data/covers/` + table `covers` (zéro base64 SQLite) → `GET /api/covers/:coverKey` (`immutable`) + `POST /api/covers/upload`.
* **Jobs Serveur (`background-worker.ts` + `jobs.routes.ts`) :**
  * Dépileur continu `background_jobs` + reprise des jobs interrompus au démarrage + flux SSE `GET /api/jobs/stream` + store client global `jobs.store.ts`.

### Critères de validation
* Tests unitaires & intégration SQLite `:memory:` (avec connecteurs mockés) :
  * *Totem / Folio* rejetés algorithmiquement en collection sans liste en dur ; *Les Reines de sang* (anthologie ancrée) conservée.
  * *Astérix* + *Astérix, la grande collection* fusionnés en 1 découpage ; *Fables* (22 t.) vs *Fables Nomad* (10 t.) séparés en 2 découpages d'une même Franchise.
  * *Tintin / Spirou* : expansion par le graphe Wikidata/Inventaire créant les tomes officiels même multi-auteurs.
  * Primauté : un champ dans `locked_fields` (Couche 2) ou `overrides_json` (Couche 3) n'est jamais écrasé par un ré-enrichissement.

---

## Jalon 3 — Bibliothèque, Sync Offline (`PUSH → PULL`), Wishlist, Prêts & Actions par Lot

### Objectif
Rendre la consultation quotidienne et la gestion de la collection 100 % opérationnelles (en ligne et hors-ligne), rapides et fiables.

### Livrables
* **Sync & Cache Local (`sync.service.ts` + `indexeddb.ts` + `sync-engine.ts`) :**
  * `POST /api/sync/push` (applique `outbox` datée en priorité) + `GET /api/sync/pull?since=...` (delta compact sans images base64).
  * Service Worker PWA (`vite-plugin-pwa`) configuré en `CacheFirst` sur `/api/covers/*`.
  * Détection offline, bannière globale, scans hors-ligne mémorisés et reprise automatique à la reconnexion.
* **Backend & Stores (`library`, `loans`, `library.store.ts`) :**
  * Routes `/api/library/*` et `/api/loans/*`, contacts emprunteurs + amis.
* **Vues & Modales :**
  * `DashboardView.vue` (4 cartes compteurs + aperçus couvertures + scans hors-ligne mémorisés).
  * `CollectionView.vue` (onglets *Livres / Séries / One-shots*, filtre libre à suggestions dynamiques, tris, pagination, mémoire d'état & scroll).
  * `WishlistView.vue` (groupée Séries puis Indépendants, filtres Genre/Auteur, badge *Souhaité par \<Prénom\>*).
  * `LoansView.vue` (onglets *Par emprunteur* en accordéons et *Chronologique*).
  * `BatchActionBar.vue` (sélection mixte intelligente), `ConfirmDeleteModal.vue` (**confirmation obligatoire sur toute suppression + choix individuel pour chaque livre prêté**), `LendModal.vue`, `BatchGenreModal.vue`, `DebugCacheView.vue`.

### Bijection couverte
* **`2.2` à `2.4`** (Dashboard, offline/reprise, scans mémorisés), **`3.1` à `3.8`** (Collection, filtres/tris, Wishlist, Prêts, Lend/Return, Sélection multiple, Batch genres), **`8.6`** (Debug cache local) + **Apport V2** (choix individuel livres prêtés à la suppression, sync `PUSH` → `PULL`, zéro base64 IndexedDB).

### Critères de validation
* Tests d'intégration `sync`: un achat fait hors-ligne (`outbox`) n'est jamais écrasé par un `pull` ; en conflit simultané entre 2 membres sur le même champ, le timestamp le plus récent gagne.
* Test suppression par lot mixte (3 non prêtés + 2 prêtés).

---

## Jalon 4 — Fiche Livre, Primauté Utilisateur (Couche 3), Édition, Intégrales & Création Manuelle

### Objectif
Offrir une gestion complète, souveraine et fiable de chaque fiche ouvrage, de ses couvertures, de ses intégrales et de la lecture individuelle.

### Livrables
* **Backend (`books.routes.ts`, `library.routes.ts`, `reading.routes.ts`) :**
  * `GET /api/books/:bookId` (fusion `Couche 3 > Couche 2 > Couche 1`), `PATCH /api/library/books/:bookId` (surcharge Couche 3), `DELETE /api/library/books/:bookId/overrides` (*Réinitialiser avec les données automatiques*), `GET /api/books/:bookId/covers` (galerie dédupliquée), `POST /api/books/manual` (`source_origin = 'manual'`).
  * `PUT /api/reading/:bookId` (`user_reading_states`, strictement isolé par `user_id`).
* **Frontend :**
  * `BookDetailView.vue` (flèches `<` / `>`, bandeau statut, liens cliquables Série & Auteurs, bloc lecture/note/notes perso individuel, `BookActions`, modale Intégrale, exclusion série).
  * `BookEditView.vue` (édition complète, checkbox *Pas de série*, `IntegralFields`, gestion genres + *+ Aux genres par défaut*, `CoverPicker` avec galerie dédupliquée et upload photo WebP, bouton *Réinitialiser*).
  * `BookCreateView.vue` (pré-remplissage serveur sur ISBN inconnu, création manuelle propre sans Inventaire.io, expansion série optionnelle).

### Bijection couverte
* **`4.7`** (Création manuelle ISBN inconnu), **`5.1` à `5.6`** (Fiche livre & nav sœur, Lecture/Notes individuelles, Actions unitaires, Édition complète, Galerie couvertures & WebP, Intégrales bidirectionnelles).

### Critères de validation
* Tests d'intégration : 2 membres du même foyer ont des statuts de lecture et notes indépendants ; la couverture choisie en Couche 3 reste prioritaire dans les listes de séries et survit à un ré-enrichissement.

---

## Jalon 5 — Acquisition Complète : Scan Simple, Rafale, Photo IA 100 % Serveur & Recherche Catalogue

### Objectif
Rendre tous les canaux d'entrée rapides, résilients et continus entre appareils (notamment la Photo IA et ses relances BnF 100 % côté serveur).

### Livrables
* **Backend (`photo-ai.service.ts`, `search.service.ts`, `jobs.routes.ts`, `search.routes.ts`) :**
  * `POST /api/jobs/photo` : OCR Gemini (clé serveur + quota mensuel `user_ai_usage`, terme *BYOK* supprimé) + Canal 3 serveur + statut possession.
  * `PATCH /api/jobs/photo/:jobId/items/:itemId` : persistance serveur des choix d'arbitrage (sélection, édition choisie, intégrale, ignoré) → continuité mobile ↔ ordinateur.
  * `POST /api/jobs/photo/:jobId/items/:itemId/retry-bnf` : relance BnF manuelle exécutée **sur le serveur** (ne plante jamais si on change d'onglet).
  * `POST /api/jobs/photo/:jobId/commit` : validation du lot vers Collection / Wishlist.
  * `POST /api/search/catalog` : recherche exhaustive locale SQLite (`books` + `book_editions` + `series` — zéro bug SQL) + BnF + Inventaire → `{ series[], books[] }`.
* **Frontend :**
  * `CameraBarcodeModal.vue` (détection rapide, mode Rafale 0 ms + vibration haptique + flash vert/orange, mode picker ISBN).
  * `ScanView.vue` (4 onglets : *Photo IA* avec bandeau global concis dans `App.vue`, *Rafale*, *Scan simple* ouvrant directement la fiche, *Recherche textuelle* persistante avec 7 champs et résultats groupés Séries + Œuvres).
  * `PhotoItemModal.vue` (zoom tactile/molette 100%–450%, choix édition, intégrale, bouton explicite *Ce n’est pas la bonne référence / Je ne trouve pas mon livre* ouvrant la sous-modale à 6 champs vides + caméra ISBN).

### Bijection couverte
* **`4.1` à `4.6`** (Scan simple, Rafale, Photo IA serveur + quota, Arbitrage + zoom, Correction manuelle BnF, Recherche textuelle exhaustive persistante) + **Apport V2** (continuité Photo IA & relance BnF multi-appareils 100 % serveur).

### Critères de validation
* Tests d'intégration `photo-ai` (quota mensuel, arbitrage serveur, relance BnF persistée) et `search/catalog` (retourne bien les séries et livres locaux + externes).

---

## Jalon 6 — Séries (Franchises/Découpages), Auteurs, Nouveautés & CRON Calendaire

### Objectif
Boucler toute la logique de suivi de séries, découverte de nouveautés et notifications automatisées.

### Livrables
* **Backend (`series.routes.ts`, `notifications.routes.ts`, `cron-scheduler.ts`) :**
  * `GET /api/series/:seriesId` (tomes du découpage + lien vers autres découpages de la Franchise), `POST /api/series/:seriesId/expand` (enrichissement immédiat par le Graphe puis BnF + bilan réel), `POST /api/series/attach` (rattachement/fusion Couche 3), `POST /api/series/:seriesId/exclude`.
  * `GET /api/authors/:name`, `GET /api/releases`, `POST /api/releases/check`, `POST /api/releases/dismiss`.
  * `GET/PUT /api/notifications/prefs`, `POST/DELETE /api/notifications/push` (VAPID).
  * `cron-scheduler.ts` idempotent sur `cron_runs` : digests horaires (Web Push + Resend selon fuseau), passe nocturne (veille nouveautés, éditions sœurs, purge logs TTL, purge `/data/covers/` orphelins > 30 jours), avec rattrapage après redémarrage.
* **Frontend :**
  * `SeriesDetailView.vue` (filtres *Tout / Possédés / Non possédés*, enrichissement à la demande avec compteur réel, encart *Autres découpages de la saga*, `SeriesAttachModal`, exclusion, `BatchActionBar`).
  * `AuthorDetailView.vue` (Séries + Œuvres), `ReleasesView.vue` (tris date/alpha, *Vérifier*, *Tout masquer*, ajout lot).
  * `NotificationOnboardingModal.vue` + onglet *Notifications* dans `ProfileView.vue`.

### Bijection couverte
* **`6.1` à `6.7`** (Fiche série, Enrichir/Actualiser, Rattacher/Fusionner, Exclure tome, Profil Auteur, Nouveautés, Notifications Push/E-mail), **`8.7`** (CRON automatique serveur) + **Apport V2** (`cron_runs` idempotent + purge orphelins `/data/covers/`).

### Critères de validation
* Tests d'intégration CRON : idempotence `cron_runs`, détection de nouveauté sans faux positif sur un livre déjà possédé (y compris via intégrale), purge des couvertures orphelines > 30j sans supprimer les couvertures référencées.

---

## Jalon 7 — Social (Foyer, Amis, Cadeaux Anti-Spoiler), Stats, Export, Admin & Mise en Production

### Objectif
Finaliser le périmètre complet, vérifier les 52 lignes de la matrice de bijection, puis déployer la V2 proprement sur le serveur Debian.

### Livrables
* **Social (`social.service.ts`, `social.routes.ts`, `SocialView.vue`, `PublicShareView.vue`) :**
  * Foyer : QR Code, code `FAM-...`, liste membres (`owner`), rejoindre un foyer, régénération de code.
  * Amis : accès strictement via QR Code / code `PUB-...` / lien (régénérable), ajout/retrait ami, vitrine lecture seule (`SharedLibraryBrowser` : Collection, Wishlist, Prêtés sans nom d'emprunteur).
  * **Réservation Cadeau anti-spoiler :** `POST/DELETE /api/social/share/:token/reserve/:bookId` — bouton *« Je l’offre »* pour les amis, badge *« Déjà réservé par un proche »* pour les autres amis, **100 % masqué côté API pour le propriétaire et son foyer**, purgé automatiquement quand le livre passe en *Possédé*.
* **Statistiques & Export (`stats-export.service.ts`, `ProfileView.vue`) :**
  * `GET /api/stats?periodDays=...` (4 KPIs cliquables, activité, lecture/notes individuelles, pages, Tops 10 cliquables, prêts actifs).
  * `GET /api/me/export?format=csv|json` + boutons d'export dans *Mon Profil*.
* **Console Admin (`admin.service.ts`, `admin.routes.ts`, `AdminView.vue`) :**
  * Séparation stricte Moi ≠ Admin (100 % via `/admin`).
  * Vue d'ensemble, Catalogue Maître unitaire & modification par lot (inscrit `locked_fields` Couche 2), Comptes & RAZ quota IA, Maintenance CRON manuelle, Logs Pipeline V4 (filtres, export JSON, purge TTL).
* **Déploiement & Exploitation :**
  * Mise à jour `deploy.sh` (sauvegarde automatique SQLite avant migration), ajout `ADMIN_EMAIL` dans `/srv/docker/inventaire-surcouche/.env`, `Dockerfile` + `docker-compose.tunnel.yml` vérifiés (port `127.0.0.1:8082:3000`, `mem_limit: 512m`, en-têtes PWA & caméra).
  * Recette terrain sur base vierge V2 (`https://biblio.mathieuegardtest.fr`).

### Bijection couverte
* **`7.1` à `7.3`** (Foyer, Amis, Vitrine), **`8.1`**, **`8.3` à `8.5`** (Stats, Admin Vue d'ensemble/Comptes, Admin Catalogue Maître unitaire & lot, Logs Pipeline) + **Apports V2** (Réservation Cadeau anti-spoiler, Régénération liens/codes, Export CSV/JSON).

### Critères de validation
* Test sécurité critique : `GET /api/me`, `GET /api/sync/pull`, `GET /api/books/:id` et `GET /api/social/share/:token` appelés par un membre du foyer ne contiennent **jamais** `wishlist_reservations` ; un ami hors foyer voit bien la réservation ; passage en `owned` supprime la réservation.
* **100 % des 52 cases cochées (`☑`)** dans `03_MATRICE_BIJECTION_V1_V2.md`, `0` erreur TypeScript, `100 %` Vitest vert.

---

## Preuve de Couverture Bijective (52 / 52 Fonctions V1 + Apports V2)

| Jalon | Lignes de `03_MATRICE_BIJECTION_V1_V2.md` couvertes | Nombre | Nouveautés V2 incluses |
| :--- | :--- | :-: | :--- |
| **Jalon 0** | Socle technique transverse (prérequis de toutes les lignes) | — | Clean Room `shared`/`server`/`client`, `DatabaseAdapter`, SQLite WAL, Zod, `i18n` |
| **Jalon 1** | `1.1`, `1.2`, `1.3`, `1.4`, `1.5`, `1.6`, `1.7`, `1.8`, `1.9`, `1.10`, `2.1`, `8.2` | **12** | Cookie `HttpOnly` strict, `ADMIN_EMAIL`, succession `owner`, Multi-thèmes Design Tokens, `<BaseModal>`, `<ToastHost>` |
| **Jalon 2** | Socle métier de `4.1`, `4.6`, `4.7`, `5.5`, `6.2`, `8.7` | — | Tableau comparatif, Anti-fausses séries algorithmique, Franchise → Découpage, Graphe Wikidata/Inventaire d'abord, WebP disque uniquement, `background_jobs` + SSE |
| **Jalon 3** | `2.2`, `2.3`, `2.4`, `3.1`, `3.2`, `3.3`, `3.4`, `3.5`, `3.6`, `3.7`, `3.8`, `8.6` | **12** | Sync `PUSH → PULL`, Cache API PWA (0 base64 IndexedDB), confirmation suppression + choix individuel livres prêtés |
| **Jalon 4** | `4.7`, `5.1`, `5.2`, `5.3`, `5.4`, `5.5`, `5.6` | **7** | Primauté Couche 3 + bouton *Réinitialiser*, création manuelle pure sans Inventaire.io |
| **Jalon 5** | `4.1`, `4.2`, `4.3`, `4.4`, `4.5`, `4.6` | **6** | Photo IA + arbitrage + relance BnF 100 % serveur multi-appareils, recherche catalogue SQLite sans bug |
| **Jalon 6** | `6.1`, `6.2`, `6.3`, `6.4`, `6.5`, `6.6`, `6.7`, `8.7` | **8** | Navigation inter-découpages d'une Franchise, `cron_runs` idempotent, purge orphelins `/data/covers/` |
| **Jalon 7** | `7.1`, `7.2`, `7.3`, `8.1`, `8.3`, `8.4`, `8.5` | **7** | Réservation Cadeau anti-spoiler, régénération codes partage, Export CSV/JSON, `locked_fields` Admin Couche 2 |
| **TOTAL** | **Toutes les lignes `1.1` à `8.7` sans exception** | **52 / 52 (100 %)** | **100 % des arbitrages CEO/CTO couverts** |
