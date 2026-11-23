# Index de la Documentation Projet (`biblio-collection`)

La documentation est strictement segmentée par version afin de distinguer la **référence active V2** de **l'archive historique V1** :

## 1. Référence Active — `documentation/v2/` (À consulter en priorité)
* [`v2/01_CARTOGRAPHIE_V1.md`](./v2/01_CARTOGRAPHIE_V1.md) — Cartographie exhaustive de la V1 (workflows UX, routes, tables SQLite, doublons et dettes à ne pas reproduire).
* [`v2/02_PRINCIPES_ARCHITECTURE_V2.md`](./v2/02_PRINCIPES_ARCHITECTURE_V2.md) — Principes d'architecture Clean Room V2, pipeline 3 étages, algorithmes anti-collections poche et séries à redécoupage, primauté utilisateur, stack, sécurité, multi-thèmes et `i18n`.
* [`v2/03_MATRICE_BIJECTION_V1_V2.md`](./v2/03_MATRICE_BIJECTION_V1_V2.md) — Matrice exhaustive des 51 fonctionnalités UX et portées de données (`Local`, `Utilisateur`, `Foyer`, `Catalogue Central`) servant de checklist de bijection V1 → V2.

## 2. Exploitation Serveur (Commun V1 & V2)
* [`DEPLOIEMENT_SERVEUR_DEBIAN.md`](./DEPLOIEMENT_SERVEUR_DEBIAN.md) — Procédures d'exploitation du serveur Debian 13 (OptiPlex 3060 Micro, Docker + Cloudflare Tunnel, sauvegardes).

## 3. Archive Historique — `documentation/v1/` (Lecture historique uniquement)
Contient l'historique complet de la V1 (tag Git `v1.0-archive`, commit `9234b8a`) : cahier des charges initial, spécifications V3/V4, journal `ETAT_PROJET.md` et archives `historique/`. **Ne pas utiliser comme spécification pour les développements V2.**
