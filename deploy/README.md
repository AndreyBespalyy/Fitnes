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
