#!/bin/bash
# Автообновление тестового сервера: если в GitHub (ветка main) появилась новая версия,
# забирает её и пересобирает контейнеры. Запускается таймером fitnes-update каждые 5 минут.
set -euo pipefail
cd /opt/fitnes
exec 9>/run/fitnes-update.lock
flock -n 9 || exit 0
git fetch -q origin main
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then exit 0; fi
echo "$(date -Is) обновление $(git rev-parse --short HEAD) -> $(git rev-parse --short origin/main)"
git reset -q --hard origin/main
cd deploy
docker compose up -d --build
docker image prune -f >/dev/null
echo "$(date -Is) готово"
