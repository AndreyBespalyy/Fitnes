#!/bin/bash
# Автообновление сервера. Запускается таймером fitnes-update каждые 5 минут (deploy/setup-autoupdate.sh).
# 1. Раз в сутки делает резервную копию (deploy/backup.sh), при неудаче пишет в Telegram.
# 2. Проверяет, что сайт отвечает (deploy/healthcheck.sh), и сообщает о сбое и о восстановлении.
# 3. Ставит только проверенную версию: ветку deploy, которую GitHub обновляет после зелёных автотестов (ci.yml).
#    Пока ветки deploy нет, берёт main, как раньше. UPDATE_BRANCH=main в deploy/.env — всегда main.
# 4. Если в новой версии меняется база, сначала делает копию.
# 5. Если не собрался ИИ-сервер (профиль ai), CRM всё равно обновляется; полная сборка повторяется в следующий раз.
# 6. Если после обновления сайт не ответил за 3 минуты, возвращает прошлую версию, пишет в Telegram
#    и эту версию больше не ставит (дождётся следующей).
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

# Сайт отвечает? Сообщение о сбое и о восстановлении
bash deploy/healthcheck.sh || true

BRANCH=$(envval UPDATE_BRANCH)
if [ -z "$BRANCH" ]; then
  if git ls-remote -q --exit-code --heads origin deploy >/dev/null 2>&1; then BRANCH=deploy; else BRANCH=main; fi
fi
git fetch -q origin "$BRANCH"
new=$(git rev-parse FETCH_HEAD)

# DEPLOYED — версия, собранная целиком (её же пишет прежняя версия скрипта); RUNNING — версия, на которой работает CRM.
DEPLOYED=/opt/fitnes-deployed
RUNNING=$STATE/running
full=$(cat "$DEPLOYED" 2>/dev/null || true)
cur=$(cat "$RUNNING" 2>/dev/null || true)
[ -n "$cur" ] || cur=${full:-$(git rev-parse -q --verify HEAD || echo нет)}
[ "$full" = "$new" ] && exit 0

BAD=$STATE/bad-commit
if [ -f "$BAD" ] && [ "$(cat "$BAD")" = "$new" ]; then exit 0; fi
if [ "$cur" != нет ] && [ "$cur" != "$new" ] && ! git merge-base --is-ancestor "$cur" "$new" 2>/dev/null; then
  # Проверенная версия старше работающей (например, сразу после перехода с main на deploy) — ждём следующую
  git merge-base --is-ancestor "$new" "$cur" 2>/dev/null && exit 0
  log "ветка $BRANCH разошлась с работающей версией ${cur:0:7}: обновление пропущено"
  exit 0
fi

healthy() {
  for _ in $(seq 1 36); do
    if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then return 0; fi
    sleep 5
  done
  return 1
}
# Собрать и запустить: всё, а если не вышло — только CRM. Код 0 — всё, 2 — только CRM, 1 — не собралось.
build() {
  if docker compose up -d --build; then return 0; fi
  log "ОШИБКА полной сборки, обновляю только CRM"
  docker compose up -d --build app worker && return 2
  return 1
}

MIGR=""
if [ "$cur" != "$new" ]; then
  log "обновление ${cur:0:7} -> ${new:0:7} (ветка $BRANCH)"
  if [ "$cur" = нет ] || [ -n "$(git diff --name-only "$cur" "$new" -- apps/api/db/migrations 2>/dev/null || echo изменения)" ]; then
    MIGR=1
    log "в новой версии меняется база: копия перед обновлением"
    if ! bash deploy/backup.sh; then
      log "копия перед обновлением не удалась — обновление отложено"
      notify "🟡 Обновление до ${new:0:7} отложено: не удалось сделать копию базы перед изменениями. Проверьте место на диске сервера"
      exit 1
    fi
  fi
else
  log "повтор полной сборки ${new:0:7}"
fi

git reset -q --hard "$new"
cd deploy
export APP_VERSION=${new:0:7}
rc=0; build || rc=$?
if [ "$rc" -ne 1 ] && healthy; then
  echo "$new" > "$RUNNING"
  rm -f "$BAD"
  if [ "$rc" -eq 0 ]; then echo "$new" > "$DEPLOYED"; log "готово"; else log "CRM обновлена, полную сборку повторю в следующий раз"; fi
  docker image prune -f >/dev/null || true
  exit 0
fi

# Новая версия не поднялась: возвращаем прошлую и больше не пробуем эту же
log "после обновления сайт не отвечает — возвращаю ${cur:0:7}"
echo "$new" > "$BAD"
cd /opt/fitnes
if [ "$cur" = нет ] || [ "$cur" = "$new" ]; then notify "🔴 Версия ${new:0:7} не запустилась, вернуться не к чему. Нужна помощь разработчика. Журнал: /var/log/fitnes-update.log"; exit 1; fi
git reset -q --hard "$cur"
cd deploy
export APP_VERSION=${cur:0:7}
HINT=""
[ -n "$MIGR" ] && HINT=" Новая версия могла успеть изменить базу; если что-то работает странно, восстановите копию, сделанную перед обновлением (deploy/restore.sh)."
rc=0; build || rc=$?
if [ "$rc" -ne 1 ] && healthy; then
  log "возвращена версия ${cur:0:7}, сайт работает"
  notify "🔴 Обновление до ${new:0:7} не удалось: сайт не запустился. Вернул прошлую версию ${cur:0:7}, сайт работает. Эту версию больше не ставлю, жду следующую.$HINT"
else
  log "сайт не работает и на прошлой версии"
  notify "🔴 Сайт не работает ни на новой версии ${new:0:7}, ни на прошлой ${cur:0:7}. Нужна помощь разработчика. Журнал: /var/log/fitnes-update.log"
fi
exit 1
