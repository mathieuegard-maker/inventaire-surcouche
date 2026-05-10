# 📚 Surcouche Mobile - Inventaire.io

Ce projet est une interface web (optimisée pour mobile) agissant comme une surcouche par-dessus l'API d'Inventaire.io. Elle permet de scanner, d'identifier, de résoudre les métadonnées complexes (auteurs, séries, tomes) et d'ajouter rapidement des livres ou des bandes dessinées à sa collection personnelle.

---

## 🏗️ 1. État Actuel du Code (Exhaustif)

L'application suit une architecture stricte de type MVC / Service-Oriented Architecture, séparant rigoureusement la logique réseau, le traitement des données et l'interface utilisateur.

### 🛠️ Technologies Utilisées
* **Frontend :** TypeScript, Vite (Vanilla TS, pas de framework lourd).
* **Backend (Proxy) :** Vercel Serverless Functions (`/api/*`) pour masquer les identifiants, gérer les cookies de session en toute sécurité et éviter les problèmes de CORS.
* **Base de Données :** L'API officielle d'Inventaire.io (et Wikidata en fallback sémantique si nécessaire).

### 📁 Architecture des Modules Existants

#### A. Les Services (Lecture/Écriture et Sessions)
Localisés dans `src/services/`, ils gèrent l'état de l'application et les actions directes de l'utilisateur.
* **`auth.service.ts` & `user.service.ts` :** Gèrent la connexion, stockent le cookie de session via le proxy Vercel, et récupèrent l'URI du profil utilisateur connecté.
* **`inventory.service.ts` (Le Cerveau Local) :** * *Chargement initial :* Télécharge la liste des URIs possédées par l'utilisateur au démarrage et les stocke dans un `Set` en mémoire ultra-rapide.
    * *Vérification :* Permet de vérifier instantanément (sans appel réseau) si un livre scanné est déjà possédé (`isUriOwned`).
    * *Écriture :* Envoie l'ordre d'ajouter un livre via le proxy `POST /api/inventory/add` et met à jour le `Set` local en temps réel pour empêcher les doublons.

#### B. Le Pipeline d'Acquisition (Les Résolveurs)
Localisés dans `src/resolvers/`, ce sont des modules en lecture seule (pas d'état). Ils transforment un ISBN en un objet propre et affichable.
* **`entity.resolver.ts` (Le Détective) :** Cherche l'édition physique. S'il manque des informations (ex: Auteurs de BD), il applique une **Cascade de Résolution** intelligente : il remonte à l'Œuvre parente, puis à la Série parente pour hériter des créateurs.
* **`mapper.ts` :** Normalise le chaos des données brutes (les fameux "claims" `wdt:P...`) en un format de données standardisé (`RawBook`).
* **`humanizer.ts` (Le Traducteur) :** Prend les identifiants bruts (ex: `wd:Q3568204`) et fait un appel réseau pour récupérer les noms lisibles des auteurs, genres, séries et éditeurs. Fusionne intelligemment Scénaristes et Illustrateurs si aucun Auteur global n'est défini.

#### C. Le Module Série ("Mega-Batching")
* **Proxy `api/series/list.ts` :** Utilise l'endpoint "Pure Inventaire" (`/entities/serie-parts`) pour lister instantanément toutes les URIs des tomes appartenant à une saga.
* **`series.resolver.ts` :** Implémente une logique de **Mega-Batch**. Au lieu de faire des requêtes en boucle pour chaque tome de la série, il regroupe TOUS les identifiants de la saga, télécharge les données brutes en un seul appel (`/entities/by-uris`), extrait tous les IDs d'auteurs/genres à traduire, les traduit en un seul appel, assemble les objets `HumanizedBook` et les trie par numéro de tome.

---

## 🚀 2. Roadmap & Objectifs (À Faire)

Le pipeline de données (Backend) est robuste et performant. Les prochaines étapes se concentrent exclusivement sur l'Interface Utilisateur (UI), l'expérience globale (UX) et le traitement de masse (Bulk).

**Voici l'ordre d'implémentation logique :**

### Étape 1 : Interface Graphique des Séries (Frontend)
* **Objectif :** Transformer le tableau `[TEST SERIE]` de la console en une vraie interface.
* **Action :** Dans `main.ts`, créer un cont