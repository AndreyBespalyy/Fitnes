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
  local TESTREADY=/opt/fitnes-test-ready CADDYSUM=/opt/fitnes-caddy.sha
  mkdir -p "$STATE"
  log() { echo "$(date -Is) $*"; }
  notify() { bash /opt/fitnes/deploy/notify.sh "$1" || true; }
  health() {  # $1 — сервис
    local id; id=$(docker compose ps -q "$1" 2>/dev/null | head -1)
    [ -n "$id" ] || { echo нет; return; }
    docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo нет
  }
  # Ждём, пока сервис $1 ответит: до $2 секунд
  wait_healthy() {
    local t=0 st
    while [ "$t" -lt "$2" ]; do
      st=$(health "$1")
      [ "$st" = healthy ] && return 0
      [ "$st" = unhealthy ] && return 1
      sleep 5; t=$((t + 5))
    done
    return 1
  }

  # Есть ли в текущей версии тестовый стенд (п. 4)
  has_test() { (cd /opt/fitnes/deploy && docker compose config --services 2>/dev/null | grep -qx test-app); }
  # Первый запуск тестового стенда: его база — копия последней резервной копии рабочей (без копии — учебные данные)
  init_test_stand() {
    [ -f "$TESTREADY" ] && return 0
    has_test || return 0
    docker image inspect fitnes-app:test >/dev/null 2>&1 || return 0
    local f tmp t=0
    f=$(ls -1t "$STATE"/fitnes-*.tar 2>/dev/null | head -1 || true)
    log "тестовый стенд: первый запуск, база — ${f:-учебные данные}"
    ( cd /opt/fitnes/deploy
      docker compose stop test-app >/dev/null 2>&1 || true
      docker compose up -d test-db
      until docker compose exec -T test-db pg_isready -U postgres >/dev/null 2>&1; do sleep 2; t=$((t + 2)); [ "$t" -lt 120 ] || exit 1; done
      docker compose run --rm --no-deps -T test-app node db/dist/setup.mjs
      if [ -n "$f" ]; then
        tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
        tar xf "$f" -C "$tmp" db.dump storage.tgz
        docker compose exec -T test-db psql -U postgres -qc "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'fitnes' and pid <> pg_backend_pid()" >/dev/null
        docker compose exec -T test-db pg_restore -U postgres -d fitnes --clean --if-exists --single-transaction < "$tmp/db.dump"
        docker compose run --rm --no-deps -T test-app sh -c 'mkdir -p /data/storage && cd /data/storage && tar xzf -' < "$tmp/storage.tgz"
      else
        docker compose run --rm --no-deps -T test-app sh -c 'node db/dist/migrate.mjs && node db/dist/seed.mjs'
      fi
    ) || { log "ОШИБКА: тестовый стенд не подготовлен, повторю через 5 минут"; return 0; }
    touch "$TESTREADY"
    log "тестовый стенд подготовлен"
  }
  # Caddy читает Caddyfile при запуске: изменился файл — пересоздаём (пара секунд без ответа)
  caddy_sync() {
    local h; h=$(sha256sum /opt/fitnes/deploy/Caddyfile | cut -c1-64)
    [ "$(cat "$CADDYSUM" 2>/dev/null)" = "$h" ] && return 0
    (cd /opt/fitnes/deploy && docker compose up -d --no-deps --force-recreate caddy >/dev/null) && log "Caddy перезапущен с новым Caddyfile"
    echo "$h" > "$CADDYSUM"
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
  # Тестовый стенд, появившийся с прошлым обновлением, и новые адреса Caddy подхватываем и без новой версии
  if has_test && [ ! -f "$TESTREADY" ]; then init_test_stand; [ -f "$TESTREADY" ] && (cd deploy && docker compose up -d --no-build test-app >/dev/null); fi
  caddy_sync
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
  # Образ, который работает сейчас, — запасной: откат без пересборки
  if docker image inspect fitnes-app:latest >/dev/null 2>&1; then docker tag fitnes-app:latest fitnes-app:prev; fi
  rollback() {  # $1 — что случилось
    log "ОШИБКА: $1, возвращаю ${prev:0:7}"
    echo "$new" > "$BAD"
    cd /opt/fitnes && git reset -q --hard "$prev" && cd deploy
    if docker image inspect fitnes-app:prev >/dev/null 2>&1; then docker tag fitnes-app:prev fitnes-app:latest; docker tag fitnes-app:prev fitnes-app:test; fi
    docker compose up -d --no-build app worker || true
    if has_test; then docker compose up -d --no-build test-app || true; fi
    if wait_healthy app 180; then
      notify "🟠 Новая версия ${new:0:7}: $1. Рабочий сайт на прошлой версии (${prev:0:7}) и работает. Эту версию больше не ставлю, жду следующую. Журнал: /var/log/fitnes-update.log"
      log "прошлая версия работает"
    else
      notify "🔴 Новая версия ${new:0:7}: $1. Прошлая версия тоже не поднялась — нужен человек: docker compose logs app"
      log "ОШИБКА: прошлая версия тоже не поднялась"
    fi
    docker image prune -f >/dev/null
  }
  if ! docker compose build app $(has_test && echo test-app); then rollback "не собралась"; return 1; fi
  # 1) Тестовый стенд: новая версия сначала здесь (миграции проверяются на его базе)
  if has_test; then
    init_test_stand
    docker compose up -d --no-build test-db test-app
    if ! wait_healthy test-app 180; then rollback "не запустилась на тестовом стенде"; return 1; fi
    log "тестовый стенд обновлён"
  fi
  # 2) Рабочий сайт и фоновые задачи
  docker compose up -d --no-build app worker
  if ! wait_healthy app 180; then rollback "не запустилась на рабочем сайте"; return 1; fi
  echo "$new" > "$DEPLOYED"
  rm -f "$BAD"
  log "готово"
  # 3) Остальное, в том числе ИИ-сервер (профиль ai): не собрался — CRM уже обновлена, повторим через 5 минут
  if docker compose up -d --build >/dev/null 2>&1; then rm -f "$AIPENDING"; else log "ИИ-сервер не собрался, повторю"; touch "$AIPENDING"; fi
  caddy_sync
  docker image prune -f >/dev/null
}
main "$@"
exit
