#!/bin/bash
# Учебное восстановление (п. 6 списка улучшений). Сервер запускает его сам раз в месяц ночью (update.sh),
# можно и вручную: bash deploy/restore-check.sh
# Берёт последнюю копию — из облачного хранилища, если оно настроено (так проверяется и пароль шифрования),
# иначе с сервера — и разворачивает её во временную базу fitnes_restore_check. Рабочая база и тестовый стенд
# не меняются. Результат — в «Состоянии системы» (файл restore-check-state) и, при ошибке, в служебном чате.
set -uo pipefail
cd "$(dirname "$0")"
DIR=${BACKUP_DIR:-/opt/fitnes-backups}
STATE=$DIR/restore-check-state
CHECKDB=fitnes_restore_check
log() { echo "$(date -Is) проверка восстановления: $*"; }
fail() { echo "fail: $1" > "$STATE"; log "ОШИБКА — $1"; bash ./notify.sh "🔴 Проверка восстановления не прошла: $1. Резервные копии могут быть непригодны — нужно разобраться" || true; exit 1; }
T=$(mktemp -d -p "$DIR" .check-XXXXXX); trap 'rm -rf "$T"' EXIT
if grep -qs '^OFFSITE_S3_BUCKET=.' .env; then
  F=$(bash ./offsite.sh latest "$T" | tail -1) || fail "не удалось скачать или расшифровать копию из хранилища"
  SRC="копия из хранилища"
else
  F=$(ls -1t "$DIR"/fitnes-*.tar 2>/dev/null | head -1)
  SRC="копия на сервере"
fi
[ -n "$F" ] && [ -f "$F" ] || fail "не найдено ни одной копии"
log "$SRC $(basename "$F")"
tar xf "$F" -C "$T" || fail "архив копии повреждён"
( cd "$T" && sha256sum -c --quiet SHA256SUMS ) || fail "контрольные суммы не совпали"
tar tzf "$T/storage.tgz" > /dev/null || fail "архив файлов (договоры, записи) повреждён"
# Где разворачивать: база тестового стенда, если он запущен, иначе рядом с рабочей (отдельная временная база)
SVC=db
if docker compose config --services 2>/dev/null | grep -qx test-db && [ -n "$(docker compose ps -q test-db 2>/dev/null)" ]; then SVC=test-db; fi
sql() { docker compose exec -T "$SVC" psql -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
sql -c "drop database if exists $CHECKDB" -c "create database $CHECKDB" > /dev/null || fail "не удалось создать временную базу"
if ! docker compose exec -T "$SVC" pg_restore -U postgres -d "$CHECKDB" --no-owner --exit-on-error < "$T/db.dump" > "$T/restore.log" 2>&1; then
  tail -3 "$T/restore.log"
  sql -c "drop database if exists $CHECKDB" > /dev/null
  fail "база из копии не восстановилась ($(tail -1 "$T/restore.log" | cut -c1-150))"
fi
COUNTS=$(sql -d "$CHECKDB" -c "select (select count(*) from tenants) || '|' || (select count(*) from clubs) || '|' || (select count(*) from persons) || '|' || (select count(*) from payments)")
sql -c "drop database if exists $CHECKDB" > /dev/null
IFS='|' read -r NT NC NP NPAY <<< "$COUNTS"
[ "${NT:-0}" -gt 0 ] 2>/dev/null || fail "в восстановленной базе нет ни одной сети клубов"
STAMP=$(basename "$F" | sed -E 's/^fitnes-([0-9]{4})([0-9]{2})([0-9]{2})-.*/\3.\2.\1/')
echo "ok: $SRC от $STAMP — клубов $NC, клиентов $NP, платежей $NPAY" > "$STATE"
log "готово: клубов $NC, клиентов $NP, платежей $NPAY"
