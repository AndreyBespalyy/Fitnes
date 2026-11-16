#!/bin/bash
# Проверка сервера снаружи приложения (запускается из autoupdate.sh каждые 5 минут).
# Сайт не отвечает две проверки подряд — сообщение в Telegram; ожил — сообщение о восстановлении.
# Свободного места на диске сервера меньше 10 % — сообщение не чаще раза в 6 часов.
cd "$(dirname "$0")"
STATE=/opt/fitnes-backups
mkdir -p "$STATE"
FAILS=$STATE/health-fails
n=$(cat "$FAILS" 2>/dev/null || echo 0)
if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
  if [ "$n" -ge 2 ]; then bash ./notify.sh "✅ Сайт снова работает"; fi
  echo 0 > "$FAILS"
else
  n=$((n + 1)); echo "$n" > "$FAILS"
  if [ "$n" -eq 2 ]; then bash ./notify.sh "🔴 Сайт не отвечает уже 10 минут. Пробую перезапустить приложение. Журнал: docker compose logs app"; docker compose up -d >/dev/null 2>&1 || true; fi
  if [ "$n" -gt 2 ] && [ $(( n % 36 )) -eq 0 ]; then bash ./notify.sh "🔴 Сайт всё ещё не отвечает (проверок подряд: $n)"; fi
fi
# Место на диске сервера
pct=$(df -P / | awk 'NR==2 {gsub("%","",$5); print 100-$5}')
DISK=$STATE/disk-alert
if [ -n "$pct" ] && [ "$pct" -lt 10 ]; then
  if [ ! -f "$DISK" ] || [ $(( $(date +%s) - $(stat -c %Y "$DISK") )) -gt 21600 ]; then
    bash ./notify.sh "🔴 На сервере осталось $pct % свободного места. Освободите место, иначе перестанут сохраняться копии и файлы"; touch "$DISK"
  fi
else
  rm -f "$DISK"
fi
exit 0
