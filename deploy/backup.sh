#!/bin/bash
# Резервная копия Клубной ОС: база (pg_dump), файлы (договоры, сканы, записи звонков) и настройки сервера (.env).
# Хранится в /opt/fitnes-backups (доступ только root), последние 14 копий. Запуск: bash deploy/backup.sh
# Автоматически раз в сутки запускается из autoupdate.sh.
set -euo pipefail
cd "$(dirname "$0")"
DIR=${BACKUP_DIR:-/opt/fitnes-backups}
KEEP=${BACKUP_KEEP:-14}
mkdir -p "$DIR" && chmod 700 "$DIR"
TS=$(date +%Y%m%d-%H%M)
T=$DIR/.tmp-$TS
mkdir -p "$T"
trap 'rm -rf "$T"' EXIT
docker compose exec -T db pg_dump -U postgres -Fc fitnes > "$T/db.dump"
docker compose exec -T app sh -c 'cd /data/storage 2>/dev/null && tar czf - . || tar czf - --files-from /dev/null' > "$T/storage.tgz"
# .env нужен для восстановления: им зашифрованы ключи касс, банков и мессенджеров
cp .env "$T/env" && chmod 600 "$T/env"
# Проверка: копия базы читается
docker compose exec -T db pg_restore --list < "$T/db.dump" > /dev/null
( cd "$T" && sha256sum db.dump storage.tgz env > SHA256SUMS )
tar cf "$DIR/fitnes-$TS.tar" -C "$T" db.dump storage.tgz env SHA256SUMS
chmod 600 "$DIR/fitnes-$TS.tar"
ls -1t "$DIR"/fitnes-*.tar | tail -n +$((KEEP + 1)) | xargs -r rm -f
date -Is > "$DIR/last-ok"
echo "$(date -Is) резервная копия готова: $DIR/fitnes-$TS.tar ($(du -h "$DIR/fitnes-$TS.tar" | cut -f1))"
