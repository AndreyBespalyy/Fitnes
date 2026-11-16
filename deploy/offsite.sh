#!/bin/bash
# Копии вне сервера (п. 6 списка улучшений) в облачном хранилище S3: Яндекс Облако, Selectel и любое совместимое.
#   bash deploy/offsite.sh upload <файл.tar>   — зашифровать и отправить, оставить последние OFFSITE_KEEP копий
#   bash deploy/offsite.sh latest <папка>      — скачать и расшифровать последнюю копию (для проверки восстановления)
#   bash deploy/offsite.sh list                — какие копии лежат в хранилище
# Настройки — строки в deploy/.env:
#   OFFSITE_S3_ENDPOINT=https://storage.yandexcloud.net   (Selectel: https://s3.ru-1.storage.selcloud.ru)
#   OFFSITE_S3_REGION=ru-central1                          (Selectel: ru-1)
#   OFFSITE_S3_BUCKET=имя-бакета
#   OFFSITE_S3_KEY_ID=...  OFFSITE_S3_SECRET=...           (статический ключ доступа сервисного аккаунта)
#   OFFSITE_PASSPHRASE=длинный-пароль                      (им шифруется копия; сохраните его вне сервера!)
#   OFFSITE_KEEP=30                                        (сколько копий хранить, по умолчанию 30)
# Состояние для раздела «Состояние системы» — файл offsite-state в папке копий: off / ok / fail: причина.
set -uo pipefail
cd "$(dirname "$0")"
DIR=${BACKUP_DIR:-/opt/fitnes-backups}
STATE=$DIR/offsite-state
val() { grep -s "^$1=" .env | tail -1 | cut -d= -f2- ; }
BUCKET=$(val OFFSITE_S3_BUCKET)
if [ -z "$BUCKET" ]; then echo off > "$STATE"; [ "${1:-}" = upload ] && exit 0; echo "Копия вне сервера не настроена: нет OFFSITE_S3_BUCKET в deploy/.env"; exit 1; fi
ENDPOINT=$(val OFFSITE_S3_ENDPOINT); REGION=$(val OFFSITE_S3_REGION); KEEP=$(val OFFSITE_KEEP); KEEP=${KEEP:-30}
export AWS_ACCESS_KEY_ID; AWS_ACCESS_KEY_ID=$(val OFFSITE_S3_KEY_ID)
export AWS_SECRET_ACCESS_KEY; AWS_SECRET_ACCESS_KEY=$(val OFFSITE_S3_SECRET)
export OFFSITE_PASSPHRASE; OFFSITE_PASSPHRASE=$(val OFFSITE_PASSPHRASE)
fail() { echo "fail: $1" > "$STATE"; echo "$(date -Is) ОШИБКА копии вне сервера: $1"; exit 1; }
[ -n "$ENDPOINT" ] && [ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ] || fail "не заданы OFFSITE_S3_ENDPOINT, OFFSITE_S3_KEY_ID или OFFSITE_S3_SECRET"
[ "${#OFFSITE_PASSPHRASE}" -ge 16 ] || fail "OFFSITE_PASSPHRASE не задан или короче 16 символов"
# Клиент S3 — официальный образ AWS CLI (работает с любым S3-совместимым хранилищем); на сервер ничего не ставится
s3() { docker run --rm -i -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION="${REGION:-us-east-1}" \
  -v "$DIR:/b" amazon/aws-cli:2.22.35 --endpoint-url "$ENDPOINT" "$@"; }
PREFIX="s3://$BUCKET/fitnes"
case "${1:-}" in
  upload)
    F=${2:?файл копии}; N=$(basename "$F").enc
    openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:OFFSITE_PASSPHRASE -in "$F" -out "$DIR/$N" || fail "не удалось зашифровать"
    chmod 600 "$DIR/$N"
    if ! s3 s3 cp --only-show-errors "/b/$N" "$PREFIX/$N"; then rm -f "$DIR/$N"; fail "хранилище не приняло файл (проверьте ключ, бакет и адрес)"; fi
    rm -f "$DIR/$N"
    # Старые копии в хранилище: оставляем последние KEEP
    s3 s3 ls "$PREFIX/" 2>/dev/null | awk '{print $4}' | grep '^fitnes-.*\.tar\.enc$' | sort | head -n -"$KEEP" | while read -r old; do
      s3 s3 rm --only-show-errors "$PREFIX/$old" || true
    done
    echo ok > "$STATE"
    echo "$(date -Is) копия отправлена в хранилище: $N" ;;
  latest)
    OUT=${2:?папка}; mkdir -p "$OUT"
    N=$(s3 s3 ls "$PREFIX/" | awk '{print $4}' | grep '^fitnes-.*\.tar\.enc$' | sort | tail -1)
    [ -n "$N" ] || { echo "В хранилище нет копий"; exit 1; }
    s3 s3 cp --only-show-errors "$PREFIX/$N" "/b/.dl-$N" || { echo "Не удалось скачать $N"; exit 1; }
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:OFFSITE_PASSPHRASE -in "$DIR/.dl-$N" -out "$OUT/${N%.enc}" || { rm -f "$DIR/.dl-$N"; echo "Не удалось расшифровать $N (другой пароль?)"; exit 1; }
    rm -f "$DIR/.dl-$N"
    echo "$OUT/${N%.enc}" ;;
  list) s3 s3 ls "$PREFIX/" ;;
  *) echo "Использование: bash deploy/offsite.sh upload <файл> | latest <папка> | list"; exit 1 ;;
esac
