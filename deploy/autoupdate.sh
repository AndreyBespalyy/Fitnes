#!/bin/bash
# Автообновление тестового сервера: если в GitHub (ветка main) появилась новая версия,
# забирает её и пересобирает контейнеры. Запускается таймером fitnes-update каждые 5 минут.
set -euo pipefail
cd /opt/fitnes
exec 9>/run/fitnes-update.lock
flock -n 9 || exit 0
# Резервная копия раз в сутки (AT12): если последней успешной больше 20 часов
LAST=/opt/fitnes-backups/last-ok
if [ ! -f "$LAST" ] || [ $(( $(date +%s) - $(stat -c %Y "$LAST") )) -gt 72000 ]; then
  bash deploy/backup.sh || echo "$(date -Is) ОШИБКА резервной копии"
fi
git fetch -q origin main
# Развёрнутый коммит запоминается только после успешной сборки: если сборка упала,
# следующий запуск попробует снова (раньше сравнивали с HEAD и упавшая версия больше не собиралась).
DEPLOYED=/opt/fitnes-deployed
cur=$(cat "$DEPLOYED" 2>/dev/null || echo нет)
new=$(git rev-parse origin/main)
if [ "$cur" = "$new" ]; then exit 0; fi
echo "$(date -Is) обновление ${cur:0:7} -> ${new:0:7}"
git reset -q --hard origin/main
cd deploy
if docker compose up -d --build; then
  echo "$new" > "$DEPLOYED"
  echo "$(date -Is) готово"
else
  # Если не собрался ИИ-сервер (профиль ai), CRM всё равно обновляем; полную сборку повторим в следующий раз
  echo "$(date -Is) ОШИБКА сборки, обновляю только CRM"
  docker compose up -d --build app
fi
docker image prune -f >/dev/null
