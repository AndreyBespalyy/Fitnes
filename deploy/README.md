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
