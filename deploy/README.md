# Тестовый сервер 144.31.107.204

Проект лежит в `/opt/fitnes`, запускается через Docker Compose из папки `deploy`.
Сайт: https://app.amoglobal.ru (и https://test.amoglobal.ru). Сертификаты HTTPS выпускает и продлевает Caddy сам.

Первый запуск:

    cd /opt/fitnes/deploy
    ./init-env.sh                       # случайные пароли БД и ключ шифрования в deploy/.env
    docker compose up -d --build
    docker compose exec app npm run db:seed -w apps/api   # тестовые клубы и сотрудники, только один раз

Обновление (новая версия кода в /opt/fitnes):

    cd /opt/fitnes/deploy && docker compose up -d --build

Новые миграции применяются сами при запуске. Данные базы и файлы хранятся в томах Docker и при обновлении не теряются.

Полезное: `docker compose ps`, `docker compose logs -f app`, `docker compose restart app`.
Не удаляйте `deploy/.env`: в нём ключ, которым зашифрованы пароли касс, ключи банка и сохранённые карты.

## Обновление с рабочего компьютера (Windows, PowerShell)

    cd C:\Users\Admin\Desktop\Fitnes; git pull; git archive --format=tar.gz -o $env:TEMP\fitnes.tar.gz HEAD
    scp -i C:\Users\Admin\.ssh\project2_vps -o IdentitiesOnly=yes $env:TEMP\fitnes.tar.gz root@144.31.107.204:/root/
    ssh -i C:\Users\Admin\.ssh\project2_vps -o IdentitiesOnly=yes root@144.31.107.204 "tar -xzf /root/fitnes.tar.gz -C /opt/fitnes && rm /root/fitnes.tar.gz && cd /opt/fitnes/deploy && docker compose up -d --build"

На сервере не запускайте db:reset и повторный db:seed: это сотрёт или задвоит данные.

## Автообновление с GitHub

Один раз (на рабочем компьютере, PowerShell):

    cd C:\Users\Admin\Desktop\Fitnes; git pull
    Get-Content deploy\setup-autoupdate.sh -Raw | ssh -i C:\Users\Admin\.ssh\project2_vps -o IdentitiesOnly=yes root@144.31.107.204 "tr -d '\r' | bash"

Скрипт покажет открытый ключ: его добавляют в репозиторий GitHub → Settings → Deploy keys (только чтение).
Дальше сервер каждые 5 минут проверяет ветку main и сам обновляется. Журнал: `/var/log/fitnes-update.log`.

С ноября 2026 сервер ставит не main, а ветку `deploy`: GitHub обновляет её после зелёных автотестов (`.github/workflows/ci.yml`).
Перед обновлением с изменениями базы делается копия. Если сайт не поднялся за 3 минуты, сервер возвращает прошлую версию.
Оповещения о сбоях идут в Telegram: строки `ALERT_TELEGRAM_BOT_TOKEN` и `ALERT_TELEGRAM_CHAT_ID` в `deploy/.env`.
Подробно: `docs/03_Инструкции/Состояние_системы.md`. Скрипты: `autoupdate.sh`, `healthcheck.sh`, `notify.sh`.
