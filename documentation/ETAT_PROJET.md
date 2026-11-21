# État du Projet & Mémoire Architecturale — `inventaire-surcouche` (Biblio Collection PWA)

* **Dernière mise à jour :** `2026-11-21T11:45+01:00`
* **Branche active :** `feat/architecture-v4`
* **Dernier journal versionné :** [`v01_2026-11-18_genese-et-architecture-v4.md`](./historique/v01_2026-11-18_genese-et-architecture-v4.md)
* **Spécification algorithmique de référence :** [`Architecture_Algorithme_Livres_AntiGravity-v4.md`](./Architecture_Algorithme_Livres_AntiGravity-v4.md)

---

## 1. Résumé exécutif : ce qu’est l’application aujourd’hui

`biblio-collection-pwa` est une PWA Vue 3 + TypeScript **local-first** (cache miroir dans IndexedDB via Dexie) adossée à une API portable tournant aujourd’hui en **Cloudflare Pages Functions + D1 (`biblio-catalog-db`, région WEUR) + Worker CRON (`biblio-release-cron`)**.

Son objectif : gérer une bibliothèque familiale multi-membres (inventaire, wishlist, prêts, alertes de sorties, partage foyer/amis, statistiques, interface admin) avec **acquisition rapide sans erreur** par code-barres (`Canal 1`), ISBN manuel (`Canal 2`), recherche texte (`Canal 3`) et photo IA de couverture ou d’étagère (`Canal 4`).

### Infrastructure déployée (état au 2026-11-18)
* **Front-End & Functions :** Cloudflare Pages `biblio-collection-pwa` (`wrangler.toml`, `functions/[[path]].ts` → routeurs `v2-backend-router.service.ts` et `d1-gateway-actions.service.ts`).
* **Base D1 :** `biblio-catalog-db` (ID `f1f0f7a3-f319-4c97-a495-1ef143881795`), migrations `0001` à `0011`.
* **Worker CRON :** `workers/release-cron` (`biblio-release-cron`, schedule horaire `0 * * * *`) : dépile `enrichment_queue` (Couche 5B), surveille les nouveautés de séries, lance l’enrichissement silencieux d’éditions sœurs, envoie les digests push/email et purge les vieux logs.
* **Stockage couvertures :** tables D1 `catalog_covers` (R2 `COVERS_BUCKET` préparé dans `wrangler.toml`, non encore activé : `r2CoversBucket: false`).

---

## 2. Décisions d’Architecture Structurantes (ADR — Le « Pourquoi »)

Ces décisions expliquent **pourquoi** le code est structuré ainsi et doivent être préservées sauf évolution explicite documentée :

### ADR-01 — Sortie d’Inventaire.io comme back-end maître → Autonomie D1 + Multi-source (2026-11-14)
* **Contexte :** La V1 (`v1-inventaire-backup`, mai–juin 2026) proxyait l’API et les identifiants `inventaire.io`. La base Inventaire.io comportait des trous fréquents sur les BD franco-belges et créait une dépendance réseau/authentification fragile.
* **Décision :** Créer un back-end autonome sur Cloudflare D1 + comptes foyer propres (V2), et utiliser `inventaire.io` **uniquement en lecture publique non authentifiée, en parallèle** des autres sources (`BnF SRU`, `Google Books`, `OpenLibrary`, `Wikidata`).
* **Pourquoi :** Jamais de source unique ; le croisement parallèle garantit l’exhaustivité et évite de dépendre d’un compte tiers.

### ADR-02 — Migration d’une IA à 2 couches vers une IA OCR stricte en 1 passe + Couche 3/4 déterministe (2026-11-18)
* **Contexte :** Une branche expérimentale `feat/two-layer-ai-resolution` (`29a1842`..`d495142`) utilisait deux appels IA successifs (OCR puis normalisation sémantique Work). Cela augmentait la latence, la consommation de quota et la fréquence des erreurs HTTP 503 Gemini Vision.
* **Décision :** Supprimer la 2e couche IA et contraindre Gemini Vision à **1 seule passe OCR compacte à 6 champs** (`spineIndex`, `rawText`, `titleHint`, `volumeNumber`, `authorHint`, `isbn`), puis déléguer toute la classification bibliographique (séries, tomes, hors-séries, intégrales) au **Canal 3 (2 passes)** et aux **Couches 3–4**.
* **Fallback multi-modèles :** Prioriser les modèles actifs (`gemini-3.5-flash-lite`, `gemini-3.5-flash`, `gemini-3.8-flash`...) dans `src/core/utils/vision-prompt.util.ts` avec relance automatique serveur + client sur 503/429 (jusqu'à éviter les anciens modèles `2.0/2.5` qui renvoyaient 404).

### ADR-03 — Modèle FRBR V4 et Pivot ISBN-13 / O(1) (`migrations/0011`) (2026-11-18)
* **Contexte :** Avant V4, les éditions BD de la BnF (dépourvues d’entité *Work* dédiée) étaient mal dédupliquées, et `upsertCatalogEntity` fusionnait parfois des tomes distincts sur la même œuvre.
* **Décision :** Introduire le modèle V4 dans `v4-pipeline.service.ts` (`v4_series`, `books`, `book_isbn_index`, `v4_library_books`, `enrichment_queue`, `pipeline_logs`) :
  1. **La possession est au niveau du « Livre » consolidé** (`books`), qui agrège tous les ISBN-13 FR sœurs dans `book_isbn_index` pour une vérification $O(1)$ offline et online.
  2. Tout livre sans ISBN-13 exploitable (y compris après extrapolation presse `330`/`378`/`977`) est écarté (`UNSUPPORTED_NO_ISBN`).
  3. **Intégrales & Albums doubles bidirectionnels** : `integral_metadata` ↔ `parent_integrals` détectent `ALREADY_OWNED`, `INCLUDED_IN_INTEGRAL`, `PARTIAL_INTEGRAL_OWNED`, `FULL_INTEGRAL_OWNED`.
  4. **Rétro-compatibilité V2 :** Conserver un pont vers `catalog_entities` et `library_items` tant que les vues `SeriesView`/`CollectionView`/`BookDetailView` lisent ces structures.

### ADR-04 — Canal 3 en 2 passes (Base Locale + D1 Serveur d’abord) (2026-11-18)
* **Décision :** Avant d’appeler les APIs externes (`BnF`, `Google Books`, `OpenLibrary`), le Canal 3 (`photo-book-resolution.service.ts`) interroge d’abord IndexedDB puis `/api/v2/books/search-local` sur D1.
* **Pourquoi :** Réduire la latence, éviter le rate-limit Google Books (429 fréquents) et réutiliser immédiatement les séries déjà consolidées.

### ADR-05 — Rester sur Cloudflare en phase de test, tout en rendant le Back-End portable (2026-11-18)
* **Décision :** Maintenir l’hébergement Cloudflare (`Pages + D1 + Cron`) tant que les tests terrain sont en cours ; ne **pas** coupler `v4-pipeline.service.ts` aux APIs propriétaires Cloudflare, mais passer par l’interface abstraite `DatabaseBinding` (`src/core/adapters/storage-db.interface.ts`) et `fetch()` standard.
* **Pourquoi :** Préparer sans dette technique une future migration vers un serveur local Mac auto-hébergé derrière Cloudflare Tunnel.

### ADR-06 — Parcours `/scan` dédié et sous-vue d’arbitrage aérée (2026-11-18)
* **Contexte :** Les modales imbriquées rendaient le tri Photo IA illisible sur mobile (listes denses, `<select>` en ligne, blocages sur Rafale/Scan simple).
* **Décision :** Extraire une vraie route `/scan` ([ScanView.vue](file:///Users/mathieuegard/Dropbox/Mac/Desktop/script_app_bd/inventaire-surcouche/src/ui/views/ScanView.vue)) avec 3 onglets côte à côte (`Photo IA`, `Rafale`, `Scan simple`), une modale caméra dédiée ([CameraBarcodeModal.vue](file:///Users/mathieuegard/Dropbox/Mac/Desktop/script_app_bd/inventaire-surcouche/src/ui/components/CameraBarcodeModal.vue)) qui s’ouvre directement sur `Rafale` et `Scan simple` (fermeture auto sur `Scan simple` + spinner de chargement vers la fiche), une grille de couvertures épurée et une sous-vue dédiée ([PhotoItemDetailModal.vue](file:///Users/mathieuegard/Dropbox/Mac/Desktop/script_app_bd/inventaire-surcouche/src/ui/components/PhotoItemDetailModal.vue)) affichant la position physique gauche/droite sur l’étagère et les options d’édition.

---

## 3. Règles métier & Pièges critiques découverts en tests réels (À ne jamais réintroduire)

1. **Ne JAMAIS classer « Intégrale » sur le seul critère `pageCount >= 180`** (Test #2 : les romans graphiques unitaires de Davodeau de 200+ pages étaient faussement taggés Intégrale). Exiger une preuve explicite (`intégrale`, `coffret`, `omnibus`, `tomes X à Y`, pagination double MARC `280`, multi-`P629`, ou album double avec deux vrais titres distincts — jamais sur un simple sous-titre après `/` type `Journal d'un...`).
2. **Lire les intégrales BnF dans `245$e`, `$h`, `$u` ET les œuvres multiples dans `wdt:P629` sur Inventaire.io / Wikidata** (Test #2 : *Aya de Yopougon Intégrale 1 & 2* avaient `"intégrale"` en `245$e` et `[Q1, Q2, Q3]` en `P629`). Toujours préserver un titre distinct (`Intégrale 1`, `Intégrale 2`) et prioriser la couverture correspondant exactement à `anchorIsbn13`.
3. **Ne jamais laisser un squelette C5 périmé piéger la Couche 2** : si un ISBN pointe vers un squelette `enrichment_queue` non enrichi (`status != 'done'`) ou si l’utilisateur change le format (`UserIngestHint.isIntegral`), forcer Couche 3→4 et migrer les liaisons `v4_library_books` (`replaceSkeletonBookId`).
4. **Ne jamais dédupliquer `catalog_entities` (`work`) avec `OR` entre `normalized_label` et `series_number`** (Test #2 : fusionnait *Culottées* T1/T2 et toutes les éditions d’*Aya* sur le même `work_uri`).
5. **Toujours synchroniser `db.cache_books` ET `db.inventory`/`db.wishlist` lors d’un ajout V4** : appeler `databaseService.addRegistryEntry(...)`, sinon `CollectionView` + `syncOrchestrator` considèrent le registre vide et réinitialisent `ownershipStatus = 'none'`.
6. **Priorité stricte InterMarc BnF :** `460/461` > `245$p/$u` > `290` > `410/295` en filtrant les collections poche (`Folio`, `J'ai Lu`, etc.), et fusion des alias de séries par `stripEditorialCollectionSuffixes` (incluant `Les aventures de Tintin reporter` → `tintin`).
7. **Filtrage strict Livres Imprimés FR dans Canal 3 & Couche 3 (Test #3, 2026-11-21) :**
   * Ajouter systématiquement `(bib.doctype all "a")` dans les requêtes SRU BnF (titre/série/auteur/sœurs) et rejeter `245$d` non-livre (`Images animées`, `Enregistrement sonore`, `DVD`, `Blu-ray`...) ainsi que les codes-barres EAN non-livres (`3607...`, `00289...`, `40351...`).
   * Ne conserver que les ISBN-13 francophones (`9782...`, `97910...`) et EAN presse FR (`330`, `378`, `977`) dans le Canal 3 afin d'écarter les éditions étrangères (`97884` ES, `97890` NL, `9783` DE, `9798` KDP) qui polluaient *Aya de Yopougon* et *Dayak*.
   * Ne **jamais** appliquer `JUNK_SERIES_REGEX` dans `parseIntermarcRecord` lorsque `includeIntegrals: true` (ce bug supprimait toutes les Intégrales FR BnF !).
   * Dans `scoreHintMatch`, ne jamais attribuer le bonus de numéro de tome (`+42`) ni le bonus d'édition sans ancrage sémantique réel sur le titre, la série ou l'auteur (évite *Chihayafuru #44* pour *Boule & Bill #44* ou *Ao Ashi #28* pour *Les Schtroumpfs #28*).
   * En Couche 3 (`api_bnf_sisters`), lorsqu'un tome ancre est numéroté (`1`, `2`...) et porte un titre générique identique à la série (*Culottées*, *Aya de Yopougon*), rejeter les notices sœurs sans numéro de tome (évite la contamination croisée d'ISBN entre T1 et T2).
   * Retirer les modèles Gemini obsolètes renvoyant HTTP 404 (`gemini-3-flash`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`) de `PREFERRED_GEMINI_MODELS` pour ne pas gaspiller la moitié des tentatives OCR Vision.
   * Permettre la saisie explicite des **tomes inclus** (`UserIngestHint.includedVolumeNumbers`) dans `PhotoItemDetailModal.vue` lorsqu'une Intégrale est sélectionnée, propager ces tomes en Couche 4 (`integral_metadata_json`), et marquer les tomes couverts comme possédés dans `series.orchestrator.ts`.
8. **Résolveur canonique de séries & Garde anti-écrasement de tomes (Audit Test #4 — Tintin, 2026-11-21) :**
   * **Pourquoi :** Les logs D1 ont montré que les rééditions BnF secondaires (*Archives Tintin*, *Les aventures de Tintin reporter*, *Fac-similés*, *France Loisirs*) portent des numéros internes divergents (*Le Lotus bleu* #1, *L'île noire* #10, *Le trésor de Rackham le Rouge* #8, *Les cigares du pharaon* #20). `consolidateBookLayer4` prenait le 1er numéro trouvé (`break`) puis fusionnait par `(series_id, volume_number)` sans vérifier le titre, écrasant *Le sceptre d'Ottokar* (#8) et *L'étoile mystérieuse* (#10) et mélangeant couvertures + ISBNs.
   * **Décision :** Introduire `src/core/resolvers/series-canonical.resolver.ts` (index canonique Wikidata `P179/P1545` + vote pondéré déclassant les collections secondaires + `areDistinctSeriesWorkTitles` + upgrade du nom canonique de série). Interdire strictement l'écrasement/fusion de deux œuvres aux titres distinctifs incompatibles en Couche 4 **et** dans `series.orchestrator.ts`. Détecter aussi `suivi de` comme album double / intégrale.
   * **UX & Vision :** Consigne explicite dans `vision-prompt.util.ts` de suivre l'angle du texte sur les couvertures/tranches penchées ; fallbacks CDN/image-proxy systématiques sur les éditions proposées (fin des `?` abusifs) ; lightbox zoomable (pinch/molette/`+`/`-`/pan) + labels explicites BnF dans `PhotoItemDetailModal.vue` ; barre persistante `CollectionSubNav.vue` dans `CollectionView`, `SeriesView` et `BookDetailView`.

---

## 4. Point d’étape courant & Prochaines priorités

* **État actuel :** Correctifs post-Test #3 implémentés et vérifiés (filtrage strict livres FR `bib.doctype all "a"` + `245$d` + ISBN FR, conservation des Intégrales FR BnF, garde anti-hors-sujet `scoreHintMatch`, anti-contamination `Culottées` T1/T2, fusion `Tintin reporter`, retrait des modèles Gemini 404, sous-vue `PhotoItemDetailModal.vue` avec photo d'étagère + couverture agrandie + zoom plein écran + saisie des tomes inclus d'Intégrale + couverture de possession en `SeriesView`).
* **Prochaine étape immédiate :** Déployer sur Cloudflare Pages + CRON et effectuer le **Test #4 terrain** (vérifier *Aya de Yopougon* Intégrales FR + tomes inclus, *Boule & Bill* / *Schtroumpfs* / *La mort de Staline* sans DVD ni mangas parasites, et nouvelle modale d'arbitrage).
* **Chantiers ultérieurs envisagés :** activation R2 (`biblio-covers-webp`) si stockage externe des WebP souhaité ; migration éventuelle vers serveur local Mac (SQLite/Postgres + Cloudflare Tunnel) une fois le pipeline validé sur tests réels.

---

## 5. Index chronologique des journaux

| Version | Date | Périmètre & Commits | Lien |
| :--- | :--- | :--- | :--- |
| **`v01`** | `2026-11-18` | Genèse V1 (`81bf957`), Autonomie Cloudflare V2 (`f9aec93`..`29a1842`), Refactoring V4 (`e26fa39`..`e425074`) | [`v01_2026-11-18_genese-et-architecture-v4.md`](./historique/v01_2026-11-18_genese-et-architecture-v4.md) |
