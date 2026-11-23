#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ -f "./data/biblio.sqlite" ]; then
  BACKUP_DIR="./backups/pre-deploy-$(date +%Y%m%d-%H%M%S)"
  echo "=== Sauvegarde SQLite avant migration (${BACKUP_DIR}) ==="
  mkdir -p "${BACKUP_DIR}"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "./data/biblio.sqlite" ".backup '${BACKUP_DIR}/biblio.sqlite'"
  else
    cp -a ./data/biblio.sqlite* "${BACKUP_DIR}/"
  fi
fi

echo "=== Mise à jour du code depuis GitHub ==="
git pull --ff-only

echo "=== Reconstruction et redémarrage du conteneur (Cloudflare Tunnel 127.0.0.1:8082) ==="
docker compose -f docker-compose.tunnel.yml up -d --build

echo "=== Vérification santé locale ==="
sleep 3
curl -fsS http://127.0.0.1:8082/health && echo ""

echo "=== Nettoyage des anciennes images Docker ==="
docker image prune -f

echo "Déploiement V2 terminé !"
