# Journal Historique `v01` — Genèse (V1), Autonomie Cloudflare (V2/V3) et Pipeline FRBR V4

* **Version :** `v01`
* **Date de clôture :** `2026-11-18T16:35+01:00`
* **Période couverte :** `2026-05-09` → `2026-11-18` (`81bf957` → `e425074`)
* **Statut en fin de période :** Déployé sur Cloudflare Pages (`biblio-collection-pwa`) + Worker CRON (`biblio-release-cron`), base D1 prête pour le Test #3, `34` fichiers de tests (`163/163` tests passés).

---

## Chronologie datée des évolutions et arbitrages

### Phase 1 — Surcouche Mobile Inventaire.io (V1) : `2026-05-09` → `2026-06-01`
* **Commits clés :** `81bf957` (09 mai), `3588498` (13 mai, *PDA V1 stable*), `7fad5a2` (18 mai, architecture `core/`), `2e585fa` & `cac8549` (31 mai, premiers résolveurs BnF / Google Books / OpenLibrary + proxy d’images), `b2e23f3` (01 juin, édition comparative), `0c835ad` (tag `v1-inventaire-backup`).
* **Ce qui a été fait :**
  * Prototype PWA Vue 3 / TypeScript / IndexedDB (Dexie) initialement hébergé sur Vercel avec authentification proxy sur `inventaire.io`.
  * Acquisition code-barres, wishlist, suivi de prêts hors plateforme (registre local), humanisation et édition comparative ligne à ligne (`BookEdit.vue`).
* **Limites rencontrées :** latence des appels directs `inventaire.io`, données BD incomplètes ou incohérentes sur les éditions françaises, dépendance forte au maintien du proxy/session tiers.

### Phase 2 — Passage Standalone sur Cloudflare Pages & D1 (V2/V3) : `2026-11-14` → `2026-11-17`
* **Commits clés :** `f9aec93` (14 nov., socle D1 + PWA standalone), `3149f1d` (15 nov., séries BnF `460$3` / `bib.ens2bib`), `fd47fae` (16 nov., `workers/release-cron` + notifications push/email), `789d45d` & `49ec057` (16 nov., proxy Gemini Vision serveur avec quota mensuel partagé par utilisateur), `60294a6` (16 nov., `AdminView`), `29a1842` (17 nov., borne `v2-cloudflare-standalone`).
* **Migrations créées :** `0001_initial_schema.sql` à `0010_admin_role.sql`.
* **Choix logiques majeurs :**
  * Création de comptes utilisateurs/bibliothèques autonomes dans Cloudflare D1 (`users`, `sessions`, `libraries`, `library_members`, `share_tokens`, `friend_connections`), tout en gardant un client offline-first via `sync` et `DB_RESET_TOKEN`.
  * Ajout de l’acquisition par photo IA (étagère multi-tranches) + tri par doutes / certitudes + expansion préventive des séries et alerte de nouveautés par Worker CRON horaire.
  * Dédoublonnage visuel des couvertures (dHash) et stockage WebP côté serveur (`catalog_covers`, R2 optionnel).
* **Pivot du 17 novembre (`ee7353a` → `d495142`, branche `feat/two-layer-ai-resolution`) :**
  * Essai d’une analyse photo IA à 2 couches (OCR strict puis normalisation sémantique Work via LLM).
  * **Pourquoi abandonné / recadré :** l’audit architectural mené le `2026-11-18` (spécifications `Architecture_Algorithme_Livres_AntiGravity` v3 → v4) a montré qu’une double passe IA alourdissait latence, coûts et erreurs `503` Gemini sans résoudre les fusions de séries ou d’intégrales. La couche sémantique IA a été remplacée par une passe OCR unique + consolidation multi-sources déterministe.

### Phase 3 — Refonte V4 : Pipeline FRBR en 5 Couches & Recadrage `/scan` : `2026-11-18`
* **Spécification écrite :** [`Architecture_Algorithme_Livres_AntiGravity-v4.md`](../Architecture_Algorithme_Livres_AntiGravity-v4.md) (commit de sécurité `d495142` sur `feat/two-layer-ai-resolution`, puis développement sur `feat/architecture-v4`).
* **Commit `e26fa39` (`2026-11-18 14:21`) — Noyau Pipeline V4 :**
  * Migration `migrations/0011_v4_frbr_books_and_logs.sql` (`v4_series`, `books`, `book_isbn_index`, `v4_library_books`, `enrichment_queue`, `pipeline_logs`).
  * Implémentation de [`v4-pipeline.service.ts`](../../src/core/services/v4-pipeline.service.ts) sur `DatabaseBinding` (portable hors Cloudflare) :
    * **C1 :** 4 canaux unifiés sur le contrat pivot ISBN-13 (+ extrapolation presse `330`/`378`/`977`). OCR photo strict à 6 champs (1 passe IA, cadrage bibliothèque 90° en tête de prompt).
    * **C2 :** lookup O(1) `book_isbn_index` + détection bidirectionnelle des Intégrales/Albums doubles (`INCLUDED_IN_INTEGRAL`, `PARTIAL_INTEGRAL_OWNED`, `FULL_INTEGRAL_OWNED`).
    * **C3 :** découverte parallèle **multi-source** (`BnF SRU`, `Inventaire.io` public, `Google Books`, `OpenLibrary`, `Wikidata`) + Canal 3 en 2 passes (Local/D1 avant externes).
    * **C4 :** consolidation post-collecte (albums doubles = intégrales, vote majoritaire sur cluster de série normalisé, règle Hors-Série évaluée *uniquement* après agrégation de toutes les éditions sœurs).
    * **C5 + CRON :** squelette série rapide + file `enrichment_queue` dépilée par `workers/release-cron`, sans saturer les sous-requêtes Cloudflare Workers.
  * Onglet logs détaillés dans `AdminView`.
* **Commit `f14da27` (`2026-11-18 15:44`) — Retours Test #1 :**
  * Remplacement de l’overlay scanner par une route dédiée `/scan` ([ScanView.vue](../../src/ui/views/ScanView.vue)) + modale caméra isolée ([CameraBarcodeModal.vue](../../src/ui/components/CameraBarcodeModal.vue)).
  * Relance automatique multi-modèles sur erreurs `503`/`429` Gemini et logs granulaires API par source (`C3.api_*`).
  * Correction BnF InterMarc (`460 > 245 > 290 > 410`) pour éviter que `Folio #6561` crée des séries ou absorbe *Culottées* T2 dans T1 ; nettoyage `Collection les Schtroumpfs` → `Les Schtroumpfs` ; répercussion des fusions manuelles de séries sur `books`/`v4_series`.
* **Commit `e425074` (`2026-11-18 16:20`) — Analyse logs Test #2 & Refonte UX :**
  * **Bugs critiques corrigés après inspection D1 de Test #2 :**
    1. Suppression de l’heuristique `pageCount >= 180` qui classait à tort les one-shots d’Étienne Davodeau en `Intégrale`, et garde-fou sur les sous-titres avec `/`.
    2. Correction de la perte des livres pré-cochés en `CollectionView` (`ScanView` appelait `markUriOwnedInRegistry` inexistant au lieu d’`addRegistryEntry`, provoquant une remise à `'none'` lors de l’hydratation).
    3. Correction complète du cas *Aya de Yopougon Intégrales 1 & 2* : extraction MARC `245$e/$h/$u` + multi-`wdt:P629` Inventaire/Wikidata (`includedVolumeNumbers`), priorité couverture sur ISBN exact ancré, suppression du `OR` fautif dans `upsertCatalogEntity`, et migration automatique `v4_library_books` quand un squelette C5 est upgradé.
    4. Réordonnancement de `PREFERRED_GEMINI_MODELS` (modèles 3.5/3.8 actifs en tête au lieu des modèles 2.0/2.5 en 404).
  * **Refonte UX `/scan` :**
    1. 3 onglets côte à côte en grille sur mobile (`Photo IA`, `Rafale`, `Scan simple`).
    2. Ouverture directe de la caméra au clic sur `Rafale` / `Scan simple` avec explications dans la modale (`Fermer` sur Rafale sans bouton superflu dessous ; fermeture auto + écran de chargement puis redirection sur `Scan simple`).
    3. Grille aérée couverture + case à cocher + ouverture au clic de [`PhotoItemDetailModal.vue`](../../src/ui/components/PhotoItemDetailModal.vue) (position étagère gauche/droite, choix éditions, bascule explicite Intégrale, relance BnF).
    4. Verrouillage `BatchActionBar` + bannière flottante de progression + bouton `Voir ma Collection →`.

---

## Borne de reprise pour le prochain journal (`v02`)

* **Dernier commit inclus :** `e425074` (`2026-11-18`)
* **Prochain delta à couvrir :** `e425074..HEAD` (résultats du Test #3, activations éventuelles R2 / nouvelles fonctionnalités / préparatifs serveur local Mac).
