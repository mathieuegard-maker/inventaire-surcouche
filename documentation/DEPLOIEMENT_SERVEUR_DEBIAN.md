# Déploiement Auto-Hébergé (Debian + Docker) — `mathieuegardtest.fr`

Ce guide permet de déployer **Biblio Collection PWA** sur votre serveur Debian **sans aucune dépendance Cloudflare** (SQLite local persistant + couvertures sur disque + CRON interne + HTTPS automatique Let's Encrypt).

---

## 1. Prérequis sur le serveur Debian

* **DNS :** un enregistrement `A` (et `AAAA` si IPv6) pointant `mathieuegardtest.fr` vers l'IP publique de votre serveur Debian.
* **Ports ouverts :** `80/tcp` et `443/tcp` (indispensable pour Let's Encrypt HTTPS, la PWA installable, la caméra code-barres et les notifications Push).
* **Docker + Docker Compose :**
  ```bash
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER
  ```

---

## 2. Installation & Premier Lancement

```bash
git clone <URL_DE_VOTRE_DEPOT> biblio-collection
cd biblio-collection
git checkout feat/self-hosted-server

# 1. Créer le fichier .env à partir du modèle
cp .env.example .env
# Générer un secret JWT solide et renseigner GEMINI_API_KEY (+ RESEND / VAPID si utilisés)
openssl rand -hex 32
nano .env

# 2. Construire et démarrer l'application + Caddy HTTPS
docker compose up -d --build
```

Au démarrage, le conteneur `biblio-collection-app` :
1. Crée `/data/biblio.sqlite` et applique automatiquement les 12 migrations SQL (`migrations/`).
2. Stocke les couvertures WebP dans `/data/covers/`.
3. Démarre le planificateur interne (`CRON_ENABLED=true`, toutes les 60 min par défaut) qui remplace le Worker CRON Cloudflare.
4. Caddy obtient et renouvelle automatiquement le certificat HTTPS pour `https://mathieuegardtest.fr`.

Vérification rapide :
```bash
docker compose logs -f biblio-app
curl -fsS https://mathieuegardtest.fr/health
```

---

## 3. Si vous utilisez déjà Nginx sur votre serveur Debian

Si les ports `80`/`443` sont déjà occupés par un Nginx existant :
1. Dans [`docker-compose.yml`](../docker-compose.yml), supprimez le service `caddy` et décommentez `ports: - "127.0.0.1:3000:3000"` sur `biblio-app`.
2. Copiez [`deploy/nginx-mathieuegardtest.fr.conf`](../deploy/nginx-mathieuegardtest.fr.conf) dans `/etc/nginx/sites-available/mathieuegardtest.fr`, activez le site puis lancez `sudo certbot --nginx -d mathieuegardtest.fr`.

---

## 4. Mise à jour & Sauvegarde

### Mettre à jour l'application
```bash
git pull
docker compose up -d --build
```

### Sauvegarde quotidienne recommandée (cron Debian)
Toutes vos données vivent dans le dossier `./data/` (`biblio.sqlite` + `covers/`).
Pour une sauvegarde à chaud propre de SQLite (mode WAL) :
```bash
docker exec biblio-collection-app node -e "
const Database = require('better-sqlite3');
const db = new Database('/data/biblio.sqlite', { readonly: true });
db.backup('/data/backup-' + new Date().toISOString().slice(0,10) + '.sqlite').then(() => { db.close(); process.exit(0); });
"
```
