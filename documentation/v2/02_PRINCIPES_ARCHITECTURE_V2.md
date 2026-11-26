# Idées & Principes d’Architecture — Préparation V2

> **Document vivant (Phase d’idéation)** — Complément de [`01_CARTOGRAPHIE_V1.md`](./01_CARTOGRAPHIE_V1.md).
>
> **Méthode décidée :**
> 1. **Coucher toutes les idées, principes et cas limites sur le papier** (sans se précipiter dans le code).
> 2. **Ordonner et arbitrer** les choix d’architecture.
> 3. **Vérifier la couverture à 100 %** de toutes les fonctions métier actuelles (inventoriées dans [`01_CARTOGRAPHIE_V1.md`](./01_CARTOGRAPHIE_V1.md)).
> 4. **Rédiger le plan d’action V2** de A à Z en repartant sur des bases saines (en évitant de réimporter du code spaghetti).

---

## 1. Architecture cible de l’Acquisition & Enrichissement (Les 3 Étages)

### Étage 1 — Identification pure (Canal → ISBN-13)
* Quel que soit le point d’entrée utilisateur (**Scan code-barres simple**, **Mode Rafale**, **Saisie ISBN**, **Photo IA étagère/couverture**, **Recherche textuelle**), son **unique responsabilité** est d’identifier l’ouvrage et d’en extraire un **ISBN-13 normalisé**.
* Aucune logique d’enrichissement complet ou d’expansion de série ne doit polluer cette couche.

### Étage 2 — Collecte Multi-Sources & Tableau Comparatif Normalisé
* À partir de l’ISBN-13, un collecteur unique interroge **toutes les sources en parallèle** : BnF SRU, SUDOC (ABES), Inventaire.io, Wikidata, Google Books, Open Library.
* Chaque source remplit une **colonne normalisée d’un même tableau comparatif** :
  * Titre de l’œuvre / Titre de l’album
  * Série candidate + Type de lien (Ensemble bibliographique `460`, Série graphe `P179`, ou simple Collection éditoriale `225/410`)
  * Numéro de tome
  * Auteurs / Scénaristes / Dessinateurs
  * Éditeur, Collection éditoriale, Année, Pagination, Langue
  * Identifiants de graphe (`wikidataWorkQid`, `wikidataSeriesQid`, `inventaireWorkUri`, `bnfEnsembleId`, `ppnSudoc`)
  * Couverture candidate
* Un **arbitre déterministe** compare les colonnes entre elles (confrontation et normalisation) pour produire la fiche consolidée, au lieu de prendre « le premier qui répond ».

### Étage 3 — Graphe `Édition ↔ Œuvre ↔ Série` & Expansion par le Graphe
* Pour chaque ISBN, on s’efforce de reconstruire le **graphe réel** :
  `Édition physique (ISBN)` → `Œuvre (Q-ID / URI)` → `Série / Franchise (Q-ID / Ensemble)`.
* **Expansion des tomes par le graphe d’abord :**
  1. Si la série possède un ancrage graphe (Wikidata `P179` / Inventaire.io), on récupère **toutes les œuvres officielles de la série** (titre canonique + ordre `P1545` + image), ce qui évite le plafond texte de la BnF (45 notices saturées de rééditions) et résout les séries multi-auteurs (*Spirou*, *Astérix*, *Marsupilami*).
  2. Pour chaque œuvre manquante du graphe, on cherche son édition/ISBN FR (via Inventaire `wdt:P629` puis requête ciblée BnF/SUDOC sur le titre exact de ce tome).
  3. On autorise l’existence d’un tome officiel du graphe **même avant d’avoir trouvé son ISBN FR** (l’ISBN est complété en tâche de fond).
  4. La recherche BnF `460$3` (`bib.ens2bib`) / texte reste le filet de sécurité pour les séries franco-belges absentes de Wikidata.

---

## 2. Défi Algorithmique n°1 : Éliminer les fausses séries (Collections éditoriales / Poche type *Totem*, *Folio*, *J'ai lu*…) — Zéro liste en dur

### Le problème constaté
Dans les romans et les éditions poche, les éditeurs numérotent leurs collections (*Totem #42* chez Gallmeister, *Folio #7304*, *Points*, *10/18*, etc.). La BnF place ces noms dans les zones de collection (`225`/`410`). Sans garde-fou générique, l’application prend cette collection pour une **série narrative** et mélange des dizaines de romans d’auteurs sans aucun rapport dans une seule « série » interminable.

### Solution algorithmique proposée (100 % dynamique, zéro mot-clé en dur)
Lors du passage dans le **Tableau Comparatif (Étage 2)** et avant toute création de série en base, appliquer 3 tests algorithmiques combinés :

1. **Distinction structurelle MARC (`Ensemble` vs `Collection`) :**
   * En MARC (BnF/SUDOC), les zones `460`/`461` désignent un **ensemble bibliographique (série)**, alors que `225`/`410` désignent une **collection éditoriale**.
   * Si un nom candidat n’apparaît **que** dans `225`/`410` (jamais en `460`/`461` ni en `P179` Wikidata/Inventaire), il est marqué **« Collection éditoriale suspecte »**.
2. **Confrontation `Œuvre` vs `Édition` dans le Tableau Comparatif :**
   * Une vraie série (*Harry Potter*, *Tintin*) existe au niveau de **l’Œuvre** (Wikidata `P179`, Inventaire, Google Books, BnF `460`).
   * Une collection poche (*Totem*, *Folio*) n’existe qu’au niveau de **l’Édition physique** : les autres sources (Wikidata, Inventaire, Google Books, ou une autre édition grand format du même livre) ne mentionnent **aucune série**.
3. **Test mathématique d’hétérogénéité des auteurs (le critère décisif) :**
   * Si un doute subsiste sur un nom de série candidat `S` issu de `225`/`410` : un contrôle rapide (sur les notices déjà en base ou via 1 requête BnF de 10 notices sur `S`) vérifie le **ratio d’auteurs distincts**.
   * **Règle :** Une vraie série narrative partage un noyau d’auteurs (ou au moins un chevauchement d’auteurs entre ses tomes). Si sur un échantillon de 5 à 10 livres de `S`, **la quasi-totalité ont des auteurs différents sans aucun auteur commun** (et/ou des numéros de tome très élevés / épars), `S` est **mathématiquement une collection éditoriale**, jamais une série.
   * **Action :** On classe `S` dans le champ `collection` de l’édition, et `series` de l’œuvre reste vide (`One-shot`).

### Cas limites identifiés (Stress-test du Défi n°1)
1. **Faux négatif — Vraies séries anthologiques / multi-auteurs** (ex. *Les Reines de sang*, *Ils ont fait l'Histoire*, *La Sagesse des mythes*) :
   * Chaque tome a un auteur différent, donc un test d'hétérogénéité d'auteurs appliqué seul les rejetterait à tort comme « collections ».
   * *Parade algorithmique :* Ne **jamais** rejeter une série si elle est confirmée comme vraie série dans Wikidata (`P179`), dans une notice d'ensemble BnF `460` liée à un petit nombre borné de tomes, OU si ses titres suivent une thématique/numérotation séquentielle courte (`1, 2, 3...`). Le test d'hétérogénéité des auteurs ne doit bloquer que les candidats suspects (`225/410` seuls ou numérotation > 30 / éparse) sans ancrage `P179`.
2. **Faux négatif — Grandes séries à auteurs multiples dans le temps** (ex. *Spirou et Fantasio*, *Blake et Mortimer*, *Astérix*) :
   * Un échantillon aléatoire de 5 tomes peut tomber sur 5 duos différents.
   * *Parade :* Ces séries ont un ancrage fort `P179` Wikidata + `460` BnF : elles ne passent donc même pas par le filtre de suspicion `225/410`.
3. **Faux positif — Collection éditoriale dédiée à un seul auteur** (ex. *Tout Simenon*, *Collection Stephen King* en poche) :
   * Tous les livres ont le même auteur (`Simenon`), donc le test d'hétérogénéité ne les piège pas.
   * *Parade :* La **confrontation Œuvre vs Édition** (le fait que l'œuvre originale sur Wikidata/Inventaire ou en grand format ne fasse pas partie d'une série, ou appartienne déjà à une autre série comme *Maigret*) démasque le conteneur éditorial.

---

## 3. Défi Algorithmique n°2 : Gérer les séries à redécoupage continu (Comics & Mangas type *Fables*, éditions doubles/compendiums…) — Zéro cas particulier en dur

### Le problème constaté
Dans les comics (*Fables*, *Sandman*, *Walking Dead*…) et les mangas (*Dragon Ball*, *Akira*, *Monster*…), une même saga est publiée sous **plusieurs découpages incompatibles** (ex. *Fables* édition classique en 22 tomes vs *Fables [Urban Nomad]* en 10 tomes vs *Fables Intégrale* en 11 tomes vs *Compendium* en 4 tomes).
* Le Tome 4 d’un découpage n’a **ni le même contenu, ni le même titre, ni la même couverture** que le Tome 4 d’un autre découpage.
* Si on fusionne tout par `(Série + N° de tome)`, on écrase les couvertures et on crée des faux manquants. Si on les laisse séparés sans lien, on perd la notion qu’il s’agit de la même franchise.

### Solution algorithmique proposée (Modèle à 3 niveaux : Franchise → Découpage → Tome)
Au lieu de forcer toutes les éditions dans un seul entonnoir `Série + Tome`, introduire une séparation propre :

1. **Modèle de données à 2 étages pour les séries :**
   * **Franchise / Méta-Série** (niveau macro, ex. *Fables*, ancré par le Q-ID Wikidata ou le tronc commun normalisé).
   * **Découpage Éditorial / Lignée** (niveau méso, ex. *Lignée A : Fables — Urban Comics*, *Lignée B : Fables — Urban Nomad*, *Lignée C : Fables — Intégrale*).
   * L’utilisateur qui scanne un tome de *Lignée B* voit sa progression et ses tomes manquants **dans Lignée B** (cohérence des couvertures, des titres et du nombre total de tomes), tout en ayant un lien discret vers les autres découpages de la même Franchise (*« Autres éditions de cette saga »*).
2. **Détection algorithmique d’un découpage distinct (zéro mot-clé codé en dur) :**
   * Lorsqu’un livre rattaché à une série `S` arrive avec un numéro de tome `N` (ex. `N = 4`), on compare son **titre propre** et sa **signature éditoriale (`Éditeur + Collection`)** avec le tome `N` déjà connu de `S` :
     * **Même titre normalisé** (ou très proche) → c’est simplement une **autre édition du même tome** (ex. réédition anniversaire) : elles fusionnent sous le même tome.
     * **Titres distincts** (ex. *« La Marche des soldats de bois »* vs *« Les Mille et Une Nuits »*) **ET** signature `Collection/Format` différente → c’est la preuve algorithmique que l’éditeur a créé un **autre découpage** de la série ! Le moteur rattache ce livre à un découpage distinct de la même Franchise, sans jamais avoir besoin de coder en dur `"Nomad"`, `"Deluxe"`, `"Perfect"` ou `"Bunko"`.
3. **Couverture transversale par arcs / tomes inclus :**
   * Lorsqu’une notice (via BnF `245$i` / `330$a`, Inventaire multi-`P629`, ou saisie utilisateur) indique qu’un volume d’un découpage (ex. *Intégrale*, *Compendium*, *Tome double*) couvre les tomes/épisodes `X à Y` de la lignée d’origine, on stocke cette plage génériquement (comme déjà amorcé pour les intégrales) afin de savoir que l’utilisateur possède déjà l’histoire, même sous un autre découpage.

### Cas limites identifiés (Stress-test du Défi n°2)
1. **Variantes de nom d'une même série sans changement de découpage** (ex. *« Astérix »*, *« Les Aventures d'Astérix »*, *« Une aventure d'Astérix le Gaulois »*, *« Astérix, la grande collection »*) :
   * *Risque :* Si on créait un découpage par nom de collection/série différent, *Astérix* exploserait en 4 sous-séries alors que les tomes 1 à 40 sont identiques !
   * *Parade :* **La règle d'or est le contenu, pas le libellé.** Avant de créer un nouveau découpage, on vérifie si `(Tome N, Titre du tome)` correspond à l'édition déjà connue. Tant que les titres des tomes concordent (*Le Cadeau de César* = *Le Cadeau de César*), on fusionne dans la **même lignée canonique** (et on enregistre simplement l'alias du nom de série).
2. **Titres génériques ou retraductions** (ex. manga dont le tome 1 s'appelle juste *« Tome 1 »* dans l'édition A et *« Tome 1 : L'Éveil »* dans l'édition B, ou deux traductions françaises d'un même tome) :
   * *Risque :* Une comparaison purement textuelle des titres croirait à deux contenus différents alors que c'est le même découpage.
   * *Parade :* Ignorer les titres génériques (`Tome N`, `Volume N`, `Série #N`) lors du test de divergence, et vérifier la **pagination** (un redécoupage double/compendium a ~1,7× à 3× plus de pages qu'un tome simple) ainsi que le `Q-ID` Wikidata de l'œuvre.
3. **Décalage de numérotation en cours de série** (ex. tomes 1–10 identiques, puis fusion de 2 tomes au n° 11) :
   * Un seul conflit sur le tome 11 ne doit pas casser les tomes 1–10 : le système doit pouvoir rattacher ponctuellement un volume comme « couvrant les tomes 11-12 » (logique d'intégrale/tome double) plutôt que de dupliquer toute la série.

---

## 4. Principe Architectural Non-Négociable : La Primauté Absolue de l’Utilisateur (« User Override First »)

Parce qu’aucun algorithme bibliographique ne couvrira 100 % des bizarreries éditoriales, l’application doit garantir dès sa conception qu’**une décision manuelle de l’utilisateur (ou de l’admin) est souveraine et irréversible par les robots**.

### Règle de hiérarchie des 3 couches de vérité
1. **Couche 1 — Vérité Automatique (Robots : BnF, SUDOC, Wikidata, Inventaire, CRON) :**
   * Alimentée et rafraîchie librement par le pipeline d’acquisition et les tâches de fond nocturnes.
   * *Ne peut jamais modifier un champ verrouillé aux couches 2 ou 3.*
2. **Couche 2 — Vérité Catalogue Maître (Correction Admin) :**
   * Chaque fiche maître conserve un jeu de champs verrouillés (`locked_fields`, ex. `["series", "publisher", "volumeNumber"]`).
   * Dès qu’un admin corrige un champ (unitaire ou par lot), ce champ passe dans `locked_fields` : aucun ré-enrichissement ultérieur ni scan d’un autre ISBN de la même œuvre ne pourra le réécraser.
3. **Couche 3 — Vérité Privée Foyer / Utilisateur (Priorité Maximale) :**
   * Toute action explicite de l’utilisateur dans son foyer — *rattacher/changer de série*, *« ce n’est pas une série / passer en one-shot »*, *« déclarer intégrale (tomes X-Y) »*, *exclure un tome d’une série*, *choisir ou uploader une couverture*, *modifier titre/auteurs/genres* — est enregistrée comme **surcharge utilisateur datée et verrouillée**.
   * **Garantie V2 :**
     * À l’affichage (fiches, vignettes de séries, statistiques), **Couche 3 > Couche 2 > Couche 1**.
     * Si un autre ISBN de la même œuvre est scanné plus tard, ou si le CRON ré-enrichit la série la nuit, **les choix de l’utilisateur restent intacts**.
     * L’utilisateur dispose toutefois d’un bouton explicite *« Réinitialiser avec les données automatiques »* s’il souhaite un jour lever son verrou.

---

## 5. Séparation Client / Serveur & Travail en Arrière-Plan (KISS / SOLID / DRY)

### Ce qui est bancal en V1
* **Client trop lourd (héritage PWA sans serveur) :** Le navigateur exécute encore de la logique serveur (`external-metadata`, `photo-book-resolution` fallback, `book-semantic`, `background-creation`, `stats.service` qui scanne tout IndexedDB, `sync.orchestrator` qui ré-humanise les `wd:`).
* **4 files d'attente concurrentes :** `photo_scan_jobs` (serveur), `pending_actions` (IndexedDB), `pending_creations` (IndexedDB), `pendingScansStore` (`localStorage`), plus des promesses piégées dans les composants Vue (`handleDetailRetryBnf` dans `ScanView.vue`) qui se perdent si on change de page.

### Règles d'or V2
1. **Serveur = Cerveau, Client = Interface + Cache offline :**
   * **100 % du métier** (résolution ISBN/BnF/Wikidata, consolidation, expansion séries, calcul des stats lourdes, compression/stockage des couvertures) vit sur le serveur.
   * **Le téléphone** ne fait que : afficher l’UI, lire son cache local (`IndexedDB` pour affichage instantané et consultation hors-ligne), et empiler dans **une unique file offline** les actions simples effectuées sans réseau (*ajouter, retirer, prêter, noter*).
2. **Moteur unique de Jobs Serveur (survit à la fermeture de page/app) :**
   * Toute opération > 1 seconde (**Photo IA**, **Relance BnF d’une tranche**, **Enrichissement d’une série**, **Création manuelle**, **Import/Traitement lot**) est un **Job Serveur** persisté en base (`background_jobs`).
   * L’interface s’y abonne via un **store global unique** (SSE ou polling léger global dans `App`, jamais dans une vue locale) : quitter la page ou fermer l’appli n’interrompt jamais rien, et rouvrir l’appli (même sur un autre appareil du foyer) affiche l’état exact.

---

## 6. Backend, CRON & Réglages Serveur

### Ce qui est bancal en V1
* `server/scheduler.ts` utilise un `setInterval(60 min)` qui teste `getHours() === 2` : si le serveur redémarre à 02h05, la passe nocturne est sautée ; et `drainEnrichmentQueueBatch(15)` n'est dépilé qu'une fois par heure, obligeant l'utilisateur à attendre jusqu'à 60 min pour voir les tomes d'une série enrichie.

### Architecture cible V2
1. **Séparer le Worker de file d'attente du CRON calendaire :**
   * **Worker continu (en arrière-plan)** : dès qu'un job ou un tome en `enrichment_queue` est inséré, il dépile en continu par petits lots avec un régulateur de débit propre (BnF/Wikidata) au lieu d'attendre 1 heure.
   * **CRON calendaire idempotent (en base `cron_runs`)** :
     * *Toutes les heures (à `:00`)* : envoi des digests Push / E-mail.
     * *Une fois par nuit (ex. `02h00`, rattrapée au démarrage si manquée)* : veille nouveautés des séries + découverte d'éditions sœurs + purge des vieux logs.

---

## 7. CSS, Ergonomie Transverse & Qualité de Code

### Ce qui est bancal en V1
* Un fichier monolithique `src/ui/styles/theme.css` de **2 302 lignes** mélangé avec des `<style scoped>` redondants dans les vues.
* Des `z-index` empilés manuellement (`2250`, `2350`), plusieurs modales codées chacune à la main, des réglages globaux dispersés (`focusin` auto-select dans `src/main.ts`, `useModalScrollable`).
* `Pinia` installé mais non utilisé par les stores `src/state/*.ts` (simples `reactive()` manuels).

### Architecture cible V2
1. **Design System CSS modulaire :** découper en couches strictes (`tokens.css` variables couleurs/espacements, `base.css` reset & typo, `primitives.css` boutons/inputs/badges/cartes, `layouts.css` grilles). Zéro CSS métier dupliqué dans les vues.
2. **Composants socles uniques :**
   * **Un seul `<BaseModal>`** (basé sur `<dialog>` natif / `Teleport`) gérant automatiquement l'empilement, `Escape`, le clic extérieur, le scroll interne et le focus trap.
   * **Un seul `<ToastHost>`** global pour tous les messages de succès/erreur (fini les `errorMsg` / `feedbackMessage` recodés dans chaque vue).
   * **Ergonomie globale centralisée** : auto-sélection du texte au focus (`v-auto-select` ou global propre), raccourcis clavier (`Escape`, `Enter`), états de chargement/désactivation cohérents.

---

## 8. Évaluation & Optimisation de la Stack Technique

| Brique | État V1 | Décision V2 | Pourquoi |
| :--- | :--- | :--- | :--- |
| **Front-End** | Vue 3.5 + Vite 8 + Pinia 3 (inutilisé) + Vue Router 5 | **Garder Vue 3 + Vite + Vue Router + utiliser vraiment Pinia** | Légère, réactive, maîtrisée. Utiliser Pinia pour de vrais stores propres et testables. |
| **PWA** | `vite-plugin-pwa` (Workbox) | **Garder** | Indispensable pour l'install mobile, le mode offline et le push. |
| **Backend** | Hono 4.13 + Node 22 + `better-sqlite3` (WAL) | **Garder + Hono RPC / Zod** | Ultra-rapide sur OptiPlex. Ajouter **Zod** (validation stricte + contrats partagés front/back typés de bout en bout). |
| **Cloudflare** | `wrangler` + `functions/` + `d1-gateway*` | **Supprimer totalement** | L'app est 100 % auto-hébergée ; supprimer ce vestige élimine la moitié de la complexité. |
| **Scan Caméra** | `html5-qrcode` (2.3.8) | **À réévaluer (`BarcodeDetector` natif + polyfill / `@zxing`)** | `html5-qrcode` est vieillissant et parfois lent sur iOS Safari. |
| **Tests** | Vitest 4 | **Garder + tests d'intégration SQLite `:memory:`** | Permet de tester chaque route API et chaque règle métier sans mocks fragiles. |

---

## 9. Arbitrages Produit, Données & Sécurité Validés (Passe CTO ↔ CEO)

### A. Nomenclature officielle des 3 espaces de données & Choix SQLite
Physiquement, le serveur utilise **un seul fichier SQLite en mode WAL** (`biblio.sqlite`, capable d'encaisser plusieurs centaines de milliers de livres et plusieurs milliers d'utilisateurs actifs sur l'OptiPlex sans RAM dédiée ni latence réseau), encapsulé derrière une **couche Repository SQL standard** (pour permettre un éventuel passage vers PostgreSQL plus tard si passage en multi-serveurs), et découpé logiquement en **2 espaces serveur étanches**, plus **1 cache sur l'appareil** :
1. **Le Catalogue Central (Serveur — Commun)** : source de vérité bibliographique partagée (œuvres, éditions, ISBN, franchises, découpages séries, tomes connus même non possédés). Modifié uniquement par les robots (Couche 1) et l'Admin (Couche 2).
2. **L'Espace Foyer & Compte (Serveur — Privé)** :
   * *Niveau Foyer (`library_id`)* : possessions, wishlist, prêts, alertes nouveautés, surcharges privées de fiches/couvertures/séries/intégrales (Couche 3).
   * *Niveau Utilisateur (`user_id`)* : identifiants, statut de lecture, note, notes perso, genres par défaut, amis suivis, préférences notifications/thème, quota IA.
3. **Le Cache Local (Appareil — Hors-ligne) & Protocole `PUSH d'abord, PULL ensuite`** : miroir léger dans IndexedDB + Cache API PWA pour consultation instantanée hors-ligne + une unique file d'actions offline datées (`outbox`).
   * **Garantie UX (zéro perte d'action hors-ligne) :** Au retour du réseau, le téléphone envoie **en priorité absolue (`PUSH`)** toutes ses actions hors-ligne (ex. livres achetés/passés en *Possédé*, prêts, notes) au serveur. Le serveur les applique **avant** que le téléphone ne récupère (`PULL`) les changements venus d'autres appareils. En cas de conflit simultané entre 2 membres sur le même champ, le serveur tranche au timestamp le plus récent (*Last-Write-Wins*) pour maintenir la cohérence.

### B. Stockage des couvertures (Pérenne + Rapide + Léger)
* **Côté serveur :** Chaque couverture retenue (source externe ou upload utilisateur) est téléchargée une fois, compressée en **WebP (~15–35 Ko)** et enregistrée **en fichier sur disque (`/data/covers/`)** (sauvegardé chaque nuit sur Google Drive). Même si Amazon ou la BnF supprime l'URL demain, l'image n'est jamais perdue. Zéro blob base64 dans SQLite + nettoyage nocturne des fichiers orphelins (> 30j).
* **Côté appareil :** Zéro base64 dans IndexedDB ; mise en cache binaire native par le **Cache API du Service Worker PWA** (`CacheFirst` sur `/api/covers/*`) → ouverture instantanée, hors-ligne natif, RAM et IndexedDB ultra-légers.

### C. Sécurité & Cycle de vie des Comptes
* **Authentification stricte :** Zéro fallback `userUri` ; 100 % des routes privées protégées par cookie `HttpOnly; Secure; SameSite=Lax`.
* **Succession foyer :** Si le `owner` quitte ou supprime son compte dans un foyer partagé, le membre le plus ancien devient automatiquement `owner`.
* **Admin sur base vierge :** Auto-promotion propre via variable `ADMIN_EMAIL` dans `.env` (ou 1er compte inscrit), sans commande SQL manuelle.
* **Séparation stricte Moi vs Admin :** L'interface personnelle est 100 % identique pour tout le monde ; aucune édition sur une fiche personnelle ne touche le Catalogue Central (tout changement central passe exclusivement par `/admin`).

### D. Règles Métier Validées
* **Photo IA 100 % Serveur :** L'appareil compresse et envoie la photo ; OCR Gemini, résolution BnF/SUDOC/Wikidata, état d'arbitrage et relances BnF vivent côté serveur (continuité totale mobile ↔ ordinateur, zéro perte si fermeture de l'app).
* **Suppression de livres (confirmation obligatoire + cas des livres prêtés) :** **Toute suppression** (unitaire ou en lot, même pour les livres non prêtés) exige une **modale de confirmation** anti-misclick. De plus, si un ou plusieurs livres de la sélection sont actuellement prêtés, une étape spécifique demande **individuellement pour chaque livre prêté** s'il faut annuler sa suppression ou le marquer rendu et supprimer quand même.
* **Accès Amis strict & Réservation Cadeau sur Wishlist (anti-spoiler) :** Seuls les amis/proches disposant explicitement du QR Code, du code `PUB-...` ou du lien partagé peuvent consulter les listes (aucun annuaire public ; possibilité de régénérer son code pour révoquer l'ancien). Sur la wishlist partagée, un ami **inscrit et connecté dans l'application** peut marquer *« Je l'offre »* (`wishlist_reservations`) — un visiteur non connecté qui clique voit un message clair l'invitant à se connecter ou créer son compte gratuit : les autres amis voient qu'il est déjà réservé (évite les doublons), mais **l'API masque totalement cette information au propriétaire et à son foyer** (zéro fuite réseau). La réservation s'efface automatiquement quand le livre passe en *Possédé*.
* **Pas de doublons physiques :** Hors intégrales (qui couvrent plusieurs tomes), 1 œuvre = possédée ou non.
* **Export utilisateur :** Bouton *Exporter ma bibliothèque* en **CSV** et **JSON** depuis Mon Profil.
* **Quotas IA Gemini :** Suppression du terme *BYOK* ; conservation de la clé API Gemini serveur avec quota mensuel géré par utilisateur et RAZ admin.

### E. Stratégie Clean Room V2 & Thèmes évolutifs
* **Clean Room & Sauvegarde V1 :** Création d'un tag Git `v1.0-archive` + snapshot complet de la base SQLite V1 et `/data/covers/` avant de démarrer la V2 sur une **base SQLite vierge**. On ne copie-colle pas la V1 : on réécrit proprement en réutilisant uniquement les briques pures et testées.
* **Migrations futures (V2 → V2.x) :** Système de migrations SQL incrémentales strictes + sauvegarde automatique avant migration dans `deploy.sh` + tests automatisés rejouant toutes les migrations de `0001` à `N`.
* **Design System « Thémable » (Multi-apparences) :** Architecture CSS 100 % basée sur des Design Tokens sémantiques (`[data-theme="..."]`), zéro couleur en dur dans les composants, permettant de changer facilement toute l'apparence et d'offrir plusieurs thèmes au choix de l'utilisateur (ex. *Éditorial Clair*, *Sombre*, *Chaleureux*).
* **Internationalisation (`i18n`) 100 % centralisée dès le jour 1 :** Zéro texte visible écrit en dur dans les vues ou composants front-end ; tous les libellés, boutons, placeholders et messages sont centralisés dans un dictionnaire unique typé (`locales/fr.ts`), permettant de traduire instantanément toute l'application dans d'autres langues en ne traduisant qu'un seul fichier.

---

## 10. Arbitrages Techniques Terrain (Post-déploiement V2)
* **BnF SRU en HTTPS IPv4 (`node:https`, `family: 4`) :** la BnF coupe désormais les requêtes HTTP port 80 (`ECONNRESET`) et certains handshakes `undici` (`fetch` par défaut Node 22) expirent. L'utilisation de `https://catalogue.bnf.fr/api/SRU` via `node:https` IPv4 forcé + `User-Agent` navigateur + `Accept: application/xml` répond de façon fiable en < 1 s.
* **Inventaire.io (`inv:...` + `invp:P2`) :** l'API `action=by-uris&uris=isbn:...` retourne les éditions sous leur URI canonique (`inv:...`) avec le hash image dans `invp:P2` (`https://inventaire.io/img/entities/<hash>`). Le connecteur résout désormais via `redirects` / `type === 'edition'` / `wdt:P212`, charge les relations `P629`/`P179`/`P50` manquantes et expose `searchSeriesUri` et `searchByText`.
* **Cascade multi-sources de couvertures avant WebP (`CoverService.resolveBestCoverFromCascade`) :** BnF `950$a` → Inventaire `invp:P2` → CDN Amazon Direct ISBN-10 → CDN Eyrolles/Dilicom H1400 (avec rejet explicite du placeholder exact de 63 601 octets) → OpenLibrary Covers ISBN → Apple Books / iTunes FR, le tout converti et dédupliqué en WebP sur `/data/covers/`.
* **Découverte de rattrapage pour l'expansion de séries :** si une série est créée sans `wikidata_qid` ni `bnf_ensemble_ids` (ex. depuis SUDOC seul), `SeriesGraphService.expandSeriesByGraph()` tente automatiquement `inventaire.searchSeriesUri` → `wikidata.searchSeriesQid` → `bnf.searchBySeriesName` (`460$3` → `bib.ens2bib`) et mémorise les identifiants découverts.
* **Cascade multi-modèles Gemini Vision (`gemini.connector.ts`) :** Google ayant retiré `gemini-2.5-flash` pour les nouveaux projets (`HTTP 404`), le connecteur tente une cascade résiliente (`gemini-3-flash-preview` → `gemini-flash-latest` → `gemini-3.1-flash-lite` → `gemini-2.5-flash-lite`) avec bascule automatique sur `404`, `429` et `503`.
* **Ergonomie Scan mobile (`ScanView.vue`) :** cliquer sur l'onglet *Rafale* ou *Scan simple* ouvre directement la fenêtre caméra `CameraBarcodeModal`.
* **Invariants universels de non-collision séries (`SeriesGraphService` + `text-normalize.util.ts`) :** deux tomes portant des numéros de tome connus et distincts ne fusionnent jamais (ni dans `mergeGraphWorks`, ni via `findBookInSeriesByNormalizedTitle`), une intégrale ne fusionne jamais avec un tome unitaire, et un titre générique (identique au nom de série ou `Tome N`) ne peut ni déclencher une correspondance sur le seul titre ni écraser un titre distinctif existant (ex. *Bug, Livre 1..4* face à BnF *Bug*).
* **Confrontation Œuvre vs Édition en Étage 2 (`ComparisonTableService` + `WikidataConnector.lookupWorkByTitleAndAuthor`) :** lorsqu'une édition (collector, réédition, coffret) est absente d'Inventaire (pas de `wikidataWorkQid` trouvé par ISBN), l'Étage 2 interroge Wikidata par `(Titre distinctif + Auteur)` sous **triple verrou strict** (label FR/EN normalisé exact + présence `P179` + nom de famille créateur `P50`/`P58`/`P110` en mot entier). Les identifiants de série (`bnfEnsembleId`, `wikidataSeriesQid`, `volumeNumber`) ne sont hérités que des colonnes compatibles avec la série retenue (`isCompatibleSeriesName`), empêchant toute collection éditoriale hétérogène (ex. *Les archives Tintin*) de contaminer la série canonique (*Les Aventures de Tintin*).
* **Auteurs, couvertures & Photo IA (passe terrain KISS/DRY) :**
  * Recherche et fiche Auteur (`matchesAuthorName` + `GET /api/authors/:name`) : comparaison insensible aux accents/tirets/ordre (corrige le `LIKE` SQLite sur *Hergé*, *Jean-Pierre Gibrat*…), vraie requête BnF par auteur seul (`bib.author all`), et affichage ordonné *Dans votre bibliothèque* (séries puis indépendants) suivi des *Autres œuvres de cet auteur* (séries puis indépendants via BnF/Inventaire).
  * Couvertures éditeurs prioritaires (`CoverService`) : les images `commons.wikimedia.org` (`P18` Wikidata, souvent des photos thématiques non couvertures) sont reléguées en tout dernier recours après la cascade ISBN éditeur (BnF → Inventaire → Amazon → Eyrolles → OpenLibrary).
  * Photo IA : cascade progressive BnF + Inventaire sans coller le numéro de tome dans `bib.title all` + scoring de pertinence, et validation asynchrone `photo_commit` sur le `BackgroundWorker` existant (concurrence 4, progression SSE, zéro timeout).
  * Remplacement « Ce n'est pas le bon livre » : composant unique `BookLookupModal.vue` partagé entre Photo IA et `BookEditView.vue` + endpoint `POST /api/books/:bookId/replace` transférant statut foyer, lecture/notes et prêts actifs vers le nouvel ouvrage sans altérer le Catalogue Central.
* **Fiabilisation séries, médias RDA, couvertures et Photo IA (passe terrain #2) :**
  * **Anti-faux découpages & Fusion de séries en 2 clics (`SeriesGraphService`, `SeriesDetailView.vue`, `SeriesAttachModal.vue`) :** une intégrale, un hors-série, un tome sans numéro ou une édition luxe sans collection distincte (ex. *Astérix en Lusitanie* 126 p.) ne déclenche plus de découpage séparé sur la pagination seule. Bouton direct *« Fusionner cette série… »* dans l'en-tête des pages Série (avec pré-tri des découpages frères en haut de liste et fusion transitive Couche 3 via `mergeEntireSourceSeriesId`).
  * **Séparation structurelle des médias via ISO/RDA `051$a` (`intermarc-parser.ts`, `bnf.connector.ts`, `SeriesGraphService`) :** rejet natif des supports multimédias/DVD (`245$d = Multimédia multisupport`, `051$a = tdi/prm/spw` et codes-barres presse `378`/`330`/`977` en expansion de série), distinction algorithmique `illustrated` (`051$a = sti` / illustrateurs) vs `text_only` (`051$a = txt` seul) empêchant une série BD (ex. *Nestor Burma* Casterman) d'absorber les romans homonymes (*Presses de la Cité* / *R. Laffont*) tout en les séparant proprement dans la même Franchise. Ajout du secours ISBN-10 dans `bnf.lookupByIsbn` pour les notices BnF antérieures à 2007.
  * **Photo IA — Secours pseudonyme & filtrage bruit Inventaire (`photo-ai.service.ts`) :** filtrage par recouvrement lexical (`>= 0,4`) sur la recherche floue Inventaire et ajout d'une passe de secours *Titre seul* si `0` résultat avec auteur sur un titre distinctif (`>= 6` car., non générique — ex. *Pappa in Afrika* / *Anton Kannemeyer* indexé sous *Joe Dog* à la BnF).
  * **Résilience Inventaire & Galerie « Rechercher d'autres couvertures » (`http-client.ts`, `inventaire.connector.ts`, `cover.service.ts`, `library.service.ts`) :** les `HTTP 404` normaux (ISBN absent d'Inventaire) ne comptent plus comme pannes dans le circuit-breaker (uniquement `>= 500` / timeouts, seuil `6`, cooldown `30 s`), évitant de couper Inventaire durant les expansions en rafale (ex. *Universal War One*). `listBookCoverCandidates(..., external=1)` fonctionne désormais même sans ISBN (éditions sœurs Inventaire `P629`, CDN Amazon/Eyrolles/OpenLibrary, BnF, Google Books et Apple Books) avec vérification réelle en parallèle avant affichage.
* **Fiabilisation Gemini 503, sélection d'édition Photo IA, séries décalées & import CSV/JSON/Excel (passe terrain #3) :**
  * **Gemini 503 explicite & Réessai sans re-consommer le quota (`gemini.connector.ts`, `photo-ai.service.ts`, `POST /api/jobs/photo/:jobId/retry-ocr`, `ScanView.vue`) :** les payloads JSON bruts renvoyés par l'API Gemini (`503`, `429`, `5xx`, timeout) sont traduits en messages français clairs, et un bouton *« Réessayer l'analyse »* ré-empile le lot existant sur le serveur à partir de l'image déjà stockée sans re-décompter le quota mensuel IA.
  * **Persistance d'édition Photo IA & Couverture d'édition choisie en Couche 3 (`photo-ai.service.ts`, `PhotoItemModal.vue`) :** `executePhotoOcrJob` fusionne désormais les arbitrages déjà enregistrés en base avant chaque `reportProgress` / écriture finale (zéro écrasement en cours de lot) ; au commit, si l'utilisateur a choisi une édition alternative dans le lot, sa couverture WebP est explicitement appliquée en Couche 3 (`overrides.coverKey`) afin de primer sur l'édition historique du Catalogue Central.
  * **Séries à numérotation décalée (*Tintin* Casterman vs Wikidata), *Boule & Bill* et fusion dédupliquée (`text-normalize.util.ts`, `ingestion.service.ts`, `series-graph.service.ts`, `series-management.service.ts`) :** unification `&` ↔ `et` dans `extractFranchiseBaseName` (*Boule & Bill* === *Boule et Bill*) ; correspondance de tome dans `resolveIsbns` par ordre strict *ISBN → QID Wikidata → titre distinctif → numéro de tome vérifié par `compareSameVolumeContent`*, préservant la numérotation canonique Wikidata et évitant la création de faux découpages (`Tintin (Casterman)`) ; lors d'une fusion complète de série (`mergeEntireSourceSeriesId`), les doublons non possédés de la cible sont masqués en Couche 3 (`hiddenSeriesIds`) et l'exemplaire possédé hérite du numéro/ordre de tri s'il en était dépourvu.
  * **Sérialisation `HttpClient` & 429 ponctuel (`http-client.ts`) :** `waitSlot` réserve atomiquement le créneau `nextAllowedAt` entre appels concurrents (`photo_commit`), et le cooldown de 10 min sur `HTTP 429` est réservé à `google_books` (quota journalier), tandis que `inventaire` / `wikidata` / `bnf` effectuent une pause courte (3 s) + 1 réessai automatique.
  * **Import utilisateur CSV / JSON / Excel `.xlsx` à pivot ISBN-13 strict (`collection-import.util.ts`, `collection-import.service.ts`, `POST /api/me/import`, `ProfileView.vue`) :** tâche de fond serveur `collection_import` suivie en temps réel via SSE. **Invariant strict validé produit :** tout ouvrage importé passe obligatoirement par un ISBN-13 vers `IngestionService.resolveIsbns` (ISBN fourni dans le fichier ou retrouvé via `PhotoAiService.searchBookCandidates` BnF/Inventaire) ; aucune fiche sans ISBN n'est créée en Couches 3–4, les lignes sans ISBN résolu étant listées dans le rapport final `unmatched`. Les statuts foyer (`owned`/`wish`), intégrales et états de lecture personnels (`reading_state`) sont restaurés proprement (et les lignes `none` issues d'un export V2 sont ignorées).
* **Passe de conformité architecturale V2 (audit Clean Room) :**
  * **Zéro image base64 dans SQLite (`photo-ai.service.ts`) :** `createPhotoJob` ne stocke plus `imageDataUrl` dans `background_jobs.payload_json` ; seule la référence disque WebP HD (`previewCoverKey`) est enregistrée en base et relue depuis `/data/covers/` lors de l'appel Gemini (et lors d'un `retry-ocr`).
  * **Zéro SQL brut dans les services & SQL standard portable (`admin.repo.ts`, `admin.service.ts`, `notification.repo.ts`, `library.repo.ts`, `user.repo.ts`) :** extraction des 9 requêtes SQL d'`AdminService` dans `AdminRepository` et remplacement des 5 `INSERT OR IGNORE/REPLACE` spécifiques SQLite par `INSERT ... ON CONFLICT DO NOTHING / DO UPDATE` (compatible SQLite et PostgreSQL).
  * **Nettoyage vestige Cloudflare :** suppression définitive de `wrangler.toml` et alignement de la documentation sur BnF HTTPS IPv4.
* **Correctif anti-régressions séries & connecteurs (passe terrain #4) :**
  * **`User-Agent` par source & anti-saturation Inventaire (`http-client.ts`, `photo-ai.service.ts`, `inventaire.connector.ts`) :** `BROWSER_USER_AGENT` réservé exclusivement à `bnf` ; `User-Agent` API standard (`BiblioCollection/2.0`) vers `inventaire`, `wikidata`, `sudoc` et `openlibrary` (évite les `HTTP 429` immédiats sur Inventaire.io). En Photo IA, `inventaire.searchByText` est appelé uniquement en filet de secours si la BnF n'a pas trouvé de candidat suffisant (divise par ~10× la charge Inventaire sur les lots de 20+ livres). `HttpClient` ne met jamais en cache `external_cache` une réponse HTTP 200 contenant un payload JSON d'erreur (`{"error": ...}`, ex. `cirrussearch-too-busy-error` Wikidata).
  * **Norme ISBD/MARC `280$c` / `215$c` pour les BD pré-2015 (`intermarc-parser.ts`) :** en complément de RDA `051$a`, la présence d'illustrations intérieures dans `280$c`/`215$c` (`ill. en coul.`, hors `couv. ill.` seul et hors Dewey `8xx`) classe la notice en `illustrated` (`BD`), corrigeant les notices BnF antérieures à 2015 (*Le Petit Spirou*, *Tintin*) tout en maintenant la séparation stricte BD vs Roman (*Nestor Burma*).
  * **Découverte Wikidata par la preuve & trous BnF (`wikidata.connector.ts`, `series-graph.service.ts`) :** `searchSeriesQids` interroge Wikidata avec `uselang=fr`, classe en priorité les séries de BD/livres (bilingue FR+EN, rejet des franchises média, jeux vidéo, films, personnages et séries TV), bascule automatiquement `&` → `et` si vide (*Boule & Bill* → `Q59991`), et `expandSeriesByGraph` ne verrouille `wikidata_qid` en base que si le candidat renvoie effectivement des œuvres (`Q105030970` 0 œuvre → bascule vers `Q42490`). En absence de graphe, `needsBnfDiscovery` se déclenche également lorsqu'un ensemble BnF présente des trous de numérotation (`minVol > 2` ou couverture `< 50 %`).
* **Refonte Étage 3 unifié (Phases 3A / 3B / 3C) & Worker 2 voies (passe architecture V2) :**
  * **Phase 3A — Liste complète sans trous (`bnf.connector.ts`, `series-graph.service.ts`, `text-normalize.util.ts`) :** découverte multi-dossiers BnF sans verrouillage sur le seul auteur du tome scanné (jusqu'à 5 ensembles compatibles, en excluant les collections kiosque/compilations préfixées type `La collection…` / `Diptyque…`) + détection et bouchage actif des trous `1..maxVol` et sondage de la suite immédiate (`maxVol + 1..3`) via `bnf.searchSeriesVolume`.
  * **Phase 3B — Réutilisation Étage 1 (`BookIdentifierService`) :** pour chaque tome de la série dépourvu d'ISBN, identification ciblée BnF (puis Inventaire en secours) sous triple verrou strict anti-faux-positif (rejet non-livres, intégrales, mauvais médias, collections décalées et homonymes).
  * **Phase 3C — Réutilisation Étage 2 (`IngestionService.enrichExistingBookByIsbn` + job `series_enrich_volumes`) :** passage de chaque ISBN résolu dans le même moteur `ComparisonTableService` + `CoverService` que le scan code-barres, sans boucle infinie (`series_expand` jamais relancé), sans écraser le numéro canonique ni les verrous Couche 2 / Couche 3, et indépendance totale vis-à-vis des pannes d'Inventaire.io.
  * **Worker 2 voies (`BackgroundWorker`, `job.repo.ts`) :** découplage de la voie interactive (`photo_ocr`, `photo_commit`, `collection_import`) et de la voie catalogue (`series_expand`, `series_enrich_volumes`, `book_enrich`) pour qu'un enrichissement de série ne bloque jamais les scans/photos (et réciproquement), avec progression SSE temps réel et bandeau i18n dans `App.vue`.
* **Doctrine « L’Œuvre comme Abstraction » (arbitrages CEO/CTO — Lots 1 à 4) :**
  * **Pourquoi :** l'utilisateur collectionne des **Œuvres** (ex. *Tintin T.11 — Le Secret de La Licorne*, peu importe le tirage Casterman de 1993 ou 2006) ; l'ISBN reste le pivot d'entrée physique (scan code-barres) et le moteur technique d'enrichissement multi-éditions, mais ne doit plus fragmenter la recherche textuelle, la Photo IA ni la sélection de couvertures. Zéro migration SQL nécessaire grâce au modèle V2 `books` ↔ `N book_editions` ↔ `series` ↔ `franchises`.
  * **Lot 1 — Consensus visuel de couvertures par `dHash` serveur (`cover-dhash.util.ts`, `cover.service.ts`, `book-identifier.service.ts`, `ingestion.service.ts`, `library.service.ts`) :** lors de l'enrichissement multi-éditions (jusqu'à 4 ISBN frères par œuvre), calcul serveur d'empreintes perceptuelles `dHash` 64 bits (`sharp`, < 2 ms/image) et vote majoritaire par regroupement visuel (seuil distance de Hamming ≤ 8) : la couverture majoritaire la plus nette est élue pour le Catalogue Central, les couvertures visuellement distinctes sont stockées en WebP sur les éditions sœurs, et la galerie `listBookCoverCandidates` élimine tout doublon quasi-identique. *Alternative écartée :* calcul `dHash` côté navigateur (rejeté : double téléchargement + violations CORS + violation de la règle client mince).
  * **Lot 2 — Gestion complète des Intégrales (`bnf.connector.ts`, `series-graph.service.ts`, `series-management.service.ts`, `series.routes.ts`, `stats-export.service.ts`, `SeriesDetailView.vue`, `BookDetailView.vue`, `ProfileView.vue`) :**
    * Découverte automatique des intégrales officielles BnF (`searchSeriesIntegrals`, regroupées par œuvre abstraite) lors de l'extension de série (Option A validée).
    * Normalisation franchise (`extractFranchiseBaseName`) retirant les préfixes/suffixes `L'intégrale…` afin que l'ajout d'une intégrale d'une série non référencée déclenche l'extension de **toute la série normale** (tomes unitaires + intégrales), et non une série dédiée aux seules intégrales.
    * Affichage séparé dans `SeriesDetailView.vue` : tomes unitaires en première intention, intégrales dans un bloc repliable dédié (`Intégrales (N)`) + bouton `+ Ajouter une intégrale`.
    * Création non-destructive (`POST /api/series/:seriesId/integrals`) : déclarer une intégrale depuis un tome unitaire crée/associe une **œuvre intégrale distincte** (avec résolution BnF de son ISBN si existante) et allume `ownedViaIntegral` sur les tomes couverts sans jamais écraser le tome unitaire.
    * Comptage validé : les statistiques globales (`ProfileView`) comptent les **livres physiques possédés** (`kpis.ownedCount`, avec sous-indicateur discret `kpis.coveredVolumesCount` si > `ownedCount`), tandis que la progression d'une série compte les **tomes unitaires couverts** (possédés en direct ou via une intégrale) sur le total de tomes unitaires.
  * **Lot 3 — Recherche textuelle centrée « Œuvre abstraite » (`catalog.repo.ts`, `search.service.ts`, `ScanView.vue`) :**
    * **Catalogue Central d'abord :** si la série/œuvre est déjà présente et étendue en SQLite local (unification `&`/`et`, recherche par nom de série dans le champ titre, et inclusion automatique des intégrales couvrant le tome N), court-circuit total des API externes (`0` appel réseau).
    * **Série → Bon Tome + Intégrale couvrante (lecture seule sans pollution DB) :** si absente de la base, consultation légère du graphe canonique (Wikidata + `BookIdentifierService`) et `bnf.searchSeriesIntegrals` (tous mis en cache dans `external_cache`), agrégation des résultats externes par œuvre abstraite (`editionCount`), tri tome unitaire exact #1 + intégrale couvrante #2, sans écrire dans `books`/`series` avant validation utilisateur.
  * **Lot 4 — Photo IA unifiée sur l’Œuvre abstraite & sélecteur visuel de couvertures Couche 3 (`photo-ai.service.ts`, `jobs.routes.ts`, `PhotoItemModal.vue`, `scan.store.ts`, `ScanView.vue`) :**
    * Même court-circuit Catalogue Central local (`0` appel BnF si l'œuvre est déjà en base) + même résolution canonique Série → Tome N + regroupement des rééditions externes d'un même album en **1 Œuvre abstraite** (avec `siblingIsbns`, `editionCount` et `coverOptions` visuellement dédupliquées).
    * Nouvel endpoint à la demande `GET /api/jobs/photo/:jobId/items/:itemId/covers` : retourne instantanément (0 ms) les couvertures locales si l'œuvre est au Catalogue Central, ou exécute un consensus multi-éditions `dHash` (max 4 éditions) à l'ouverture de la modale si œuvre nouvelle.
    * Choix explicite persisté (`selectedCoverKey` / `selectedCoverUrl`) et appliqué exclusivement en **Couche 3 Foyer (`overrides.coverKey`)** au commit, garantissant que chaque foyer choisit et conserve *sa* couverture sans jamais altérer le Catalogue Central.
* **Fiabilisation multi-sources des titres FR & numéros de tome corrompus (passe terrain #5) :**
  * **Wikidata `frwiki` & Phase 3C BnF FR (`wikidata.connector.ts`, `ingestion.service.ts`) :** lorsque `labels.fr` sur Wikidata est absent ou est un copier-coller strict d'un label étranger (`en`/`it`/`de`/`es`, ex. `Q30728090` *« Asterix e la corsa d'Italia »*), le titre de l'article Wikipédia français `frwiki` (nettoyé d'un éventuel suffixe de désambiguïsation `(...)`) prévaut ; en Phase 3C, un titre français officiel BnF/SUDOC corrige également un titre Wikidata non verrouillé lorsque le Q-ID correspond.
  * **Arbitrage BnF `460$v` corrompu vs SUDOC `461$v` structuré (`intermarc-parser.ts`, `comparison-table.service.ts`, `series-graph.service.ts`) :** `parseMarcRecord` expose `hasStructuredEnsembleVolume` (`true` uniquement quand `460$v`/`461$v` porte un vrai numéro de tome valide et non une année comme `2023` sur *Animal Jack* T.8). Dans le Tableau Comparatif comme en Phase 3A (pour les rares notices BnF suspectes), le SUDOC muni d'un `461$v` structuré propre corrige automatiquement le numéro de tome et le titre.
  * **Protection anti-bruit étranger & éditions club (`inventaire.connector.ts`, `ingestion.service.ts`) :** `inventaire.fetchSeriesWorks` écarte les fiches locales `inv:` non numérotées et sans aucune métadonnée/ISBN francophone ; `ingestion.resolveIsbns` protège les œuvres canoniques Wikidata contre tout écrasement par une réédition à numérotation club décalée (ex. France Loisirs).
* **Ordonnanceur réseau prioritaire & Cascade couvertures multi-éditions avant iTunes (passe terrain #6) :**
  * **Pourquoi :** l'audit de production sur *La collection Spirou et Fantasio* (éditions kiosque `9782815206xxx` absentes des CDN Amazon/Eyrolles/OpenLibrary) a montré que les 53 tomes tombaient tous en rafale sur Apple iTunes Search API (~100 appels en 34 s), déclenchant le rate-limit Apple (`HTTP 403/429` ~20 req/min) et laissant les tomes 21+ sans couverture alors que *Spirou et Fantasio en albums* disposait déjà de 64/64 couvertures en local.
  * **Ordonnanceur prioritaire par domaine (`request-priority.ts`, `http-client.ts`, `background-worker.ts`) :** file unique par domaine externe (`bnf`, `sudoc`, `inventaire`, `wikidata`, `google_books`, `openlibrary`, `itunes` = 1 req / 3,2 s, `covers_cdn` = 4 max) avec propagation automatique de priorité via `AsyncLocalStorage` (`high` requêtes utilisateur interactives **préempte systématiquement** `low` tâches de fond `series_expand`/`series_enrich_volumes`/CRON) + fusion des requêtes identiques simultanées (*in-flight coalescing*).
  * **Cascade couvertures multi-éditions en 3 niveaux avant iTunes (`catalog.repo.ts`, `cover.service.ts`, `ingestion.service.ts`) :**
    1. *Niveau 1* : CDN directs (Amazon, Eyrolles, OpenLibrary) sur les ISBNs connus de l'ouvrage (sans iTunes) ;
    2. *Niveau 2a (0 ms local)* : réutilisation instantanée d'une couverture WebP déjà présente sur un autre découpage de la même franchise ou sur un ouvrage local de même titre distinctif + auteur/série compatible ;
    3. *Niveau 2b (éditions sœurs)* : recherche d'ISBNs d'éditions sœurs (Graphe Inventaire `P629` + `BookIdentifierService` avec retrait sûr des préfixes kiosque `stripCompilationSeriesPrefix` uniquement sur titre distinctif) → réutilisation instantanée si l'ISBN appartient déjà à un livre compatible couvert, sinon consensus `dHash` CDN sur les éditions sœurs (zéro appel iTunes) ;
    4. *Niveau 3 (dernier recours régulé)* : Apple Books / iTunes FR (1 seule requête régulée par ouvrage) avec backoff automatique sur `HTTP 429/403` et détection `wasItunesRateLimitedSince`.
  * **Zéro couverture oubliée (`job.repo.ts`, `app.ts`, `cron-scheduler.ts`) :** support de `payload.runAfter` dans `JobRepository.claimNextPendingJob` (reprise différée automatique +75 s si `rateLimitedCount > 0`, jusqu'à 2 relances, sans migration SQL) + filet de rattrapage nocturne CRON (jusqu'à 3 séries ayant des couvertures manquantes par nuit, en priorité `low`).
  * **Hygiène intégrales BnF (`bnf.connector.ts`) :** `searchSeriesIntegrals` rejette les notices étrangères (`language !== 'fr'/'fre'`) et exige que les séries d'un seul mot court (≤ 5 car., ex. *Polo*) correspondent au début du titre/série (élimine *"Marco Polo il Milione"*).
  * **Séries d’albums imprimés Wikidata/Inventaire, anti-écrasement ISBN & rafraîchissement live (`wikidata.connector.ts`, `inventaire.connector.ts`, `series-graph.service.ts`, `cover.service.ts`, `SeriesDetailView.vue`) :**
    * `searchSeriesQids` (Wikidata) et `searchSeriesUri` (Inventaire) privilégient explicitement les séries d’albums imprimés (`en albums` / `série d’album` / `printed books`, ex. `Q102237771` *Spirou et Fantasio en albums*) devant les séries de prépublications magazines (`Q1130014` 126 histoires) ; le SPARQL exclut les sous-séries dérivées (`P31 = Q14406742` / `Q277759`, ex. *Le Spirou de…*).
    * `SeriesGraphService.expandSeriesByGraph` interdit à un tome du graphe sans ISBN ou de titre divergent d’écraser le titre distinctif d’un livre existant muni d’un ISBN vérifié.
    * `CoverService.searchItunesCoverUrls` contrôle la correspondance `trackName`/`collectionName` (`tokenOverlapRatio >= 0,6`) pour éliminer les couvertures génériques iTunes hors-sujet.
    * `SeriesDetailView.vue` écoute les événements SSE (`targetSeriesId`) pour afficher la progression en direct et recharger silencieusement la grille au fil de l’arrivée des couvertures.
  * **Protection des séries à redécoupage éditorial (Mangas & Comics multi-éditions — `series-graph.service.ts`, `intermarc-parser.ts`, `category-classifier.ts`, `comparison-table.service.ts`) :**
    * **Ancrage sur l’édition graine unitaire :** `expandSeriesByGraph` précharge d’abord le dossier BnF porté par le tome unitaire scanné (les intégrales seules ne contraignent jamais l’expansion unitaire), puis soumet le graphe Wikidata/Inventaire, chaque dossier BnF découvert (`searchBySeriesName`) et chaque sondage de trou (`searchSeriesVolume`) à `assessSeriesCutCompatibility` / `isWorkCompatibleWithEditionProfile`.
    * **Hiérarchie sans régression Romans & BD franco-belges :**
      1. Si ≥ 2 titres de tomes communs correspondent sans contradiction → **fusion toujours autorisée** (protège *Harry Potter* Gallimard↔Folio, *Dune* Laffont↔Pocket, *Lucky Luke* Dupuis↔Dargaud, *Astérix*, *Spirou*).
      2. Contradiction de titres au même numéro `N` ou décalage majeur (`≥ 3` tomes, ex. *Dragon Ball* Glénat 42 tomes vs Glénat Double *La menace* T.4/T.7 & *Les androïdes* T.15/T.29, vs Hachette *Végéta*/*Commando Ginyu*) → **rejet du découpage rival**.
      3. Graphe externe majoritairement étranger (ex. coupe anglaise Viz Media) face à un dossier BnF français → **rejet**.
      4. Écart de pagination médiane (`≥ 60 %` ou `≥ 28 %` avec éditeur/tag d’édition distinct type `Full Color` / `Perfect` / `Urban Nomad` / `Hachette`) → **appliqué uniquement aux livres illustrés (`BD`/`Manga`/`Comics`), jamais aux romans** (et sans exclure les tomes finaux +30 % du même éditeur comme *Dragon Ball* T.41–42).
    * **MARC `2 vol.` & classification `Manga` :** les coffrets multi-volumes (`280$a = 2 vol. (384 p.)`) passent automatiquement en `isIntegralHint = true` ; `ComparisonTableService` agrège les noms de collection de toutes les sources (préservant BnF `410$t = Shonen manga` / `Collection Manga`) et `classifyBookMetadata` reconnaît les indicateurs FR (`shônen`, `shôjo`, `bandes dessinées japonaises`, `741.595 2`).
* **Durcissement post-benchmark 1 080 livres — Vagues 1 & 2 (passe terrain #7) :**
  * **Pourquoi :** le benchmark automatisé sur 1 080 entrées réelles (`tests_fusionnes.csv` vs `reponses_complet_1080.csv`, 95,3 % trouvés, 0 erreur Docker) a mis en évidence 2 causes racines P0 (`expandSeriesByGraph` écrasant les catégories `Manga`/`Roman`/`Comics` en `BD` + requêtes texte envoyant bruts les marqueurs `(BD)`/`(manga)`/`Tome N`/`deluxe` à la BnF) et 3 raffinements P1 (libellés non-latins type amharique `ሃሪ ፖተር`, collections/cycles fragmentés et intégrales).
  * **Vague 1 — Catégorisation 2 paliers & pré-nettoyage recherche texte (`intermarc-parser.ts`, `category-classifier.ts`, `series-graph.service.ts`, `ingestion.service.ts`, `search-query.util.ts`, `photo-ai.service.ts`) :**
    * Extraction algorithmique de la langue originale (`041$h` InterMarc, `101$c` UNIMARC, Wikidata `P407`/`P495`) : un ouvrage graphique traduit du japonais/coréen passe en `Manga`, traduit de l'anglais en `Comics`, tandis qu'un roman japonais/anglais reste `Roman` et qu'une BD française marquée BISAC `"Comics & Graphic Novels"` reste `BD`.
    * Séparation stricte **Palier 1 (signaux structurels : Dewey, RAMEAU, langue originale)** vs **Palier 2 (résumé nettoyé des mentions *"adapté en BD/manga/film"*)** + champ `confidence: 'explicit' | 'fallback'` : `expandSeriesByGraph` ne rétrograde jamais la catégorie d'un tome déjà en base et propage la catégorie de la graine aux squelettes ; `enrichSingleSeriesVolume` promeut la catégorie dès qu'un draft multi-sources est `explicit`.
    * Pré-nettoyage pur `parseSearchIntent` : extrait `(BD)`/`(manga)`/`(comics)`/`(roman)`, numéros de tome collés (`Tome 19`, `t2`, chiffres romains `Tome II`) sans altérer les titres numériques (`1984`, `PH10`), intégrales/plages (`T.1-3`, `Tomes 1 & 2`), et qualificatifs d'édition (`deluxe`, `perfect`, `black edition`, `grand format`, éditeur) relâchés uniquement en passe de secours tout en bonifiant le scoring. Garde-fou anti-hors-sujet (`tokenOverlapRatio >= 0,25`), séparation média dans `isSameAbstractWork` & court-circuit local, pénalité guides dérivés et promotion de l'édition de référence devant les éditions club (`France Loisirs`) lors de la fusion abstraite.
  * **Vague 2 — Libellés latins, anti-fragmentation, intégrales & Labo CSV (`text-normalize.util.ts`, `inventaire.connector.ts`, `wikidata.connector.ts`, `collection-guard.service.ts`, `series-graph.service.ts`, `integral.util.ts`, `intermarc-parser.ts`, `comparison-table.service.ts`, `AdminBenchmarkTab.vue`) :**
    * `isLatinScriptLabel` empêche tout libellé non-latin (`ሃሪ ፖተር`) d'être retenu par Inventaire ou Wikidata.
    * `CollectionGuardService` soumet tout nom préfixé `Collection …` / `Bibliothèque …` (même issu de `P179` ou `460`) au test mathématique d'hétérogénéité des auteurs (bloque `Collection Blanche`, `Bibliothèque Charpentier` tout en validant une vraie série mono-auteur).
    * `SeriesGraphService` interdit la fragmentation des cycles littéraires en prose (*La Comédie humaine*, *Voyages extraordinaires*) par collection poche et empêche qu'un tag de collection générique absent du squelette Wikidata (*Ki-oon seinen* sur *Beastars* à pagination identique) ne duplique un découpage manga.
    * Intégrales : exclusion des plages d'années (`1946-1948`) dans `parseIncludedVolumeNumbers`, exclusion de `texte/version/édition/œuvre intégrale` et de `2 vol.` sur romans isolés, et lecture des champs MARC `250`/`205` (édition) et `300`/`311`/`327` (notes/dépouillement) via `extractIncludedVolumesFromEditorialText` pour enrichir détection et `includedVolumes`.
    * Labo Tests CSV : bouton « Charger CSV de correction » toujours visible avec préchargement et lancement automatique de la notation à la fin d'un import.
* **Entonnoir omnibox, recours officiels & durcissement exploitation — Vague 3 (passe terrain #8) :**
  * **Pourquoi :** le 2e benchmark sur 1 080 nouveaux livres (`imp_aa39bbec7dcd`, `tests_fusionnes_v2.csv`) a validé les Vagues 1 & 2 (`38,7 %` parfaits vs `22,6 %`, `88,1 %` précision champs vs `84,6 %`, `80,5 %` média vs `60,8 %`), tout en révélant 3 derniers gisements : saisies omnibox Titre+Auteur mélangés (57 % des 46 échecs), sujets génériques anglophones Open Library (`"Comic books, strips, etc."` → 23× `BD → Comics`) + Dewey `895.1`, et croissance d'`external_cache` (`365 Mo` / `475 Mo` SQLite face au `tmpfs` `/tmp` 128 Mo).
  * **Catégorisation & hygiène sources (`category-classifier.ts`, `intermarc-parser.ts`, `bnf.connector.ts`, `google-books.connector.ts`, `openlibrary.connector.ts`, `collection-guard.service.ts`, `series-graph.service.ts`) :** exclusion des sujets bibliographiques anglophones génériques (`"Comic books, strips, etc."`, `"Graphic novels"`) du classement `Comics`, correction Dewey Poésie/Théâtre vers le 3e chiffre `8[1-8][12]` (corrige simultanément les `16×` Théâtre/Poésie classés Roman et la littérature chinoise `895.13`), lecture ISBD `245$f`/`200$g` (`traduit du japonais/coréen/anglais`), rejet des EAN presse `378…` et titres non-latins sur tous les connecteurs, rejet des faux ensembles `Œuvres complètes`, protection des séries à 1-2 lettres (`"X"`) contre les préfixes à tiret (`X-O Manowar`), et héritage `Manga`/`Comics` sur les intégrales BnF sans `041$h`.
  * **Entonnoir recherche texte strictement progressif (`search-query.util.ts`, `photo-ai.service.ts`) :** support tomes décimaux (`1.5`), extraction tome+auteur au milieu (`Arslan T5 Arakawa`), exclusion des mots génériques (`Intégrale`/`Cycle`/`Tome`) du garde-fou anti-hors-sujet + exigence de série, préférence FR + titre exact + roman original face aux adaptations BD, court-circuit dès match haute confiance ; **uniquement si 0 résultat pertinent** : (F1) BnF `bib.anywhere`, (F2) découpage ciblé Titre/Auteur (max 2–3 coupes sous double verrou titre+auteur), (F3) API officielles Google Books texte & Open Library texte (100 % conforme CGU, zéro scraping).
  * **Exploitation SQLite & Labo CSV (`docker-compose.tunnel.yml`, `http-client.ts`, `job.repo.ts`, `cron-scheduler.ts`, `background-worker.ts`, `admin.service.ts`, `admin.routes.ts`, `AdminBenchmarkTab.vue`) :** `SQLITE_TMPDIR=/data`, non-mise en cache des payloads > 120 Ko + TTL 24 h au-delà de 24 Ko + `pruneExternalCache` plafonné à 6 000 entrées (au démarrage et en CRON nocturne), et persistance serveur du CSV corrigé préchargé (`pending-ground-truth.json`) avec auto-notation automatique en fin de job `collection_import` via hook `afterComplete` même navigateur fermé.
