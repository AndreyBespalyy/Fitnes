#!/bin/bash
# Автообновление сервера (описание ниже). Строки-заполнители из решёток не удалять:
# они нужны, чтобы прежняя версия скрипта, читающая этот файл с середины, корректно перешла на новую.
###############################################################################
###############################################################################
###############################################################################
###############################################################################
###############################################################################
###############################################################################
###############################################################################
###############################################################################
###
# Автообновление сервера. Запускается таймером fitnes-update каждые 5 минут (deploy/setup-autoupdate.sh).
# 1. Раз в сутки делает резервную копию (deploy/backup.sh), при неудаче пишет в Telegram.
# 2. Проверяет, что сайт отвечает (deploy/healthcheck.sh), и сообщает о сбое и о восстановлении.
# 3. Ставит только проверенную версию: ветку deploy, которую GitHub обновляет после зелёных автотестов.
# 4. Если в новой версии меняется база, сначала делает копию.
# 5. Если после обновления сайт не ответил за 3 минуты, возвращает прошлую версию и сообщает в Telegram.
# Оповещения: ALERT_TELEGRAM_BOT_TOKEN и ALERT_TELEGRAM_CHAT_ID в deploy/.env (docs/03_Инструкции/Состояние_системы.md).
# Журнал: /var/log/fitnes-update.log
set -euo pipefail
cd /opt/fitnes
exec 9>/run/fitnes-update.lock
flock -n 9 || exit 0
STATE=/opt/fitnes-backups
mkdir -p "$STATE" && chmod 700 "$STATE"
log() { echo "$(date -Is) $*"; }
notify() { bash /opt/fitnes/deploy/notify.sh "$1" || true; }
envval() { grep -s "^$1=" deploy/.env | tail -1 | cut -d= -f2- || true; }

# Резервная копия раз в сутки (AT12): если последней успешной больше 20 часов
LAST=$STATE/last-ok
if [ ! -f "$LAST" ] || [ $(( $(date +%s) - $(stat -c %Y "$LAST") )) -gt 72000 ]; then
  bash deploy/backup.sh || { log "ОШИБКА резервной копии"; notify "🔴 Ночная резервная копия не сделана. Журнал: /var/log/fitnes-update.log"; }
fi

# Сайт отвечает? Сообщение о сбое и о восстановлении (deploy/healthcheck.sh)
bash deploy/healthcheck.sh || true

# Ставим только проверенные версии: ветку deploy обновляет GitHub после того, как прошли все автотесты (ci.yml).
# UPDATE_BRANCH=main в deploy/.env возвращает прежнее поведение (обновление сразу после push).
BRANCH=$(envval UPDATE_BRANCH); BRANCH=${BRANCH:-deploy}
git fetch -q origin "$BRANCH" 2>/dev/null || exit 0
new=$(git rev-parse FETCH_HEAD)
# Какая версия реально запущена (не путать с файлами в папке: их меняет и прежняя версия этого скрипта)
DEPLOYED=$STATE/deployed
cur=$(cat "$DEPLOYED" 2>/dev/null || true)
FORCE=""
if [ -z "$cur" ]; then cur=$(git rev-parse -q --verify HEAD || echo нет); FORCE=1; fi
[ "$cur" = "$new" ] && [ -z "$FORCE" ] && exit 0
if [ "$cur" != нет ] && ! git merge-base --is-ancestor "$cur" "$new" 2>/dev/null; then
  # Проверенная версия старше текущей (например, сразу после перехода на ветку deploy) — ждём следующую
  git merge-base --is-ancestor "$new" "$cur" 2>/dev/null && exit 0
  log "ветка $BRANCH разошлась с текущей версией ${cur:0:7}: обновление пропущено"
  exit 0
fi
BAD=$STATE/bad-commit
if [ -f "$BAD" ] && [ "$(cat "$BAD")" = "$new" ]; then exit 0; fi

healthy() {
  for _ in $(seq 1 36); do
    if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then return 0; fi
    sleep 5
  done
  return 1
}

log "обновление ${cur:0:7} -> ${new:0:7}"
MIGR=""
if [ "$cur" = нет ] || [ -n "$(git diff --name-only "$cur" "$new" -- apps/api/db/migrations)" ]; then
  MIGR=1
  log "в новой версии меняется база: копия перед обновлением"
  if ! bash deploy/backup.sh; then
    log "копия перед обновлением не удалась — обновление отложено"
    notify "🟡 Обновление до ${new:0:7} отложено: не удалось сделать копию базы перед изменениями. Проверьте место на диске"
    exit 1
  fi
fi
git reset -q --hard "$new"
cd deploy
export APP_VERSION=${new:0:7}
if docker compose up -d --build && healthy; then
  docker image prune -f >/dev/null
  rm -f "$BAD"
  echo "$new" > "$DEPLOYED"
  log "готово"
  exit 0
fi

# Новая версия не поднялась: возвращаем прошлую и больше не пробуем эту же
log "после обновления сайт не отвечает — возвращаю ${cur:0:7}"
echo "$new" > "$BAD"
cd /opt/fitnes
[ "$cur" = нет ] && { notify "🔴 Первая установка ${new:0:7} не запустилась. Нужна помощь разработчика"; exit 1; }
git reset -q --hard "$cur"
cd deploy
export APP_VERSION=${cur:0:7}
HINT=""
[ -n "$MIGR" ] && HINT=" Новая версия успела изменить базу; если что-то работает странно, восстановите копию, сделанную перед обновлением: bash /opt/fitnes/deploy/restore.sh \$(ls -1t $STATE/fitnes-*.tar | head -1) --yes"
if docker compose up -d --build && healthy; then
  log "возвращена версия ${cur:0:7}, сайт работает"
  echo "$cur" > "$DEPLOYED"
  notify "🔴 Обновление до ${new:0:7} не удалось: сайт не запустился. Вернул прошлую версию ${cur:0:7}, сайт работает. Эту версию сервер больше ставить не будет, ждёт исправления.$HINT"
else
  log "сайт не работает и на прошлой версии"
  notify "🔴 Сайт не работает ни на новой версии ${new:0:7}, ни на прошлой ${cur:0:7}. Нужна помощь разработчика. Журнал: /var/log/fitnes-update.log.$HINT"
fi
exit 1
