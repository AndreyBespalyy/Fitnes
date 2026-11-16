#!/bin/bash
# Безопасное автообновление сервера (п. 5 списка улучшений). Запускается таймером fitnes-update каждые 5 минут
# через deploy/autoupdate.sh. Журнал: /var/log/fitnes-update.log
#
# - Ставит только версии, у которых прошли автопроверки на GitHub: их CI кладёт в ветку deploy (.github/workflows/ci.yml).
#   Пока ветки deploy нет, берётся main, как раньше.
# - Перед версией с изменениями базы (новые миграции) делает резервную копию. Не получилось — не обновляет и сообщает.
# - После обновления ждёт, пока сайт ответит (до 3 минут). Не ответил — возвращает прошлую версию, сообщает
#   в Telegram и больше не пробует эту версию, пока не придёт следующая.
# - Раз в сутки — резервная копия, каждые 5 минут — проверка сайта и места на диске (healthcheck.sh).
#
# Весь скрипт — одна функция: bash читает её целиком до запуска, поэтому git reset посреди работы
# (он меняет и этот файл) не ломает выполнение.
main() {
  set -euo pipefail
  cd /opt/fitnes
  exec 9>/run/fitnes-update.lock
  flock -n 9 || return 0
  local STATE=/opt/fitnes-backups DEPLOYED=/opt/fitnes-deployed BAD=/opt/fitnes-bad AIPENDING=/opt/fitnes-ai-pending
  mkdir -p "$STATE"
  log() { echo "$(date -Is) $*"; }
  notify() { bash /opt/fitnes/deploy/notify.sh "$1" || true; }
  app_health() {
    local id; id=$(docker compose ps -q app 2>/dev/null | head -1)
    [ -n "$id" ] || { echo нет; return; }
    docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo нет
  }
  # Ждём, пока сайт ответит: до $1 секунд
  wait_healthy() {
    local t=0 st
    while [ "$t" -lt "$1" ]; do
      st=$(app_health)
      [ "$st" = healthy ] && return 0
      [ "$st" = unhealthy ] && return 1
      sleep 5; t=$((t + 5))
    done
    return 1
  }

  # Резервная копия раз в сутки (AT12): если последней успешной больше 20 часов
  if [ ! -f "$STATE/last-ok" ] || [ $(( $(date +%s) - $(stat -c %Y "$STATE/last-ok") )) -gt 72000 ]; then
    bash deploy/backup.sh || { log "ОШИБКА резервной копии"; notify "🔴 Не удалась ночная резервная копия. Журнал: /var/log/fitnes-update.log"; }
  fi
  ( cd deploy && bash ./healthcheck.sh ) || true

  # UPDATE_BRANCH=main в deploy/.env — ставить сразу из main, не дожидаясь проверок
  local branch
  branch=$(grep -s '^UPDATE_BRANCH=' deploy/.env | tail -1 | cut -d= -f2- || true)
  branch=${branch:-deploy}
  if ! git fetch -q origin "$branch" 2>/dev/null; then branch=main; git fetch -q origin main; fi
  local cur new prev
  cur=$(cat "$DEPLOYED" 2>/dev/null || echo нет)
  new=$(git rev-parse "origin/$branch")
  if [ "$cur" = "$new" ]; then
    # CRM обновлена, а ИИ-сервер в прошлый раз не собрался — пробуем ещё раз
    if [ -f "$AIPENDING" ]; then (cd deploy && docker compose up -d --build >/dev/null 2>&1) && rm -f "$AIPENDING" && log "ИИ-сервер собран"; fi
    return 0
  fi
  [ "$(cat "$BAD" 2>/dev/null)" = "$new" ] && return 0
  log "обновление ${cur:0:7} -> ${new:0:7} (ветка $branch)"

  # Копия перед изменением базы
  if [ "$cur" = нет ] || ! git cat-file -e "$cur^{commit}" 2>/dev/null || [ -n "$(git diff --name-only "$cur" "$new" -- apps/api/db/migrations)" ]; then
    log "в новой версии меняется база — сначала резервная копия"
    if ! BACKUP_KEEP=${BACKUP_KEEP:-14} bash deploy/backup.sh; then
      log "ОШИБКА копии перед обновлением, обновление отложено"
      [ -f "$STATE/backup-fail-$new" ] || { notify "🔴 Не удалось сделать копию перед обновлением ${new:0:7}. Обновление отложено, повторю через 5 минут"; touch "$STATE/backup-fail-$new"; }
      return 1
    fi
    rm -f "$STATE"/backup-fail-*
  fi

  prev=$(git rev-parse HEAD)
  git reset -q --hard "$new"
  cd deploy
  local up=0
  if docker compose up -d --build; then up=1; rm -f "$AIPENDING"
  else
    # Если не собрался ИИ-сервер (профиль ai), CRM всё равно обновляем; ИИ пересоберём в следующий раз
    log "ОШИБКА полной сборки, обновляю только CRM"
    if docker compose up -d --build app worker; then up=1; touch "$AIPENDING"; fi
  fi
  if [ "$up" = 1 ] && wait_healthy 180; then
    echo "$new" > "$DEPLOYED"
    rm -f "$BAD"
    log "готово"
  else
    log "ОШИБКА: новая версия не запустилась, возвращаю ${prev:0:7}"
    echo "$new" > "$BAD"
    cd /opt/fitnes && git reset -q --hard "$prev" && cd deploy
    docker compose up -d --build app worker || true
    if wait_healthy 180; then
      notify "🟠 Новая версия ${new:0:7} не запустилась — вернул прошлую (${prev:0:7}), сайт работает. Эту версию больше не ставлю, жду следующую. Журнал: /var/log/fitnes-update.log"
      log "прошлая версия работает"
    else
      notify "🔴 Новая версия ${new:0:7} не запустилась, и прошлая тоже не поднялась. Нужен человек: docker compose logs app"
      log "ОШИБКА: прошлая версия тоже не поднялась"
    fi
  fi
  docker image prune -f >/dev/null
}
main "$@"
exit
