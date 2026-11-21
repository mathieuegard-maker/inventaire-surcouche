# Rapport de Déploiement Serveur — `inventaire-surcouche` (`Biblio Collection PWA`)

> **Date :** 2026-11-21  
> **Cible :** Serveur domestique Dell OptiPlex 3060 Micro (Debian 13 Trixie)  
> **URL prévue :** `https://biblio.mathieuegardtest.fr` *(note : le domaine réel est `mathieuegardtest.fr`, sans tiret)*  
> **Branche déployée :** `feat/self-hosted-server`

---

## 1. Architecture d'hébergement sur le serveur

Le serveur héberge déjà d'autres applications derrière un tunnel **Cloudflare (`cloudflared`)**. Pour éviter tout conflit sur les ports `80/443` ou `8081` (déjà utilisé par `effectif_MAR`), `inventaire-surcouche` est déployé de manière isolée :

- **Répertoire sur le serveur :** `/srv/docker/inventaire-surcouche`
- **Port local exposé :** `127.0.0.1:8082` → conteneur `3000` (inaccessible directement hors localhost)
- **Exposition HTTPS & PWA :** Cloudflare Tunnel (`biblio.mathieuegardtest.fr` → `http://127.0.0.1:8082`). Cloudflare gère le certificat SSL/HTTPS indispensable à l'installation de la PWA et au Service Worker (`sw.js`, `sw-push.js`).
- **Base de données & couvertures :** `/srv/docker/inventaire-surcouche/data/` monté sur `/data` dans le conteneur (`biblio.sqlite` + `covers/`), totalement ignoré par Git (`.gitignore`).

---

## 2. Modifications apportées au dépôt

1. **`docker-compose.tunnel.yml` (nouveau) :**
   - Remplace l'usage de `docker-compose.yml` (qui incluait Caddy sur `80/443`).
   - Lance uniquement `biblio-app` sur `127.0.0.1:8082:3000`, avec `env_file` (`format: raw` pour préserver les caractères spéciaux dans `.env`), `cap_drop: [ALL]`, `no-new-privileges:true`, et `mem_limit: 512m`.
2. **`Dockerfile` (durci et corrigé) :**
   - **Fix `tsx` manquant en prod :** `tsx` étant dans `devDependencies`, `npm prune --omit=dev` le supprimait avant `CMD ["npx", "tsx", ...]`. Ajout de `npm install --no-save tsx` et exécution directe via `CMD ["./node_modules/.bin/tsx", "server/index.ts"]`.
   - **Exécution non-root :** passage sous l'utilisateur `node` (UID/GID `1000`, identique à `mathieu` sur Debian) avec `chown -R node:node /app /data`.
3. **`server/index.ts` (en-têtes sécurité & PWA) :**
   - Ajout d'un middleware global posant `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security`, et **`Permissions-Policy: camera=(self), microphone=(), geolocation=()`** (`camera=(self)` préserve le scanner QR/ISBN et l'OCR photo).
   - Ajout de `Cache-Control: no-cache, no-store, must-revalidate` sur `/sw-push.js` et `Content-Type: application/manifest+json` (`no-cache`) sur `/manifest.webmanifest`.
4. **`deploy.sh` (nouveau) :**
   - Script de mise à jour en 1 commande (`git pull --ff-only`, `docker compose -f docker-compose.tunnel.yml up -d --build`, test `/health`, `docker image prune -f`).
5. **Sauvegardes automatiques (côté infrastructure `/srv/backups/backup-serveur.sh`) :**
   - Étendu pour sauvegarder à chaud toutes les nuits à `03h00` les fichiers `*.sqlite` (`biblio.sqlite`) via `sqlite3 .backup` ainsi que les dossiers `covers/` et `.env` vers Google Drive (`gdrive:Serveur_Backups/daily`).

---

## 3. Comment pousser les futures mises à jour (pour l'agent de dev)

Depuis ce dépôt local sur Mac, après avoir validé les tests (`npx tsc --noEmit`, `npm run typecheck:server`, `npx vitest run`) :

```bash
# 1. Commiter et pousser sur la branche déployée (feat/self-hosted-server)
git add <fichiers>
git commit -m "..."
git push origin feat/self-hosted-server

# 2. Déployer sur le serveur (en local via `serveur` ou à distance via `serveur-vpn`)
ssh serveur "/srv/docker/inventaire-surcouche/deploy.sh"
# (ou depuis l'extérieur : ssh serveur-vpn "/srv/docker/inventaire-surcouche/deploy.sh")
```

### Règles importantes à respecter lors des futures évolutions
- **Ne jamais toucher au port `8081` (`effectif_MAR`) ni utiliser `docker-compose.yml` avec Caddy** sur ce serveur : toujours utiliser `docker-compose.tunnel.yml` (`127.0.0.1:8082:3000`).
- **Migrations SQL (`migrations/*.sql`) :** elles sont appliquées automatiquement au démarrage de `server/index.ts`. Toujours écrire des migrations incrémentales compatibles SQLite (ne jamais modifier une ancienne migration déjà appliquée en prod).
- **Ne jamais écrire de secrets dans le dépôt :** les variables `JWT_SECRET`, `GEMINI_API_KEY`, `RESEND_API_KEY`, `VAPID_PRIVATE_JWK` vivent uniquement dans `/srv/docker/inventaire-surcouche/.env` sur le serveur.
- **PWA :** si le Service Worker ou le manifest change, vérifier après déploiement `curl -sI https://biblio.mathieuegardtest.fr/sw.js` et `manifest.webmanifest`.
