# Matrice Exhaustive des Fonctionnalités V1 (Pense-bête de Bijection V2)

> **Rôle de ce document :** Garantir qu'au moment de concevoir et coder la V2, **100 % des fonctionnalités, boutons, règles métier et portées de données** de l'application actuelle sont bien pris en compte (bijection complète V1 → V2, quitte à fusionner ou simplifier les routes techniques).
>
> **Légende des Portées :**
> * **Local** : navigateur uniquement (`IndexedDB` / `localStorage` / `Service Worker`).
> * **Utilisateur** : strictement individuel par compte (`user_id`), **non partagé** avec les autres membres du foyer.
> * **Foyer** : partagé entre tous les membres d'une même bibliothèque familiale (`library_id`).
> * **Catalogue Central** : base bibliographique commune à tous les utilisateurs de la plateforme.

---

## 1. Authentification, Compte, Sécurité & PWA

| # | Fonctionnalité UX | Écran / Bouton / Contrôle UI | Chaîne Technique Actuelle (Client → API → SQL) | Portée | V2 |
| :-: | :--- | :--- | :--- | :--- | :-: |
| 1.1 | **Connexion** | `LoginView` : `Nom d'utilisateur` + `Mot de passe` + bouton *Se connecter* | `connectionService.login` → `POST /api/gateway?action=auth-login` → `users`, `sessions`, `libraries` | Utilisateur + Local | ☑ |
| 1.2 | **Inscription + RGPD** | `LoginView` : `Pseudo`, `E-mail`, `Mot de passe`, checkbox RGPD + *En savoir plus (RGPD)* + *Créer mon compte* | `auth-register` → `users` (`gdpr_accepted_at`), crée `libraries` + `share_tokens` (`FAM-`, `PUB-`), pose `biblio_show_notif_onboarding` | Utilisateur + Foyer + Local | ☑ |
| 1.3 | **Inscription via lien Foyer / Ami** | `LoginView` (`?invite=CODE` / `?friend=TOKEN`) : checkboxes *Synchroniser avec la famille* / *Suivre cette bibliothèque* | `auth-register` / `auth-login` → `library_members` (si foyer) et/ou `friend_connections` (si ami) | Utilisateur / Foyer | ☑ |
| 1.4 | **Mot de passe oublié** | `LoginView` : *Mot de passe oublié ?* → Étape 1 (*Envoyer le code*) → Étape 2 (*Code 6 chiffres + Nouveau mdp*) | `requestPasswordReset` / `resetPassword` → `auth-forgot-password` (Resend e-mail) / `auth-reset-password` → `password_reset_tokens`, `sessions` | Utilisateur | ☑ |
| 1.5 | **Édition du profil** | `ProfileView` (`account`) : `Pseudo`, `E-mail de récupération`, `Mot de passe actuel`, `Nouveau mot de passe`, alerte e-mail manquant | `userService.updateProfile` → `profile-update` → `users` | Utilisateur | ☑ |
| 1.6 | **Déconnexion** | `ProfileView` (`account`) : *Se déconnecter* | `connectionService.logout` → `auth-logout` → supprime `sessions` + purge `localStorage`/`IndexedDB` | Utilisateur + Local | ☑ |
| 1.7 | **Suppression définitive de compte** | `ProfileView` (`account`) : *Supprimer définitivement mon compte* → Modale avec saisie du mot de passe | `connectionService.deleteAccount` → `account-delete` : supprime `users` + données perso ; supprime `libraries` **uniquement si seul membre** ; **ne touche jamais** au Catalogue Central | Utilisateur (+ Foyer si solo) | ☑ |
| 1.8 | **Installation PWA** | `LoginView` / `PublicShareView` : *Installer l'application* + astuce iOS | `pwa-install.util.ts` (`beforeinstallprompt` / `promptPwaInstall`) | Local | ☑ |
| 1.9 | **Mise à jour PWA** | `PwaReloadPrompt` : dialogue natif *Mettre à jour maintenant* / *Plus tard* | `useRegisterSW` + `SKIP_WAITING` + `controllerchange` + `window.location.reload()` | Local | ☑ |
| 1.10 | **Auto-sélection texte au focus** | Global (`src/main.ts`) : tout `<input>` / `<textarea>` | Listener `focusin` / `mouseup` | Local | ☑ |

---

## 2. Navigation, Accueil & Mode Hors-Ligne

| # | Fonctionnalité UX | Écran / Bouton / Contrôle UI | Chaîne Technique Actuelle | Portée | V2 |
| :-: | :--- | :--- | :--- | :--- | :-: |
| 2.1 | **Menu principal 6+2 entrées** | `BaseHeader` : Desktop (`ACCUEIL`, `COLLECTION`, `WISHLIST`, `PRÊTS`, `NOUVEAUTÉS`, `PARTAGE & AMIS`, `MON PROFIL`, `RECHERCHE`) + Mobile tiroir accordéon | Vue Router + `scannerState.toggleScan(router)` | Local | ☑ |
| 2.2 | **Accueil & compteurs** | `DashboardView` : 4 cartes (*Ma Collection*, *Ma Wishlist*, *Mes Prêts*, *Mes Nouveautés*) avec compteurs + 5 vignettes récentes cliquables | `statsService.getDashboardStats(30)` + `databaseService` + `seriesReleaseService.alerts` | Local + Foyer | ☑ |
| 2.3 | **Détection & reprise hors-ligne** | `App.vue` + `connectionState` : bannière hors-ligne, heartbeat `/api/v2/health` (10s), reprise auto à la reconnexion | `queueService.processQueue()`, `backgroundCreationOrchestrator.resumePendingJobs()`, `photoBatchQueueService.initAndResume()`, `seriesReleaseService.checkNewReleasesOnOpen()` | Local | ☑ |
| 2.4 | **Scans hors-ligne mémorisés** | `DashboardView` : carte *Scans hors-ligne mémorisés (N)*, *Consulter la fiche*, *✕ Retirer*, *Tout effacer* | `pendingScansStore` (`localStorage`) | Local | ☑ |

---

## 3. Collection, Wishlist & Prêts

| # | Fonctionnalité UX | Écran / Bouton / Contrôle UI | Chaîne Technique Actuelle | Portée | V2 |
| :-: | :--- | :--- | :--- | :--- | :-: |
| 3.1 | **Vues Collection** | `CollectionView` + `CollectionSubNav` : onglets `Livres`, `Séries`, `One-shots` | `databaseService.getAllBooksFromCache()`, déduplication multi-clés + `annotateIntegralCoverage()` | Foyer + Local | ☑ |
| 3.2 | **Filtres, tris & mémoire d'état** | `CollectionControls` + `WireframePagination` : filtre libre avec suggestions dynamiques (genres/séries/auteurs/éditeurs), tri (`Date`, `Auteur`, `Alphabétique`), recherche texte, pagination, restauration scroll | `viewStateStore` (`collection`, `wishlist`, `loans`) + `saveBookNavigationOrder` | Local | ☑ |
| 3.3 | **Wishlist groupée** | `WishlistView` : regroupement *Séries* puis *Livres indépendants*, filtres `Genre` & `Auteur`, recherche, badge *Souhaité par \<Prénom\>* | `databaseService` + `wished_by_user_id` (`v4_library_books` / `library_items`) + modale confirmation suppression | Foyer (+ auteur du souhait) | ☑ |
| 3.4 | **Carnet des Prêts** | `LoansView` : onglets *Par emprunteur* (accordéons dépliables/repliables) et *Chronologique*, recherche par titre/ami/série/auteur | `databaseService.getAllLoans()` ↔ `/api/gateway?action=shelves` (`loans`, `borrower_contacts`) | Foyer | ☑ |
| 3.5 | **Prêter un ou plusieurs livres** | `LendModal` (depuis `BookDetailView`, `CollectionView`, `SeriesView`, `AuthorView`, `ScanBookListTab`, `ScanTextSearchTab`) : saisie nom + chips contacts historiques & `[Ami]` | `userService.listLoanContacts()` (`loan-contacts-list`) + `biblio_loan_contacts_v1` → `queueService.enqueueAction('LEND')` → `shelves` | Foyer + Local | ☑ |
| 3.6 | **Rendre un livre prêté** | `BookActionButtons` (*Livre rendu*) / `BatchActionBar` (*Rendre*) | `queueService.enqueueAction('RETURN')` → `shelves` | Foyer + Local | ☑ |
| 3.7 | **Sélection multiple intelligente** | `BatchActionBar` : *Posséder*, *Wishlist*, *Prêter*, *Rendre*, *Rattacher série*, *+ Genre*, *Supprimer* (avec modale confirmation) + compteurs d'éligibilité `(N)` sur sélection mixte | `computeCommonBatchActions()` + `filterEligibleBooksForBatchAction()` (`batch-actions.util.ts`) | Foyer + Local | ☑ |
| 3.8 | **Ajout de genres en lot** | `BatchGenreModal` : sélection chips + champ perso (*+ Lot* ou *+ Par défaut*) + *Appliquer (N)* | `userService.addGenresToBooksBatch` (`POST /api/v2/books/batch-genres`) + `updateDefaultGenres` (`POST /api/v2/user-genres`) + cache local | Foyer (livres) + Utilisateur (défauts) | ☑ |

---

## 4. Acquisition : Scan, Photo IA, Recherche & Création

| # | Fonctionnalité UX | Écran / Bouton / Contrôle UI | Chaîne Technique Actuelle | Portée | V2 |
| :-: | :--- | :--- | :--- | :--- | :-: |
| 4.1 | **Scan Simple (Code-barres)** | `ScanView` (`simple`) + `CameraBarcodeModal` : lecture EAN-13 → ouverture directe de la fiche livre | `scannerState` → `searchService.searchByIsbn()` → `/api/v2/books/ingest` (`preview`) → `/book/isbn:...` | Catalogue Central + Local | ☐ |
| 4.2 | **Mode Rafale (Code-barres)** | `ScanView` (`burst`) + `ScanBookListTab` + `CameraBarcodeModal` : capture 0 ms, vibration haptique + flash vert/orange + toast, liste persistante, sélection & ajout par lot | `handleInstantBurstCapture()` + `useBookBatchActions` (`ingestIsbnsViaV4` + `addRegistryEntry`) | Catalogue Central + Foyer + Local | ☐ |
| 4.3 | **Photo IA (Étagère / Couverture)** | `ScanView` (`photo`) : *Prendre une photo* / *Galerie*, suivi quota mensuel, bandeau global `App.vue` (*En cours X/Y* / *Fini*), *Relancer erreurs*, *Vider le lot* | `byokVisionService.compressForMode` → `POST /api/v2/photo-jobs` → `photo-scan-jobs.service.ts` (Gemini Vision + Canal 3 + `user_ai_usage`), polling 3s (`photoBatchQueueService`) | Utilisateur (quota/job) + Catalogue Central | ☐ |
| 4.4 | **Arbitrage Photo IA & Détail** | `ScanView` (`Identifiés`, `À vérifier`, `Autres tomes des séries`, `Non identifiés`) + `PhotoItemDetailModal` : zoom tactile/molette (100%–450%), choix édition alternative (radio), *Ignorer*, *Intégrale + Tomes inclus*, *Tout relancer* | `scanDraftStore` (`localStorage`) + `photoBookResolutionService.resolveSingleCandidate` | Local (brouillon) | ☐ |
| 4.5 | **Correction manuelle BnF depuis Photo IA** | `PhotoItemDetailModal` : bouton *Ce n'est pas la bonne référence / Je ne trouve pas mon livre* → sous-modale 6 champs vides (`✕` par champ) + bouton caméra `📷` (ISBN picker) | `scannerState.openIsbnPickerModal` + `POST /api/v2/books/resolve-hints` (`canal3-resolver`) + repli client | Catalogue Central + Local | ☐ |
| 4.6 | **Recherche textuelle multi-critères** | `ScanView` (`search`) + `ScanTextSearchTab` : 7 champs (`Titre`, `Série`, `Tome`, `Auteur`, `Collection`, `Éditeur`, `ISBN`), *Rechercher*, *Effacer*, résultats groupés **Séries** + **Œuvres**, persistance | `textSearchState` + `POST /api/v2/books/search-catalog` (`catalog-search.service.ts`) ou `searchService.searchByIsbn()` | Catalogue Central + Foyer + Local | ☐ |
| 4.7 | **Création manuelle d'un ISBN inconnu** | `BookCreateUnknown` : pré-remplissage BnF/OL, champs livre/série, checkbox *Pas de série*, checkbox *Créer aussi les autres tomes manquants*, modale doublons `DedupModal` | `externalMetadataService` + `bookSemanticOrchestrator.analyzeDuplicates` + `backgroundCreationOrchestrator.enqueueBookCreation` | Catalogue Central + Foyer + Local | ☐ |

---

## 5. Fiche Livre, Édition, Couvertures & Intégrales

| # | Fonctionnalité UX | Écran / Bouton / Contrôle UI | Chaîne Technique Actuelle | Portée | V2 |
| :-: | :--- | :--- | :--- | :--- | :-: |
| 5.1 | **Fiche Livre & Navigation sœur** | `BookDetailView` : flèches `<` / `>`, bandeau statut (`Prêté à` / `Possédé` / `Souhaité · Ajouté par`), liens cliquables Série & Auteurs/Scénaristes/Dessinateurs, couverture | `databaseService`, `bookNavigation` (`sessionStorage`), `resolveBookCardCoverUrl` | Foyer + Local | ☐ |
| 5.2 | **Statut de lecture, Note & Notes perso** | `BookDetailView` : selects *Ma lecture* (`Non renseigné`, `À lire`, `En cours`, `Lu`, `Abandonné`), *Ma note* (`1..5`), zone *Notes personnelles* | `userService.saveReadingStatus` → `PUT /api/v2/reading-status` → `reading_statuses` (`user_id`) + `localStorage` | **Utilisateur** (strictement individuel) | ☐ |
| 5.3 | **Actions unitaires livre** | `BookActionButtons` + `BookDetailView` : *Ajouter à l'inventaire*, *Ajouter à la wishlist*, *Prêter*, *Livre rendu*, *Supprimer* (modale confirmation) | `queueService.enqueueAction` / `inventoryService.removeFromLibrary` / `wishlistService.removeFromWishlist` | Foyer + Local | ☐ |
| 5.4 | **Édition complète d'une fiche** | `BookEdit` : Titre, Auteurs, Série / *Pas de série*, Tome, `IntegralConfigFields`, Éditeur, Année, Pages, Genres + *+ Aux genres par défaut*, `DedupModal` | `bookSemanticOrchestrator.saveEditedBook` → `PATCH /api/v2/books/update` (`v4_library_books` Option B + propagation genres série) | Foyer (fiche) + Utilisateur (genres défaut) + Local | ☐ |
| 5.5 | **Galerie de couvertures & Upload WebP** | `BookEdit` : URL directe, *Prendre / importer une photo (WebP)*, *Rechercher d'autres couvertures*, galerie dédupliquée cliquable | `webp-compressor.util`, `cover-dedup.util`, `/api/gateway?action=work-edition-covers`, `cover-store` / `PUT /api/v2/covers/*` | Foyer (prioritaire) + Catalogue Central | ☐ |
| 5.6 | **Gestion des Intégrales** | `IntegralConfigFields` (dans `BookDetailView` modale, `BookEdit`, `PhotoItemDetailModal`) : bascule *Standard / Intégrale*, saisie *Tomes inclus* (`1-3`, `4, 5`), détection bidirectionnelle *Dans intégrale* / *Couvre X tomes* | `transformBookIntegralStatus` (`integral.service.ts`) → `PATCH /api/v2/books/update` + `annotateIntegralCoverage` | Foyer + Local | ☐ |

---

## 6. Séries, Auteurs & Alertes Nouveautés

| # | Fonctionnalité UX | Écran / Bouton / Contrôle UI | Chaîne Technique Actuelle | Portée | V2 |
| :-: | :--- | :--- | :--- | :--- | :-: |
| 6.1 | **Fiche Série & Filtres** | `SeriesView` : liste triée des tomes (possédés, dans intégrale, manquants), barre progression hydratation, onglets *Tout / Possédés / Non possédés*, recherche, sélection multiple + `BatchActionBar` | `seriesOrchestrator.getCompleteSeriesForUI` + `SeriesMiniCard` | Foyer + Local | ☐ |
| 6.2 | **Enrichir / Actualiser une série** | `SeriesView` : boutons *Enrichir la série maintenant* / *Actualiser la série*, affichage du bilan réel d'ajout | `fetchV4SeriesBooksToIndexedDb(id, { force: true })` → `GET /api/v2/books/series/:id?force=1` → Couche 5 (`enqueueOrExpandSeriesLayer5` + `drainEnrichmentQueueBatch`) | Catalogue Central → Local | ☐ |
| 6.3 | **Rattacher / Fusionner une série** | `SeriesMergeModal` (depuis `BookDetailView`, `BookEdit`, `CollectionView`, `SeriesView`) : recherche série existante ou *+ Créer*, checkbox *Fusionner toute la série source*, type (`Standard`, `HS`, `Intégrale`, `Sans n°`), position de tri `0.5` | `POST /api/gateway?action=series-merge` → `v4_series`, `books`, `v4_library_books` + cache local | Foyer + Local | ☐ |
| 6.4 | **Exclure un tome d'une série** | `BookDetailView` / `SeriesView` : *Ne fait pas partie de cette série* | `seriesOrchestrator.excludeTomesFromSeries` → `POST /api/v2/books/exclude-from-series` → `v4_library_books` (`hiddenSeriesIds`) | Foyer (Option B) + Local | ☐ |
| 6.5 | **Profil Auteur** | `AuthorView` : section *Séries* (`SeriesMiniCard`) + section *Œuvres & Albums* (`BookMiniCard`), recherche, sélection + `BatchActionBar` | Cache local + `POST /api/v2/books/search-catalog` (+ repli `inventaireSearchProvider`) | Catalogue Central + Foyer + Local | ☐ |
| 6.6 | **Nouveautés & Alertes in-app** | `ReleasesView` : *Vérifier les sorties*, tri (`Plus récentes`, `Plus anciennes`, `A→Z`, `Z→A`), *Tout masquer*, recherche, sélection + ajout Collection/Wishlist | `seriesReleaseService` → `series-check-releases` / `series-dismiss-alert` + `series-digest.service.ts` (CRON nocturne 02h00) | Foyer (alertes) + Catalogue Central | ☐ |
| 6.7 | **Préférences Notifications & Push/E-mail** | `ProfileView` (`notifications`) + `NotificationOnboardingModal` : fréquence (`off`/`daily`/`weekly`/`monthly`), jour, heure, fuseau, canal (`push`/`email`/`both`) | `notif-prefs-get/save`, `push-subscribe/unsubscribe`, `onboarding-notif-seen` → `user_notification_prefs`, `user_push_subscriptions`, CRON horaire (`web-push.service` + Resend) | Utilisateur + Local (Push) | ☐ |

---

## 7. Social : Foyer, Amis & Vitrine Publique

| # | Fonctionnalité UX | Écran / Bouton / Contrôle UI | Chaîne Technique Actuelle | Portée | V2 |
| :-: | :--- | :--- | :--- | :--- | :-: |
| 7.1 | **Partage Foyer (Synchronisation)** | `FamilyShareView` (`family`) / `FamilySharePanel` / `FamilyShareModal` : QR Code, code `FAM-...` + *Copier*, lien + *Copier/Partager*, liste membres (`proprio`), accordéon *Rejoindre un foyer* | `family-join` → `share_tokens`, `library_members` + resync complet `initializeApp()` | Foyer | ☐ |
| 7.2 | **Partage Amis (Vitrine & QR Code)** | `FamilyShareView` (`friends`) / `FriendsView` : *Mon QR Code Amis*, ajout ami par code `PUB-...` ou URL, liste amis + compteurs, *Voir sa collection*, *✕ Retirer* | `friends-list`, `friends-add`, `friends-remove`, `public-share-get` → `friend_connections` | Utilisateur (abonnements) + Foyer (vitrine) | ☐ |
| 7.3 | **Consultation bibliothèque d'un ami / lien public** | `PublicShareView` (`/shared/:token`) + `SharedLibraryBrowser` : accès sans compte, modale visiteur, *Ajouter à mes Amis*, *Créer mon compte & suivre*, filtres *Tout/Possédés/Wishlist/Prêtés* (sans nom d'emprunteur), recherche, filtre catégorie | `public-share-get` (`v4_library_books` + `books` + `loans` + `library_items`) | Lecture seule publique | ☐ |

---

## 8. Statistiques, Genres par défaut, Administration & Observabilité

| # | Fonctionnalité UX | Écran / Bouton / Contrôle UI | Chaîne Technique Actuelle | Portée | V2 |
| :-: | :--- | :--- | :--- | :--- | :-: |
| 8.1 | **Statistiques interactives** | `ProfileView` (`stats`) / `StatsView` : sélecteur période (`30j`, `90j`, `365j`, `Tout`), 4 KPIs cliquables, activité, lecture/notes, pages, Top 10 Genres/Auteurs/Sagas/Éditeurs cliquables, suivi prêts actifs | `statsService.getDetailedStats()` + `syncAllUserReadingStatuses()` | Foyer (collection/prêts) + Utilisateur (lecture/notes) | ☐ |
| 8.2 | **Genres par défaut utilisateur** | `ProfileView` (`genres`) : ajout genre perso, suppression chip `×`, *Réinitialiser la liste standard* | `userService.updateDefaultGenres` → `POST /api/v2/user-genres` → `user_default_genres` | **Utilisateur** | ☑ |
| 8.3 | **Console Admin : Vue d'ensemble & Comptes** | `AdminView` (`stats` & `users`) : stats plateforme, liste comptes, *RAZ quota IA*, *Veille nouveautés manuelle*, *Ré-hydratation catalogue* | `admin-overview`, `admin-users-list`, `admin-reset-user-ai-quota`, `admin-run-release-sweep`, `admin-rehydrate-catalog` | Serveur / Catalogue Central | ☐ |
| 8.4 | **Console Admin : Catalogue Maître (Unitaire & Lot)** | `AdminView` (`catalog`) : recherche, filtre (`all`/`no_cover`/`no_series`), type, taille page (`12..60`), pagination, édition unitaire, sélection multiple + *Modifier la sélection (N)* (6 champs opt-in) | `admin-catalog-list`, `admin-catalog-update`, `admin-catalog-bulk-update` (`catalog_entities` + `books` + `v4_series` + `book_isbn_index`) | **Catalogue Central** | ☐ |
| 8.5 | **Console Admin : Logs Pipeline V4** | `AdminView` (`logs`) : filtres couche (`C1..C5`, `CRON`), statut, recherche ISBN/trace, dépliage étapes, *Exporter JSON*, *Purger TTL* | `admin-pipeline-logs`, `admin-pipeline-logs-purge` → `pipeline_logs` | Serveur | ☐ |
| 8.6 | **Debug Base Locale** | `DebugDbView` (`/debug`) : recherche, *Rafraîchir*, *Vider* `cache_books` | `databaseService.getAllBooksFromCache()`, `db.cache_books.clear()` | Local | ☑ |
| 8.7 | **CRON automatique serveur** | `server/scheduler.ts` : Passe horaire (`drainEnrichmentQueueBatch`, `runHourlyDigestDispatch`, `purgeOldPipelineLogs`) + Passe nocturne 02h00 (`runCentralizedSeriesReleaseSweep`, `runSilentEditionDiscoveryPass`) | Direct SQLite + BnF/SUDOC/Inventaire/Wikidata + Push/Resend | Serveur / Catalogue Central | ☐ |
