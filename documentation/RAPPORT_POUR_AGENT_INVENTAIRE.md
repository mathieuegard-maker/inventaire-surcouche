# Rapport Technique & Procédure de Déploiement — `inventaire-surcouche` (`Biblio Collection PWA`)

**Destinataire :** Agent de développement du projet `inventaire-surcouche`  
**Date :** 21 novembre 2026  
**Serveur :** Dell OptiPlex 3060 Micro (Debian 13 Trixie, headless)  
**Branche déployée :** `feat/self-hosted-server` (commit `bb36da3`)  
**URL cible :** `https://biblio.mathieuegardtest.fr` *(le domaine réel est `mathieuegardtest.fr`, sans tiret)*

---

## 1. Architecture d'hébergement sur le serveur

Le serveur héberge déjà une autre application (`effectif_MAR` sur `127.0.0.1:8081`). Tout le trafic entrant public passe par un **Tunnel Cloudflare (`cloudflared`)** : il n'y a donc **ni Caddy ni Nginx** sur les ports `80/443`.

- **Dossier de production sur le serveur :** `/srv/docker/inventaire-surcouche`
- **Port local exposé :** `127.0.0.1:8082` → port `3000` du conteneur `biblio-collection-app`
- **Exposition HTTPS & PWA :** Cloudflare Tunnel route `biblio.mathieuegardtest.fr` → `http://127.0.0.1:8082` et gère le certificat SSL/HTTPS (indispensable au Service Worker et à l'installation PWA).
- **Données persistantes :** `/srv/docker/inventaire-surcouche/data/` monté dans le conteneur sur `/data` (`biblio.sqlite` et `covers/`), ignoré par Git (`.gitignore`).
- **Sauvegardes automatiques :** `/srv/backups/backup-serveur.sh` sauvegarde chaque nuit à **03h00** `biblio.sqlite` à chaud (`sqlite3 .backup`), `.env` et `covers/` vers Google Drive (`gdrive:Serveur_Backups/daily`, rétention 14j local / 30j Drive).

---

## 2. Changements effectués dans le dépôt (`feat/self-hosted-server`)

1. **[docker-compose.tunnel.yml](file:///Users/mathieuegard/Dropbox/Mac/Desktop/script_app_bd/inventaire-surcouche/docker-compose.tunnel.yml)** *(créé)* :
   - Remplace l'usage de `docker-compose.yml` (qui lançait Caddy sur `80/443`).
   - Lance uniquement le conteneur `biblio-app` sur `127.0.0.1:${BIBLIO_TUNNEL_PORT:-8082}:3000`.
   - Charge `.env` avec `format: raw` (pour préserver d'éventuels caractères `$`).
   - Durcissement Docker : `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `mem_limit: 512m`.
2. **[Dockerfile](file:///Users/mathieuegard/Dropbox/Mac/Desktop/script_app_bd/inventaire-surcouche/Dockerfile)** *(modifié)* :
   - **Correctif `tsx` manquant :** `tsx` étant déclaré dans `devDependencies`, `npm prune --omit=dev` le supprimait avant `CMD ["npx", "tsx", ...]`. Ajout de `npm install --no-save tsx` et exécution directe via `CMD ["./node_modules/.bin/tsx", "server/index.ts"]`.
   - **Exécution non-root :** passage sous l'utilisateur `node` (UID/GID `1000`, identique à `mathieu` sur Debian pour éviter tout conflit sur `./data`) avec `chown -R node:node /app /data`.
3. **[server/index.ts](file:///Users/mathieuegard/Dropbox/Mac/Desktop/script_app_bd/inventaire-surcouche/server/index.ts)** *(modifié)* :
   - Middleware global ajoutant :
     - `X-Content-Type-Options: nosniff`
     - `X-Frame-Options: DENY`
     - `Referrer-Policy: strict-origin-when-cross-origin`
     - `Permissions-Policy: camera=(self), microphone=(), geolocation=()` *(autorise la caméra sur le même domaine pour `html5-qrcode` et l'OCR photo)*
     - `Strict-Transport-Security: max-age=31536000; includeSubDomains` (en production / HTTPS)
   - En-têtes PWA : `Cache-Control: no-cache, no-store, must-revalidate` sur `/sw.js` et `/sw-push.js`, et `Content-Type: application/manifest+json; charset=utf-8` (`Cache-Control: no-cache`) sur `/manifest.webmanifest`.
4. **[deploy.sh](file:///Users/mathieuegard/Dropbox/Mac/Desktop/script_app_bd/inventaire-surcouche/deploy.sh)** *(créé, exécutable)* :
   - Automatise `git pull --ff-only`, `docker compose -f docker-compose.tunnel.yml up -d --build`, le test `http://127.0.0.1:8082/health` et `docker image prune -f`.
5. **[deploy/RAPPORT_DEPLOIEMENT_SERVEUR.md](file:///Users/mathieuegard/Dropbox/Mac/Desktop/script_app_bd/inventaire-surcouche/deploy/RAPPORT_DEPLOIEMENT_SERVEUR.md)** *(copie versionnée dans le dépôt)*.

### Vérifications effectuées avant et après déploiement
- Local : `npx tsc --noEmit`, `npm run typecheck:server`, `npx vitest run` → **38/38 fichiers, 188/188 tests passés**.
- Serveur : `biblio-collection-app` **`healthy`** sur `127.0.0.1:8082->3000/tcp`, 12 migrations SQLite appliquées, `User=node`, `CapDrop=[ALL]`, `/health` (`{"ok":true,"mode":"self-hosted-sqlite"}`), `/manifest.webmanifest` et `/sw.js` vérifiés en `200 OK`.

---

## 3. État actuel de la base de données & de la config (`.env`)

- **Base de données (`/srv/docker/inventaire-surcouche/data/biblio.sqlite`) :**
  Aucune base SQLite locale n'existait sur le Mac lors du déploiement ; le serveur a donc démarré avec une **base neuve et vide** (les 12 migrations `0001` à `0012` sont appliquées, `users` est vide).
  - *Option 1 (test rapide) :* créer un nouveau compte directement depuis l'interface web.
  - *Option 2 (migration des données réelles depuis Cloudflare D1) :* exporter la base distante `biblio-catalog-db` avec `npx wrangler d1 export biblio-catalog-db --remote --output=d1-export.sql` et l'importer dans `/srv/docker/inventaire-surcouche/data/biblio.sqlite` (en veillant à ne pas dupliquer la table `d1_migrations` / schémas déjà créés).
- **Variables configurées dans `/srv/docker/inventaire-surcouche/.env` sur le serveur :**
  - Présentes : `JWT_SECRET` (généré aléatoirement), `BIBLIO_TUNNEL_PORT=8082`, `MAIL_FROM`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, `CRON_ENABLED=true`, `CRON_INTERVAL_MINUTES=60`.
  - Non encore renseignées (fonctionnalités désactivées tant qu'elles sont absentes) : `GEMINI_API_KEY` (OCR photo IA), `RESEND_API_KEY` (emails de récupération / digests), `VAPID_PRIVATE_JWK` (envoi des notifications Web Push).

---

## 4. Procédure pour pousser les futures mises à jour sur le serveur

Depuis le dépôt local sur Mac (`/Users/mathieuegard/Dropbox/Mac/Desktop/script_app_bd/inventaire-surcouche`) :

```bash
# 1. Valider les types et les tests
npx tsc --noEmit && npm run typecheck:server && npx vitest run

# 2. Commiter et pousser sur la branche déployée
git add <fichiers>
git commit -m "feat/fix: ..."
git push origin feat/self-hosted-server

# 3. Déployer sur le serveur en 1 commande
#    - Sur le réseau Wi-Fi de la maison :
ssh serveur "/srv/docker/inventaire-surcouche/deploy.sh"
#    - Depuis l'extérieur (via Tailscale VPN) :
ssh serveur-vpn "/srv/docker/inventaire-surcouche/deploy.sh"
```

### Contraintes impératives pour l'agent de développement
1. **Ne jamais utiliser `docker-compose.yml` (avec Caddy) ni toucher aux ports `80`, `443` ou `8081`** : toujours déployer via `docker-compose.tunnel.yml` (`127.0.0.1:8082:3000`).
2. **Migrations SQL (`migrations/*.sql`) :** toujours créer de nouvelles migrations incrémentales ; ne jamais modifier un fichier de migration déjà appliqué (`0001` à `0012`).
3. **Zéro secret dans Git :** ne jamais écrire `JWT_SECRET`, `GEMINI_API_KEY`, `RESEND_API_KEY` ou `VAPID_PRIVATE_JWK` dans le dépôt (ils vivent uniquement dans `/srv/docker/inventaire-surcouche/.env` sur le serveur).
4. **Tests PWA après modif du Service Worker / Manifest :** vérifier les en-têtes `Cache-Control` sur `sw.js` / `sw-push.js` et `Permissions-Policy: camera=(self)`.
