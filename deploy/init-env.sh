#!/bin/sh
# Создаёт deploy/.env со случайными паролями. Пароли не выводятся на экран.
# Повторный запуск ничего не меняет, если .env уже есть.
set -e
cd "$(dirname "$0")"
if [ -f .env ]; then echo ".env уже есть, не трогаю"; exit 0; fi
r() { openssl rand -hex 24; }
umask 077
cat > .env <<EOT
POSTGRES_PASSWORD=$(r)
DB_OWNER_PASSWORD=$(r)
DB_APP_PASSWORD=$(r)
FISCAL_SECRET_KEY=$(r)
PUBLIC_URL=https://app.amoglobal.ru
SEED_PASSWORD=Fitnes-2026
EOT
echo ".env создан (права 600)"
