#!/bin/bash
# Восстановление Клубной ОС из резервной копии. ЗАМЕНЯЕТ текущую базу и файлы содержимым копии.
# Запуск: bash deploy/restore.sh /opt/fitnes-backups/fitnes-ГГГГММДД-ЧЧММ.tar --yes
# .env из копии не подставляется автоматически: если сервер новый, скопируйте его вручную (см. docs/03_Инструкции/Резервные_копии.md).
set -euo pipefail
cd "$(dirname "$0")"
F=${1:-}; [ -f "$F" ] || { echo "Укажите файл копии: bash deploy/restore.sh /opt/fitnes-backups/fitnes-....tar --yes"; exit 1; }
[ "${2:-}" = "--yes" ] || { echo "Восстановление заменит текущие данные копией $F. Чтобы продолжить, добавьте --yes"; exit 1; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
tar xf "$F" -C "$T"
( cd "$T" && sha256sum -c SHA256SUMS --quiet ) || { echo "Копия повреждена: контрольные суммы не сходятся"; exit 1; }
START=$(date +%s)
# Перед восстановлением — копия текущего состояния, чтобы можно было вернуться
BACKUP_KEEP=100 bash ./backup.sh || echo "Текущее состояние сохранить не удалось, продолжаю"
docker compose stop app
docker compose exec -T db psql -U postgres -v ON_ERROR_STOP=1 -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'fitnes' and pid <> pg_backend_pid()" > /dev/null
docker compose exec -T db pg_restore -U postgres -d fitnes --clean --if-exists --single-transaction < "$T/db.dump"
docker compose run --rm --no-deps -T --entrypoint sh app -c 'rm -rf /data/storage/* && mkdir -p /data/storage && tar xzf - -C /data/storage' < "$T/storage.tgz"
docker compose start app
echo "Восстановлено из $F за $(( $(date +%s) - START )) с. Откройте сайт и проверьте вход."
