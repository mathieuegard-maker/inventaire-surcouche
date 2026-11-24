# Règles Projet & Constitution Architecture V2 — `biblio-collection`

Ce document s'applique à **toute session de travail** sur ce dépôt. Son but est d'assurer une architecture V2 irréprochable (**KISS, SOLID, DRY**), d'empêcher tout retour de dette technique de la V1, et de garantir la bijection complète des fonctionnalités métier.

---

## 1. Documentation, Mémoire & Bijection V1 → V2 (Obligatoire)
* **Segmentation stricte de `documentation/` :**
  * `documentation/v2/` = **source de vérité active V2** (à lire avant toute modification structurelle).
  * `documentation/v1/` = **archive historique V1** (tag Git `v1.0-archive` ; ne pas réimporter ses patterns legacy).
  * `documentation/DEPLOIEMENT_SERVEUR_DEBIAN.md` = exploitation serveur commune.
* **Documents V2 de référence :**
  * [`documentation/v2/01_CARTOGRAPHIE_V1.md`](./documentation/v2/01_CARTOGRAPHIE_V1.md) — État des lieux V1, doublons et couplages à éliminer.
  * [`documentation/v2/02_PRINCIPES_ARCHITECTURE_V2.md`](./documentation/v2/02_PRINCIPES_ARCHITECTURE_V2.md) — Principes d'architecture, algorithmes et arbitrages CEO/CTO validés.
  * [`documentation/v2/03_MATRICE_BIJECTION_V1_V2.md`](./documentation/v2/03_MATRICE_BIJECTION_V1_V2.md) — Inventaire exhaustif des 52 fonctionnalités et portées de données à garantir.
  * [`documentation/v2/04_ARCHITECTURE_TECHNIQUE_V2.md`](./documentation/v2/04_ARCHITECTURE_TECHNIQUE_V2.md) — Blueprint technique : arborescence `shared`/`server`/`client`, schéma SQLite V2 (25 tables), contrat API unique `/api/*`.
  * [`documentation/v2/05_PLAN_EXECUTION_V2.md`](./documentation/v2/05_PLAN_EXECUTION_V2.md) — Feuille de route et jalons V2 (Jalon 0 → Jalon 7).
* **Suivi de bijection :** dès qu'une fonctionnalité est implémentée et testée en V2, cocher sa ligne (`☑`) dans `documentation/v2/03_MATRICE_BIJECTION_V1_V2.md`.
* **Capturer le « pourquoi » :** tout nouvel arbitrage produit, technique ou résolution de bug métier important est consigné (contexte, décision, alternatives écartées) dans `documentation/v2/02_PRINCIPES_ARCHITECTURE_V2.md`.
* **Workflow strict (`.agents/skills/language_rules.md`) :** toujours communiquer en français et présenter un plan clair avant de modifier du code ou de lancer des commandes structurantes.

---

## 2. Principes d'Architecture Clean Room V2 (KISS / SOLID / DRY)
* **Transition Clean Room :** la V2 est construite proprement sur une base SQLite vierge après archivage de la V1 (tag Git `v1.0-archive` + snapshot DB/covers sur le serveur). On peut reprendre des algorithmes purs validés (ex. parseur MARC, normalisation ISBN, calcul intégrales), mais **jamais** copier-coller des orchestrateurs ou routes legacy de la V1.
* **Séparation physique étanche en 3 couches :**
  * `src/shared/` : types, schémas **Zod**, dictionnaires **i18n**, utilitaires purs et parseurs bibliographiques — **zéro import Vue, Node.js, SQL ou réseau**.
  * `src/server/` : serveur **Hono** + **un seul routeur API typé (`/api/*`)** + services métier + **Repositories SQL standard** au-dessus d'un adaptateur DB (`DatabaseAdapter`, implémenté sur `better-sqlite3` WAL et remplaçable par PostgreSQL sans toucher au métier).
  * `src/client/` : **client mince Vue 3 + Pinia + Vue Router + PWA** (affichage, cache de lecture, file d'actions offline uniquement).
* **Interdictions strictes :**
  * **Zéro vestige Cloudflare/D1/R2/Wrangler** et **zéro double routeur** (`/api/gateway` banni).
  * **Zéro logique métier bibliographique lourde côté navigateur** (résolution ISBN, BnF/Wikidata, expansion de séries, stats lourdes, traitement Photo IA = **100 % serveur**).
  * **Zéro dépendance circulaire** et zéro import de code client (`src/client/`) depuis le serveur (`src/server/`).

---

## 3. Les 3 Espaces de Données, Sécurité & Primauté Utilisateur
* **Vocabulaire officiel (1 seul fichier SQLite WAL côté serveur, 2 espaces serveur + 1 cache appareil) :**
  1. **Catalogue Central (Serveur — Commun)** : source de vérité bibliographique partagée (œuvres, éditions, ISBN, franchises, découpages séries, tomes connus même non possédés).
  2. **Espace Foyer & Compte (Serveur — Privé)** :
     * *Foyer (`library_id`)* : possessions, wishlist, prêts, alertes nouveautés, surcharges privées de fiches/couvertures/séries/intégrales.
     * *Compte (`user_id`)* : identifiants, **statut de lecture, note, notes perso** (strictement individuels), genres par défaut, amis suivis, thème, préférences notifications, quota IA.
  3. **Cache Local (Appareil — Hors-ligne)** : miroir IndexedDB + Cache API PWA + une unique file d'envoi offline datée (`outbox`).
* **Synchronisation hors-ligne (`PUSH d'abord, PULL ensuite`) :**
  * Toute action hors-ligne (achat/possession, scan code-barres, prêt, retour, note) est appliquée localement et empilée dans l'`outbox`.
  * Au retour du réseau, le client **PUSH d'abord** toute son `outbox` au serveur avant de **PULL** les changements d'autres appareils : aucune action utilisateur hors-ligne n'est jamais écrasée. En cas de conflit simultané entre 2 membres sur le même champ, le timestamp le plus récent gagne (*Last-Write-Wins*).
* **Primauté Absolue de l'Utilisateur (`Couche 3 > Couche 2 > Couche 1`) :**
  * **Couche 1 (Robots : BnF, SUDOC, Wikidata, CRON)** : ne peut **jamais** écraser un champ verrouillé en Couche 2 ou 3.
  * **Couche 2 (Catalogue Maître Admin)** : chaque champ corrigé depuis `/admin` est inscrit dans `locked_fields` et protégé contre les robots.
  * **Couche 3 (Décisions Foyer / Utilisateur)** : souveraine à l'affichage (couvertures choisies, séries rattachées/exclues, one-shots, intégrales, titres/genres), survit à tout rescan ou ré-enrichissement (réinitialisable uniquement sur clic explicite de l'utilisateur).
* **Sécurité & Séparation des Rôles :**
  * **Authentification stricte :** 100 % des routes privées protégées par cookie `HttpOnly; Secure; SameSite=Lax` (**zéro fallback `userUri`**).
  * **Séparation stricte Moi ≠ Admin :** l'interface personnelle est identique pour tous les utilisateurs et ne modifie jamais le Catalogue Central ; l'édition du Catalogue Central passe exclusivement par `/admin`.
  * **Admin automatique sur base vierge :** attribué via la variable `ADMIN_EMAIL` dans `.env` (zéro commande SQL manuelle).
  * **Succession Foyer :** si le `owner` supprime ou quitte un foyer partagé, le membre le plus ancien est automatiquement promu `owner`.
* **Couvertures :**
  * Serveur : téléchargées une fois, compressées en **WebP (~15–35 Ko)** et stockées en fichiers disque `/data/covers/` (**zéro image base64 dans SQLite**, nettoyage nocturne des orphelins > 30j).
  * Client : **zéro base64 dans IndexedDB** ; mise en cache binaire via le **Cache API du Service Worker PWA** (`CacheFirst` sur `/api/covers/*`).

---

## 4. Pipeline Bibliographique, Séries & Tâches de Fond (Zéro Hardcoding)
* **Architecture d'acquisition en 3 étages :**
  1. **Étage 1 (Canal → ISBN-13)** : Scan simple, Rafale, Saisie, Photo IA ou Recherche produit un ISBN-13 propre.
  2. **Étage 2 (Collecte parallèle & Tableau Comparatif)** : interrogation parallèle BnF (`https://catalogue.bnf.fr/api/SRU` via `node:https` IPv4 forcé `family: 4`), SUDOC (ABES), Inventaire.io, Wikidata, Google Books (avec circuit-breaker 429) et Open Library → remplissage d'un tableau comparatif normalisé champ par champ avant arbitrage.
  3. **Étage 3 (Graphe `Édition ↔ Œuvre ↔ Série`)** : expansion de série **par le graphe d'abord** (Wikidata `P179`/`P1545` + Inventaire `P629`, autorisant la création d'un tome officiel du graphe avant résolution de son ISBN FR), puis BnF `460$3` (`bib.ens2bib`) / texte en filet de sécurité.
* **Règles bibliographiques algorithmiques (zéro liste ou mot-clé éditorial en dur) :**
  * **Anti-fausses séries (collections poche type *Totem*, *Folio*…)** : combinaison de la distinction MARC (`460` ensemble vs `225/410` collection), de la confrontation `Œuvre vs Édition`, et du test d'hétérogénéité des auteurs (sans bloquer les séries anthologiques ancrées `P179`/`460`).
  * **Séries à redécoupage continu (Comics/Mangas type *Fables* / *Urban Nomad*)** : modèle à 2 étages **Franchise → Découpage Éditorial**. La règle de fusion/séparation est le **contenu** (`N° de tome + Titre d'album + Pagination`), jamais le seul libellé de collection (évite de fragmenter *Astérix*).
  * **Intégrales, Hors-séries & UNIMARC :** ne jamais déduire `isIntegral` du seul nombre de pages ; évaluer `is_hors_serie` après agrégation ; ignorer l'en-tête technique codé UNIMARC `100$a` (`^\d{8}[a-z|]\d{4}`).
* **Tâches de fond & CRON :**
  * **Photo IA & Jobs longs 100 % serveur (`background_jobs`)** : OCR Gemini (clé serveur + quota mensuel utilisateur, terme *BYOK* supprimé), résolution, état d'arbitrage et relance BnF persistés sur le serveur (continuité mobile ↔ ordinateur, suivi via flux/store global unique).
  * **Worker continu vs CRON calendaire :** un worker dépile en continu les jobs et la file d'enrichissement (avec régulateur de débit BnF/Wikidata) ; le CRON calendaire (`cron_runs` idempotent, rattrapage après redémarrage) gère les digests horaires (Push VAPID / E-mail Resend) et la veille nocturne (nouveautés, éditions sœurs, purge logs et couvertures orphelines).

---

## 5. Règles UX, Design System & Internationalisation
* **Design System 100 % Design Tokens (`[data-theme="..."]`) :**
  * CSS modulaire (`tokens`, `base`, `primitives`, `layouts`) ; **zéro couleur ou police écrite en dur** dans les composants Vue afin de permettre le multi-thèmes au choix de l'utilisateur et des refontes visuelles rapides.
  * Composants socles uniques : `<BaseModal>` (gestion native pile, `Escape`, backdrop, scroll lock) et `<ToastHost>` global.
* **Internationalisation (`i18n`) 100 % centralisée :**
  * **Zéro texte visible écrit en dur dans le front-end** ; tous les libellés, boutons, placeholders et messages vivent dans un dictionnaire typé centralisé (`src/shared/locales/fr.ts`).
* **Règles UX obligatoires :**
  * **Confirmation obligatoire sur toute suppression** (anti-misclick). Si la sélection contient des livres prêtés, les non prêtés confirmés sont supprimés et chaque livre prêté fait l'objet d'un choix individuel (*Annuler sa suppression* vs *Marquer rendu et supprimer*).
  * **Partage Amis strict & Réservation Cadeau anti-spoiler :** accès listes uniquement via QR Code, code ou lien partagé (révocable par régénération). Sur la wishlist partagée, un ami peut réserver un cadeau (*« Je l'offre »*) : visible par les autres amis, **strictement masqué côté API pour le propriétaire et son foyer**, purgé automatiquement quand le livre passe en *Possédé*.
  * **Pas de gestion de doublons physiques** (hors intégrales couvrant des tomes).
  * **Export utilisateur** de sa bibliothèque en **CSV** et **JSON** depuis *Mon Profil*.
  * **Ergonomie transverse :** sélection automatique du texte au focus des champs de saisie.

---

## 6. Infrastructure, Migrations SQL & Exploitation Serveur (Debian + Docker)
* **Production :** serveur personnel Debian 13 Trixie (Dell OptiPlex 3060 Micro), dossier `/srv/docker/inventaire-surcouche`, URL publique `https://biblio.mathieuegardtest.fr`.
* **Réseau impératif :** trafic public via **Cloudflare Tunnel (`cloudflared`)** vers `127.0.0.1:8082` → port `3000` du conteneur `biblio-collection-app` (non-root `node`, `cap_drop: [ALL]`, `no-new-privileges`, `mem_limit: 512m`).
  * **Ne jamais** utiliser `docker-compose.yml` (Caddy) ni toucher aux ports `80`, `443` ou `8081` (`effectif_MAR`). Toujours utiliser `docker-compose.tunnel.yml`.
* **Données & Sauvegardes :** `/srv/docker/inventaire-surcouche/data/` (`biblio.sqlite` + `covers/`) monté sur `/data` (ignoré par Git). Sauvegarde quotidienne à 03h00 vers Google Drive (`/srv/backups/backup-serveur.sh`) + sauvegarde automatique avant migration dans `deploy.sh`.
* **Migrations SQL incrémentales strictes :** ne **jamais** modifier une migration déjà appliquée ; toute évolution de schéma crée un nouveau fichier `migrations/XXXX_*.sql` testé automatiquement de `0001` à `N` sur SQLite `:memory:`.
* **Zéro secret dans Git :** `ADMIN_EMAIL`, `JWT_SECRET`, `GEMINI_API_KEY`, `RESEND_API_KEY` et `VAPID_PRIVATE_JWK` vivent uniquement dans `/srv/docker/inventaire-surcouche/.env` sur le serveur.
* **En-têtes PWA & Caméra :** préserver `Cache-Control: no-cache, no-store, must-revalidate` sur `/sw.js` et `/sw-push.js`, `Content-Type: application/manifest+json; charset=utf-8` sur `/manifest.webmanifest`, et `Permissions-Policy: camera=(self)`.

---

## 7. Contrôle Qualité avant Clôture ou Déploiement
* Exécuter systématiquement le typecheck client, le typecheck serveur et toute la suite Vitest (unitaires + intégration SQLite `:memory:` + rejeu migrations) et rapporter uniquement les résultats réellement observés.
* Répondre en **français** avec des liens cliquables vers les fichiers modifiés.
