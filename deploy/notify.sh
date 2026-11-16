#!/bin/bash
# Оповещение о событии сервера (обновление, откат, сбой копии). Запуск: bash deploy/notify.sh "текст"
# Событие дописывается в файл server-events в папке копий; приложение раз в минуту читает его и показывает
# собственнику и администратору в уведомлениях CRM (колокольчик и push) — рабочая связь внутри CRM.
# Служебный Telegram-чат — только если в deploy/.env есть ALERT_TELEGRAM_BOT_TOKEN и ALERT_TELEGRAM_CHAT_ID
# (включается по решению Андрея; без них в Telegram ничего не уходит).
cd "$(dirname "$0")"
DIR=${BACKUP_DIR:-/opt/fitnes-backups}
mkdir -p "$DIR"
TEXT=$(printf '%s' "$1" | tr '\t\n' '  ')
printf '%s\t%s\n' "$(date -Is)" "$TEXT" >> "$DIR/server-events"
echo "$(date -Is) оповещение: $1"
val() { grep -s "^$1=" .env | tail -1 | cut -d= -f2- ; }
TOKEN=$(val ALERT_TELEGRAM_BOT_TOKEN); CHAT=$(val ALERT_TELEGRAM_CHAT_ID); HOST=$(val PUBLIC_URL)
[ -n "$TOKEN" ] && [ -n "$CHAT" ] || exit 0
curl -fsS --max-time 15 -o /dev/null "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT}" --data-urlencode "text=${HOST:-Клубная ОС} (сервер)
$1" --data-urlencode "disable_web_page_preview=true" \
  || echo "$(date -Is) не удалось отправить оповещение в Telegram"
