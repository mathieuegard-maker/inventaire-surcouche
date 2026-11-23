# Cartographie Exhaustive de l’Application — Préparation Architecture V2

> **Objectif :** Disposer d’une vision complète, factuelle et organisée de **tout ce que fait l’application aujourd’hui** (`inventaire-surcouche`), de la façon dont chaque écran s’enchaîne avec le client, les API et la base SQLite, et de l’endroit exact où se trouvent les doublons et couplages hérités de la cohabitation **V2 (D1 / Inventaire.io / IndexedDB-first)** ↔ **V4 (FRBR / SQLite-first)**.

---

## 1. Pourquoi le code actuel est devenu complexe (Diagnostic en 4 points)

1. **Deux modèles de données parallèles en production :**
   - **Modèle V2/V3 (hérité Inventaire.io / Wikidata)** : `catalog_entities` + `library_items` + `lists` virtuelles + `shelves` + `loans`, manipulés via `queueService`, `inventoryService`, `wishlistService`, `loanService`, `entityResolver`, `inventaireSyncService`, `backgroundCreationOrchestrator`.
   - **Modèle V4 (FRBR SQLite)** : `books` + `book_isbn_index` + `v4_series` + `v4_library_books` + `enrichment_queue`, manipulés via `v4-client.service.ts` et `src/core/services/v4/*`.
   - Conséquence : la plupart des opérations écrivent dans les **deux** systèmes (double-écriture `linkBookToLibrary`, double synchro au démarrage dans `syncOrchestrator.hydrateCacheInBackground()`, déduplication multi-clés `bookId || workUri || isbn13 || uri` dans `stats.service.ts`).
2. **Deux routeurs API concurrents :**
   - `/api/gateway?action=...` (~40 actions RPC héritées du proxy Cloudflare/Inventaire + 5 proxys externes).
   - `/api/v2/*` (23 routes REST plus récentes pour V4, Photo IA, recherche catalogue, préférences).
3. **Logique métier dupliquée entre Client et Serveur :**
   - Résolution ISBN externe (`external-metadata.service.ts` côté client vs `v4-layer3-discovery.ts` côté serveur).
   - Résolution Photo IA / Canal 3 (`photo-book-resolution.service.ts` côté client vs `canal3-resolver.service.ts` côté serveur).
   - Parsing InterMarc BnF (`parseIntermarcRecord` dans `bnf.resolver.ts` vs `extractMarcRecordMetadata` dans `v4-layer3-discovery.ts`).
4. **Couplages transversaux :**
   - Dépendance circulaire `bnf.resolver.ts` ↔ `series-canonical.resolver.ts`.
   - `bnf.resolver.ts` importe `fetchWithTimeout` depuis le store client `src/state/connection.ts`, ce qui force tous les modules serveur V4 qui l’importent à embarquer du code client.

---

## 2. Inventaire complet des Fonctions Métier (par Domaine)

| Domaine | Fonctions métier assurées par l'application |
| :--- | :--- |
| **1. Authentification, Compte & Profil** | Connexion / Inscription (acceptation RGPD obligatoire + e-mail de récupération), mot de passe oublié / réinitialisation par code e-mail (Resend), gestion profil (pseudo, e-mail, mot de passe), déconnexion, suppression de compte sécurisée (supprime le foyer si solo, préserve le foyer partagé, ne touche jamais au catalogue central), onboarding notifications, installation PWA, statut admin. |
| **2. Bibliothèque, Wishlist & Prêts** | Consultation Collection (vues *Livres*, *Séries*, *One-shots*, filtres libres, tri, pagination persistante), Wishlist groupée par séries + auteur du souhait (`wished_by_user_id`), Prêts (carnet par emprunteur ou chronologique, autocomplétion contacts + amis), sélection multiple intelligente (sous-ensembles éligibles par action) + actions par lot (ajout collection/wishlist, prêt, retour, suppression avec confirmation, rattachement série, ajout de genres). |
| **3. Acquisition (Scan, Photo IA, Saisie)** | **Scan simple** (caméra EAN-13 -> ouverture directe fiche livre avec statut possédé/non possédé), **Mode Rafale** (capture instantanée 0 ms + vibration haptique + file locale/V4), **Saisie hors-ligne** (`pendingScansStore` repris à la reconnexion), **Photo IA** (étagère complète ou couverture via Gemini Vision côté serveur + suivi quota mensuel `user_ai_usage` + arbitrage Sûrs / Doutes / Non identifiés / Autres tomes de la série + relance BnF ciblée avec éditeur/ISBN), **Création manuelle d'un ISBN inconnu**. |
| **4. Recherche** | **Recherche textuelle multi-critères** (`/scan?mode=search`) interrogeant le catalogue local + BnF + Inventaire.io avec regroupement **Séries** + **Œuvres** et état persistant en mémoire ; **Recherche locale rapide** (passes Canal 3). |
| **5. Fiche Livre, Édition & Intégrales** | Consultation fiche détaillée (navigation Précédent/Suivant dans la liste d'origine, contexte série et tomes manquants, statut **Lu/À lire/En cours** + note 0-5 + notes perso **strictement individuels par `user_id`**), édition complète des métadonnées (surcharge privée Option B par foyer), gestion des **Intégrales** (déclaration tomes inclus, détection bidirectionnelle *« Dans intégrale »* / *« Couvre X tomes possédés »*), galerie de couvertures multi-sources dédupliquée + upload WebP, gestion des genres + genres par défaut utilisateur. |
| **6. Séries, Enrichissement & Nouveautés** | Fiche série complète (tomes possédés, dans intégrale, ou manquants), filtrage *Tout / Possédés / Non possédés*, enrichissement à la demande (*Enrichir la série maintenant* via BnF `460$3` / CQL / SUDOC / Wikidata), exclusion privée d’un tome (`Option B`), fusion/rattachement de série, détection centralisée des **Nouveautés** (CRON nocturne) + alertes in-app + digests **Web Push** (VAPID) et **E-mail** (horaires/hebdo/mensuels selon fuseau). |
| **7. Social, Foyer & Amis** | Invitation et rattachement à un **Foyer partagé** (code d’invitation, bibliothèque commune), gestion des **Amis** (ajout par code `PUB-...` ou QR code), consultation en lecture seule de la bibliothèque d’un ami (Collection, Wishlist, Prêtés sans nom d'emprunteur) via `/family` ou lien public `/shared/:token`. |
| **8. Statistiques & Administration** | Tableau de bord KPIs & graphiques interactifs cliquables (Collection, Séries, Prêts, Lecture, Pages, Top Genres/Auteurs/Éditeurs sur période), Console **Admin** (vue d'ensemble, exploration/édition unitaire et en lot du catalogue maître, gestion utilisateurs & quotas IA, déclenchement sweep nouveautés/réhydratation, consultation/export/purge des `pipeline_logs` V4), Debug IndexedDB (`/debug`). |

---

## 3. Cartographie des Workflows UX (Bout-en-Bout)

Chaque workflow ci-dessous trace la chaîne complète :
**`Vue / Composant`** → **`Store / Orchestrateur / Service Client`** → **`Route API`** → **`Backend / SQL / Sources Externes`**.

### Workflow 1 : Démarrage, Auth & Synchronisation
1. **Démarrage (`App.vue` + `router/index.ts`)**
   → `connectionService.initializeApp()` (`connection.orchestrator.ts`)
   → Vérifie session (`userService.fetchProfile` → `/api/gateway?action=user-get` → `users`, `libraries`, `share_tokens`)
   → Charge registres V2 (`inventoryService.loadLibrary`, `wishlistService.loadWishlist`, `loanService.sync` → `/api/gateway?action=inventory-list|lists-*|shelves`)
   → Lance en fond `syncOrchestrator.hydrateCacheInBackground()` :
     - **Voie V4** : `syncV4BooksToIndexedDb()` → `GET /api/v2/books/sync` → `books` + `v4_library_books` + `v4_series` → écrit `cache_books`, `book_isbn_index`, `inventory`, `wishlist` dans IndexedDB.
     - **Voie V2 résiduelle** : pour les fiches sans `bookId` V4 → `workUriResolver.resolveBulk` → `entityResolver` → `entityHumanizer` → `correctPoorlyHumanizedBooks()`.
   → `userService.syncAllUserReadingStatuses()` → `GET /api/v2/reading-status` → `reading_statuses` → `localStorage`.
   → `seriesReleaseService.checkNewReleasesOnOpen()` → `/api/gateway?action=series-check-releases` → `series_release_alerts`.

### Workflow 2 : Scan Code-Barres (Simple & Rafale)
1. **Capture caméra (`CameraBarcodeModal.vue` / `ScanView.vue`)**
   → `barcodeIsbnProvider` lit l’EAN-13.
   - **En mode Rafale** : `handleInstantBurstCapture()` (`scanner.ts`) émet vibration + flash immédiat et pousse dans `burstBooks`, puis appelle `searchService.searchByIsbn(isbn)` en parallèle.
   - **En mode Simple** : `scannerState` appelle `searchService.searchByIsbn(isbn)` et redirige directement vers `/book/isbn:<isbn>`.
   - **Si hors-ligne** : enregistre dans `pendingScansStore` (`localStorage`), repris à la reconnexion.
2. **Résolution (`search.orchestrator.ts` → `searchByIsbn`)**
   - Étape 1 (Local-First) : `databaseService.getBookByIsbn()` (via `book_isbn_index` IndexedDB).
   - Étape 2 (V4 Serveur) : `ingestIsbnsViaV4([isbn], { action: 'preview' })` → `POST /api/v2/books/ingest` → `runV4IngestionPipeline` (C1 normalisation presse `330/378/977` → C2 index O(1) `book_isbn_index` → C3 découverte parallèle **BnF HTTP + SUDOC + Inventaire + GB + OL + Wikidata** → C4 consolidation FRBR `books` + `v4_series` → C5 squelette série + `enrichment_queue`).
   - Étape 3 (Repli V2 si V4 échoue) : `entityResolver.resolvePhysicalEntity` (`/api/gateway?action=entities-by-uris`) → puis `externalMetadataService.fetchFromExternalSources` (`bnfResolver` → `openLibraryResolver` → `googleBooksResolver`).
3. **Ajout Collection / Wishlist depuis la liste (`useBookBatchActions.ts` / `BookActionButtons.vue`)**
   - **Point de friction actuel (doublon V2/V4)** :
     - Depuis `ScanView` (`useBookBatchActions`), si le livre a un `bookId` ou ISBN, l'ajout passe par `ingestIsbnsViaV4(..., action: 'owned'|'wishlist')` + écriture directe `databaseService.addRegistryEntry` + `saveBookToCache`.
     - Depuis `BookDetailView` ou `CollectionView` (`BookActionButtons` / `BatchActionBar`), l'ajout/suppression/prêt passe par `queueService.enqueueAction()` (`pending_actions` IndexedDB) → `inventoryService` / `wishlistService` / `loanService` → `/api/gateway?action=inventory-add|bulk|delete`, `lists-*`, `shelves` → écrit dans `library_items`/`loans` puis pont `syncV4LibraryBookFlag` vers `v4_library_books` !

### Workflow 3 : Photo IA (Étagère ou Couverture)
1. **Envoi photo (`ScanView.vue`)**
   → `byokVisionService.compressForMode()` (WebP haute résolution)
   → `photoBatchQueueService.enqueuePhotos()`
   → `POST /api/v2/photo-jobs` → `createPhotoScanJob()` (`photo-scan-jobs.service.ts`) stocke dans `photo_scan_jobs`.
2. **Traitement asynchrone serveur (`processPhotoScanJob`)**
   → Vérifie `user_ai_usage` → appelle **Gemini Vision** (`PREFERRED_GEMINI_MODELS`) → extrait `candidates[]` (titre, série, tome, auteur, éditeur, texte brut tranche).
   → Pour chaque tranche : appelle `resolveBookHintsCanal3()` (`canal3-resolver.service.ts`) :
     - Passe 1 locale (`searchLocalBooksForCanal3` sur `books` + `v4_series`).
     - Passe 2 multi-source (`searchBnfServerByHints` HTTP + `OpenLibrary` + `GoogleBooks`) → `rankCanal3Consensus()` (`canal3-consensus.ts`).
   → Vérifie possession dans `v4_library_books` (`checkBookIndexLayer2`).
   → Met à jour `photo_scan_jobs.result_json` (`detectedItems`, `doubtItems`, `unresolvedItems`).
3. **Suivi UI & Arbitrage (`App.vue` + `ScanView.vue` + `PhotoItemDetailModal.vue`)**
   - `photoBatchQueueService` polle `GET /api/v2/photo-jobs` toutes les 3s et met à jour le bandeau global dans `App.vue`.
   - `ScanView.vue` synchronise les résultats dans `scanDraftStore` (`localStorage`).
   - **Relance BnF manuelle / « Je ne trouve pas mon livre » (`PhotoItemDetailModal.vue` → `ScanView.vue`)** :
     Appelle `photoBookResolutionService.resolveSingleCandidate()` côté **client** → `POST /api/v2/books/resolve-hints` (avec repli client `discoverConsensusByHints`) → met à jour uniquement les refs locales de `ScanView.vue` (non persisté dans `photo_scan_jobs`).

### Workflow 4 : Recherche Textuelle & Catalogue
1. **Formulaire multi-critères (`ScanTextSearchTab.vue` + `textSearchState.ts`)**
   → Appelle `POST /api/v2/books/search-catalog` → `searchCatalogExhaustive()` (`catalog-search.service.ts`).
   → Passe 1 locale (`v4_series` + `books` — *avec anomalie SQL sur `books` lignes 318-333 qui échoue silencieusement*) + Passe 2 externe (`BnF SRU` + `Inventaire.io /api/search?types=series`).
   → Retourne `{ series[], books[] }` affichés séparément et conservés dans `textSearchState`.
2. **Ancien moteur (`SearchResultView.vue` + `keywordSearchService`)** :
   - Vue quasi-orpheline (plus aucun lien UI vers `/search-results`), mais `keywordSearchService` reste dans `src/core/services/`.

### Workflow 5 : Fiche Livre, Édition, Couvertures & Intégrales
1. **Affichage (`BookDetailView.vue`)**
   → Lit IndexedDB (`databaseService`) ; si absent et ISBN valide, résout via `searchService.searchByIsbn()`.
   → Statut de lecture / note / notes perso : `userService.fetchReadingStatus` & `saveReadingStatus` → `GET/PUT /api/v2/reading-status` → `reading_statuses` (scopé `user_id`).
   → Déclaration Intégrale (`IntegralConfigFields.vue`) → `transformBookIntegralStatus()` (`integral.service.ts`) → `PATCH /api/v2/books/update` → `updateV4BookMetadata()` (`v4_library_books.custom_overrides_json` + recalcul couverture intégrale ↔ tomes).
2. **Édition complète (`BookEdit.vue`)**
   → Charge couvertures alternatives via `/api/gateway?action=work-edition-covers` (cache `books.editions_catalog_json` ou moissonnage BnF/OL/GB/Inventaire/Wikidata), déduplique (`cover-dedup.util.ts`), ou compresse un upload WebP (`webp-compressor.util.ts`) uploadé via `PUT /api/v2/covers/*` / `/api/gateway?action=cover-store`.
   → Validation : `bookSemanticOrchestrator.saveEditedBook()` → `PATCH /api/v2/books/update` (Option B dans `v4_library_books` + propagation genres sur tomes frères) avec repli V2 `inventaireSyncService.patchBookOnInventaire`.
   → Ajout de genres par défaut : `userService.updateDefaultGenres()` → `POST /api/v2/user-genres` → `user_default_genres`.
3. **Création manuelle (`BookCreateUnknown.vue`)**
   → `bookSemanticOrchestrator.analyzeDuplicates()` + `saveCreatedBook()` + `backgroundCreationOrchestrator.enqueueBookCreation()` → passe encore 100% par le pipeline **legacy V2** (`inventaireSyncService` + `catalog_entities`).

### Workflow 6 : Séries, Enrichissement & Alertes Nouveautés
1. **Ouverture / Enrichissement série (`SeriesView.vue`)**
   → `seriesOrchestrator.getCompleteSeriesForUI()` lit IndexedDB et déduplique œuvres + intégrales.
   → En parallèle ou au clic sur **« Enrichir la série maintenant »** : `fetchV4SeriesBooksToIndexedDb(seriesId, { force: true })` → `GET /api/v2/books/series/:seriesId?force=1` → `getV4SeriesBooks()` + `enqueueOrExpandSeriesLayer5()` (BnF `bib.ens2bib` + CQL) + `drainEnrichmentQueueBatch()`.
   → Exclusion d'un tome (`Option B`) : `seriesOrchestrator.excludeTomesFromSeries()` → `POST /api/v2/books/exclude-from-series` → `v4_library_books`.
   → Fusion / Rattachement (`SeriesMergeModal.vue`) : `/api/gateway?action=series-merge` → met à jour `v4_series`, `books`, `v4_library_books`.
2. **CRON Nouveautés & Notifications (`server/scheduler.ts`)**
   → **Passe nocturne (02h00)** : `runCentralizedSeriesReleaseSweep()` (`series-digest.service.ts`) balaye les séries V2 (`catalog_entities`) et V4 (`v4_series` + `books`) et crée les alertes dans `series_release_alerts`.
   → **Passe horaire** : `drainEnrichmentQueueBatch(15)` + `runHourlyDigestDispatch()` (envoie Web Push via `web-push.service.ts` et/ou e-mails via Resend) + `purgeOldPipelineLogs()`.

### Workflow 7 : Partage Foyer, Amis & Admin
1. **Foyer & Amis (`FamilyShareView.vue`, `FamilySharePanel.vue`, `FriendsView.vue`, `PublicShareView.vue`)**
   → `userService` → `/api/gateway?action=family-join`, `friends-list`, `friends-add`, `friends-remove`, `public-share-get`.
   → `SharedLibraryBrowser.vue` affiche Collection, Wishlist et Prêtés (sans nom d’emprunteur).
2. **Console Admin (`AdminView.vue`)**
   → `userService` → `/api/gateway?action=admin-overview`, `admin-catalog-list`, `admin-catalog-update`, `admin-catalog-bulk-update`, `admin-users-list`, `admin-reset-user-ai-quota`, `admin-run-release-sweep`, `admin-pipeline-logs`, `admin-pipeline-logs-purge`.

---

## 4. Inventaire complet des Couches Techniques

### A. Frontend — 20 Vues, 8 Stores, 3 Composables
- **Vues actives (17)** : `LoginView`, `DashboardView`, `CollectionView`, `WishlistView`, `LoansView`, `ReleasesView`, `SeriesView`, `AuthorView`, `BookDetailView`, `BookEdit`, `BookCreateUnknown`, `ScanView`, `ProfileView`, `FamilyShareView`, `PublicShareView`, `AdminView`, `DebugDbView`.
- **Vues embarquées uniquement (2)** : `StatsView` (dans `ProfileView`), `FriendsView` (dans `FamilyShareView`).
- **Vue obsolète / quasi-orpheline (1)** : `SearchResultView` (+ composant `SmartSearchBar.vue`).
- **Composants orphelins (0 référence active)** : `BaseInput.vue`, `BookResultCard.vue`, `SelectableBookList.vue`, `WelcomeModal.vue`.
- **Stores (`src/state/`)** : `session.ts`, `connection.ts`, `scanner.ts`, `scanDraft.ts`, `textSearchState.ts`, `pendingScans.ts`, `viewState.ts`, `bookNavigation.ts`.
- **Composables (`src/ui/composables/`)** : `useBookBatchActions.ts`, `useModalScrollable.ts`, `useSemanticResolution.ts`.

### B. Client Core — IndexedDB, Orchestrateurs, Resolvers & Services
- **IndexedDB (`database.service.ts`, Dexie v7)** : 8 tables (`inventory`, `wishlist`, `cache_books`, `loans`, `pending_actions`, `pending_creations`, `photo_scan_jobs`, `book_isbn_index`).
- **Orchestrateurs (7)** : `connection.orchestrator`, `sync.orchestrator`, `search.orchestrator`, `series.orchestrator`, `queue.orchestrator` *(100% V2)*, `book-semantic.orchestrator` *(Hybride)*, `background-creation.orchestrator` *(100% V2)*.
- **Resolvers (9)** : `bnf.resolver` *(transversal)*, `series-canonical.resolver` *(transversal)*, `googlebooks.resolver`, `openlibrary.resolver`, et **5 resolvers 100% legacy V2** (`entity.resolver`, `mapper`, `humanizer`, `series.resolver`, `workUri.resolver`).
- **Services Client (19 fichiers dans `src/core/services/`)** :
  - **V4 purs** : `v4-client.service.ts`, `integral.service.ts`, `photo-batch-queue.service.ts`.
  - **Transversaux / Hybrides** : `user.service.ts`, `stats.service.ts`, `book-cache.service.ts`, `image.service.ts`, `byok-vision.service.ts`, `photo-book-resolution.service.ts`, `keyword-search.service.ts`, `series-release.service.ts`.
  - **Legacy V2** : `inventory.service.ts`, `wishlist.service.ts`, `loan.service.ts`, `external-metadata.service.ts`, `inventaire-sync.service.ts`, `work-edition-harvester.service.ts`, `config.service.ts`.

### C. Backend — Routeurs HTTP, Services Serveur & Adaptateurs
- **Serveur (`server/`)** : `index.ts` (Hono), `scheduler.ts` (CRON horaire + nocturne), `sqlite-db.adapter.ts` (`better-sqlite3`), `fs-cover-bucket.adapter.ts`.
- **Routes `/api/v2/*` (`v2-backend-router.service.ts`)** : 23 endpoints (`/health`, `/covers/*`, `/sync`, `/books/search-local`, `/books/search-catalog`, `/books/ingest`, `/books/resolve-hints`, `/books/sync`, `/books/series/:seriesId`, `/books/update`, `/books/exclude-from-series`, `/books/batch-genres`, `/logs/client`, `/photo-jobs*`, `/reading-status`, `/user-genres`).
- **Actions `/api/gateway?action=...`** :
  - Auth/Compte (`auth-login`, `auth-register`, `user-get`, `onboarding-notif-seen`, `account-delete`, `profile-update`, `auth-forgot-password`, `auth-reset-password`, `auth-logout`).
  - Notifications (`notif-prefs-get/save`, `push-subscribe/unsubscribe`).
  - Foyer/Amis (`family-join`, `public-share-get`, `friends-list/add/remove`, `loan-contacts-list`).
  - Admin (`admin-overview`, `admin-catalog-list/update/bulk-update`, `admin-users-list`, `admin-reset-user-ai-quota`, `admin-rehydrate-catalog`, `rehydrate-catalog`, `admin-run-release-sweep`, `admin-pipeline-logs/purge`).
  - V2 Inventaire/Wishlist/Prêts (`inventory-list/add/bulk/delete`, `lists-by-creator/create/get/add-elements/remove-elements`, `shelves`).
  - V2 Entités/Séries (`entities-by-uris/create/update-claim/update-label/update-genres/patch`, `reverse-claims`, `series-list`, `author-works`, `search-text`, `series-merge`, `series-check-releases`, `series-dismiss-alert`).
  - Vision sync (`vision-status`, `vision-analyze`).
  - Proxys externes (`external-lookup`, `google-books`, `cover-store`, `image-proxy`, `work-edition-covers`).

### D. Base SQLite — 26 Tables (Migrations `0001` à `0015`)
- **Catalogue central (6)** : `books`, `book_isbn_index`, `v4_series`, `catalog_entities` *(V2 maintenu en pont)*, `catalog_covers`, `series`/`works`/`editions` *(vestiges 0001)*.
- **Foyer (8)** : `libraries`, `library_members`, `v4_library_books`, `library_items` *(V2 maintenu en pont)*, `loans`, `borrower_contacts`, `share_tokens`, `series_release_alerts`.
- **Utilisateur (9)** : `users`, `sessions`, `password_reset_tokens`, `reading_statuses`, `friend_connections`, `user_notification_prefs`, `user_push_subscriptions`, `user_ai_usage`, `user_default_genres`.
- **Technique / Jobs (3)** : `enrichment_queue`, `pipeline_logs`, `photo_scan_jobs`.

---

## 5. Doublons, Anomalies Factuelles & Vestiges à Nettoyer pour la V2

### Anomalies & Couplages découverts dans le code
1. **Bug SQL silencieux dans `catalog-search.service.ts` (L. 318-333)** : sélectionne `b.publisher` et `b.publication_year` sur la table `books` (qui n'a pas ces colonnes) → la requête SQL échoue et tombe dans le `catch` (renvoyant `localBooks = []`).
2. **Dépendance circulaire** : `bnf.resolver.ts` ↔ `series-canonical.resolver.ts`.
3. **Fuite client → serveur** : `bnf.resolver.ts` importe `src/state/connection.ts`, tiré par tous les services serveur V4.
4. **Filtre des alertes nouveautés dans `series-digest.service.ts`** : `runHourlyDigestDispatch()` filtre uniquement contre `library_items` au lieu de `v4_library_books`.
5. **Doublons de helpers** : `normalizeToIsbn13()` dupliquée 3 fois ; `USER_AGENT_BASE` dupliquée 3 fois ; 2 parseurs InterMarc (`parseIntermarcRecord` vs `extractMarcRecordMetadata`).
6. **Vestiges Cloudflare / D1** : dossier `functions/api/`, noms `d1-gateway*.ts`, messages d'erreur mentionnant `"Bucket R2"` / `"Cloudflare Pages"`.

---

## 6. Pistes d'Architecture Cible pour une V2 Propre

Si tu décides de restructurer vers une V2 propre sans perdre aucune fonctionnalité métier :
1. **Séparer physiquement 3 dossiers étanches :**
   - `src/shared/` : types purs, utils (`isbn`, `integral`, `string`, `category`), parseurs bibliographiques (`intermarc-parser`, `work-identity`, `canal3-consensus`) — **zéro import réseau ou Pinia/Vue**.
   - `src/server/` : un **unique routeur Hono REST/RPC** (`/api/*`) structuré par domaine (`auth`, `books`, `series`, `library`, `loans`, `photo-jobs`, `search`, `social`, `notifications`, `admin`) + SQLite seul (suppression de `catalog_entities`, `library_items`, `series/works/editions` V2 après migration).
   - `src/client/` : vues Vue 3 + **un seul flux de mutation** (IndexedDB + file offline unifiée vers `/api/library/*` et `/api/books/*`), en supprimant les 7 modules legacy V2 (`entityResolver`, `mapper`, `humanizer`, `series.resolver`, `workUri.resolver`, `inventaire-sync`, `background-creation` V2) et les 4 composants / 1 vue orphelins.
