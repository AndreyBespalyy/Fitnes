#!/bin/bash
# Автообновление тестового сервера: если в GitHub (ветка main) появилась новая версия,
# забирает её и пересобирает контейнеры. Запускается таймером fitnes-update каждые 5 минут.
set -euo pipefail
cd /opt/fitnes
exec 9>/run/fitnes-update.lock
flock -n 9 || exit 0
git fetch -q origin main
cur=$(git rev-parse -q --verify HEAD || echo нет)
new=$(git rev-parse origin/main)
if [ "$cur" = "$new" ]; then exit 0; fi
echo "$(date -Is) обновление ${cur:0:7} -> ${new:0:7}"
git reset -q --hard origin/main
cd deploy
docker compose up -d --build
docker image prune -f >/dev/null
echo "$(date -Is) готово"
