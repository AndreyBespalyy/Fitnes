#!/bin/bash
# Сообщение в служебный Telegram-чат о состоянии сервера. Запуск: bash deploy/notify.sh "текст"
# Нужны ALERT_TELEGRAM_BOT_TOKEN и ALERT_TELEGRAM_CHAT_ID в deploy/.env. Без них сообщение только пишется в журнал.
cd "$(dirname "$0")"
val() { grep -s "^$1=" .env | tail -1 | cut -d= -f2- ; }
TOKEN=$(val ALERT_TELEGRAM_BOT_TOKEN); CHAT=$(val ALERT_TELEGRAM_CHAT_ID); HOST=$(val PUBLIC_URL)
TEXT="${HOST:-Клубная ОС} (сервер)
$1"
echo "$(date -Is) оповещение: $1"
[ -n "$TOKEN" ] && [ -n "$CHAT" ] || exit 0
curl -fsS --max-time 15 -o /dev/null "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT}" --data-urlencode "text=${TEXT}" --data-urlencode "disable_web_page_preview=true" \
  || echo "$(date -Is) не удалось отправить оповещение в Telegram"
