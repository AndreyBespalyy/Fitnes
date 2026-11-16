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

## Рабочая сборка и фоновые задачи (с 16.11.2026)

Образ собирается заранее (`Dockerfile`, два этапа) и запускается в режиме production без tsx и TypeScript.
Работают два контейнера из одного образа:
- `app` — сайт и API (`APP_ROLE=web`), при запуске применяет миграции базы;
- `worker` — фоновые задачи (`APP_ROLE=worker`): касса, автосписания, рассылки, ИИ, push, обзоры, напоминания. Стартует после того, как сайт ответил.

Перезапустить только сайт: `docker compose restart app` (списания и рассылки не прерываются). Журнал фоновых задач: `docker compose logs -f worker`.
Команды обслуживания в контейнере те же: `docker compose exec app npm run platform -w apps/api -- contract show`.

## Безопасное автообновление (с 16.11.2026)

Таймер запускает `autoupdate.sh`, вся логика — в `update.sh`:
- ставится только версия из ветки `deploy`: GitHub сдвигает её после зелёных автотестов (`.github/workflows/ci.yml`); пока ветки нет — `main`;
- перед версией с новыми миграциями — резервная копия; не получилась — обновление откладывается;
- сайт не ответил за 3 минуты — возвращается прошлая версия, неудачная больше не ставится (`/opt/fitnes-bad`);
- оповещения — `notify.sh` (строки `ALERT_TELEGRAM_BOT_TOKEN` и `ALERT_TELEGRAM_CHAT_ID` в `.env`), проверка сайта и диска каждые 5 минут — `healthcheck.sh`.
`UPDATE_BRANCH=main` в `.env` — ставить сразу из main, не дожидаясь проверок.

## Тестовый стенд test.amoglobal.ru (с 16.11.2026)

Свои контейнеры `test-app` и `test-db`, своя база и свои файлы. Новая версия сначала ставится на стенд (на его базе проверяются
миграции) и переходит на app. только если там запустилась; иначе обе остаются на прошлой версии (`update.sh`).
При первом запуске база стенда — копия последней ночной резервной копии рабочей; дальше они живут отдельно.
На стенде нет фоновых задач и оповещений (`APP_ROLE=test`): в копии базы настоящие токены ботов и банков.
Пересоздать базу стенда из свежей копии: `rm /opt/fitnes-test-ready` — сервер сделает это в течение 5 минут.
## Копии вне сервера и учебное восстановление (с 16.11.2026)

Ночная копия (`backup.sh`) дополнительно шифруется и отправляется в облачное хранилище S3, если в `.env` есть строки `OFFSITE_S3_*`
(Яндекс Облако или Selectel, обычно 100–300 ₽ в месяц). Без них всё работает как раньше, а «Состояние системы» показывает «не настроена».

    OFFSITE_S3_ENDPOINT=https://storage.yandexcloud.net
    OFFSITE_S3_REGION=ru-central1
    OFFSITE_S3_BUCKET=имя-бакета
    OFFSITE_S3_KEY_ID=идентификатор-ключа
    OFFSITE_S3_SECRET=секретный-ключ
    OFFSITE_PASSPHRASE=пароль-не-короче-16-символов
    OFFSITE_KEEP=30

Пароль `OFFSITE_PASSPHRASE` сохраните ещё и вне сервера (менеджер паролей): без него копию не расшифровать.
Проверить вручную: `bash deploy/offsite.sh list`, отправить сейчас: `bash deploy/backup.sh`.

Раз в месяц ночью `restore-check.sh` сам разворачивает последнюю копию (из хранилища, если оно настроено) во временную базу,
проверяет её и удаляет. Результат — в «Состоянии системы», ошибка — в служебном чате. Вручную: `bash deploy/restore-check.sh`.
