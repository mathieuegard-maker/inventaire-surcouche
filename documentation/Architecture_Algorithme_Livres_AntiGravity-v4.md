# CAHIER D'ARCHITECTURE & SPÉCIFICATION ALGORITHMIQUE — VERSION 4.0

**Architecture Front/Back, pipeline d'ingestion FRBR en 5 couches, acquisition multi-canaux, intégrales bidirectionnelles, veille nocturne et observabilité administrateur**

* **Destinataire** : Moteur d'ingénierie IA AntiGravity
* **Périmètre** : Langue française (`FR`)
* **Version** : `4.0` (consolide l'intégralité de la Version 3.0 + les décisions architecturales & garde-fous validés lors de l'audit technique)

---

## 1. Vision Architecturale, Séparation Front/Back & Modèle de Données

L'objectif de ce document est de définir l'architecture algorithmique complète permettant d'alimenter, d'organiser et de dédupliquer une application de gestion de bibliothèque personnelle. L'architecture repose sur une séparation stricte entre le client Front-End (**Couche 1**) et le moteur métier Back-End (**Couches 2 à 5** et **Cron nocturne**), fondée sur le modèle bibliographique **FRBR** (*Functional Requirements for Bibliographic Records*).

> **PRINCIPE MÉTIER FONDAMENTAL : POSSESSION AU NIVEAU DU « LIVRE » (ŒUVRE CONSOLIDÉE)**
> Dans l'application, l'utilisateur ne possède pas une « Édition » physique isolée, mais un « Livre » au sens intellectuel consolidé. Chaque fiche Livre regroupe l'ensemble des ISBN-13 francophones correspondant à cette œuvre.
>
> *Conséquence directe* : lorsqu'un utilisateur scanne un code-barres, une requête en temps constant $O(1)$ sur l'index des ISBN permet de savoir instantanément s'il possède déjà le livre (même s'il scanne une réédition différente de l'exemplaire rangé chez lui), sans aucun appel API externe.
>
> *Périmètre assumé (Garde-fou)* : Tout ouvrage doit aboutir à un ISBN-13 valide. Si un livre ancien ou atypique ne dispose d'aucun ISBN-13 (et qu'aucune réédition française dotée d'un ISBN ne peut être extrapolée), il est explicitement exclu du périmètre de l'application (`UNSUPPORTED_NO_ISBN`).

### 1.1 Séparation Stricte Front-End / Back-End & Contrat d'Interface

* **Couche 1 — Périmètre Front-End** : Exécutée côté client (mobile/web), elle prend en charge les 4 canaux d'acquisition (scan code-barres, saisie manuelle, recherche texte libre, photo IA de couverture ou d'étagère multi-tranches). Pour les canaux 3 et 4, le Front-End invoque le service Back-End utilitaire de résolution texte → ISBN-13 et le service OCR photo (1 seule passe IA OCR strict).
* **Interface pivot Front → Back** : La frontière d'entrée vers le pipeline principal est strictement normalisée : la Couche 1 transmet au Back-End un identifiant ISBN-13 unique (ou un tableau d'ISBN-13 en mode lot lors d'un scan d'étagère) accompagné du `source_channel`.
* **Couches 2 à 5 & Cron Nocturne — Périmètre Back-End pur (Agnostique de l'UI & Portable)** : Les Couches 2 à 5 opèrent exclusivement côté serveur/moteur de données. Elles ne prescrivent jamais de comportement d'interface utilisateur (ni modale, ni bouton). Leur unique responsabilité est de résoudre, consolider, enrichir et retourner au Front-End un payload JSON structuré contenant la fiche Livre, son `ownership` (`status`, `status_message`) et un identifiant de traçabilité `trace_id`.
* **Portabilité d'infrastructure** : L'hébergement cible prioritaire pour les tests et la production actuelle reste **Cloudflare Pages + D1 (SQLite) + Worker Cron dédié (`workers/release-cron`)**. Tout le code métier des Couches 2 à 5 doit toutefois rester écrit en TypeScript pur au-dessus d'interfaces abstraites (`DatabaseBinding` pour SQL, `CoverBucketBinding` pour R2/disque, `fetch()` standard), sans API propriétaire Cloudflare dans la logique métier, afin de permettre ultérieurement une migration transparente vers un serveur local auto-hébergé derrière un Tunnel Cloudflare.

### 1.2 Architecture de Stockage à Deux Niveaux & Indexation Relationnelle des ISBN

* **Base de données Serveur (`D1` / SQLite)** : Référentiel central mutualisé stockant l'ensemble des fiches Livre canoniques consolidées à travers l'activité de tous les utilisateurs et du cron nocturne, ainsi que la file d'enrichissement asynchrone (`enrichment_queue`) et le journal d'audit administrateur (`pipeline_logs`).
* **Base de données Locale (`IndexedDB` sur le terminal PWA)** : Miroir exact des fiches de la DB Serveur concernant l'utilisateur (œuvres possédées `is_owned = true`, wishlist, et œuvres non possédées `is_owned = false` des séries suivies), incluant son propre index `book_isbn_index` local pour une vérification hors-ligne en $O(1)$ (en magasin ou en brocante) ainsi qu'une file locale `pending_scans` si un code-barres inconnu est scanné hors réseau. La synchronisation différentielle (`updated_at > last_sync`) rapporte vers la PWA les enrichissements effectués sur le serveur même lorsque l'application a été refermée entre-temps.
* **Table d'indexation relationnelle `book_isbn_index`** : En base Serveur et Locale, chaque ISBN-13 est indexé dans la table relationnelle dédiée `book_isbn_index (isbn13 VARCHAR(13) PRIMARY KEY, book_id FOREIGN KEY, is_integral BOOLEAN)`. Cela garantit une recherche en $O(1)$ et empêche par contrainte `UNIQUE` qu'un même ISBN-13 soit rattaché à deux fiches unitaires distinctes.
* **Référencement bidirectionnel des Intégrales (`integral_metadata` ↔ `parent_integrals`)** : En miroir du champ `integral_metadata` présent sur chaque fiche d'intégrale (ou album double éditorial), chaque fiche de tome unitaire embarque un champ `parent_integrals` listant les `book_id`, titres et ISBN-13 des intégrales/albums doubles qui incluent cette œuvre.

### 1.3 Hiérarchie des Entités Bibliographiques (incluant les Hors-Séries & Albums Doubles)

| Entité | Rôle dans le système | Exemple concret |
| --- | --- | --- |
| **Série (`Series`)** | Famille canonique regroupant des œuvres ordonnées par numéro de tome ainsi que d'éventuels hors-séries. | *Les Aventures de Tintin* (vote majoritaire sur cluster normalisé) |
| **Œuvre (`Work`)** | Entité intellectuelle abstraite numérotée au sein d'une série (ou indépendante), indépendante de son support physique. | *Tintin au Congo* (Tome 2) |
| **Hors-Série (`Special / HS`)** | Œuvre rattachée à une série canonique (`same series_id`) dépourvue de numéro de tome séquentiel après agrégation de toutes les éditions sœurs FR (`is_hors_serie = true, volume_number = null`). | *Astérix — Comment Obélix est tombé dans la marmite...* |
| **Intégrale / Album Double** | Fiche marquée `is_integral = true` couvrant ≥ 2 œuvres unitaires (intégrale classique, coffret, compilation ou album double France Loisirs). Portée dans `book_isbn_index` sous son propre `book_id`. | *Astérix le Gaulois / La serpe d'or* (`9782298099539`) ou *L'Intégrale T.1–3* |
| **Édition (`Edition`)** | Objet physique précis caractérisé par un ISBN-13 unique, un éditeur, une date de parution et une couverture. | Casterman, 1993, cartonné, ISBN `9782203001015` |
| **Fiche Livre (`Book`)** | Entité maître stockée en DB Serveur et DB Locale : fusionne l'Œuvre, sa Série canonique, ses liens bidirectionnels d'intégrales, la liste de ses ISBN-13 FR et son statut de possession. | Fiche *« Tintin au Congo »* + `parent_integrals` + 14 ISBN-13 FR |

### 1.4 Schéma JSON Cible d'une Fiche Livre (Payload Retourné par le Back-End)

```json
{
  "book_id": "uuid-v4",
  "work_canonical_id": "bnf:cb39145678x",
  "canonical_title": "Tintin au Congo",
  "series": {
    "series_id": "uuid-series-tintin",
    "canonical_name": "Les Aventures de Tintin",
    "aliases": ["Tintin", "Tintin (Les aventures de)"],
    "volume_number": 2,
    "is_hors_serie": false,
    "hors_serie_label": null
  },
  "authors": [
    { "name": "Hergé", "roles": ["Scénario", "Dessin"] }
  ],
  "language": "fr",
  "is_integral": false,
  "integral_metadata": {
    "included_volume_numbers": [],
    "included_work_ids": [],
    "included_isbns": []
  },
  "parent_integrals": [
    {
      "integral_book_id": "uuid-integrale-tintin-1",
      "title": "Les Aventures de Tintin - L'Intégrale Tome 1 (Tomes 1 à 3)",
      "isbn13": "9782203099999"
    }
  ],
  "known_isbns": [
    "9782203001015",
    "9782203001022",
    "9782203011021",
    "9782203084742"
  ],
  "editions_catalog": [
    {
      "isbn13": "9782203001015",
      "publisher": "Casterman",
      "publication_year": 1993,
      "cover_url": "https://cdn.example.com/covers/9782203001015.jpg"
    }
  ],
  "selected_cover_url": "https://cdn.example.com/covers/9782203001015.jpg",
  "ownership": {
    "is_owned": true,
    "status": "ALREADY_OWNED",
    "status_message": "Vous possédez déjà ce livre.",
    "partial_integral_details": null,
    "added_at": "2026-11-18T07:14:00Z",
    "source_channel": "BARCODE_SCAN"
  }
}
```

---

## 2. Architecture Globale Front/Back & Pipeline à 5 Couches

Le flux reste structuré selon les 5 couches et le contrat pivot ISBN-13 :
* **Couche 1 (Front-End)** : Canaux 1 à 4 → `{ isbns: ["978..."], source_channel }` (ou `UNSUPPORTED_NO_ISBN` / mise en file locale `pending_scans` si hors-ligne sur un code inconnu).
* **Couche 2 (Back-End + Miroir Local IndexedDB)** : Lookup $O(1)$ sur `book_isbn_index` & statuts bidirectionnels intégrales (`ALREADY_OWNED`, `INCLUDED_IN_INTEGRAL`, `PARTIAL_INTEGRAL_OWNED`, `FULL_INTEGRAL_OWNED`, `LOCAL_UNOWNED`, `SERVER_CATALOG_HIT`).
* **Couche 3 (Back-End)** : Découverte multi-source **en parallèle** (`BnF SRU`, `Google Books`, `OpenLibrary`, `Wikidata` et `inventaire.io` en lecture seule publique) avec filtre strict `lang = 'fr'`.
* **Couche 4 (Back-End)** : Consolidation finale sur le tableau complet des éditions équivalentes (Intégrales & Albums doubles, héritage des numéros avant typage `is_hors_serie`, vote majoritaire de série sur cluster normalisé, idempotence sur `work_canonical_id`, indexation dans `book_isbn_index`).
* **Couche 5 (Back-End différée) & Cron Nocturne** : Création rapide du squelette de série, puis enrichissement progressif asynchrone côté serveur via `enrichment_queue` (y compris lorsque la PWA est fermée) et veille nocturne via `workers/release-cron`.

---

## 3. Spécification Détaillée des 5 Couches (Mise à Jour V4)

### 3.1 Couche 1 (Front-End) : Acquisition, Extrapolation & Normalisation

Exécutée côté Front-End, la Couche 1 unifie quatre canaux d'acquisition hétérogènes :

* **Canal 1 — Scan de code-barres (EAN-13)** : Lecture optique locale, nettoyage syntaxique, vérification du checksum modulo 10.
  * Accepte les préfixes ISBN-13 classiques (`978`, `979`).
  * **Cas des EAN presse/kiosque (`330...`, `378...`, `977...`)** : fréquents sur les collections kiosque (Hachette/Atlas). Ils ne sont pas rejetés d'emblée : la Couche 1 tente une résolution par titre/EAN à la BnF pour extrapoler l'ISBN-13 `978...` de l'album équivalent avant tout éventuel rejet.
  * **Mode hors-ligne** : si l'EAN est absent de `book_isbn_index` local et qu'il n'y a pas de réseau, l'EAN est conservé dans la file locale `pending_scans` pour traitement dès le retour de la connexion.
* **Canal 2 — Saisie manuelle d'ISBN** : Nettoyage par regex des tirets/espaces, validation du checksum et conversion mathématique automatique ISBN-10 → ISBN-13 (`978` + recalcul de clé).
* **Canal 3 — Recherche en texte libre (et passerelle texte → ISBN pour le Canal 4)** :
  * Ce moteur partagé prend en charge aussi bien la requête tapée par l'utilisateur que les fiches OCR extraites par le Canal 4.
  * **Pipeline de résolution texte → ISBN-13** :
    1. *Si un ISBN imprimé valide est déjà présent* → court-circuit vers cet ISBN-13.
    2. *Extraction structurée / heuristique* : détection d'indices numériques de tome (`T.28`, `Tome 28`, `N°3`, `#7`, nombre en fin de chaîne hors années) et séparation série / titre / auteur.
    3. *Requêtes hiérarchiques en parallèle multi-source (`lang = 'fr'`)* :
       - Requête précise `(titre + auteur [+ tome])` ;
       - Requête série + tome `(série_normalisée + volume_number [+ auteur])` (indispensable lorsque la tranche n'affiche que `"Boule & Bill N°3"` ou `"Le Petit Spirou 7"`) ;
       - Requête de repli `(titre seul)` ou `(titre + série)` si 0 résultat sur l'auteur (auteurs multiples, reprise d'après un créateur, faute d'OCR).
    4. *Scoring déterministe pondéré & Regroupement par Œuvre (`workKey`)* :
       - Points positifs pour correspondance floue/exacte du titre, recouvrement auteur/dessinateur, correspondance série (après normalisation `&` ↔ `et` et suppression des préfixes éditoriaux) + numéro de tome exact, et consensus multi-sources (`BnF` + `Google Books` + `OpenLibrary` + `D1`/`inventaire.io`).
       - Pénalité si auteur contradictoire ou numéro de tome explicitement différent ; priorité aux ISBN français (`9782...` / `97910...`).
       - Fusion des candidats appartenant à la **même œuvre** avant arbitrage (pour ne jamais demander à l'utilisateur de choisir entre deux éditions d'un même album).
    5. *Sortie* : envoi de l'ISBN-13 gagnant (ou choix rapide UI en cas d'ambiguïté entre œuvres réellement distinctes ou unitaire vs intégrale) au contrat Front → Back.
* **Canal 4 — Reconnaissance photo par IA (Architecture 1 couche IA OCR strict + Couplage Canal 3 / Couche 3)** :
  * **Choix architectural retenu (1 seule couche IA)** : Afin de minimiser la latence, le coût API, la consommation de quota et d'éliminer tout risque d'hallucination sur les sorties récentes ou les renumérotations éditoriales, **l'IA n'effectue qu'une passe unique de Vision OCR strict** (jamais appelée sur les canaux 1, 2 et 3). La résolution sémantique et le rattachement d'œuvre sont délégués aux sources bibliographiques structurées (Canal 3 → Couches 2 à 4).
  * **Exigence d'isolation visuelle par tranche (étagère multi-tranches)** :
    - Le prompt ordonne au modèle Vision multimodal de segmenter la photo **tranche par tranche** (de gauche à droite ou de haut en bas), en délimitant chaque dos de livre par ses frontières physiques (bords, couleur de fond, ombre), avec **interdiction de mélanger** un logo d'éditeur, un auteur ou un numéro d'une tranche voisine.
    - L'IA retourne un tableau JSON strict contraint par **`responseSchema` OpenAPI** (`temperature: 0.1`), où **chaque objet encapsule intégralement l'OCR d'une seule tranche** :
      ```json
      [
        {
          "spineIndex": 1,
          "rawSpineText": "Tout le texte brut lu uniquement sur cette tranche",
          "series": "Nom de série imprimé ou ''",
          "title": "Titre de l'album imprimé ou ''",
          "subtitle": "Sous-titre éventuel ou ''",
          "volumeNumber": "Numéro de tome en chiffres lu sur ce dos (hors année/prix) ou ''",
          "author": "Auteur / mention 'par X d'après Y' lisible sur ce dos ou ''",
          "illustrator": "Dessinateur lisible sur ce dos ou ''",
          "publisher": "Éditeur ou logo lisible sur ce dos ou ''",
          "collection": "Collection éditoriale ou ''",
          "isbn": "ISBN si lisible ou ''",
          "detectedType": "bd | manga | roman | integrale | unknown",
          "confidence": "high | medium | low"
        }
      ]
      ```
  * **Passerelle Canal 4 → Canal 3 → Back-End** : Pour chaque tranche détectée, le Canal 3 résout l'objet OCR isolé en ISBN-13 français (extrapolation automatique si livre ancien sans ISBN imprimé), les résultats valides sont affichés dans la modale de validation par lot, et la validation utilisateur envoie `{ isbns: [...], source_channel: "PHOTO_SHELF_BATCH" | "PHOTO_SINGLE" }` au Back-End.

### 3.2 Couche 2 (Back-End & Miroir Local) : Vérification Double Niveau & Intégrales Bidirectionnelles

Inchangée sur le contrat métier (`ALREADY_OWNED`, `INCLUDED_IN_INTEGRAL`, `PARTIAL_INTEGRAL_OWNED`, `FULL_INTEGRAL_OWNED`, `LOCAL_UNOWNED`, `SERVER_CATALOG_HIT`, `FULL_MISS`), appuyée sur `book_isbn_index` en DB Locale (`IndexedDB`) pour le $O(1)$ hors-ligne puis en DB Serveur (`D1`).

### 3.3 Couche 3 (Back-End) : Découverte Multi-API Parallèle & Expansion de Graphe

* **Interrogation parallèle obligatoire multi-sources (`Promise.allSettled`)** :
  Aucune source unique (y compris `inventaire.io`, dont les données communautaires peuvent contenir des erreurs) ne fait foi seule. La Couche 3 interroge **simultanément** avec timeout court et filtre linguistique strict (`lang = 'fr'`) :
  1. **Catalogue Général BnF (SRU)** : référence d'autorité FR (notices bibliographiques, auteurs, éditeurs, dates, couvertures BnF).
  2. **Wikidata & `inventaire.io` (API lecture publique sans authentification)** : signaux FRBR (`wd:Q...` Work ↔ `wdt:P179` Série ↔ `wdt:P1545` n° de tome).
  3. **OpenLibrary & Google Books** : éditions sœurs additionnelles, résumés, nombres de pages et couvertures.
* **Étapes 3.1 → 3.3 (Pivot → Équivalence d'Œuvre → Crawl horizontal FR)** :
  - *Important (réalité BnF BD)* : `data.bnf.fr` ne modélisant généralement pas de nœud FRBR `Work` pour la bande dessinée, la « remontée vers l'Œuvre » s'appuie sur **deux signaux combinés** :
    1) l'identifiant Work `wd:Q...` / OpenLibrary quand une source FRBR le fournit de façon cohérente ;
    2) le couple algorithmique `(titre normalisé + auteur principal)` issu de l'édition pivot, utilisé pour crawler horizontalement BnF (`bib.title` + `bib.author`), Google Books et OpenLibrary (filtre `lang = 'fr'`, garde-fou anti-homonymes sur titre + recouvrement d'auteur).
  - Produit le **Super-Tableau brut (`Staging Payload`)** avec conservation d'un marqueur `anchor_edition` sur `input_isbn_13`.

### 3.4 Couche 4 (Back-End) : Consolidation Finale sur Tableau Complet, Intégrales Bidirectionnelles & Hors-Séries

**Principe clé V4** : Toutes les règles d'identification (intégrales, albums doubles, numérotation des tomes, hors-séries, vote majoritaire de série) ne sont appliquées **qu'après** avoir assemblé le **Super-Tableau complet** des éditions équivalentes issues de toutes les sources de la Couche 3.

* **A. Intégrales, Coffrets & Albums Doubles éditoriaux** :
  - Regex étendues aux **albums doubles** (`titre 1 / titre 2`, `tome 1 + 2`, `2 albums`, `France Loisirs` double) en plus des marqueurs d'intégrale/coffret/omnibus.
  - Scénario 1 (entrée = tome unitaire) : les éditions sœurs identifiées comme intégrales ou albums doubles sont sorties des `known_isbns` unitaires et enregistrées dans `parent_integrals`.
  - Scénario 2 (entrée = intégrale ou album double) : `is_integral = true`, résolution des sous-volumes, mise à jour symétrique de `parent_integrals` des fiches unitaires et calcul de possession `PARTIAL_INTEGRAL_OWNED` / `FULL_INTEGRAL_OWNED`.
* **B. Règle révisée des Hors-Séries (Héritage avant typage HS)** :
  - **Ne jamais typer `is_hors_serie = true` simplement parce que l'édition scannée n'a pas de numéro.**
  - Une fois le Super-Tableau complet réuni : si **au moins une édition sœur FR** ou une source (BnF autre édition, Wikidata `P1545`) fournit un `volume_number`, l'œuvre **hérite obligatoirement de ce numéro** (l'absence sur l'édition pivot est traitée comme un oubli de notice éditeur).
  - L'œuvre n'est typée `is_hors_serie = true` (`volume_number = null`) **que si** (1) son titre/sous-titre contient un marqueur explicite (*Hors-série*, *HS*, *Spécial*, *Album d'or*...) **OU** (2) aucune des éditions sœurs FR collectées en Couche 3 ne comporte de numéro séquentiel et aucun tome régulier existant de la série ne porte ce titre.
* **C. Élection du Nom Canonique de Série (Cluster normalisé + Vote majoritaire)** :
  - **Pré-groupement lexical** : avant de faire voter les libellés, les variantes partageant la même signature normalisée (minuscules, sans accents, `&` unifié avec `et`, suppression des mentions de collection après `-`, `:` ou `,`) sont regroupées dans le même cluster afin que `"Boule & Bill"` et `"Boule et Bill"` ne s'annulent pas au vote.
  - **Palier 1 — Vote majoritaire (≥ 60–70 %)** sur les libellés du cluster/série (ou nom exact existant en base si la série existe déjà).
  - **Palier 2 — Noyau lexical minimal** en cas de forte disparité sans majorité.
  - Conservation de toutes les variantes dans `series.aliases` + prise en charge de la fusion manuelle persistante dans `aliases`.
* **D. Idempotence, Couverture & Indexation** :
  - Sélection de la couverture la plus fiable (en excluant tout placeholder `1x1` `< 15px`) avec repli sur les autres éditions sœurs de `editions_catalog`.
  - Contrôle d'idempotence sur `work_canonical_id` / `(series_id + volume_number)` / `(series_id + normalized_title)` avant insertion, et insertion atomique dans `book_isbn_index`.

### 3.5 Couche 5 (Back-End) : Enrichissement Progressif & Différé de la Série

Pour garantir une réponse rapide à l'utilisateur **et** respecter la limite Cloudflare (50 sous-requêtes `fetch()` par invocation) tout en utilisant le multi-source complet :
* **Phase 5A — Squelette immédiat (1–2 requêtes max)** : Interrogation rapide BnF `bib.ens2bib` + Wikidata sur la série canonique → création en DB Serveur (et renvoi/sync vers DB Locale en statut `is_owned = false`) de tous les tomes et hors-séries connus avec leur ISBN-13 principal FR.
* **Phase 5B — File d'enrichissement serveur asynchrone (`enrichment_queue`)** : Les tomes manquants non encore consolidés multi-API sont inscrits dans la table D1 `enrichment_queue (book_id, isbn13, priority, status, attempts, updated_at)`.
* **Exécution continue même PWA fermée** : le serveur (`ctx.waitUntil` par petit lot initial + Worker Cron `workers/release-cron`) dépile progressivement `enrichment_queue` par petits paquets multi-sources (Couches 3 et 4 avec `skip_layer_5 = true`). Lorsque l'utilisateur rouvre la PWA, la synchronisation différentielle télécharge silencieusement les `known_isbns`, couvertures et `parent_integrals` complétés.

---

## 4. Processus Asynchrone Back-End : Worker Cron (`workers/release-cron`)

S'appuie sur le Cloudflare Worker dédié déjà existant (`workers/release-cron`, lié à la même base D1 `biblio-catalog-db`), découpé en **lots bornés** compatibles Cloudflare Workers (et aisément extensibles lors d'une future migration auto-hébergée) :

| Tâche Cron | Action DB Serveur | Action DB Locale (Sync suivante) | Notification |
| --- | --- | --- | --- |
| **1. Dépilage `enrichment_queue` (Couche 5 différée)** | Passage des œuvres en attente dans les Couches 3–4 multi-sources → remplissage `book_isbn_index`, `known_isbns`, couvertures et `parent_integrals`. | Téléchargement silencieux lors de la synchro différentielle à l'ouverture de la PWA. | **NON** |
| **2. Veille Nouvelles Œuvres (toutes séries actives)** | Passage du nouvel ISBN-13 détecté dans les Couches 3–4 → création fiche Livre + `book_isbn_index` + liens `parent_integrals`. | Poussée vers la DB Locale des utilisateurs possédant ≥ 1 tome de la série en statut `is_owned = false`. | **OUI** — Push / Email / `/releases` |
| **3. Veille Silencieuse Nouvelles Éditions** | Ajout du nouvel ISBN-13 FR dans `book_isbn_index`, `known_isbns`, `editions_catalog` et `parent_integrals` de la fiche existante. | Mise à jour silencieuse vers les DB Locales concernées (conservation stricte de `is_owned`). | **NON** |
| **4. Nettoyage Logs Admin (TTL)** | Suppression automatique des logs `ok` > 7 jours et `warn`/`error` > 30 jours dans `pipeline_logs`. | — | **NON** |

---

## 5. Observabilité & Logs Administrateur (`pipeline_logs`)

Afin de diagnostiquer rapidement tout comportement inattendu (doublon de tome, série non fusionnée, couverture manquante, erreur de parsing ou refus API externe) sur les tests réels :

* **Corrélation par `trace_id`** : Chaque requête d'acquisition (ou exécution Cron) génère un `trace_id` unique propagé de la Couche 1 jusqu'à la Couche 5.
* **Table D1 `pipeline_logs`** :
  * Champs : `id`, `trace_id`, `user_id` (anonymisé/optionnel), `source_channel`, `layer` (`C1`, `C2`, `C3`, `C4`, `C5`, `CRON`), `step_name`, `status` (`ok` | `warn` | `error`), `duration_ms`, `summary`, `payload_json`, `created_at`.
  * **Performance** : écriture groupée non-bloquante en fin d'opération (`batch` + `waitUntil`) pour un impact nul sur la latence perçue.
  * **Sécurité** : aucun jeton d'authentification, mot de passe ou clé API n'est jamais enregistré dans `payload_json`.
* **Interface Admin (`AdminView` — Onglet « Logs & Diagnostic »)** :
  * Liste des traces récentes regroupées par `trace_id` avec filtre par statut (`error`, `warn`, `all`), par couche (`C1`..`C5`, `CRON`) et recherche par ISBN/titre.
  * Vue détaillée chronologique d'une trace : requêtes API externes lancées, temps de réponse, scores de candidats, décisions prises en Couche 4 (pourquoi tel tome a été rattaché, pourquoi telle couverture ou série a été élue) + bouton **« Exporter la trace en JSON »**.
  * Niveaux configurables (`errors_only`, `summary`, `verbose_debug`).

---

## 6. Règles Invariantes V4 (Mise à Jour des Directives AntiGravity)

Les 14 règles de la V3 restent en vigueur, enrichies et précisées par les invariants suivants :
1. **IA strictement limitée à l'OCR photo (1 seule passe)** : jamais d'appel IA sur les canaux 1, 2 et 3 ; extraction JSON contrainte par `responseSchema` avec isolation visuelle stricte tranche par tranche.
2. **Multi-source parallèle obligatoire (Couches 3 & 5)** : `BnF + Wikidata + inventaire.io (lecture) + OpenLibrary + Google Books` en parallèle, pondération d'autorité (aucune confiance aveugle dans une source unique), filtre strict `lang = 'fr'`.
3. **Albums doubles = Intégrales** : toute édition regroupant ≥ 2 œuvres distinctes est typée `is_integral = true` avec liens `parent_integrals` bidirectionnels.
4. **Hors-Série après consolidation complète uniquement** : héritage prioritaire du `volume_number` depuis les éditions sœurs FR en Couche 4 avant d'appliquer `is_hors_serie = true`.
5. **Couche 5 différée & bornée côté serveur** : squelette immédiat + file `enrichment_queue` dépilée en arrière-plan par `workers/release-cron` (portable hors Cloudflare grâce aux interfaces abstraites).
6. **Traçabilité complète** : chaque acquisition et passe Cron journalise ses étapes par `trace_id` dans `pipeline_logs` pour inspection et export JSON dans l'interface Administrateur.
