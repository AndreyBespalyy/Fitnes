# Клубная ОС: образ приложения (API + собранный веб)
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY apps apps
COPY docs docs
RUN npm run build -w apps/web
ENV API_HOST=0.0.0.0 API_PORT=3000 STORAGE_DIR=/data/storage
EXPOSE 3000
# При каждом запуске: проверить пользователей БД, применить новые миграции, запустить API
CMD ["sh", "-c", "npm run db:setup -w apps/api && npm run db:migrate -w apps/api && npm start -w apps/api"]
