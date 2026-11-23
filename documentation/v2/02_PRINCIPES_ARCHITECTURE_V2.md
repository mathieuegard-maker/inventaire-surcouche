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
