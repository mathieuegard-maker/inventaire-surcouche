#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "=== Mise à jour du code depuis GitHub ==="
git pull --ff-only

echo "=== Reconstruction et redémarrage du conteneur ==="
docker compose -f docker-compose.tunnel.yml up -d --build

echo "=== Vérification santé locale ==="
sleep 3
curl -fsS http://127.0.0.1:8082/health && echo ""

echo "=== Nettoyage des anciennes images Docker ==="
docker image prune -f

echo "Déploiement terminé !"
