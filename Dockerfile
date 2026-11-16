# Клубная ОС: образ приложения (API + собранный веб).
# Рабочая сборка (п. 10 списка улучшений): всё собирается на первом этапе, в итоговый образ попадают
# только собранные файлы и пакеты для работы — без tsx, TypeScript и инструментов сборки. Запуск в режиме production.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY apps apps
# Инструкции из docs встраиваются в веб при сборке
COPY docs docs
RUN npm run build -w apps/web && npm run build -w apps/api
# Для работы нужны только пакеты из dependencies: инструменты сборки убираем без повторной загрузки
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/db/dist apps/api/db/dist
COPY --from=build /app/apps/api/db/migrations apps/api/db/migrations
COPY --from=build /app/apps/web/dist apps/web/dist
# Привычные команды (npm run platform, npm run db:seed и т.п.) в образе запускают собранные файлы
RUN npm pkg set -w apps/api scripts.start="node --enable-source-maps dist/main.mjs" scripts.db:setup="node db/dist/setup.mjs" \
    scripts.db:migrate="node db/dist/migrate.mjs" scripts.db:seed="node db/dist/seed.mjs" scripts.db:reset="node db/dist/reset.mjs" \
    scripts.platform="node db/dist/platform.mjs"
ENV API_HOST=0.0.0.0 API_PORT=3000 STORAGE_DIR=/data/storage
EXPOSE 3000
WORKDIR /app/apps/api
# Сайт (APP_ROLE=web или без роли): при каждом запуске проверить пользователей БД, применить новые миграции, запустить API.
# Фоновые задачи (APP_ROLE=worker): миграции уже применил сайт, сразу запуск.
CMD ["sh", "-c", "if [ \"$APP_ROLE\" != worker ]; then node db/dist/setup.mjs && node db/dist/migrate.mjs; fi && exec node --enable-source-maps dist/main.mjs"]
